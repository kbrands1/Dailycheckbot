/**
 * ClickUp.gs - ClickUp API Integration
 * Handles all ClickUp API calls with caching
 */

const CLICKUP_BASE_URL = 'https://api.clickup.com/api/v2';

/**
 * Get ClickUp API token from config
 */
function getClickUpToken() {
  return PropertiesService.getScriptProperties().getProperty('CLICKUP_API_TOKEN');
}

/**
 * Make authenticated request to ClickUp API
 */
function clickUpRequest(endpoint, method = 'GET', payload = null, retryCount = 0) {
  const token = getClickUpToken();

  if (!token) {
    console.error('ClickUp API token not configured');
    return null;
  }

  const options = {
    method: method,
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true
  };

  if (payload) {
    options.payload = JSON.stringify(payload);
  }

  try {
    const response = UrlFetchApp.fetch(CLICKUP_BASE_URL + endpoint, options);
    const code = response.getResponseCode();

    if (code === 429) {
      if (retryCount >= 2) {
        console.error('ClickUp rate limit exceeded after ' + retryCount + ' retries');
        return null;
      }
      console.warn('ClickUp rate limited, waiting 60s... (retry ' + (retryCount + 1) + ')');
      Utilities.sleep(60000);
      return clickUpRequest(endpoint, method, payload, retryCount + 1);
    }

    if (code >= 400) {
      console.error(`ClickUp API error: ${code} - ${response.getContentText()}`);
      return null;
    }

    return JSON.parse(response.getContentText());
  } catch (error) {
    console.error('ClickUp request failed:', error);
    return null;
  }
}

/**
 * Get workspace structure (cached)
 */
function getWorkspaceStructure() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('clickup_workspace');

  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      // Invalid cache, continue to fetch fresh
    }
  }

  console.log('Fetching fresh ClickUp workspace structure...');

  // Fetch teams
  const teams = clickUpRequest('/team');
  if (!teams || !teams.teams || teams.teams.length === 0) {
    console.error('No ClickUp teams found');
    return null;
  }

  const teamId = teams.teams[0].id;

  const structure = {
    teamId: teamId,
    spaces: [],
    lists: [],
    statuses: {},
    members: {}
  };

  // Get spaces
  const spaces = clickUpRequest(`/team/${teamId}/space`);
  if (!spaces || !spaces.spaces) {
    console.error('Failed to fetch ClickUp spaces');
    return null;
  }

  for (const space of spaces.spaces) {
    structure.spaces.push({
      id: space.id,
      name: space.name
    });

    // Get folders
    const folders = clickUpRequest(`/space/${space.id}/folder`);
    if (folders && folders.folders) {
      for (const folder of folders.folders) {
        for (const list of (folder.lists || [])) {
          structure.lists.push({
            id: list.id,
            name: list.name,
            folder: folder.name,
            space: space.name
          });
          // Get statuses from list
          const listDetails = clickUpRequest(`/list/${list.id}`);
          if (listDetails && listDetails.statuses) {
            structure.statuses[list.id] = listDetails.statuses;
          }
        }
      }
    }

    // Get folderless lists
    const folderlessLists = clickUpRequest(`/space/${space.id}/list`);
    if (folderlessLists && folderlessLists.lists) {
      for (const list of folderlessLists.lists) {
        structure.lists.push({
          id: list.id,
          name: list.name,
          folder: null,
          space: space.name
        });
        const listDetails = clickUpRequest(`/list/${list.id}`);
        if (listDetails && listDetails.statuses) {
          structure.statuses[list.id] = listDetails.statuses;
        }
      }
    }
  }

  // Get team members
  const team = clickUpRequest(`/team/${teamId}`);
  if (team && team.team && team.team.members) {
    for (const member of team.team.members) {
      if (member.user && member.user.email) {
        structure.members[member.user.email.toLowerCase()] = {
          id: member.user.id,
          username: member.user.username,
          email: member.user.email
        };
      }
    }
  }

  // Cache for 1 hour
  try {
    cache.put('clickup_workspace', JSON.stringify(structure), 3600);
  } catch (e) {
    console.warn('Failed to cache workspace structure:', e);
  }

  console.log(`Cached ClickUp structure: ${structure.lists.length} lists, ${Object.keys(structure.members).length} members`);
  return structure;
}

/**
 * Clear workspace cache
 */
function clearClickUpCache() {
  CacheService.getScriptCache().remove('clickup_workspace');
}

/**
 * Get stored ClickUp team ID (fast — no API call)
 * Falls back to fetching from API if not stored yet
 */
