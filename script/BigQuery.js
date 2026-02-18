/**
 * BigQuery.gs - BigQuery Data Storage
 * Handles all BigQuery operations
 */

const DATASET_ID = 'checkin_bot';

/**
 * Insert rows into a BigQuery table
 */
function insertIntoBigQuery(tableName, rows) {
  if (!rows || rows.length === 0) return;

  const projectId = getProjectId();
  const token = getServiceAccountToken('https://www.googleapis.com/auth/bigquery');

  if (!token) {
    console.error('SA token missing, falling back to built-in BigQuery service');
    try {
      const insertRequest = {
        rows: rows.map(row => ({ insertId: Utilities.getUuid(), json: row }))
      };
      BigQuery.Tabledata.insertAll(insertRequest, projectId, DATASET_ID, tableName);
    } catch (e) {
      console.error('Built-in fallback failed:', e.message);
    }
    return;
  }

  try {
    const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/datasets/${DATASET_ID}/tables/${tableName}/insertAll`;
    const payload = {
      rows: rows.map(row => ({
        insertId: Utilities.getUuid(),
        json: row
      }))
    };

    const options = {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      console.error(`BigQuery REST insert error for ${tableName}:`, response.getContentText());
    } else {
      console.log(`Successfully inserted ${rows.length} rows into ${tableName} via SA`);
    }
  } catch (error) {
    console.error(`BigQuery REST insert exception for ${tableName}:`, error.message);
  }
}

/**
 * Run a BigQuery query and return results
 */
function runBigQueryQuery(query) {
  const projectId = getProjectId();
  const token = getServiceAccountToken('https://www.googleapis.com/auth/bigquery');

  if (!token) {
    console.error('SA token missing for query, falling back to built-in service');
    try {
      const request = { query: query, useLegacySql: false };
      let queryResults = BigQuery.Jobs.query(request, projectId);
      // ... minimal parsing or just returning empty since this is a fallback
      return [];
    } catch (e) { return []; }
  }

  try {
    const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/queries`;
    const payload = { query: query, useLegacySql: false };

    const options = {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    let response = UrlFetchApp.fetch(url, options);
    let queryResults = JSON.parse(response.getContentText());

    if (response.getResponseCode() !== 200) {
      console.error('BigQuery REST query error:', response.getContentText());
      return [];
    }

    const jobId = queryResults.jobReference.jobId;

    // Polling if not complete
    while (!queryResults.jobComplete) {
      Utilities.sleep(1000);
      const pollUrl = `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/queries/${jobId}`;
      const pollResponse = UrlFetchApp.fetch(pollUrl, {
        method: 'get',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true
      });
      queryResults = JSON.parse(pollResponse.getContentText());
    }

    // Parse results
    if (!queryResults.rows) return [];

    const schema = queryResults.schema;
    return queryResults.rows.map(row => {
      const obj = {};
      row.f.forEach((cell, i) => {
        const fieldName = schema.fields[i].name;
        obj[fieldName] = cell.v;
      });
      return obj;
    });
  } catch (error) {
    console.error('BigQuery REST query exception:', error.message);
    return [];
  }
}

/**
 * Log a check-in
 */
function logCheckIn(email, timestamp, response, isLate) {
  const row = {
    checkin_id: Utilities.getUuid(),
    user_email: email,
    checkin_date: Utilities.formatDate(timestamp, 'America/Chicago', 'yyyy-MM-dd'),
    checkin_timestamp: timestamp.toISOString(),
    response_text: response,
    is_late: isLate,
    created_at: new Date().toISOString()
  };

  insertIntoBigQuery('check_ins', [row]);
  return row.checkin_id;
}

/**
 * Log an EOD report
 */
function logEodReport(email, timestamp, tasksCompleted, blockers, tomorrowPriority, rawResponse, hoursWorked) {
  const row = {
    eod_id: Utilities.getUuid(),
    user_email: email,
    eod_date: Utilities.formatDate(timestamp, 'America/Chicago', 'yyyy-MM-dd'),
    eod_timestamp: timestamp.toISOString(),
    tasks_completed: tasksCompleted,
    blockers: blockers,
    tomorrow_priority: tomorrowPriority,
    raw_response: rawResponse,
    hours_worked: hoursWorked !== null && hoursWorked !== undefined ? hoursWorked : null,
    created_at: new Date().toISOString()
  };

  insertIntoBigQuery('eod_reports', [row]);
  return row.eod_id;
}

/**
 * Log a missed check-in
 */
function logMissedCheckIn(email, date, type) {
  const row = {
    missed_id: Utilities.getUuid(),
    user_email: email,
    missed_date: Utilities.formatDate(date, 'America/Chicago', 'yyyy-MM-dd'),
    missed_type: type, // 'CHECKIN' or 'EOD'
    created_at: new Date().toISOString()
  };

  insertIntoBigQuery('missed_checkins', [row]);
}

/**
 * Log task action from ClickUp
 */
function logTaskAction(userEmail, taskId, taskName, listId, listName, actionType, oldStatus, newStatus, oldDueDate, newDueDate, status, source) {
  const row = {
    action_id: Utilities.getUuid(),
    timestamp: new Date().toISOString(),
    user_email: userEmail,
    task_id: taskId,
    task_name: taskName,
    list_id: listId,
    list_name: listName,
    action_type: actionType,
    old_status: oldStatus,
    new_status: newStatus,
    old_due_date: oldDueDate,
    new_due_date: newDueDate,
    status: status,
    source: source || 'clickup'
  };

  insertIntoBigQuery('clickup_task_actions', [row]);
}

/**
 * Log task delay with reason
 */
function logTaskDelay(userEmail, taskId, taskName, originalDueDate, newDueDate, delayReason, delayCount, source) {
  const row = {
    delay_id: Utilities.getUuid(),
    timestamp: new Date().toISOString(),
    user_email: userEmail,
    task_id: taskId,
    task_name: taskName,
    original_due_date: originalDueDate,
    new_due_date: newDueDate,
    delay_reason: delayReason,
    delay_count: delayCount,
    source: source || 'clickup'
  };

  insertIntoBigQuery('task_delays', [row]);
}

/**
 * Log overdue snapshot
 */
function logOverdueSnapshot(snapshots) {
  if (!snapshots || snapshots.length === 0) return;

  const today = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');

  const rows = snapshots.map(s => ({
    snapshot_date: today,
    user_email: s.user_email,
    task_id: s.task_id,
    task_name: s.task_name,
    list_name: s.list_name,
    original_due_date: s.original_due_date,
    days_overdue: s.days_overdue,
    is_chronic: s.days_overdue >= 3,
    delay_count: s.delay_count || 0
  }));

  insertIntoBigQuery('overdue_snapshots', rows);
}

/**
 * Log daily ClickUp snapshot
 */
function logClickUpDailySnapshot(snapshots) {
  insertIntoBigQuery('clickup_daily_snapshot', snapshots);
}

/**
 * Log system event
 */
function logSystemEvent(eventType, status, details = {}) {
  const row = {
    event_id: Utilities.getUuid(),
    timestamp: new Date().toISOString(),
    event_type: eventType,
    status: status,
    details: JSON.stringify(details)
  };

  insertIntoBigQuery('system_events', [row]);
}

/**
 * Log error to sheet (fallback)
 */
function logErrorToSheet(tableName, data, error) {
  console.error(`Error inserting into ${tableName}:`, error, 'Data:', JSON.stringify(data));
}

/**
 * Log a bot error to BigQuery for tracking
 */
function logBotError(functionName, error, context) {
  try {
    insertIntoBigQuery('bot_errors', [{
      error_id: Utilities.getUuid(),
      timestamp: new Date().toISOString(),
      function_name: functionName || 'unknown',
      error_message: error ? (error.message || String(error)) : '',
      error_stack: error ? (error.stack || '') : '',
      context: context ? JSON.stringify(context) : ''
    }]);
  } catch (e) {
    // Avoid infinite loop if bot_errors table insert itself fails
    console.error('Failed to log bot error:', e.message);
  }
}

/**
 * Get today's check-ins
 */
function getTodayCheckIns() {
  const today = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');
  const projectId = getProjectId();

  const query = `
    SELECT user_email, checkin_timestamp, is_late
    FROM \`${projectId}.${DATASET_ID}.check_ins\`
    WHERE checkin_date = '${today}'
  `;

  return runBigQueryQuery(query);
}

/**
 * Get today's EOD reports
 */
function getTodayEodReports() {
  const today = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');
  const projectId = getProjectId();

  const query = `
    SELECT user_email, eod_timestamp, tasks_completed, blockers, hours_worked
    FROM \`${projectId}.${DATASET_ID}.v_eod_reports\`
    WHERE eod_date = '${today}'
  `;

  return runBigQueryQuery(query);
}

/**
 * Sanitize a string for safe use in BigQuery queries (BUG #12 fix)
 * Escapes single quotes and removes dangerous characters
 */
function sanitizeForBQ(value) {
  if (value === null || value === undefined) return '';
  // Escape backslashes FIRST, then quotes (order matters to avoid double-escaping)
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/;/g, '');
}

