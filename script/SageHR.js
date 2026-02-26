/**
 * SageHR.gs - Sage HR API Integration
 * Syncs employee data from Sage HR
 */

const SAGE_HR_BASE_URL = 'https://omnisecsolutions.sage.hr/api/';

/**
 * Make authenticated request to Sage HR API
 */
function sageHRRequest(endpoint, method = 'GET', payload = null) {
  const config = getConfig();
  const apiKey = config.sage_hr_api_key;

  if (!apiKey) {
    console.error('Sage HR API key not configured');
    return null;
  }

  const options = {
    method: method,
    headers: {
      'X-Auth-Token': apiKey,
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true
  };

  if (payload) {
    options.payload = JSON.stringify(payload);
  }

  try {
    const response = UrlFetchApp.fetch(SAGE_HR_BASE_URL + endpoint, options);
    const code = response.getResponseCode();

    if (code >= 400) {
      console.error(`Sage HR API error: ${code} - ${response.getContentText()}`);
      return null;
    }

    return JSON.parse(response.getContentText());
  } catch (error) {
    console.error('Sage HR request failed:', error);
    return null;
  }
}

/**
 * Get all employees from Sage HR
 */
function getSageHREmployees() {
  const result = sageHRRequest('/employees');

  if (!result || !result.data) {
    console.error('Failed to fetch Sage HR employees');
    return [];
  }

  return result.data.map(emp => ({
    id: emp.id,
    email: emp.email,
    first_name: emp.first_name,
    last_name: emp.last_name,
    full_name: `${emp.first_name} ${emp.last_name}`,
    name: `${emp.first_name} ${emp.last_name}`, // alias for compatibility with code that uses member.name
    department: emp.department?.name || '',
    position: emp.position?.name || '',
    manager_id: emp.reports_to?.id || null,
    manager_email: emp.reports_to?.email || null,
    status: 'active', //FIXED: emp doesn't have status field,this api already filter active employees: https://developer.sage.com/hr/apis/sagehr/v1.0.0/sage-hr-v1-0-swagger/tags/employee/paths/list-active-employees-in-company
    start_date: emp.start_date
  }));
}

/**
 * Get employees who are working today (not on leave)
 */
function getWorkingEmployeesToday() {
  const today = new Date();
  const dateStr = Utilities.formatDate(today, 'America/Chicago', 'yyyy-MM-dd');

  // Get all employees
  const employees = getSageHREmployees();
  if (!employees.length) {
    // Fallback to config sheet if Sage HR fails
    console.warn('Falling back to config sheet for team members');
    return getActiveTeamMembers();
  }

  // Get leave requests for today
  const leaves = sageHRRequest(`/leave-management/requests?from=${dateStr}&to=${dateStr}`);
  const onLeave = new Set();

  if (leaves && leaves.data) {
    leaves.data.forEach(leave => {
      if (leave.status === 'Approved') {
        onLeave.add(leave.employee_id);
      }
    });
  }

  // Filter out employees on leave
  const working = employees.filter(emp => {
    return emp.status === 'active' && !onLeave.has(emp.id);
  });

  return working;
}

/**
 * Daily Sage HR sync - runs at 6:00 AM
 * Syncs employee data and stores in BigQuery
 */
function dailySageHRSync() {
  console.log('Starting daily Sage HR sync...');

  if (!isWorkday()) {
    console.log('Not a workday, skipping Sage HR sync');
    return;
  }

  const employees = getSageHREmployees();

  if (!employees.length) {
    logSystemEvent('SAGE_HR_SYNC', 'FAILED', { error: 'No employees returned' });

    // Alert manager
    const config = getConfig();
    sendDirectMessage(
      config.settings.manager_email,
      '⚠️ **Sage HR Sync Failed**\n\nCould not fetch employee data from Sage HR. Using cached/config data for today.'
    );
    return;
  }

  // Get who's on leave today
  const working = getWorkingEmployeesToday();
  const onLeaveCount = employees.filter(e => e.status === 'active').length - working.length;

  // --- Detect new employees without DM spaces ---
  var config = getConfig();
  var newEmployees = [];
  var missingDMEmployees = [];

  working.forEach(function(emp) {
    // Check if they're in the team_members sheet
    var inSheet = config.team_members.find(function(tm) { return tm.email === emp.email; });

    // Skip not_tracked users — they don't need bot setup
    if (inSheet && inSheet.tracking_mode === 'not_tracked') return;

    // Check if they have a DM space (can the bot message them?)
    var dmSpace = getDMSpace(emp.email);
    if (!dmSpace) {
      missingDMEmployees.push(emp);
    }

    if (!inSheet) {
      newEmployees.push(emp);
    }
  });

  // Alert manager about new employees needing setup
  if (missingDMEmployees.length > 0) {
    var alertMsg = '👤 **New Employee Bot Setup Required**\n\n';
    alertMsg += 'The following employees are active in Sage HR but haven\'t set up their bot DM yet. They need to send a message to the bot to activate it:\n\n';
    missingDMEmployees.forEach(function(emp) {
      var name = emp.full_name || emp.name || emp.email;
      alertMsg += '• **' + name + '** (' + emp.email + ')';
      var isNew = newEmployees.some(function(ne) { return ne.email === emp.email; });
      if (isNew) alertMsg += ' — _also missing from team_members sheet_';
      alertMsg += '\n';
    });
    alertMsg += '\n**Action needed:** Ask them to open a DM with the Daily Check-in Bot and send any message (e.g. "hello"). The bot will then be able to send them check-ins and EOD prompts.';

    if (newEmployees.length > 0) {
      alertMsg += '\n\nFor new employees also missing from the team_members sheet, you may want to add them with their department, task source, and schedule settings.';
    }

    try {
      sendDirectMessage(config.settings.manager_email, alertMsg);
    } catch (e) {
      console.error('Failed to send new employee alert:', e.message);
    }
  }

  // Store sync results
  const syncData = {
    sync_date: new Date().toISOString(),
    total_employees: employees.length,
    active_employees: employees.filter(e => e.status === 'active').length,
    on_leave_today: onLeaveCount,
    working_today: working.length,
    missing_dm: missingDMEmployees.length,
    new_employees: newEmployees.length
  };

  // Log to BigQuery
  insertIntoBigQuery('sage_hr_syncs', [syncData]);

  // Update team members cache
  updateTeamMembersCache(working);

  logSystemEvent('SAGE_HR_SYNC', 'SUCCESS', syncData);
  console.log(`Sage HR sync complete: ${working.length} working today, ${onLeaveCount} on leave, ${missingDMEmployees.length} missing DM, ${newEmployees.length} new`);
}

/**
 * Update team members cache in Script Properties
 */
function updateTeamMembersCache(employees) {
  const cache = CacheService.getScriptCache();
  cache.put('working_employees', JSON.stringify(employees), 21600); // 6 hours
}

/**
 * Get cached working employees
 */
function getCachedWorkingEmployees() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('working_employees');

  if (cached) {
    return JSON.parse(cached);
  }

  // If no cache, fetch fresh
  return getWorkingEmployeesToday();
}

