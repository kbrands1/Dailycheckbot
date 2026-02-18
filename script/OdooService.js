/**
 * OdooService.gs - Odoo 18 Task Integration
 *
 * Connects to Odoo via JSON-RPC to fetch project tasks
 * for the daily check-in bot.
 *
 * Odoo Instance: https://k-brands.odoo.com
 * Database: k-brands
 *
 * Required Script Properties:
 *   - ODOO_API_KEY
 *   - ODOO_DB (database name - find via database selector or admin)
 *
 * ============================================
 * SETUP INSTRUCTIONS:
 * ============================================
 *
 * 1. Find your Odoo Database Name:
 *    - Go to https://k-brands.odoo.com/web/database/selector
 *    - Or check with your Odoo administrator
 *    - Common patterns: subdomain, subdomain-main, subdomain-production
 *
 * 2. Generate Odoo API Key:
 *    - Log into https://k-brands.odoo.com as tools@k-brands.com
 *    - Go to user profile (top right) → Preferences
 *    - Account Security tab → Developer API Keys
 *    - Click "New API Key", name it "Check-in Bot"
 *    - Copy the key immediately (shown only once)
 *
 * 3. Add Script Properties:
 *    - In Apps Script, go to Project Settings (gear icon)
 *    - Scroll to Script Properties
 *    - Add: ODOO_API_KEY = [your key]
 *    - Add: ODOO_DB = [your database name]
 *
 * 4. Test the connection:
 *    - Run testOdooConnection() function
 *    - Check logs for success message
 *
 * 5. Verify task access:
 *    - Run testGetTasks() to see sample tasks
 *    - Run testGetUserTasks() with a real email
 *
 * ============================================
 * API DOCUMENTATION REFERENCES:
 * ============================================
 * - Odoo 18 External API: https://www.odoo.com/documentation/18.0/developer/reference/external_api.html
 * - JSON-RPC Guide: https://www.cybrosys.com/odoo/odoo-books/odoo-16-development/rpc/json-rpc/
 * - API Key Auth: https://www.odoo.com/forum/help-1/odoo-17-json-rpc-and-api-key-263158
 */

// ===========================================
// CONFIGURATION
// ===========================================

const ODOO_URL = 'https://k-brands.odoo.com';
const ODOO_USERNAME = 'tools@k-brands.com';
const ODOO_JSONRPC_ENDPOINT = ODOO_URL + '/jsonrpc';

// Cache keys
const ODOO_UID_CACHE_KEY = 'odoo_uid';
const ODOO_CACHE_DURATION = 1800; // 30 minutes in seconds

// ===========================================
// CORE API METHODS
// ===========================================

/**
 * Get Odoo database name from Script Properties
 * @returns {string|null} - Database name or null if not found
 */
function getOdooDatabase() {
  const props = PropertiesService.getScriptProperties();
  const db = props.getProperty('ODOO_DB');

  if (!db) {
    console.error('ODOO_DB not found in Script Properties. Please add your Odoo database name.');
    console.error('To find your database name, go to: https://k-brands.odoo.com/web/database/selector');
    return null;
  }

  return db;
}

/**
 * Get API key from Script Properties
 * @returns {string|null} - API key or null if not found
 */
function getOdooApiKey() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('ODOO_API_KEY');

  if (!apiKey) {
    console.error('ODOO_API_KEY not found in Script Properties');
    return null;
  }

  return apiKey;
}

/**
 * Authenticate with Odoo and get user ID (uid)
 * Uses JSON-RPC call to /jsonrpc with common service
 * @returns {number|null} - Odoo user ID or null on failure
 */
function odooAuthenticate() {
  console.log('Authenticating with Odoo...');

  const apiKey = getOdooApiKey();
  const db = getOdooDatabase();

  if (!apiKey || !db) {
    return null;
  }

  try {
    const result = odooJsonRpc('common', 'login', [db, ODOO_USERNAME, apiKey]);

    if (result && typeof result === 'number') {
      console.log('Successfully authenticated with Odoo. UID:', result);
      return result;
    } else {
      console.error('Authentication failed. Response:', result);
      return null;
    }
  } catch (error) {
    console.error('Odoo authentication error:', error.message);
    return null;
  }
}

/**
 * Generic JSON-RPC call to Odoo
 * @param {string} service - 'common' or 'object'
 * @param {string} method - RPC method name
 * @param {Array} args - Method arguments
 * @returns {*} - Response from Odoo or null on error
 */
function odooJsonRpc(service, method, args) {
  const payload = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: service,
      method: method,
      args: args
    },
    id: Math.floor(Math.random() * 1000000000)
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    timeout: 30000 // 30 second timeout
  };

  try {
    console.log(`Odoo RPC: ${service}.${method}`);
    const response = UrlFetchApp.fetch(ODOO_JSONRPC_ENDPOINT, options);
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();

    if (responseCode !== 200) {
      console.error(`Odoo HTTP error ${responseCode}:`, responseText);
      return null;
    }

    const jsonResponse = JSON.parse(responseText);

    if (jsonResponse.error) {
      console.error('Odoo RPC error:', JSON.stringify(jsonResponse.error));
      return null;
    }

    return jsonResponse.result;

  } catch (error) {
    console.error('Odoo RPC request failed:', error.message);
    return null;
  }
}