/**
 * Get user's check-in streak
 */
function getUserStreak(email) {
  const projectId = getProjectId();
  const safeEmail = sanitizeForBQ(email);

  const query = `
    WITH consecutive_days AS (
      SELECT
        checkin_date,
        DATE_DIFF(checkin_date, LAG(checkin_date) OVER (ORDER BY checkin_date), DAY) as day_diff
      FROM \`${projectId}.${DATASET_ID}.check_ins\`
      WHERE user_email = '${safeEmail}'
      ORDER BY checkin_date DESC
    )
    SELECT COUNT(*) as streak
    FROM (
      SELECT checkin_date
      FROM consecutive_days
      WHERE day_diff IS NULL OR day_diff = 1
    )
  `;

  const result = runBigQueryQuery(query);
  return result.length > 0 ? parseInt(result[0].streak) : 0;
}

/**
 * Get weekly stats for a user
 */
function getUserWeeklyStats(email) {
  const projectId = getProjectId();
  const safeEmail = sanitizeForBQ(email);

  const query = `
    SELECT
      COUNT(DISTINCT c.checkin_date) as checkin_days,
      SUM(CASE WHEN c.is_late THEN 1 ELSE 0 END) as late_days,
      COUNT(DISTINCT e.eod_date) as eod_days
    FROM \`${projectId}.${DATASET_ID}.check_ins\` c
    LEFT JOIN \`${projectId}.${DATASET_ID}.v_eod_reports\` e
      ON c.user_email = e.user_email AND c.checkin_date = e.eod_date
    WHERE c.user_email = '${safeEmail}'
      AND c.checkin_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
  `;

  const result = runBigQueryQuery(query);
  return result.length > 0 ? result[0] : { checkin_days: 0, late_days: 0, eod_days: 0 };
}

