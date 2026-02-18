/**
 * Config.gs - Configuration Management
 * Loads settings from Google Sheet and Script Properties
 *
 * ============================================
 * ODOO INTEGRATION POINTS:
 * ============================================
 *
 * 1. Add ODOO_API_KEY to Script Properties (line ~33)
 *
 * 2. Add odoo_config tab loading function (after loadClickUpConfigTab)
 *    - enabled: boolean
 *    - include_in_morning: boolean
 *    - include_in_eod: boolean
 *
 * 3. Add odoo_user_map tab for email → Odoo user mapping
 *    - Columns: email, odoo_user_id, odoo_username
 *
 * 4. Add task_source column to team_members tab:
 *    - 'clickup' - tasks from ClickUp only
 *    - 'odoo' - tasks from Odoo only
 *    - 'both' - tasks from both systems
 *    - Modify loadTeamMembersTab() to include this field
 *
 * 5. Create getTasksForUser(email, period) function that:
 *    - Checks member's task_source setting
 *    - Calls ClickUp and/or Odoo based on setting
 *    - Merges results if 'both'
 *
 * ============================================
 */

// Cache for config to avoid repeated sheet reads
let CONFIG_CACHE = null;
let CONFIG_CACHE_TIME = null;
const CONFIG_CACHE_DURATION = 300000; // 5 minutes

/**
 * Get all configuration
 */
function getConfig() {
  // Check cache
  if (CONFIG_CACHE && CONFIG_CACHE_TIME && (Date.now() - CONFIG_CACHE_TIME < CONFIG_CACHE_DURATION)) {
    return CONFIG_CACHE;
  }
  
  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty('CONFIG_SHEET_ID');
  
  if (!sheetId) {
    throw new Error('CONFIG_SHEET_ID not set in Script Properties');
  }
  
  const ss = SpreadsheetApp.openById(sheetId);
  const config = {
    // Script Properties (sensitive)
    sage_hr_api_key: props.getProperty('SAGE_HR_API_KEY'),
    openai_api_key: props.getProperty('OPENAI_API_KEY'),
    clickup_api_token: props.getProperty('CLICKUP_API_TOKEN'),
    bigquery_project_id: props.getProperty('BIGQUERY_PROJECT_ID'),
    odoo_api_key: props.getProperty('ODOO_API_KEY'),
    
    // From settings tab
    settings: loadSettingsTab(ss),
    
    // From team_members tab
    team_members: loadTeamMembersTab(ss),
    
    // From work_hours tab
    work_hours: loadWorkHoursTab(ss),
    
    // From holidays tab
    holidays: loadHolidaysTab(ss),
    
    // From clickup_config tab
    clickup_config: loadClickUpConfigTab(ss),
    
    // From clickup_user_map tab
    clickup_user_map: loadClickUpUserMapTab(ss),

    // From odoo_config tab
    odoo_config: loadOdooConfigTab(ss),

    // From odoo_user_map tab
    odoo_user_map: loadOdooUserMapTab(ss),

    // From special_hours tab (Ramadan, etc.)
    special_hours: loadSpecialHoursTab(ss),

    // From email_mapping tab (Sage HR → Google email)
    email_mapping: loadEmailMappingTab(ss)
  };
  
  // Cache it
  CONFIG_CACHE = config;
  CONFIG_CACHE_TIME = Date.now();
  
  return config;
}

/**
 * Clear config cache (call after sheet updates)
 */
function clearConfigCache() {
  CONFIG_CACHE = null;
  CONFIG_CACHE_TIME = null;
}

/**
 * Load settings tab (key-value pairs)
 */
function loadSettingsTab(ss) {
  const sheet = ss.getSheetByName('settings');
  if (!sheet) return {};
  
  const data = sheet.getDataRange().getValues();
  const settings = {};
  
  // Skip header row
  for (let i = 1; i < data.length; i++) {
    const key = data[i][0];
    let value = data[i][1];
    
    if (key) {
      // Parse booleans
      if (value === 'TRUE' || value === true) value = true;
      else if (value === 'FALSE' || value === false) value = false;
      // Parse numbers
      else if (!isNaN(value) && value !== '') value = Number(value);
      // Parse comma-separated lists
      else if (typeof value === 'string' && value.includes(',') && value.includes('@')) {
        value = value.split(',').map(v => v.trim());
      }
      
      settings[key] = value;
    }
  }
  
  return settings;
}

/**
 * Load team members tab
 */