/**
 * Execute Odoo model method (search_read, create, write, etc.)
 * @param {string} model - Odoo model name (e.g., 'project.task')
 * @param {string} method - Method name (e.g., 'search_read')
 * @param {Array} args - Positional arguments (domain, etc.)
 * @param {Object} kwargs - Keyword arguments (fields, limit, etc.)
 * @returns {*} - Result from Odoo or null on error
 */
function odooExecute(model, method, args = [], kwargs = {}) {
  const uid = getCachedUid();
  if (!uid) {
    console.error('Cannot execute: No valid Odoo UID');
    return null;
  }

  const apiKey = getOdooApiKey();
  const db = getOdooDatabase();

  if (!apiKey || !db) {
    return null;
  }

  // execute_kw signature: [db, uid, password, model, method, args, kwargs]
  const executeArgs = [db, uid, apiKey, model, method, args, kwargs];

  console.log(`Odoo execute: ${model}.${method}`);
  return odooJsonRpc('object', 'execute_kw', executeArgs);
}

// ===========================================
// CACHING
// ===========================================

/**
 * Get cached Odoo UID or authenticate and cache
 * @returns {number|null} - User ID or null
 */
function getCachedUid() {
  const cache = CacheService.getScriptCache();
  const cachedUid = cache.get(ODOO_UID_CACHE_KEY);

  if (cachedUid) {
    return parseInt(cachedUid, 10);
  }

  // Not cached, authenticate
  const uid = odooAuthenticate();

  if (uid) {
    cache.put(ODOO_UID_CACHE_KEY, uid.toString(), ODOO_CACHE_DURATION);
  }

  return uid;
}

/**
 * Clear Odoo cache (UID and any other cached data)
 */
function clearOdooCache() {
  const cache = CacheService.getScriptCache();
  cache.remove(ODOO_UID_CACHE_KEY);
  console.log('Odoo cache cleared');
}

// ===========================================
// USER METHODS
// ===========================================

/**
 * Get Odoo user ID from email address
 * @param {string} email - User's email
 * @returns {number|null} - Odoo user ID or null if not found
 */
function getOdooUserIdByEmail(email) {
  if (!email) {
    console.error('getOdooUserIdByEmail: No email provided');
    return null;
  }

  console.log('Looking up Odoo user by email:', email);

  // Search res.users by login (email) field
  const result = odooExecute(
    'res.users',
    'search_read',
    [[['login', '=', email]]],
    { fields: ['id', 'name', 'login'], limit: 1 }
  );

  if (result && result.length > 0) {
    console.log('Found Odoo user:', result[0].name, 'ID:', result[0].id);
    return result[0].id;
  }

  console.log('No Odoo user found for email:', email);
  return null;
}

/**
 * Get all Odoo users (for mapping purposes)
 * @returns {Array} - Array of user objects {id, name, login}
 */
function getAllOdooUsers() {
  const result = odooExecute(
    'res.users',
    'search_read',
    [[['active', '=', true]]],
    { fields: ['id', 'name', 'login'] }
  );

  return result || [];
}

// ===========================================
// TASK-SPECIFIC METHODS
// ===========================================

/**
 * Get all tasks assigned to a user
 * @param {string} email - User's email address
 * @param {Object} options - Optional filters
 * @param {boolean} options.includeCompleted - Include done tasks (default: false)
 * @param {number} options.projectId - Filter by project ID
 * @param {number} options.limit - Max tasks to return (default: 100)
 * @returns {Array} - Array of task objects
 */
function getTasksByUserEmail(email, options = {}) {
  const userId = getOdooUserIdByEmail(email);
  if (!userId) {
    console.log('Cannot get tasks: User not found for email:', email);
    return [];
  }

  return getTasksByUserId(userId, options);
}

/**
 * Get all tasks assigned to a user by Odoo user ID
 * @param {number} userId - Odoo user ID
 * @param {Object} options - Optional filters
 * @returns {Array} - Array of task objects
 */