/**
 * Get task completion stats for a user this week
 */
function getUserTaskStats(email) {
  const projectId = getProjectId();
  const safeEmail = sanitizeForBQ(email);

  const query = `
    SELECT
      SUM(tasks_due_today) as total_due,
      SUM(tasks_completed_today) as total_completed,
      SUM(tasks_moved_tomorrow) as total_moved,
      SUM(tasks_overdue) as total_overdue,
      AVG(completion_rate) as avg_completion_rate
    FROM \`${projectId}.${DATASET_ID}.clickup_daily_snapshot\`
    WHERE user_email = '${safeEmail}'
      AND snapshot_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
  `;

  const result = runBigQueryQuery(query);
  return result.length > 0 ? result[0] : null;
}

/**
 * Get team overdue summary
 */
function getTeamOverdueSummary() {
  const projectId = getProjectId();
  const today = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');

  const query = `
    SELECT
      user_email,
      COUNT(*) as total_overdue,
      MAX(days_overdue) as max_days_overdue,
      ROUND(AVG(days_overdue), 1) as avg_days_overdue,
      SUM(CASE WHEN is_chronic THEN 1 ELSE 0 END) as chronic_count
    FROM \`${projectId}.${DATASET_ID}.overdue_snapshots\`
    WHERE snapshot_date = '${today}'
    GROUP BY user_email
    ORDER BY total_overdue DESC
  `;

  return runBigQueryQuery(query);
}

/**
 * Get delay reasons breakdown for this week
 */
function getWeeklyDelayReasons() {
  const projectId = getProjectId();

  const query = `
    SELECT
      delay_reason,
      COUNT(*) as count
    FROM \`${projectId}.${DATASET_ID}.task_delays\`
    WHERE timestamp >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), WEEK(MONDAY))
    GROUP BY delay_reason
    ORDER BY count DESC
  `;

  return runBigQueryQuery(query);
}