function getTeamId() {
  var props = PropertiesService.getScriptProperties();
  var teamId = props.getProperty('CLICKUP_TEAM_ID');
  if (teamId) return teamId;

  // Fallback: fetch from API and store
  console.log('CLICKUP_TEAM_ID not set, fetching from API...');
  var teams = clickUpRequest('/team');
  if (teams && teams.teams && teams.teams.length > 0) {
    teamId = teams.teams[0].id;
    props.setProperty('CLICKUP_TEAM_ID', String(teamId));
    console.log('Stored CLICKUP_TEAM_ID: ' + teamId);
    return teamId;
  }
  console.error('Could not fetch ClickUp team ID');
  return null;
}

/**
 * One-time sync: crawl ClickUp workspace and populate clickup_user_map sheet + CLICKUP_TEAM_ID.
 * Run this from the GAS editor after initial setup, or after adding new team members.
 * This is the ONLY function that does the expensive workspace crawl.
 */
function syncClickUpUserMap() {
  console.log('=== Syncing ClickUp User Map ===');

  // 1. Fetch team ID
  var teams = clickUpRequest('/team');
  if (!teams || !teams.teams || teams.teams.length === 0) {
    console.error('No ClickUp teams found');
    return;
  }
  var teamId = teams.teams[0].id;

  // Store team ID in Script Properties
  PropertiesService.getScriptProperties().setProperty('CLICKUP_TEAM_ID', String(teamId));
  console.log('Stored CLICKUP_TEAM_ID: ' + teamId);

  // 2. Fetch team members
  var team = clickUpRequest('/team/' + teamId);
  if (!team || !team.team || !team.team.members) {
    console.error('Failed to fetch team members');
    return;
  }

  var members = team.team.members;
  console.log('Found ' + members.length + ' ClickUp members');

  // 3. Write to clickup_user_map sheet
  var config = getConfig();
  var ss = SpreadsheetApp.openById(config._spreadsheetId || PropertiesService.getScriptProperties().getProperty('CONFIG_SHEET_ID'));
  var sheet = ss.getSheetByName('clickup_user_map');

  if (!sheet) {
    sheet = ss.insertSheet('clickup_user_map');
    sheet.appendRow(['google_email', 'clickup_user_id', 'clickup_username']);
    console.log('Created clickup_user_map sheet');
  }

  // Read existing mappings to preserve manual overrides
  var existingData = sheet.getDataRange().getValues();
  var existingMap = {};
  for (var i = 1; i < existingData.length; i++) {
    if (existingData[i][0]) {
      existingMap[existingData[i][0].toLowerCase()] = true;
    }
  }

  // Add new members that aren't already in the sheet
  var added = 0;
  for (var j = 0; j < members.length; j++) {
    var member = members[j];
    if (member.user && member.user.email) {
      var email = member.user.email.toLowerCase();
      if (!existingMap[email]) {
        sheet.appendRow([email, String(member.user.id), member.user.username || '']);
        added++;
        console.log('Added: ' + email + ' -> ' + member.user.id);
      } else {
        console.log('Skipped (already exists): ' + email);
      }
    }
  }

  console.log('=== Sync complete: ' + added + ' new members added, ' + (members.length - added) + ' already existed ===');

  // 4. Also rebuild the workspace cache while we're at it (for list name lookups)
  getWorkspaceStructure();
  console.log('Workspace structure cache refreshed');
}

/**
 * Get ClickUp user ID from Google email
 * FAST PATH: checks config sheet first (no API call)
 * Only falls back to workspace crawl if sheet has no mapping
 */
function getClickUpUserId(googleEmail) {
  // Fast path: check config sheet mapping first (no API call)
  var config = getConfig();
  var userMap = config.clickup_user_map || {};
  if (userMap[googleEmail]) {
    return userMap[googleEmail].clickup_user_id;
  }

  // Also try lowercase
  var emailLower = googleEmail.toLowerCase();
  if (userMap[emailLower]) {
    return userMap[emailLower].clickup_user_id;
  }

  // Slow fallback: check workspace structure (requires API crawl)
  console.warn('No sheet mapping for ' + googleEmail + ', falling back to workspace crawl');
  var structure = getWorkspaceStructure();
  if (structure && structure.members[emailLower]) {
    return structure.members[emailLower].id;
  }

  console.warn('No ClickUp user found for: ' + googleEmail);
  return null;
}