function getTasksByUserId(userId, options = {}) {
  const includeCompleted = options.includeCompleted || false;
  const projectId = options.projectId || null;
  const limit = options.limit || 100;

  // Build domain filter
  // user_ids is a many2many field, use 'in' operator
  const domain = [['user_ids', 'in', [userId]]];

  // Filter by project if specified
  if (projectId) {
    domain.push(['project_id', '=', projectId]);
  }

  // Exclude completed tasks unless specified
  // In Odoo, completed tasks are typically in stages marked as 'fold' or specific stage names
  // We'll filter by checking if the task has a date_deadline or is active
  if (!includeCompleted) {
    domain.push(['active', '=', true]);
  }

  console.log('Fetching tasks for user ID:', userId, 'Domain:', JSON.stringify(domain));

  const result = odooExecute(
    'project.task',
    'search_read',
    [domain],
    {
      fields: [
        'id',
        'name',
        'user_ids',
        'date_deadline',
        'stage_id',
        'project_id',
        'priority',
        'tag_ids',
        'description',
        'create_date',
        'write_date',
        'date_last_stage_update'
      ],
      limit: limit,
      order: 'date_deadline asc, priority desc'
    }
  );

  if (!result) {
    console.log('No tasks returned from Odoo');
    return [];
  }

  console.log(`Found ${result.length} tasks for user ID ${userId}`);
  return result;
}

/**
 * Get tasks due today for a user
 * @param {string} email - User's email
 * @returns {Array} - Tasks due today
 */
function getTodaysTasks(email) {
  const userId = getOdooUserIdByEmail(email);
  if (!userId) {
    return [];
  }

  const today = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');

  const domain = [
    ['user_ids', 'in', [userId]],
    ['date_deadline', '=', today],
    ['active', '=', true]
  ];

  console.log('Fetching today\'s tasks for:', email, 'Date:', today);

  const result = odooExecute(
    'project.task',
    'search_read',
    [domain],
    {
      fields: [
        'id', 'name', 'date_deadline', 'stage_id', 'project_id', 'priority'
      ],
      order: 'priority desc, name asc'
    }
  );

  return result || [];
}

/**
 * Get overdue tasks for a user
 * @param {string} email - User's email
 * @returns {Array} - Overdue tasks
 */
function getOverdueTasks(email) {
  const userId = getOdooUserIdByEmail(email);
  if (!userId) {
    return [];
  }

  const today = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');

  const domain = [
    ['user_ids', 'in', [userId]],
    ['date_deadline', '<', today],
    ['date_deadline', '!=', false],
    ['active', '=', true]
  ];

  console.log('Fetching overdue tasks for:', email);

  const result = odooExecute(
    'project.task',
    'search_read',
    [domain],
    {
      fields: [
        'id', 'name', 'date_deadline', 'stage_id', 'project_id', 'priority'
      ],
      order: 'date_deadline asc'
    }
  );

  return result || [];
}

/**
 * Get upcoming tasks for a user (next 7 days)
 * @param {string} email - User's email
 * @param {number} days - Number of days ahead (default: 7)
 * @returns {Array} - Upcoming tasks
 */
function getUpcomingTasks(email, days = 7) {
  const userId = getOdooUserIdByEmail(email);
  if (!userId) {
    return [];
  }

  const today = new Date();
  const futureDate = new Date(today);
  futureDate.setDate(today.getDate() + days);

  const todayStr = Utilities.formatDate(today, 'America/Chicago', 'yyyy-MM-dd');
  const futureDateStr = Utilities.formatDate(futureDate, 'America/Chicago', 'yyyy-MM-dd');

  const domain = [
    ['user_ids', 'in', [userId]],
    ['date_deadline', '>', todayStr],
    ['date_deadline', '<=', futureDateStr],
    ['active', '=', true]
  ];

  console.log('Fetching upcoming tasks for:', email, 'Until:', futureDateStr);

  const result = odooExecute(
    'project.task',
    'search_read',
    [domain],
    {
      fields: [
        'id', 'name', 'date_deadline', 'stage_id', 'project_id', 'priority'
      ],
      order: 'date_deadline asc'
    }
  );

  return result || [];
}

// ===========================================
// PROJECT/DEPARTMENT METHODS
// ===========================================

/**
 * Get project ID by name
 * @param {string} projectName - Project name
 * @returns {number|null} - Project ID or null
 */
function getProjectIdByName(projectName) {
  const result = odooExecute(
    'project.project',
    'search_read',
    [[['name', 'ilike', projectName]]],
    { fields: ['id', 'name'], limit: 1 }
  );

  if (result && result.length > 0) {
    console.log('Found project:', result[0].name, 'ID:', result[0].id);
    return result[0].id;
  }

  console.log('Project not found:', projectName);
  return null;
}

/**
 * Get all projects
 * @returns {Array} - Array of project objects
 */
function getAllProjects() {
  const result = odooExecute(
    'project.project',
    'search_read',
    [[['active', '=', true]]],
    { fields: ['id', 'name', 'user_id', 'partner_id'] }
  );

  return result || [];
}

/**
 * Get tasks by project name
 * @param {string} projectName - Project name (e.g., 'Finance', 'Supply Chain')
 * @param {Object} options - Optional filters
 * @returns {Array} - Tasks in that project
 */