/**
 * Get repeat delayed tasks
 */
function getRepeatDelayedTasks() {
  const projectId = getProjectId();

  const query = `
    SELECT
      task_id,
      task_name,
      user_email,
      COUNT(*) as times_delayed
    FROM \`${projectId}.${DATASET_ID}.task_delays\`
    WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 14 DAY)
    GROUP BY task_id, task_name, user_email
    HAVING COUNT(*) >= 3
    ORDER BY times_delayed DESC
  `;

  return runBigQueryQuery(query);
}

/**
 * Get task action count for user today
 */
function getUserTodayTaskActions(email) {
  const projectId = getProjectId();
  const today = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');
  const safeEmail = sanitizeForBQ(email);

  const query = `
    SELECT action_type, COUNT(*) as count
    FROM \`${projectId}.${DATASET_ID}.clickup_task_actions\`
    WHERE user_email = '${safeEmail}'
      AND DATE(timestamp) = '${today}'
    GROUP BY action_type
  `;

  return runBigQueryQuery(query);
}

/**
 * Get real weekly stats for the team (BUG #9 fix)
 * Used by generateWeeklySummary to replace hardcoded values
 */
function getWeeklyTeamStats() {
  const projectId = getProjectId();

  var statsResult = runBigQueryQuery(`
    SELECT
      COUNT(DISTINCT user_email) as total_members,
      COUNT(DISTINCT checkin_date) as total_days,
      COUNT(*) as total_checkins,
      SUM(CASE WHEN is_late THEN 1 ELSE 0 END) as late_checkins
    FROM \`${projectId}.${DATASET_ID}.check_ins\`
    WHERE checkin_date >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
  `);

  var eodResult = runBigQueryQuery(`
    SELECT COUNT(*) as total_eods
    FROM \`${projectId}.${DATASET_ID}.v_eod_reports\`
    WHERE eod_date >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
  `);

  var taskResult = runBigQueryQuery(`
    SELECT
      SUM(tasks_due_today) as total_due,
      SUM(tasks_completed_today) as total_completed,
      SUM(tasks_moved_tomorrow) as total_moved,
      SUM(tasks_overdue) as total_overdue
    FROM \`${projectId}.${DATASET_ID}.clickup_daily_snapshot\`
    WHERE snapshot_date >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
  `);

  var perfectResult = runBigQueryQuery(`
    SELECT user_email
    FROM \`${projectId}.${DATASET_ID}.check_ins\`
    WHERE checkin_date >= DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))
      AND is_late = FALSE
    GROUP BY user_email
    HAVING COUNT(DISTINCT checkin_date) >= 5
  `);

  var stats = statsResult.length > 0 ? statsResult[0] : {};
  var eod = eodResult.length > 0 ? eodResult[0] : {};
  var tasks = taskResult.length > 0 ? taskResult[0] : {};

  var totalMembers = parseInt(stats.total_members) || 1;
  var totalCheckins = parseInt(stats.total_checkins) || 0;
  var lateCheckins = parseInt(stats.late_checkins) || 0;
  var totalEods = parseInt(eod.total_eods) || 0;
  var expectedCheckins = totalMembers * 5; // 5 workdays

  return {
    checkinRate: expectedCheckins > 0 ? Math.round(totalCheckins / expectedCheckins * 100) : 0,
    onTimeRate: totalCheckins > 0 ? Math.round((totalCheckins - lateCheckins) / totalCheckins * 100) : 0,
    eodRate: expectedCheckins > 0 ? Math.round(totalEods / expectedCheckins * 100) : 0,
    avgLateMinutes: 0, // Would need timestamp analysis
    perfectAttendance: perfectResult.map(function (r) { return r.user_email.split('@')[0]; }),
    totalDue: parseInt(tasks.total_due) || 0,
    totalCompleted: parseInt(tasks.total_completed) || 0,
    totalMoved: parseInt(tasks.total_moved) || 0,
    totalOverdue: parseInt(tasks.total_overdue) || 0
  };
}

/**
 * Setup all BigQuery tables (BUG #16 fix)
 * Run once after initial deployment to create required tables
 */