/**
 * Get tasks due for a user
 * @param {string} googleEmail - User's Google email
 * @param {string} dueBy - 'today' or 'week'
 * @returns {Array} Array of task objects
 */
function getTasksDueForUser(googleEmail, dueBy = 'today') {
  const clickUpUserId = getClickUpUserId(googleEmail);
  if (!clickUpUserId) {
    console.warn(`Cannot fetch tasks for ${googleEmail}: no ClickUp user ID`);
    return [];
  }

  const teamId = getTeamId();
  if (!teamId) return [];

  const now = new Date();
  const timezone = 'America/Chicago';

  let dueDateLt, dueDateGt;

  if (dueBy === 'today') {
    // End of today in Chicago timezone
    var tomorrowChicago = Utilities.formatDate(new Date(now.getTime() + 86400000), 'America/Chicago', 'yyyy-MM-dd');
    var chicagoHour = parseInt(Utilities.formatDate(now, 'America/Chicago', 'HH'));
    var utcHour = now.getUTCHours();
    var offsetHours = utcHour - chicagoHour;
    if (offsetHours < 0) offsetHours += 24;
    var endOfDayMs = new Date(tomorrowChicago + 'T00:00:00Z').getTime() + (offsetHours * 3600000);
    dueDateLt = endOfDayMs;
    dueDateGt = 0; // Include all overdue
  } else if (dueBy === 'week') {
    const friday = new Date(now);
    const daysUntilFriday = (5 - now.getDay() + 7) % 7;
    friday.setDate(now.getDate() + daysUntilFriday);
    friday.setHours(23, 59, 59, 999);
    dueDateLt = friday.getTime();
    dueDateGt = 0;
  }

  const endpoint = `/team/${teamId}/task?` +
    `assignees[]=${clickUpUserId}&` +
    `due_date_lt=${dueDateLt}&` +
    (dueDateGt > 0 ? `due_date_gt=${dueDateGt}&` : '') +
    `include_closed=true&` +
    `subtasks=true`;

  const result = clickUpRequest(endpoint);

  if (!result || !result.tasks) {
    console.warn(`No tasks returned for ${googleEmail}`);
    return [];
  }

  // Start of today for overdue calculation
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  // Filter: exclude tasks that were closed BEFORE today
  var filteredTasks = result.tasks.filter(function (task) {
    var statusType = task.status && task.status.type ? task.status.type : 'open';
    if (statusType !== 'closed') return true;
    if (task.date_closed) {
      var closedDate = new Date(parseInt(task.date_closed));
      return closedDate >= startOfToday;
    }
    return false;
  });

  // Try workspace cache for list context (fast if cached, skip if not)
  var listLookup = {};
  try {
    var cachedWs = CacheService.getScriptCache().get('clickup_workspace');
    if (cachedWs) {
      var ws = JSON.parse(cachedWs);
      if (ws.lists) {
        ws.lists.forEach(function (l) { listLookup[l.id] = l; });
      }
    }
  } catch (e) { /* skip enrichment if cache unavailable */ }

  // Enrich with list info and calculate overdue
  return filteredTasks.map(task => {
    const taskList = task.list || {};
    const list = taskList.id ? listLookup[taskList.id] : null;
    const dueDate = task.due_date ? new Date(parseInt(task.due_date)) : null;
    const isOverdue = dueDate && dueDate < startOfToday;
    const daysOverdue = isOverdue ? Math.floor((startOfToday - dueDate) / (1000 * 60 * 60 * 24)) : 0;

    return {
      id: task.id,
      name: task.name,
      description: task.description || '',
      status: task.status?.status || 'unknown',
      statusType: task.status?.type || 'open',
      dueDate: dueDate,
      dueDateStr: dueDate ? Utilities.formatDate(dueDate, timezone, 'EEE, MMM d') : null,
      listId: taskList.id || '',
      listName: list ? list.name : (taskList.name || 'Unknown'),
      folderName: list ? list.folder : null,
      spaceName: list ? list.space : null,
      url: task.url,
      isOverdue: isOverdue,
      daysOverdue: daysOverdue,
      priority: task.priority?.priority || null,
      timeEstimateMs: task.time_estimate || null,
      timeEstimateHrs: task.time_estimate ? Math.round(task.time_estimate / 3600000 * 10) / 10 : null
    };
  }).sort((a, b) => {
    if (a.isOverdue && !b.isOverdue) return -1;
    if (!a.isOverdue && b.isOverdue) return 1;
    if (a.isOverdue && b.isOverdue) return b.daysOverdue - a.daysOverdue;
    return (a.dueDate || new Date('2099-01-01')) - (b.dueDate || new Date('2099-01-01'));
  });
}