function getTasksByProject(projectName, options = {}) {
  const projectId = getProjectIdByName(projectName);
  if (!projectId) {
    return [];
  }

  const includeCompleted = options.includeCompleted || false;
  const limit = options.limit || 100;

  const domain = [['project_id', '=', projectId]];

  if (!includeCompleted) {
    domain.push(['active', '=', true]);
  }

  console.log('Fetching tasks for project:', projectName);

  const result = odooExecute(
    'project.task',
    'search_read',
    [domain],
    {
      fields: [
        'id', 'name', 'user_ids', 'date_deadline', 'stage_id',
        'project_id', 'priority', 'create_date'
      ],
      limit: limit,
      order: 'date_deadline asc, priority desc'
    }
  );

  return result || [];
}

/**
 * Get all active tasks for finance team
 * @returns {Array} - Finance project tasks
 */
function getFinanceTasks() {
  // Try common finance project names
  const financeNames = ['Finance', 'Accounting', 'Finance Team'];

  for (const name of financeNames) {
    const tasks = getTasksByProject(name);
    if (tasks.length > 0) {
      return tasks;
    }
  }

  console.log('No Finance project found');
  return [];
}

/**
 * Get all active tasks for supply chain team
 * @returns {Array} - Supply chain project tasks
 */
function getSupplyChainTasks() {
  // Try common supply chain project names
  const scNames = ['Supply Chain', 'Logistics', 'Procurement', 'Inventory'];

  for (const name of scNames) {
    const tasks = getTasksByProject(name);
    if (tasks.length > 0) {
      return tasks;
    }
  }

  console.log('No Supply Chain project found');
  return [];
}

// ===========================================
// TASK STATUS UPDATES
// ===========================================

/**
 * Get all task stages for a project
 * @param {number} projectId - Project ID
 * @returns {Array} - Array of stage objects
 */
function getTaskStages(projectId) {
  const domain = projectId
    ? [['project_ids', 'in', [projectId]]]
    : [];

  const result = odooExecute(
    'project.task.type',
    'search_read',
    [domain],
    { fields: ['id', 'name', 'fold', 'sequence'] }
  );

  return result || [];
}

/**
 * Update task stage
 * @param {number} taskId - Task ID
 * @param {number} stageId - New stage ID
 * @returns {boolean} - Success status
 */
function updateTaskStage(taskId, stageId) {
  console.log('Updating task', taskId, 'to stage', stageId);

  const result = odooExecute(
    'project.task',
    'write',
    [[taskId], { stage_id: stageId }]
  );

  return result === true;
}

/**
 * Update task deadline
 * @param {number} taskId - Task ID
 * @param {string} newDeadline - New deadline in 'yyyy-MM-dd' format
 * @returns {boolean} - Success status
 */
function updateTaskDeadline(taskId, newDeadline) {
  console.log('Updating task', taskId, 'deadline to', newDeadline);

  const result = odooExecute(
    'project.task',
    'write',
    [[taskId], { date_deadline: newDeadline }]
  );

  return result === true;
}

// ===========================================
// FORMATTING METHODS
// ===========================================

/**
 * Format task for display in Google Chat message
 * @param {Object} task - Odoo task object
 * @returns {string} - Formatted string for chat
 */
function formatTaskForChat(task) {
  const priorityIcons = {
    '0': '',
    '1': '!',
    '2': '!!',
    false: ''
  };

  const priority = priorityIcons[task.priority] || '';
  const priorityPrefix = priority ? `[${priority}] ` : '';

  // Format deadline
  let deadlineStr = '';
  if (task.date_deadline) {
    const deadline = new Date(task.date_deadline);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (deadline < today) {
      deadlineStr = ` (OVERDUE: ${task.date_deadline})`;
    } else if (deadline.getTime() === today.getTime()) {
      deadlineStr = ' (Due: Today)';
    } else {
      deadlineStr = ` (Due: ${task.date_deadline})`;
    }
  }

  // Get stage name (stage_id is a tuple [id, name])
  const stageName = task.stage_id ? task.stage_id[1] : 'No Stage';

  // Get project name (project_id is a tuple [id, name])
  const projectName = task.project_id ? task.project_id[1] : '';
  const projectStr = projectName ? ` [${projectName}]` : '';

  return `${priorityPrefix}${task.name}${deadlineStr} - ${stageName}${projectStr}`;
}

/**
 * Format multiple tasks as a bulleted list for chat
 * @param {Array} tasks - Array of tasks
 * @param {Object} options - Formatting options
 * @param {boolean} options.groupByProject - Group tasks by project
 * @param {number} options.maxTasks - Max tasks to show
 * @returns {string} - Formatted task list
 */