/**
 * Check if an employee is on leave today
 */
function isEmployeeOnLeave(email) {
  const working = getCachedWorkingEmployees();
  return !working.some(e => e.email === email);
}

/**
 * Get employees who are on leave today (for morning summary "Out Today" section)
 * Returns array of { name, email, leave_type }
 */
function getEmployeesOnLeaveToday() {
  var today = new Date();
  var dateStr = Utilities.formatDate(today, 'America/Chicago', 'yyyy-MM-dd');

  var employees = getSageHREmployees();
  if (!employees || employees.length === 0) return [];

  var leaves = sageHRRequest('/leave-management/requests?from=' + dateStr + '&to=' + dateStr);
  if (!leaves || !leaves.data) return [];

  var onLeave = [];
  leaves.data.forEach(function (leave) {
    if (leave.status === 'Approved') {
      var emp = employees.find(function (e) { return e.id === leave.employee_id; });
      if (emp && emp.status === 'active') {
        onLeave.push({
          name: emp.full_name || emp.email.split('@')[0],
          email: emp.email,
          leave_type: leave.policy_name || leave.leave_type || 'PTO'
        });
      }
    }
  });

  return onLeave;
}

/**
 * Get employees with birthdays today (for morning summary)
 * Returns array of { name, email }
 */