function loadTeamMembersTab(ss) {
  const sheet = ss.getSheetByName('team_members');
  if (!sheet) return [];
  
  const data = sheet.getDataRange().getValues();
  const members = [];
  
  // Skip header row
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) { // Has email
      members.push({
        email: data[i][0],
        name: data[i][1],
        department: data[i][2],
        manager_email: data[i][3],
        active: data[i][4] !== false && data[i][4] !== 'FALSE',
        custom_start_time: data[i][5] || null,
        custom_end_time: data[i][6] || null,
        timezone: data[i][7] || 'America/Chicago',
        task_source: data[i][8] || 'clickup'  // clickup, odoo, or both
      });
    }
  }
  
  return members;
}

/**
 * Load work hours tab
 */
function loadWorkHoursTab(ss) {
  const sheet = ss.getSheetByName('work_hours');
  if (!sheet) {
    // Return defaults
    return {
      default_start: '08:00',
      default_end: '17:00',
      friday_start: '07:00',
      friday_end: '11:00',
      default_hours_per_day: 8,
      friday_hours_per_day: 4,
      timezone: 'America/Chicago'
    };
  }

  const data = sheet.getDataRange().getValues();
  const hours = {};

  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) {
      hours[data[i][0]] = data[i][1];
    }
  }

  // Ensure hours defaults exist
  if (!hours.default_hours_per_day) hours.default_hours_per_day = 8;
  if (!hours.friday_hours_per_day) hours.friday_hours_per_day = 4;

  return hours;
}

/**
 * Get expected working hours for today
 * Returns 4 on Fridays, 8 on Mon-Thu (configurable via work_hours sheet)
 */
function getTodayExpectedHours() {
  var config = getConfig();
  var day = new Date().getDay();
  if (day === 5) {
    return parseFloat(config.work_hours.friday_hours_per_day) || 4;
  }
  return parseFloat(config.work_hours.default_hours_per_day) || 8;
}

/**
 * Load holidays tab
 */
function loadHolidaysTab(ss) {
  const sheet = ss.getSheetByName('holidays');
  if (!sheet) return [];
  
  const data = sheet.getDataRange().getValues();
  const holidays = [];
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) {
      holidays.push({
        date: data[i][0],
        name: data[i][1],
        type: data[i][2] || 'full' // full, half_am, half_pm
      });
    }
  }
  
  return holidays;
}

/**
 * Load ClickUp config tab
 */
function loadClickUpConfigTab(ss) {
  const sheet = ss.getSheetByName('clickup_config');
  if (!sheet) {
    return {
      enabled: true,
      include_in_morning: true,
      include_in_eod: true,
      auto_update: true,
      add_comments: true,
      show_weekly_monday: true,
      overdue_warning: true
    };
  }
  
  const data = sheet.getDataRange().getValues();
  const config = {};
  
  for (let i = 1; i < data.length; i++) {
    const key = data[i][0];
    let value = data[i][1];
    
    if (key) {
      if (value === 'TRUE' || value === true) value = true;
      else if (value === 'FALSE' || value === false) value = false;
      else if (!isNaN(value) && value !== '') value = Number(value);
      
      config[key] = value;
    }
  }

  // Ensure use_clickup_time_estimates defaults to false
  if (config.use_clickup_time_estimates === undefined) {
    config.use_clickup_time_estimates = false;
  }

  return config;
}

/**
 * Load ClickUp user mapping tab
 */
function loadClickUpUserMapTab(ss) {
  const sheet = ss.getSheetByName('clickup_user_map');
  if (!sheet) return {};
  
  const data = sheet.getDataRange().getValues();
  const map = {};
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][1]) {
      map[data[i][0]] = {
        clickup_user_id: String(data[i][1]),
        clickup_username: data[i][2] || ''
      };
    }
  }
  
  return map;
}

/**
 * Load Odoo config tab
 */
function loadOdooConfigTab(ss) {
  const sheet = ss.getSheetByName('odoo_config');
  if (!sheet) {
    return { enabled: false, include_in_morning: false, include_in_eod: false };
  }

  const data = sheet.getDataRange().getValues();
  const config = {};

  for (let i = 1; i < data.length; i++) {
    const key = data[i][0];
    let value = data[i][1];

    if (key) {
      if (value === 'TRUE' || value === true) value = true;
      else if (value === 'FALSE' || value === false) value = false;
      else if (!isNaN(value) && value !== '') value = Number(value);

      config[key] = value;
    }
  }

  return config;
}

/**
 * Load Odoo user mapping tab
 * Maps Google email → {odoo_user_id, odoo_username}
 */