function formatTaskListForChat(tasks, options = {}) {
  if (!tasks || tasks.length === 0) {
    return 'No tasks found.';
  }

  const groupByProject = options.groupByProject || false;
  const maxTasks = options.maxTasks || 20;

  // Limit tasks
  const displayTasks = tasks.slice(0, maxTasks);
  const hasMore = tasks.length > maxTasks;

  if (groupByProject) {
    // Group by project
    const projectGroups = {};

    for (const task of displayTasks) {
      const projectName = task.project_id ? task.project_id[1] : 'No Project';
      if (!projectGroups[projectName]) {
        projectGroups[projectName] = [];
      }
      projectGroups[projectName].push(task);
    }

    let result = '';
    for (const [project, projectTasks] of Object.entries(projectGroups)) {
      result += `*${project}:*\n`;
      for (const task of projectTasks) {
        result += `  • ${formatTaskForChat(task)}\n`;
      }
    }

    if (hasMore) {
      result += `\n_...and ${tasks.length - maxTasks} more tasks_`;
    }

    return result.trim();
  } else {
    // Simple bulleted list
    let result = '';
    for (const task of displayTasks) {
      result += `• ${formatTaskForChat(task)}\n`;
    }

    if (hasMore) {
      result += `_...and ${tasks.length - maxTasks} more tasks_`;
    }

    return result.trim();
  }
}

/**
 * Get task summary for a user (for check-in message)
 * @param {string} email - User's email
 * @returns {Object} - Summary object with counts and formatted text
 */
function getOdooTaskSummary(email) {
  const todayTasks = getTodaysTasks(email);
  const overdueTasks = getOverdueTasks(email);
  const upcomingTasks = getUpcomingTasks(email, 7);

  const summary = {
    todayCount: todayTasks.length,
    overdueCount: overdueTasks.length,
    upcomingCount: upcomingTasks.length,
    todayTasks: todayTasks,
    overdueTasks: overdueTasks,
    upcomingTasks: upcomingTasks,
    formattedText: ''
  };

  // Build formatted text
  let text = '';

  if (overdueTasks.length > 0) {
    text += `*OVERDUE (${overdueTasks.length}):*\n`;
    text += formatTaskListForChat(overdueTasks, { maxTasks: 5 });
    text += '\n\n';
  }

  if (todayTasks.length > 0) {
    text += `*Due Today (${todayTasks.length}):*\n`;
    text += formatTaskListForChat(todayTasks, { maxTasks: 10 });
    text += '\n\n';
  }

  if (upcomingTasks.length > 0) {
    text += `*Upcoming (${upcomingTasks.length}):*\n`;
    text += formatTaskListForChat(upcomingTasks, { maxTasks: 5 });
  }

  if (!text) {
    text = 'No Odoo tasks found.';
  }

  summary.formattedText = text.trim();
  return summary;
}

// ===========================================
// TASK NORMALIZATION
// ===========================================

/**
 * Normalize an Odoo task to match the ClickUp task shape
 * so the rest of the bot can handle both identically.
 * @param {Object} task - Raw Odoo task from search_read
 * @returns {Object} - Normalized task matching ClickUp shape
 */
function normalizeOdooTask(task) {
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var dueDate = task.date_deadline ? new Date(task.date_deadline + 'T00:00:00') : null;
  var isOverdue = dueDate && dueDate < today;
  var daysOverdue = isOverdue ? Math.floor((today - dueDate) / (1000 * 60 * 60 * 24)) : 0;

  return {
    id: String(task.id),
    name: task.name,
    description: task.description || '',
    status: task.stage_id ? task.stage_id[1] : 'unknown',
    statusType: 'open',
    dueDate: dueDate,
    dueDateStr: dueDate ? Utilities.formatDate(dueDate, 'America/Chicago', 'EEE, MMM d') : null,
    listId: task.project_id ? String(task.project_id[0]) : '',
    listName: task.project_id ? task.project_id[1] : 'No Project',
    folderName: null,
    spaceName: null,
    url: ODOO_URL + '/web#id=' + task.id + '&model=project.task&view_type=form',
    isOverdue: isOverdue,
    daysOverdue: daysOverdue,
    priority: task.priority === '2' ? 'urgent' : (task.priority === '1' ? 'high' : null),
    timeEstimateMs: null,
    timeEstimateHrs: null,
    source: 'odoo',
    odooStageId: task.stage_id ? task.stage_id[0] : null,
    odooProjectId: task.project_id ? task.project_id[0] : null
  };
}

/**
 * Normalize an array of Odoo tasks and sort by overdue-first, then due date
 * @param {Array} tasks - Raw Odoo tasks
 * @returns {Array} - Sorted normalized tasks
 */
function normalizeOdooTasks(tasks) {
  return (tasks || []).map(normalizeOdooTask).sort(function(a, b) {
    if (a.isOverdue && !b.isOverdue) return -1;
    if (!a.isOverdue && b.isOverdue) return 1;
    if (a.isOverdue && b.isOverdue) return b.daysOverdue - a.daysOverdue;
    if (a.dueDate && b.dueDate) return a.dueDate - b.dueDate;
    return 0;
  });
}

// ===========================================
// INTEGRATION HELPERS
// ===========================================

/**
 * Get tasks for a user, combining with any configured source
 * This is the main method to call from the check-in bot
 * @param {string} email - User's email
 * @param {string} period - 'today', 'overdue', 'week', or 'all'
 * @returns {Array} - Array of task objects
 */