function getTodayBirthdays() {
  var today = new Date();
  var todayMonth = today.getMonth() + 1; // 1-indexed
  var todayDay = today.getDate();

  var employees = sageHRRequest('/employees');
  if (employees && employees.data) {
    var todayBirthdays = [];
    employees.data.forEach(function (emp) {
      if (emp.date_of_birth) {
        var dob = new Date(emp.date_of_birth);
        dob.setTime(dob.getTime() + 6 * 60 * 60 * 1000);
        if ((dob.getMonth() + 1) === todayMonth && dob.getDate() === todayDay) {
          todayBirthdays.push({
            name: emp.first_name + ' ' + emp.last_name,
            email: emp.email
          });
        }
      }
    });
    return todayBirthdays;
  }

  // Fallback: check individual employee records
  var employees = getSageHREmployees();
  if (!employees || employees.length === 0) return [];

  // Sage HR may not expose DOB in standard endpoint; return empty gracefully
  return [];
}

// ============================================
// SPREADSHEET SYNC FUNCTIONS
// ============================================

/**
 * Sync employees from Sage HR to the team_members spreadsheet tab
 * This writes/updates the team_members tab with current Sage HR data
 */
function syncEmployeesToSheet() {
  console.log('Syncing employees to spreadsheet...');

  const employees = getSageHREmployees();
  if (!employees || employees.length === 0) {
    console.error('No employees to sync');
    return { success: false, error: 'No employees returned from Sage HR' };
  }

  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty('CONFIG_SHEET_ID');

  if (!sheetId) {
    console.error('CONFIG_SHEET_ID not set');
    return { success: false, error: 'CONFIG_SHEET_ID not configured' };
  }

  const ss = SpreadsheetApp.openById(sheetId);
  let sheet = ss.getSheetByName('team_members');

  // Create sheet if it doesn't exist
  if (!sheet) {
    sheet = ss.insertSheet('team_members');
    console.log('Created team_members sheet');
  }

  // Prepare header row
  const headers = ['email', 'name', 'department', 'manager_email', 'active', 'custom_start_time', 'custom_end_time', 'timezone', 'task_source', 'tracking_mode', 'custom_block2_start', 'custom_block2_end'];

  // Get existing data to preserve custom fields (custom_start_time, custom_end_time, timezone, task_source)
  const existingData = sheet.getDataRange().getValues();
  const existingByEmail = {};

  if (existingData.length > 1) {
    for (let i = 1; i < existingData.length; i++) {
      const email = existingData[i][0];
      if (email) {
        existingByEmail[email] = {
          custom_start_time: existingData[i][5] || '',
          custom_end_time: existingData[i][6] || '',
          timezone: existingData[i][7] || 'America/Chicago',
          task_source: existingData[i][8] || 'clickup',
          tracking_mode: existingData[i][9] || 'tracked',
          custom_block2_start: existingData[i][10] || '',
          custom_block2_end: existingData[i][11] || ''
        };
      }
    }
  }

  // Prepare rows from Sage HR data, preserving custom fields
  const rows = employees.map(emp => {
    const existing = existingByEmail[emp.email] || {};
    return [
      emp.email,
      emp.full_name || emp.name,
      emp.department || '',
      emp.manager_email || '',
      emp.status === 'active' ? 'TRUE' : 'FALSE',
      existing.custom_start_time || '',
      existing.custom_end_time || '',
      existing.timezone || 'America/Chicago',
      existing.task_source || 'clickup',
      existing.tracking_mode || 'tracked',
      existing.custom_block2_start || '',
      existing.custom_block2_end || ''
    ];
  });

  // Clear and write data
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  // Format header row
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');

  console.log(`Synced ${rows.length} employees to team_members sheet`);
  return { success: true, count: rows.length };
}

/**
 * Sync time-off/leave data from Sage HR to a time_off spreadsheet tab
 * Fetches leave requests for the current week
 */