/**
 * Get statuses for a specific list.
 * Uses cached workspace if available, otherwise fetches just the list directly (fast).
 * Per-list statuses are also cached individually to avoid rate limits.
 */
function _getListStatuses(listId) {
  const cache = CacheService.getScriptCache();

  // Try cached workspace first (no API call)
  const cachedWorkspace = cache.get('clickup_workspace');
  if (cachedWorkspace) {
    try {
      const structure = JSON.parse(cachedWorkspace);
      if (structure.statuses && structure.statuses[listId]) {
        return structure.statuses[listId];
      }
    } catch (e) { /* fall through */ }
  }

  // Try per-list cache (no API call)
  const listCacheKey = 'clickup_list_statuses_' + listId;
  const cachedList = cache.get(listCacheKey);
  if (cachedList) {
    try {
      return JSON.parse(cachedList);
    } catch (e) { /* fall through */ }
  }

  // No cache — fetch just this list (1 API call, ~500ms)
  console.log('Fetching statuses for list ' + listId + ' directly (no full workspace crawl)');
  const listDetails = clickUpRequest('/list/' + listId);
  const statuses = (listDetails && listDetails.statuses) ? listDetails.statuses : [];

  // Cache per-list statuses for 1 hour
  try {
    cache.put(listCacheKey, JSON.stringify(statuses), 3600);
  } catch (e) {
    console.warn('Failed to cache list statuses:', e);
  }

  return statuses;
}

/**
 * Get closed status for a list
 */
function getClosedStatus(listId) {
  const statuses = _getListStatuses(listId);
  const closed = statuses.find(s => s.type === 'closed');
  return closed ? closed.status : 'complete';
}

/**
 * Get in-progress status for a list
 */
function getInProgressStatus(listId) {
  const statuses = _getListStatuses(listId);
  var inProgress = statuses.find(s =>
    s.status.toLowerCase().includes('progress') || s.status.toLowerCase().includes('working')
  );
  if (inProgress == undefined) inProgress = statuses.find(s => s.type === 'custom' && s.orderindex > 0);
  return inProgress ? inProgress.status : 'in progress';
}

/**
 * Update task status
 */
function updateTaskStatus(taskId, newStatus) {
  return clickUpRequest(`/task/${taskId}`, 'PUT', {
    status: newStatus
  });
}

/**
 * Update task due date
 */
function updateTaskDueDate(taskId, newDueDate) {
  return clickUpRequest(`/task/${taskId}`, 'PUT', {
    due_date: newDueDate.getTime(),
    due_date_time: false
  });
}

/**
 * Add comment to task
 */
function addTaskComment(taskId, comment) {
  return clickUpRequest(`/task/${taskId}/comment`, 'POST', {
    comment_text: comment
  });
}

/**
 * Mark task complete
 */
function markTaskComplete(taskId, listId, userName) {
  const closedStatus = getClosedStatus(listId);
  const result = updateTaskStatus(taskId, closedStatus);

  if (result) {
    const config = getConfig();
    if (config.clickup_config.add_comments !== false) {
      const timestamp = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd HH:mm:ss z');
      addTaskComment(taskId,
        `✅ Marked complete via Daily Check-in Bot\nBy: ${userName}\nDate: ${timestamp}`
      );
    }
  }

  return result;
}

/**
 * Move task to tomorrow
 */
function moveTaskToTomorrow(taskId, userName, reason) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(17, 0, 0, 0); // 5 PM tomorrow

  const result = updateTaskDueDate(taskId, tomorrow);

  if (result && userName) {
    const config = getConfig();
    if (config.clickup_config.add_comments !== false) {
      const timestamp = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd HH:mm:ss z');
      var comment = `➡️ Moved to tomorrow via Daily Check-in Bot\nBy: ${userName}\nDate: ${timestamp}`;
      if (reason) comment += `\nReason: ${reason}`;
      addTaskComment(taskId, comment);
    }
  }

  return result;
}

/**
 * Set task to in progress
 */
function setTaskInProgress(taskId, listId, userName) {
  const inProgressStatus = getInProgressStatus(listId);
  const result = updateTaskStatus(taskId, inProgressStatus);

  if (result && userName) {
    const config = getConfig();
    if (config.clickup_config.add_comments !== false) {
      const timestamp = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd HH:mm:ss z');
      addTaskComment(taskId,
        `🔄 Set to In Progress via Daily Check-in Bot\nBy: ${userName}\nDate: ${timestamp}`
      );
    }
  }

  return result;
}