function setupBigQueryTables() {
  var projectId = getProjectId();

  var tables = {
    check_ins: [
      { name: 'checkin_id', type: 'STRING' },
      { name: 'user_email', type: 'STRING' },
      { name: 'checkin_date', type: 'DATE' },
      { name: 'checkin_timestamp', type: 'TIMESTAMP' },
      { name: 'response_text', type: 'STRING' },
      { name: 'is_late', type: 'BOOLEAN' },
      { name: 'created_at', type: 'TIMESTAMP' }
    ],
    eod_reports: [
      { name: 'eod_id', type: 'STRING' },
      { name: 'user_email', type: 'STRING' },
      { name: 'eod_date', type: 'DATE' },
      { name: 'eod_timestamp', type: 'TIMESTAMP' },
      { name: 'tasks_completed', type: 'STRING' },
      { name: 'blockers', type: 'STRING' },
      { name: 'tomorrow_priority', type: 'STRING' },
      { name: 'raw_response', type: 'STRING' },
      { name: 'hours_worked', type: 'FLOAT' },
      { name: 'created_at', type: 'TIMESTAMP' }
    ],
    missed_checkins: [
      { name: 'missed_id', type: 'STRING' },
      { name: 'user_email', type: 'STRING' },
      { name: 'missed_date', type: 'DATE' },
      { name: 'missed_type', type: 'STRING' },
      { name: 'created_at', type: 'TIMESTAMP' }
    ],
    clickup_task_actions: [
      { name: 'action_id', type: 'STRING' },
      { name: 'timestamp', type: 'TIMESTAMP' },
      { name: 'user_email', type: 'STRING' },
      { name: 'task_id', type: 'STRING' },
      { name: 'task_name', type: 'STRING' },
      { name: 'list_id', type: 'STRING' },
      { name: 'list_name', type: 'STRING' },
      { name: 'action_type', type: 'STRING' },
      { name: 'old_status', type: 'STRING' },
      { name: 'new_status', type: 'STRING' },
      { name: 'old_due_date', type: 'STRING' },
      { name: 'new_due_date', type: 'STRING' },
      { name: 'status', type: 'STRING' },
      { name: 'source', type: 'STRING' }
    ],
    task_delays: [
      { name: 'delay_id', type: 'STRING' },
      { name: 'timestamp', type: 'TIMESTAMP' },
      { name: 'user_email', type: 'STRING' },
      { name: 'task_id', type: 'STRING' },
      { name: 'task_name', type: 'STRING' },
      { name: 'original_due_date', type: 'STRING' },
      { name: 'new_due_date', type: 'STRING' },
      { name: 'delay_reason', type: 'STRING' },
      { name: 'delay_count', type: 'INTEGER' },
      { name: 'source', type: 'STRING' }
    ],
    overdue_snapshots: [
      { name: 'snapshot_date', type: 'DATE' },
      { name: 'user_email', type: 'STRING' },
      { name: 'task_id', type: 'STRING' },
      { name: 'task_name', type: 'STRING' },
      { name: 'list_name', type: 'STRING' },
      { name: 'original_due_date', type: 'STRING' },
      { name: 'days_overdue', type: 'INTEGER' },
      { name: 'is_chronic', type: 'BOOLEAN' },
      { name: 'delay_count', type: 'INTEGER' }
    ],
    clickup_daily_snapshot: [
      { name: 'snapshot_date', type: 'DATE' },
      { name: 'user_email', type: 'STRING' },
      { name: 'tasks_due_today', type: 'INTEGER' },
      { name: 'tasks_overdue', type: 'INTEGER' },
      { name: 'tasks_due_this_week', type: 'INTEGER' },
      { name: 'tasks_completed_today', type: 'INTEGER' },
      { name: 'tasks_moved_tomorrow', type: 'INTEGER' },
      { name: 'completion_rate', type: 'FLOAT' }
    ],
    escalations: [
      { name: 'escalation_id', type: 'STRING' },
      { name: 'escalation_type', type: 'STRING' },
      { name: 'user_email', type: 'STRING' },
      { name: 'task_id', type: 'STRING' },
      { name: 'task_name', type: 'STRING' },
      { name: 'days_overdue', type: 'INTEGER' },
      { name: 'recipients', type: 'STRING' },
      { name: 'created_at', type: 'TIMESTAMP' }
    ],
    ai_evaluations: [
      { name: 'evaluation_id', type: 'STRING' },
      { name: 'evaluation_date', type: 'DATE' },
      { name: 'evaluation_text', type: 'STRING' },
      { name: 'team_size', type: 'INTEGER' },
      { name: 'created_at', type: 'TIMESTAMP' }
    ],
    badges_awarded: [
      { name: 'badge_id', type: 'STRING' },
      { name: 'user_email', type: 'STRING' },
      { name: 'badge_key', type: 'STRING' },
      { name: 'badge_emoji', type: 'STRING' },
      { name: 'badge_name', type: 'STRING' },
      { name: 'awarded_at', type: 'TIMESTAMP' }
    ],
    system_events: [
      { name: 'event_id', type: 'STRING' },
      { name: 'timestamp', type: 'TIMESTAMP' },
      { name: 'event_type', type: 'STRING' },
      { name: 'status', type: 'STRING' },
      { name: 'details', type: 'STRING' }
    ],
    sage_hr_syncs: [
      { name: 'sync_date', type: 'TIMESTAMP' },
      { name: 'total_employees', type: 'INTEGER' },
      { name: 'active_employees', type: 'INTEGER' },
      { name: 'on_leave_today', type: 'INTEGER' },
      { name: 'working_today', type: 'INTEGER' }
    ],
    employees: [
      { name: 'employee_id', type: 'STRING' },
      { name: 'email', type: 'STRING' },
      { name: 'name', type: 'STRING' },
      { name: 'department', type: 'STRING' },
      { name: 'position', type: 'STRING' },
      { name: 'manager_email', type: 'STRING' },
      { name: 'status', type: 'STRING' },
      { name: 'start_date', type: 'DATE' },
      { name: 'task_source', type: 'STRING' },
      { name: 'updated_at', type: 'TIMESTAMP' }
    ],
    time_off: [
      { name: 'time_off_id', type: 'STRING' },
      { name: 'user_email', type: 'STRING' },
      { name: 'leave_date', type: 'DATE' },
      { name: 'leave_type', type: 'STRING' },
      { name: 'status', type: 'STRING' },
      { name: 'created_at', type: 'TIMESTAMP' }
    ],
    gamification_streaks: [
      { name: 'streak_id', type: 'STRING' },
      { name: 'user_email', type: 'STRING' },
      { name: 'streak_type', type: 'STRING' },
      { name: 'current_streak', type: 'INTEGER' },
      { name: 'best_streak', type: 'INTEGER' },
      { name: 'last_updated', type: 'TIMESTAMP' }
    ],
    bot_errors: [
      { name: 'error_id', type: 'STRING' },
      { name: 'timestamp', type: 'TIMESTAMP' },
      { name: 'function_name', type: 'STRING' },
      { name: 'error_message', type: 'STRING' },
      { name: 'error_stack', type: 'STRING' },
      { name: 'context', type: 'STRING' }
    ]
  };

  // Create dataset if needed
  try {
    BigQuery.Datasets.get(projectId, DATASET_ID);
    console.log('Dataset already exists: ' + DATASET_ID);
  } catch (e) {
    try {
      BigQuery.Datasets.insert({ datasetReference: { projectId: projectId, datasetId: DATASET_ID } }, projectId);
      console.log('Created dataset: ' + DATASET_ID);
    } catch (e2) {
      console.error('Failed to create dataset:', e2.message);
      return;
    }
  }

  // Create tables
  var created = 0;
  var existing = 0;
  for (var tableName in tables) {
    try {
      BigQuery.Tables.get(projectId, DATASET_ID, tableName);
      console.log('Table already exists: ' + tableName);
      existing++;
    } catch (e) {
      try {
        var tableResource = {
          tableReference: { projectId: projectId, datasetId: DATASET_ID, tableId: tableName },
          schema: { fields: tables[tableName] }
        };
        BigQuery.Tables.insert(tableResource, projectId, DATASET_ID);
        console.log('Created table: ' + tableName);
        created++;
      } catch (e2) {
        console.error('Failed to create table ' + tableName + ':', e2.message);
      }
    }
  }

  console.log('Table setup complete: ' + created + ' created, ' + existing + ' already existed');

  // Handle ALTER TABLE for existing eod_reports table - add hours_worked column if missing
  try {
    var alterQuery = 'ALTER TABLE `' + projectId + '.' + DATASET_ID + '.eod_reports` ADD COLUMN IF NOT EXISTS hours_worked FLOAT64';
    runBigQueryQuery(alterQuery);
    console.log('Ensured hours_worked column exists in eod_reports');
  } catch (e) {
    console.log('hours_worked column may already exist or ALTER failed:', e.message);
  }

  // Add source column to clickup_task_actions if missing
  try {
    var alterActions = 'ALTER TABLE `' + projectId + '.' + DATASET_ID + '.clickup_task_actions` ADD COLUMN IF NOT EXISTS source STRING';
    runBigQueryQuery(alterActions);
    console.log('Ensured source column exists in clickup_task_actions');
  } catch (e) {
    console.log('source column in clickup_task_actions may already exist or ALTER failed:', e.message);
  }

  // Add source column to task_delays if missing
  try {
    var alterDelays = 'ALTER TABLE `' + projectId + '.' + DATASET_ID + '.task_delays` ADD COLUMN IF NOT EXISTS source STRING';
    runBigQueryQuery(alterDelays);
    console.log('Ensured source column exists in task_delays');
  } catch (e) {
    console.log('source column in task_delays may already exist or ALTER failed:', e.message);
  }

  // Create deduplication view for eod_reports (Append-Only Fix)
  try {
    var viewQuery = 'CREATE OR REPLACE VIEW `' + projectId + '.' + DATASET_ID + '.v_eod_reports` AS '
      + 'SELECT * EXCEPT(row_num) FROM ('
      + '  SELECT *, ROW_NUMBER() OVER (PARTITION BY user_email, eod_date ORDER BY created_at DESC) as row_num '
      + '  FROM `' + projectId + '.' + DATASET_ID + '.eod_reports` '
      + ') WHERE row_num = 1';
    runBigQueryQuery(viewQuery);
    console.log('Created/Updated deduplication view v_eod_reports');
  } catch (e) {
    console.error('Failed to create v_eod_reports view:', e.message);
  }
}