function loadOdooUserMapTab(ss) {
  const sheet = ss.getSheetByName('odoo_user_map');
  if (!sheet) return {};

  const data = sheet.getDataRange().getValues();
  const map = {};

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][1]) {
      map[data[i][0]] = {
        odoo_user_id: String(data[i][1]),
        odoo_username: data[i][2] || ''
      };
    }
  }

  return map;
}

/**
 * Unified task fetcher — gets tasks from ClickUp, Odoo, or both
 * based on the team member's task_source setting.
 * Returns normalized task array in the standard ClickUp-compatible shape.
 */
function getTasksForUser(email, period) {
  var config = getConfig();
  var member = config.team_members.find(function(m) { return m.email === email; });
  var taskSource = member ? member.task_source : 'clickup';
  var tasks = [];

  // ClickUp tasks
  if ((taskSource === 'clickup' || taskSource === 'both') && config.clickup_config.enabled) {
    try {
      var clickupTasks = getTasksDueForUser(email, period);
      clickupTasks.forEach(function(t) { t.source = 'clickup'; });
      tasks = tasks.concat(clickupTasks);
    } catch (err) {
      console.error('ClickUp task fetch error for ' + email + ':', err.message);
    }
  }

  // Odoo tasks
  if ((taskSource === 'odoo' || taskSource === 'both') && config.odoo_config && config.odoo_config.enabled) {
    try {
      var odooRawTasks = getOdooTasksForUser(email, period);
      var normalizedOdoo = normalizeOdooTasks(odooRawTasks);
      tasks = tasks.concat(normalizedOdoo);
    } catch (err) {
      console.error('Odoo task fetch error for ' + email + ':', err.message);
    }
  }

  // Re-sort merged list: overdue first, then by due date
  tasks.sort(function(a, b) {
    if (a.isOverdue && !b.isOverdue) return -1;
    if (!a.isOverdue && b.isOverdue) return 1;
    if (a.isOverdue && b.isOverdue) return b.daysOverdue - a.daysOverdue;
    if (a.dueDate && b.dueDate) return a.dueDate - b.dueDate;
    return 0;
  });

  return tasks;
}

/**
 * Check if today is a holiday and return the holiday object (or null)
 */
function getHolidayInfo(date = new Date()) {
  const config = getConfig();
  const dateStr = Utilities.formatDate(date, config.work_hours.timezone || 'America/Chicago', 'yyyy-MM-dd');

  for (var i = 0; i < config.holidays.length; i++) {
    var h = config.holidays[i];
    var holidayDate = h.date instanceof Date
      ? Utilities.formatDate(h.date, 'America/Chicago', 'yyyy-MM-dd')
      : h.date;
    if (holidayDate === dateStr) return h;
  }
  return null;
}

/**
 * Check if today is a holiday (any type)
 */
function isHoliday(date = new Date()) {
  return getHolidayInfo(date) !== null;
}

/**
 * Check if today is a full-day off (type=full or no type specified)
 * half_pm and half_am holidays are NOT full days off
 */
function isFullDayOff(date = new Date()) {
  var holiday = getHolidayInfo(date);
  if (!holiday) return false;
  return !holiday.type || holiday.type === 'full';
}

/**
 * Check if today is a half_pm holiday (morning triggers run, EOD triggers skip)
 */
function isHalfPmHoliday(date = new Date()) {
  var holiday = getHolidayInfo(date);
  return holiday && holiday.type === 'half_pm';
}

/**
 * Check if today is a workday (at least partial)
 */
function isWorkday(date = new Date()) {
  const day = date.getDay();
  // Sunday = 0, Saturday = 6
  if (day === 0 || day === 6) return false;
  // Full day off = not a workday. Half-day holidays ARE workdays.
  if (isFullDayOff(date)) return false;
  return true;
}

/**
 * Check if afternoon/EOD triggers should run today
 * Returns false on half_pm holidays (morning only) and full holidays
 */
function isEodWorkday(date = new Date()) {
  if (!isWorkday(date)) return false;
  if (isHalfPmHoliday(date)) return false;
  return true;
}

/**
 * Get work hours for today, with special period override (Ramadan, etc.)
 */