/**
 * Get task by ID
 */
function getTaskById(taskId) {
  return clickUpRequest(`/task/${taskId}`);
}

/**
 * Get all overdue tasks for the team
 */
function getAllOverdueTasks() {
  const teamId = getTeamId();
  if (!teamId) return [];

  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const endpoint = `/team/${teamId}/task?` +
    `due_date_lt=${startOfToday.getTime()}&` +
    `include_closed=false&` +
    `subtasks=true`;

  const result = clickUpRequest(endpoint);

  if (!result || !result.tasks) return [];

  return result.tasks.map(task => {
    const dueDate = task.due_date ? new Date(parseInt(task.due_date)) : null;
    const daysOverdue = dueDate ? Math.floor((startOfToday - dueDate) / (1000 * 60 * 60 * 24)) : 0;

    // Find assignee email via reverse lookup from config sheet
    let assigneeEmail = null;
    if (task.assignees && task.assignees.length > 0) {
      const assignee = task.assignees[0];
      // Use assignee email from API response if available
      if (assignee.email) {
        assigneeEmail = assignee.email.toLowerCase();
      } else {
        // Reverse lookup from config sheet user map
        var cfgMap = getConfig().clickup_user_map || {};
        for (var mapEmail in cfgMap) {
          if (cfgMap[mapEmail].clickup_user_id === String(assignee.id)) {
            assigneeEmail = mapEmail;
            break;
          }
        }
      }
    }

    return {
      id: task.id,
      name: task.name,
      listId: task.list.id,
      listName: task.list.name,
      dueDate: dueDate,
      daysOverdue: daysOverdue,
      isChronic: daysOverdue >= 3,
      assigneeEmail: assigneeEmail,
      url: task.url
    };
  });
}

/**
 * Add time entry to a task
 * Uses clickup_user_map sheet to attribute time to the correct user when available.
 */
function addTimeEntry(taskId, durationMs, userName, userEmail) {
  var teamId = getTeamId();
  if (!teamId) return null;

  var now = Date.now();
  var payload = {
    tid: taskId,
    description: 'Logged via Daily Check-in Bot by ' + userName,
    duration: durationMs,
    start: now - durationMs,
    stop: now
  };

  // Attribute to the correct ClickUp user if mapping is available
  if (userEmail) {
    var clickUpUserId = getClickUpUserId(userEmail);
    if (clickUpUserId) {
      payload.assignee = parseInt(clickUpUserId, 10);
    }
  }

  return clickUpRequest('/team/' + teamId + '/time_entries', 'POST', payload);
}

/**
 * Get today's time entries for a user from ClickUp
 * Returns { totalHours, entries: [{ taskName, hours }] }
 */
function getTodayTimeEntries(googleEmail) {
  var teamId = getTeamId();
  if (!teamId) return null;

  var clickUpUserId = getClickUpUserId(googleEmail);
  if (!clickUpUserId) return null;

  var now = new Date();
  var startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  var endpoint = '/team/' + teamId + '/time_entries?' +
    'start_date=' + startOfDay.getTime() + '&' +
    'end_date=' + now.getTime() + '&' +
    'assignee=' + clickUpUserId;

  try {
    var result = clickUpRequest(endpoint);
    if (!result || !result.data) return { totalHours: 0, entries: [] };

    var entries = result.data.map(function (entry) {
      return {
        taskName: entry.task ? entry.task.name : 'Unknown',
        taskId: entry.task ? entry.task.id : null,
        hours: Math.round(parseInt(entry.duration) / 3600000 * 100) / 100,
        description: entry.description || ''
      };
    });

    var totalMs = result.data.reduce(function (sum, e) { return sum + parseInt(e.duration); }, 0);
    return {
      totalHours: Math.round(totalMs / 3600000 * 100) / 100,
      entries: entries
    };
  } catch (e) {
    console.error('getTodayTimeEntries failed for ' + googleEmail + ':', e.message);
    return null;
  }
}

/**
 * Get task delay count (how many times it's been moved)
 */
function getTaskDelayCount(taskId) {
  const projectId = getProjectId();

  const safeTaskId = sanitizeForBQ(taskId);
  const query = `
    SELECT COUNT(*) as count
    FROM \`${projectId}.checkin_bot.task_delays\`
    WHERE task_id = '${safeTaskId}'
  `;

  const result = runBigQueryQuery(query);
  return result.length > 0 ? parseInt(result[0].count) : 0;
}