function getOdooTasksForUser(email, period = 'today') {
  switch (period) {
    case 'today':
      return getTodaysTasks(email);
    case 'overdue':
      return getOverdueTasks(email);
    case 'week':
      return getUpcomingTasks(email, 7);
    case 'all':
      return getTasksByUserEmail(email);
    default:
      return getTodaysTasks(email);
  }
}

// ===========================================
// TEST FUNCTIONS
// ===========================================

/**
 * Test Odoo connection and authentication
 * Run this first to verify setup
 */
function testOdooConnection() {
  console.log('=== Testing Odoo Connection ===');
  console.log('URL:', ODOO_URL);
  console.log('Username:', ODOO_USERNAME);

  // Clear cache to force fresh auth
  clearOdooCache();

  const db = getOdooDatabase();
  if (!db) {
    console.error('FAILED: No database name found in Script Properties');
    console.log('Please add ODOO_DB to Script Properties');
    console.log('To find your database name, try: https://k-brands.odoo.com/web/database/selector');
    return false;
  }
  console.log('Database:', db);

  const apiKey = getOdooApiKey();
  if (!apiKey) {
    console.error('FAILED: No API key found in Script Properties');
    console.log('Please add ODOO_API_KEY to Script Properties');
    return false;
  }
  console.log('API Key found (first 10 chars):', apiKey.substring(0, 10) + '...');

  const uid = odooAuthenticate();

  if (uid) {
    console.log('SUCCESS: Authenticated with Odoo');
    console.log('User ID (UID):', uid);
    return true;
  } else {
    console.error('FAILED: Could not authenticate with Odoo');
    return false;
  }
}

/**
 * Test fetching tasks - get a sample of all tasks
 */
function testGetTasks() {
  console.log('=== Testing Get Tasks ===');

  const result = odooExecute(
    'project.task',
    'search_read',
    [[['active', '=', true]]],
    {
      fields: ['id', 'name', 'user_ids', 'date_deadline', 'stage_id', 'project_id', 'priority'],
      limit: 10
    }
  );

  if (result && result.length > 0) {
    console.log('SUCCESS: Found', result.length, 'tasks');
    console.log('Sample tasks:');
    for (const task of result) {
      console.log(`  - [${task.id}] ${task.name}`);
      console.log(`    Project: ${task.project_id ? task.project_id[1] : 'None'}`);
      console.log(`    Stage: ${task.stage_id ? task.stage_id[1] : 'None'}`);
      console.log(`    Deadline: ${task.date_deadline || 'No deadline'}`);
      console.log(`    Assigned to: ${task.user_ids ? task.user_ids.length : 0} user(s)`);
    }
    return result;
  } else {
    console.log('No tasks found or error occurred');
    return [];
  }
}

/**
 * Test getting tasks for a specific user
 * Update the email to test with a real user
 */
function testGetUserTasks() {
  console.log('=== Testing Get User Tasks ===');

  // Test with the API user first
  const testEmail = ODOO_USERNAME;
  console.log('Testing with email:', testEmail);

  // First, verify the user exists
  const userId = getOdooUserIdByEmail(testEmail);
  if (!userId) {
    console.log('User not found:', testEmail);
    console.log('Trying to list all users...');

    const users = getAllOdooUsers();
    console.log('Found', users.length, 'users:');
    for (const user of users.slice(0, 10)) {
      console.log(`  - ${user.login} (ID: ${user.id})`);
    }
    return;
  }

  console.log('User ID:', userId);

  // Get tasks
  const tasks = getTasksByUserEmail(testEmail);
  console.log('Found', tasks.length, 'tasks for user');

  if (tasks.length > 0) {
    console.log('Tasks:');
    for (const task of tasks.slice(0, 5)) {
      console.log('  -', formatTaskForChat(task));
    }
  }

  // Get today's tasks
  const todayTasks = getTodaysTasks(testEmail);
  console.log('Today\'s tasks:', todayTasks.length);

  // Get overdue tasks
  const overdueTasks = getOverdueTasks(testEmail);
  console.log('Overdue tasks:', overdueTasks.length);

  return tasks;
}

/**
 * Test getting finance and supply chain tasks
 */
function testGetDepartmentTasks() {
  console.log('=== Testing Department Tasks ===');

  // List all projects first
  console.log('Listing all projects...');
  const projects = getAllProjects();
  console.log('Found', projects.length, 'projects:');
  for (const project of projects) {
    console.log(`  - ${project.name} (ID: ${project.id})`);
  }

  // Test Finance
  console.log('\nFetching Finance tasks...');
  const financeTasks = getFinanceTasks();
  console.log('Finance tasks:', financeTasks.length);
  if (financeTasks.length > 0) {
    console.log('Sample:', formatTaskForChat(financeTasks[0]));
  }

  // Test Supply Chain
  console.log('\nFetching Supply Chain tasks...');
  const scTasks = getSupplyChainTasks();
  console.log('Supply Chain tasks:', scTasks.length);
  if (scTasks.length > 0) {
    console.log('Sample:', formatTaskForChat(scTasks[0]));
  }

  return { finance: financeTasks, supplyChain: scTasks };
}