function getTodayWorkHours() {
  const config = getConfig();
  const today = new Date();
  const dayOfWeek = today.getDay();

  // Ensure we always return strings in HH:MM format
  const formatTime = (val, defaultVal) => {
    if (!val) return defaultVal;
    if (typeof val === 'string') return val;
    if (val instanceof Date) {
      return Utilities.formatDate(val, 'America/Chicago', 'HH:mm');
    }
    if (typeof val === 'number') {
      const hours = Math.floor(val);
      const mins = Math.round((val - hours) * 60);
      return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
    }
    return defaultVal;
  };

  // Check for active special hours period (Ramadan, etc.)
  var specialPeriod = getActiveSpecialPeriod(today);
  if (specialPeriod) {
    if (dayOfWeek === 5) {
      return {
        start: formatTime(specialPeriod.fri_start, '10:00'),
        end: formatTime(specialPeriod.fri_end, '14:00')
      };
    }
    return {
      start: formatTime(specialPeriod.mt_start, '10:00'),
      end: formatTime(specialPeriod.mt_end, '17:00')
    };
  }

  if (dayOfWeek === 5) { // Friday
    return {
      start: formatTime(config.work_hours.friday_start, '07:00'),
      end: formatTime(config.work_hours.friday_end, '11:00')
    };
  }

  return {
    start: formatTime(config.work_hours.default_start, '08:00'),
    end: formatTime(config.work_hours.default_end, '17:00')
  };
}

/**
 * Get active team members
 */
function getActiveTeamMembers() {
  const config = getConfig();
  return config.team_members.filter(m => m.active);
}

/**
 * Get BigQuery project ID
 */
function getProjectId() {
  const config = getConfig();
  return config.bigquery_project_id || PropertiesService.getScriptProperties().getProperty('BIGQUERY_PROJECT_ID');
}

/**
 * Get recipients for a specific report type
 */
function getReportRecipients(reportType) {
  const config = getConfig();
  const settings = config.settings;

  switch (reportType) {
    case 'ai_evaluation':
      return settings.ai_eval_recipients || [settings.manager_email];
    case 'weekly_summary':
      return settings.weekly_summary_recipients || [settings.manager_email];
    case 'escalation':
      return settings.escalation_recipients || [settings.manager_email, settings.ops_leader_email];
    default:
      return [settings.manager_email];
  }
}

/**
 * Load special hours tab (Ramadan, Q4 crunch, etc.)
 * Columns: period_name, start_date, end_date, mt_start, mt_end, fri_start, fri_end
 */
function loadSpecialHoursTab(ss) {
  const sheet = ss.getSheetByName('special_hours');
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  const periods = [];

  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) {
      periods.push({
        name: data[i][0],
        start_date: data[i][1],
        end_date: data[i][2],
        mt_start: data[i][3] || null,
        mt_end: data[i][4] || null,
        fri_start: data[i][5] || null,
        fri_end: data[i][6] || null
      });
    }
  }

  return periods;
}

/**
 * Get active special period for a given date (e.g. Ramadan)
 * Returns the period object if today falls within it, null otherwise
 */
function getActiveSpecialPeriod(date) {
  var config = getConfig();
  if (!config.special_hours || config.special_hours.length === 0) return null;

  var dateStr = Utilities.formatDate(date || new Date(), 'America/Chicago', 'yyyy-MM-dd');

  for (var i = 0; i < config.special_hours.length; i++) {
    var period = config.special_hours[i];
    var startStr = period.start_date instanceof Date
      ? Utilities.formatDate(period.start_date, 'America/Chicago', 'yyyy-MM-dd')
      : String(period.start_date);
    var endStr = period.end_date instanceof Date
      ? Utilities.formatDate(period.end_date, 'America/Chicago', 'yyyy-MM-dd')
      : String(period.end_date);

    if (dateStr >= startStr && dateStr <= endStr) return period;
  }
  return null;
}

/**
 * Load email mapping tab (Sage HR email → Google email)
 * Columns: sage_hr_email, google_email, notes
 */
function loadEmailMappingTab(ss) {
  const sheet = ss.getSheetByName('email_mapping');
  if (!sheet) return {};

  const data = sheet.getDataRange().getValues();
  const map = {};

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][1]) {
      map[data[i][0].toLowerCase()] = data[i][1].toLowerCase();
    }
  }

  return map;
}

/**
 * Resolve email using email mapping (Sage HR → Google)
 * If no mapping found, returns the original email
 */
function resolveEmail(sageHrEmail) {
  var config = getConfig();
  var mapped = config.email_mapping[sageHrEmail.toLowerCase()];
  return mapped || sageHrEmail;
}

/**
 * Get OpenAI model from settings (configurable)
 */
function getOpenAIModel() {
  var config = getConfig();
  return config.settings.openai_model || 'gpt-4o-mini';
}

/**
 * Get late threshold in minutes from settings (configurable)
 */
function getLateThresholdMin() {
  var config = getConfig();
  return parseInt(config.settings.late_threshold_min) || 15;
}