/**
 * Get last week's wins for Monday kickoff message
 * Returns: { topCompleter, totalCompleted, teamCheckinRate }
 */
function getLastWeekWins() {
  var projectId = getProjectId();

  // Top completer last week
  var topResult = runBigQueryQuery(
    'SELECT user_email, SUM(tasks_completed_today) as total_completed'
    + ' FROM `' + projectId + '.' + DATASET_ID + '.clickup_daily_snapshot`'
    + ' WHERE snapshot_date >= DATE_SUB(DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)), INTERVAL 7 DAY)'
    + '   AND snapshot_date < DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))'
    + ' GROUP BY user_email'
    + ' ORDER BY total_completed DESC'
    + ' LIMIT 1'
  );

  // Total completed last week
  var totalResult = runBigQueryQuery(
    'SELECT SUM(tasks_completed_today) as total'
    + ' FROM `' + projectId + '.' + DATASET_ID + '.clickup_daily_snapshot`'
    + ' WHERE snapshot_date >= DATE_SUB(DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)), INTERVAL 7 DAY)'
    + '   AND snapshot_date < DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))'
  );

  // Check-in rate last week
  var checkinResult = runBigQueryQuery(
    'SELECT COUNT(*) as total_checkins, COUNT(DISTINCT user_email) as unique_users'
    + ' FROM `' + projectId + '.' + DATASET_ID + '.check_ins`'
    + ' WHERE checkin_date >= DATE_SUB(DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)), INTERVAL 7 DAY)'
    + '   AND checkin_date < DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY))'
  );

  var topCompleter = topResult.length > 0 ? {
    email: topResult[0].user_email,
    name: topResult[0].user_email.split('@')[0],
    count: parseInt(topResult[0].total_completed) || 0
  } : null;

  var totalCompleted = totalResult.length > 0 ? parseInt(totalResult[0].total) || 0 : 0;

  var checkins = checkinResult.length > 0 ? parseInt(checkinResult[0].total_checkins) || 0 : 0;
  var uniqueUsers = checkinResult.length > 0 ? parseInt(checkinResult[0].unique_users) || 1 : 1;
  var teamCheckinRate = uniqueUsers > 0 ? Math.round(checkins / (uniqueUsers * 5) * 100) : 0;

  return {
    topCompleter: topCompleter,
    totalCompleted: totalCompleted,
    teamCheckinRate: teamCheckinRate
  };
}

