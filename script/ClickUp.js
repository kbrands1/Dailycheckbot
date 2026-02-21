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
function clickUpRequest(endpoint, method = 'GET', payload = null) {
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
      // Rate limited - wait and retry
      console.warn('ClickUp rate limited, waiting 60s...');
      Utilities.sleep(60000);
      return clickUpRequest(endpoint, method, payload);
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
 * Get ClickUp user ID from Google email
 */
function getClickUpUserId(googleEmail) {
  const structure = getWorkspaceStructure();
  if (!structure) return null;

  const emailLower = googleEmail.toLowerCase();

  // Try direct email match
  if (structure.members[emailLower]) {
    return structure.members[emailLower].id;
  }

  // Try config sheet mapping
  const config = getConfig();
  const userMap = config.clickup_user_map || {};
  if (userMap[googleEmail]) {
    return userMap[googleEmail].clickup_user_id;
  }

  console.warn(`No ClickUp user found for: ${googleEmail}`);
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

  const structure = getWorkspaceStructure();
  if (!structure) return [];

  const now = new Date();
  const timezone = 'America/Chicago';

  let dueDateLt, dueDateGt;

  if (dueBy === 'today') {
    // End of today
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    dueDateLt = endOfDay.getTime();
    dueDateGt = 0; // Include all overdue
  } else if (dueBy === 'week') {
    // End of Friday
    const friday = new Date(now);
    const daysUntilFriday = (5 - now.getDay() + 7) % 7;
    friday.setDate(now.getDate() + daysUntilFriday);
    friday.setHours(23, 59, 59, 999);
    dueDateLt = friday.getTime();

    // BUG #10 fix: Include ALL overdue tasks (not just from this week)
    // so Monday preview shows tasks overdue from previous weeks
    dueDateGt = 0;
  }

  const endpoint = `/team/${structure.teamId}/task?` +
    `assignees[]=${clickUpUserId}&` +
    `due_date_lt=${dueDateLt}&` +
    (dueDateGt > 0 ? `due_date_gt=${dueDateGt}&` : '') +
    `include_closed=false&` +
    `subtasks=false`;

  const result = clickUpRequest(endpoint);

  if (!result || !result.tasks) {
    console.warn(`No tasks returned for ${googleEmail}`);
    return [];
  }

  // Start of today for overdue calculation
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  // Enrich with list info and calculate overdue
  return result.tasks.map(task => {
    const list = structure.lists.find(l => l.id === task.list.id);
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
      listId: task.list.id,
      listName: list ? list.name : task.list.name,
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
    // Sort: overdue first (by days), then by due date
    if (a.isOverdue && !b.isOverdue) return -1;
    if (!a.isOverdue && b.isOverdue) return 1;
    if (a.isOverdue && b.isOverdue) return b.daysOverdue - a.daysOverdue;
    return (a.dueDate || new Date('2099-01-01')) - (b.dueDate || new Date('2099-01-01'));
  });
}

/**
 * Get statuses for a specific list.
 * Uses cached workspace if available, otherwise fetches just the list directly (fast).
 */
function _getListStatuses(listId) {
  // Try cached workspace first (no API call)
  const cache = CacheService.getScriptCache();
  const cached = cache.get('clickup_workspace');
  if (cached) {
    try {
      const structure = JSON.parse(cached);
      if (structure.statuses && structure.statuses[listId]) {
        return structure.statuses[listId];
      }
    } catch (e) { /* fall through */ }
  }

  // No cache or list not found — fetch just this list (1 API call, ~500ms)
  console.log('Fetching statuses for list ' + listId + ' directly (no full workspace crawl)');
  const listDetails = clickUpRequest('/list/' + listId);
  return (listDetails && listDetails.statuses) ? listDetails.statuses : [];
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
function moveTaskToTomorrow(taskId) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(17, 0, 0, 0); // 5 PM tomorrow

  return updateTaskDueDate(taskId, tomorrow);
}

/**
 * Set task to in progress
 */
function setTaskInProgress(taskId, listId) {
  const inProgressStatus = getInProgressStatus(listId);
  return updateTaskStatus(taskId, inProgressStatus);
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
  const structure = getWorkspaceStructure();
  if (!structure) return [];

  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const endpoint = `/team/${structure.teamId}/task?` +
    `due_date_lt=${startOfToday.getTime()}&` +
    `include_closed=false&` +
    `subtasks=false`;

  const result = clickUpRequest(endpoint);

  if (!result || !result.tasks) return [];

  return result.tasks.map(task => {
    const dueDate = task.due_date ? new Date(parseInt(task.due_date)) : null;
    const daysOverdue = dueDate ? Math.floor((startOfToday - dueDate) / (1000 * 60 * 60 * 24)) : 0;

    // Find assignee email
    let assigneeEmail = null;
    if (task.assignees && task.assignees.length > 0) {
      const assignee = task.assignees[0];
      // Reverse lookup from structure.members
      for (const [email, member] of Object.entries(structure.members)) {
        if (member.id === assignee.id) {
          assigneeEmail = email;
          break;
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