function syncLeavesToSheet() {
  console.log('Syncing leaves to spreadsheet...');

  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty('CONFIG_SHEET_ID');

  if (!sheetId) {
    console.error('CONFIG_SHEET_ID not set');
    return { success: false, error: 'CONFIG_SHEET_ID not configured' };
  }

  const ss = SpreadsheetApp.openById(sheetId);
  let sheet = ss.getSheetByName('time_off_view');

  // Create sheet if it doesn't exist
  if (!sheet) {
    sheet = ss.insertSheet('time_off_view');
    console.log('Created time_off_view sheet');
  }

  // Get employees for name lookup
  const employees = getSageHREmployees();
  const empById = {};
  employees.forEach(e => { empById[e.id] = e; });

  // Fetch leaves for next 14 days
  const today = new Date();
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + 14);

  const startStr = Utilities.formatDate(today, 'America/Chicago', 'yyyy-MM-dd');
  const endStr = Utilities.formatDate(endDate, 'America/Chicago', 'yyyy-MM-dd');

  // Try to get leaves using date range
  let allLeaves = [];

  // Fetch for each day (Sage HR may require specific dates)
  for (let d = new Date(today); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateStr = Utilities.formatDate(d, 'America/Chicago', 'yyyy-MM-dd');
    const leaves = sageHRRequest('/leave-management/requests?from=' + dateStr + '&to=' + dateStr);

    if (leaves && leaves.data) {
      leaves.data.forEach(leave => {
        // Avoid duplicates
        if (!allLeaves.find(l => l.id === leave.id)) {
          allLeaves.push(leave);
        }
      });
    }
  }

  // Prepare header row
  const headers = ['employee_email', 'employee_name', 'leave_type', 'start_date', 'end_date', 'status', 'days'];

  // Prepare rows
  const rows = allLeaves.map(leave => {
    const emp = empById[leave.employee_id] || {};
    return [
      emp.email || '',
      emp.full_name || emp.name || '',
      leave.policy_name || leave.leave_type || 'Unknown',
      leave.start_date || '',
      leave.end_date || '',
      leave.status || '',
      leave.days || ''
    ];
  }).filter(row => row[4] !== ''); // Filter out rows without end_date (incomplete data)

  // Sort by start_date
  rows.sort((a, b) => (a[3] || '').localeCompare(b[3] || ''));

  // Clear and write data
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  // Format header row
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');

  console.log(`Synced ${rows.length} leave records to time_off_view sheet`);
  return { success: true, count: rows.length };
}

/**
 * Full Sage HR sync - employees + leaves to spreadsheet + BigQuery
 * Run this manually or call from dailySageHRSync
 */
function fullSageHRSync() {
  console.log('=== Full Sage HR Sync ===');

  // Sync employees to spreadsheet
  const empResult = syncEmployeesToSheet();
  console.log('Employee sync:', empResult);

  // Sync leaves to spreadsheet
  const leaveResult = syncLeavesToSheet();
  console.log('Leave sync:', leaveResult);

  // Also run the regular daily sync (BigQuery + cache)
  dailySageHRSync();

  return {
    employees: empResult,
    leaves: leaveResult
  };
}

/**
 * Test Sage HR connection and show what data is available
 */
function testSageHRData() {
  console.log('=== Testing Sage HR Data ===');

  // Test employees endpoint
  const employees = getSageHREmployees();
  console.log('Employees fetched:', employees.length);
  if (employees.length > 0) {
    console.log('Sample employee:', JSON.stringify(employees[0], null, 2));
  }

  // Test leaves endpoint for today
  const today = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');
  const leaves = sageHRRequest('/leave-management/requests?from=' + today + '&to=' + today);
  console.log('Leaves for today:', leaves ? (leaves.data ? leaves.data.length : 'no data array') : 'null response');
  if (leaves && leaves.data && leaves.data.length > 0) {
    console.log('Sample leave:', JSON.stringify(leaves.data[0], null, 2));
  }

  return {
    employees: employees.length,
    leaves: leaves ? (leaves.data ? leaves.data.length : 0) : 0,
    birthdays: birthdays ? (birthdays.data ? birthdays.data.length : 0) : 0
  };
}