/**
 * Get active streaks that are at risk (for Monday kickoff)
 * Returns array of { email, name, streak }
 */
function getActiveStreaks() {
  var projectId = getProjectId();

  var result = runBigQueryQuery(
    'WITH ranked AS ('
    + '  SELECT user_email, checkin_date,'
    + '    DATE_DIFF(checkin_date, LAG(checkin_date) OVER (PARTITION BY user_email ORDER BY checkin_date), DAY) as gap'
    + '  FROM `' + projectId + '.' + DATASET_ID + '.check_ins`'
    + '  WHERE checkin_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY)'
    + '  AND is_late = FALSE'
    + '),'
    + 'streak_breaks AS ('
    + '  SELECT user_email, checkin_date, gap,'
    + '    SUM(CASE WHEN gap > 3 OR gap IS NULL THEN 1 ELSE 0 END) OVER (PARTITION BY user_email ORDER BY checkin_date) as grp'
    + '  FROM ranked'
    + ')'
    + ' SELECT user_email, COUNT(*) as streak_length'
    + ' FROM streak_breaks'
    + ' WHERE grp = (SELECT MAX(grp) FROM streak_breaks sb WHERE sb.user_email = streak_breaks.user_email)'
    + ' GROUP BY user_email'
    + ' HAVING COUNT(*) >= 5'
    + ' ORDER BY streak_length DESC'
  );

  return result.map(function (r) {
    return {
      email: r.user_email,
      name: r.user_email.split('@')[0],
      streak: parseInt(r.streak_length) || 0
    };
  });
}