/**
 * Test the task summary function
 */
function testTaskSummary() {
  console.log('=== Testing Task Summary ===');

  const testEmail = ODOO_USERNAME;
  console.log('Getting task summary for:', testEmail);

  const summary = getOdooTaskSummary(testEmail);

  console.log('Summary:');
  console.log('  Today:', summary.todayCount);
  console.log('  Overdue:', summary.overdueCount);
  console.log('  Upcoming:', summary.upcomingCount);
  console.log('\nFormatted text:');
  console.log(summary.formattedText);

  return summary;
}

/**
 * Test task stages
 */
function testTaskStages() {
  console.log('=== Testing Task Stages ===');

  const stages = getTaskStages();
  console.log('Found', stages.length, 'stages:');
  for (const stage of stages) {
    console.log(`  - ${stage.name} (ID: ${stage.id}, Fold: ${stage.fold})`);
  }

  return stages;
}

// ===========================================
// DATABASE DISCOVERY
// ===========================================

/**
 * Discover available Odoo databases
 * This function tries multiple methods to find the database name
 * Run this if you don't know your Odoo database name
 */
function discoverOdooDatabases() {
  console.log('=== Discovering Odoo Databases ===');
  console.log('URL:', ODOO_URL);

  const results = {
    dbListMethod: [],
    versionInfo: null,
    serverInfo: null,
    suggestions: []
  };

  // Method 1: Try the db.list JSON-RPC call
  console.log('\n--- Method 1: db.list JSON-RPC ---');
  try {
    const dbListPayload = {
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service: 'db',
        method: 'list',
        args: []
      },
      id: Math.floor(Math.random() * 1000000000)
    };

    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(dbListPayload),
      muteHttpExceptions: true,
      timeout: 30000
    };

    const response = UrlFetchApp.fetch(ODOO_JSONRPC_ENDPOINT, options);
    const responseText = response.getContentText();
    console.log('db.list response:', responseText);

    const jsonResponse = JSON.parse(responseText);

    if (jsonResponse.result && Array.isArray(jsonResponse.result)) {
      results.dbListMethod = jsonResponse.result;
      console.log('SUCCESS! Found databases:', jsonResponse.result.join(', '));
    } else if (jsonResponse.error) {
      console.log('db.list blocked or error:', jsonResponse.error.message || JSON.stringify(jsonResponse.error));
      // This is common - Odoo often disables db listing for security
    }
  } catch (error) {
    console.log('db.list method failed:', error.message);
  }

  // Method 2: Try common/version to at least verify server is reachable
  console.log('\n--- Method 2: Server Version Check ---');
  try {
    const versionPayload = {
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service: 'common',
        method: 'version',
        args: []
      },
      id: Math.floor(Math.random() * 1000000000)
    };

    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(versionPayload),
      muteHttpExceptions: true,
      timeout: 30000
    };

    const response = UrlFetchApp.fetch(ODOO_JSONRPC_ENDPOINT, options);
    const jsonResponse = JSON.parse(response.getContentText());

    if (jsonResponse.result) {
      results.versionInfo = jsonResponse.result;
      console.log('Odoo Version:', jsonResponse.result.server_version || JSON.stringify(jsonResponse.result));
    }
  } catch (error) {
    console.log('Version check failed:', error.message);
  }

  // Method 3: Try to fetch the web login page and look for database selector
  console.log('\n--- Method 3: Web Page Check ---');
  try {
    const webResponse = UrlFetchApp.fetch(ODOO_URL + '/web/database/selector', {
      muteHttpExceptions: true,
      followRedirects: false,
      timeout: 30000
    });

    const statusCode = webResponse.getResponseCode();
    const content = webResponse.getContentText();

    console.log('Database selector page status:', statusCode);

    if (statusCode === 200) {
      // Look for database names in the HTML
      // Common patterns: data-db-name="xxx" or option value="xxx"
      const dbMatches = content.match(/data-db[^"]*"([^"]+)"/g) || [];
      const optionMatches = content.match(/<option[^>]*value="([^"]+)"[^>]*>/g) || [];

      if (dbMatches.length > 0 || optionMatches.length > 0) {
        console.log('Found database references in HTML');
        console.log('DB matches:', dbMatches.join(', '));
        console.log('Option matches:', optionMatches.join(', '));
      }

      // Check if it says "Access Denied" or similar
      if (content.includes('Access Denied') || content.includes('Not Found')) {
        console.log('Database selector is disabled (Access Denied)');
      }
    } else if (statusCode === 303 || statusCode === 302) {
      // Redirect - might contain db in URL
      const location = webResponse.getHeaders()['Location'];
      console.log('Redirected to:', location);
      if (location && location.includes('db=')) {
        const dbMatch = location.match(/db=([^&]+)/);
        if (dbMatch) {
          results.suggestions.push(dbMatch[1]);
          console.log('Found database in redirect URL:', dbMatch[1]);
        }
      }
    }
  } catch (error) {
    console.log('Web check failed:', error.message);
  }

  // Method 4: Try common database name patterns
  console.log('\n--- Method 4: Testing Common Database Names ---');
  const commonNames = [
    'k-brands',
    'kbrands',
    'k_brands',
    'production',
    'main',
    'odoo',
    'k-brands-main',
    'k-brands-production',
    'kbrands-main',
    'kbrands_production'
  ];

  const apiKey = getOdooApiKey();
  if (apiKey) {
    for (const dbName of commonNames) {
      console.log(`Testing database: "${dbName}"...`);

      try {
        const authPayload = {
          jsonrpc: '2.0',
          method: 'call',
          params: {
            service: 'common',
            method: 'login',
            args: [dbName, ODOO_USERNAME, apiKey]
          },
          id: Math.floor(Math.random() * 1000000000)
        };

        const options = {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(authPayload),
          muteHttpExceptions: true,
          timeout: 10000
        };

        const response = UrlFetchApp.fetch(ODOO_JSONRPC_ENDPOINT, options);
        const jsonResponse = JSON.parse(response.getContentText());

        if (jsonResponse.result && typeof jsonResponse.result === 'number') {
          results.suggestions.push(dbName);
          console.log(`SUCCESS! Database "${dbName}" works! User ID: ${jsonResponse.result}`);
        } else if (jsonResponse.error) {
          const errorMsg = jsonResponse.error.data?.message || jsonResponse.error.message || '';
          if (errorMsg.includes('does not exist')) {
            console.log(`  "${dbName}" - does not exist`);
          } else if (errorMsg.includes('Access Denied') || errorMsg.includes('Invalid')) {
            console.log(`  "${dbName}" - exists but auth failed (wrong credentials)`);
            results.suggestions.push(dbName + ' (auth failed - db exists)');
          } else {
            console.log(`  "${dbName}" - error: ${errorMsg}`);
          }
        }
      } catch (error) {
        console.log(`  "${dbName}" - request failed: ${error.message}`);
      }
    }
  } else {
    console.log('Skipping database tests - no API key configured');
  }

  // Summary
  console.log('\n=== SUMMARY ===');

  if (results.dbListMethod.length > 0) {
    console.log('Databases from db.list:', results.dbListMethod.join(', '));
    console.log('\nTo configure, add this to Script Properties:');
    console.log(`  ODOO_DB = ${results.dbListMethod[0]}`);
  }

  if (results.suggestions.length > 0) {
    console.log('Working database names found:', results.suggestions.join(', '));
    const workingDb = results.suggestions.find(s => !s.includes('auth failed'));
    if (workingDb) {
      console.log('\nTo configure, add this to Script Properties:');
      console.log(`  ODOO_DB = ${workingDb}`);
    }
  }

  if (results.dbListMethod.length === 0 && results.suggestions.length === 0) {
    console.log('Could not automatically discover the database name.');
    console.log('\nManual steps to find your database name:');
    console.log('1. Log into Odoo at ' + ODOO_URL);
    console.log('2. Look at the URL - it might show ?db=YOUR_DATABASE');
    console.log('3. Or ask your Odoo administrator');
    console.log('4. Or check the Odoo.sh dashboard if using Odoo.sh');
  }

  if (results.versionInfo) {
    console.log('\nOdoo Server Info:', JSON.stringify(results.versionInfo));
  }

  return results;
}

/**
 * Quick test to verify a specific database name
 * @param {string} dbName - Database name to test
 */
function testDatabaseName(dbName) {
  if (!dbName) {
    console.log('Usage: testDatabaseName("your-database-name")');
    console.log('Or run discoverOdooDatabases() to find available databases');
    return false;
  }

  console.log('Testing database:', dbName);

  const apiKey = getOdooApiKey();
  if (!apiKey) {
    console.error('No ODOO_API_KEY found in Script Properties');
    return false;
  }

  try {
    const authPayload = {
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service: 'common',
        method: 'login',
        args: [dbName, ODOO_USERNAME, apiKey]
      },
      id: Math.floor(Math.random() * 1000000000)
    };

    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(authPayload),
      muteHttpExceptions: true,
      timeout: 30000
    };

    const response = UrlFetchApp.fetch(ODOO_JSONRPC_ENDPOINT, options);
    const jsonResponse = JSON.parse(response.getContentText());

    if (jsonResponse.result && typeof jsonResponse.result === 'number') {
      console.log('SUCCESS! Database "' + dbName + '" is correct!');
      console.log('User ID:', jsonResponse.result);
      console.log('\nNow add this to Script Properties:');
      console.log('  ODOO_DB = ' + dbName);
      return true;
    } else if (jsonResponse.error) {
      console.error('FAILED:', jsonResponse.error.data?.message || jsonResponse.error.message);
      return false;
    }
  } catch (error) {
    console.error('Request failed:', error.message);
    return false;
  }

  return false;
}