/**
 * Update today's EOD report with hours (bare-number follow-up)
 */
function updateTodayEodHours(email, hours) {
  var projectId = getProjectId();
  var safeEmail = sanitizeForBQ(email);
  var today = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');

  // Append-only pattern: INSERT new row with hours instead of UPDATE
  var query = 'INSERT INTO `' + projectId + '.' + DATASET_ID + '.eod_reports` '
    + '(eod_id, user_email, eod_date, eod_timestamp, tasks_completed, blockers, tomorrow_priority, raw_response, hours_worked, created_at) '
    + 'SELECT \'' + Utilities.getUuid() + '\', \'' + safeEmail + '\', eod_date, eod_timestamp, tasks_completed, blockers, tomorrow_priority, raw_response, ' + hours + ', CURRENT_TIMESTAMP() '
    + 'FROM `' + projectId + '.' + DATASET_ID + '.v_eod_reports` '
    + 'WHERE user_email = \'' + safeEmail + '\' AND eod_date = \'' + today + '\'';

  runBigQueryQuery(query);
}

/**
 * Get weekly hours data - per-person daily hours for current week
 */
function getWeeklyHoursData() {
  var projectId = getProjectId();
  var query = 'SELECT user_email, eod_date, hours_worked, tasks_completed'
    + ' FROM `' + projectId + '.' + DATASET_ID + '.v_eod_reports`'
    + ' WHERE eod_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)'
    + ' AND hours_worked IS NOT NULL'
    + ' ORDER BY user_email, eod_date';
  return runBigQueryQuery(query);
}

/**
 * Get hours trends - weekly averages for 4-week trends
 */
function getHoursTrends() {
  var projectId = getProjectId();
  var query = 'SELECT'
    + ' user_email,'
    + ' EXTRACT(ISOWEEK FROM eod_date) AS week_num,'
    + ' MIN(eod_date) AS week_start,'
    + ' ROUND(AVG(hours_worked), 1) AS avg_daily_hours,'
    + ' ROUND(SUM(hours_worked), 1) AS total_hours,'
    + ' COUNT(*) AS days_reported'
    + ' FROM `' + projectId + '.' + DATASET_ID + '.v_eod_reports`'
    + ' WHERE eod_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 28 DAY)'
    + ' AND hours_worked IS NOT NULL'
    + ' GROUP BY user_email, week_num'
    + ' ORDER BY user_email, week_num';
  return runBigQueryQuery(query);
}
