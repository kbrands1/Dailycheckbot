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
      var alertConfig = getConfig();
      sendDirectMessage(alertConfig.settings.manager_email,
        '⚠️ BigQuery service account token failed. Using built-in fallback. Check SA key expiry.');
    } catch (alertErr) { /* don't let alert failure break the query */ }
    try {
      const request = { query: query, useLegacySql: false };
      let queryResults = BigQuery.Jobs.query(request, projectId);
      if (!queryResults.rows) return [];
      return queryResults.rows.map(row => {
        const obj = {};
        row.f.forEach((cell, i) => {
          obj[queryResults.schema.fields[i].name] = cell.v;
        });
        return obj;
      });
    } catch (e) {
      console.error('Built-in BigQuery fallback failed:', e.message);
      return [];
    }
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
 * Check if a record already exists for a user on a given date
 * Used for deduplication of check-ins and EODs
 */
function hasExistingRecord(tableName, emailField, dateField, email, date) {
  var safeEmail = sanitizeForBQ(email);
  var dateStr = Utilities.formatDate(date, 'America/Chicago', 'yyyy-MM-dd');
  var query = 'SELECT COUNT(*) as cnt FROM `' + getProjectId() + '.' + DATASET_ID + '.' + tableName +
    '` WHERE ' + emailField + ' = "' + safeEmail + '" AND ' + dateField + ' = "' + dateStr + '"';
  var results = runBigQueryQuery(query);
  return results.length > 0 && parseInt(results[0].cnt) > 0;
}

/**
 * Log a check-in (with deduplication)
 */
function logCheckIn(email, timestamp, response, isLate) {
  // Deduplication: skip if already checked in today
  if (hasExistingRecord('check_ins', 'user_email', 'checkin_date', email, timestamp)) {
    console.log('Duplicate check-in skipped for ' + email);
    return null;
  }

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
 * Log an EOD report (with deduplication)
 */
function logEodReport(email, timestamp, tasksCompleted, blockers, tomorrowPriority, rawResponse, hoursWorked) {
  // Deduplication: skip if already submitted EOD today
  if (hasExistingRecord('eod_reports', 'user_email', 'eod_date', email, timestamp)) {
    console.log('Duplicate EOD report skipped for ' + email);
    return null;
  }

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
function logTaskAction(userEmail, taskId, taskName, listId, listName, actionType, oldStatus, newStatus, oldDueDate, newDueDate, status, source, outcome, deliverableLink) {
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
    source: source || 'clickup',
    outcome: outcome || null,
    deliverable_link: deliverableLink || null
  };

  insertIntoBigQuery('clickup_task_actions', [row]);
}

/**
 * Get today's task actions for a user (to check if they completed any tasks)
 */
function getTodayTaskActions(userEmail) {
  var projectId = getProjectId();
  var today = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');
  var query = 'SELECT action_type, task_name FROM `' + projectId + '.' + DATASET_ID + '.clickup_task_actions` ' +
    'WHERE user_email = "' + userEmail + '" AND DATE(timestamp) = "' + today + '"';
  try {
    return runBigQueryQuery(query);
  } catch (e) {
    console.error('getTodayTaskActions failed:', e.message);
    return [];
  }
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
    SELECT user_email, eod_timestamp, tasks_completed, blockers, tomorrow_priority, hours_worked
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
    SELECT action_type, COUNT(*) as count FROM (
      SELECT task_id, action_type FROM (
        SELECT task_id, action_type, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY timestamp DESC) as rn
        FROM \`${projectId}.${DATASET_ID}.clickup_task_actions\`
        WHERE user_email = '${safeEmail}'
          AND DATE(timestamp) = '${today}'
      ) WHERE rn = 1
    ) GROUP BY action_type
  `;

  return runBigQueryQuery(query);
}

/**
 * Get today's completed task outcomes for a user (for AI evaluation)
 * Returns task name, outcome, deliverable_link, and hours logged
 */
function getUserTodayTaskOutcomes(email) {
  var projectId = getProjectId();
  var today = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');
  var safeEmail = sanitizeForBQ(email);

  var query = 'SELECT task_name, outcome, deliverable_link ' +
    'FROM `' + projectId + '.' + DATASET_ID + '.clickup_task_actions` ' +
    'WHERE user_email = \'' + safeEmail + '\' AND DATE(timestamp) = \'' + today + '\' ' +
    'AND action_type = \'COMPLETE\' AND outcome IS NOT NULL AND outcome != \'\' ' +
    'ORDER BY timestamp';

  try {
    return runBigQueryQuery(query);
  } catch (e) {
    console.error('getUserTodayTaskOutcomes failed:', e.message);
    return [];
  }
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
      { name: 'source', type: 'STRING' },
      { name: 'outcome', type: 'STRING' },
      { name: 'deliverable_link', type: 'STRING' }
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

  // Add outcome + deliverable_link columns to clickup_task_actions if missing
  try {
    var alterOutcome = 'ALTER TABLE `' + projectId + '.' + DATASET_ID + '.clickup_task_actions` ADD COLUMN IF NOT EXISTS outcome STRING';
    runBigQueryQuery(alterOutcome);
    console.log('Ensured outcome column exists in clickup_task_actions');
  } catch (e) {
    console.log('outcome column in clickup_task_actions may already exist or ALTER failed:', e.message);
  }
  try {
    var alterDeliverable = 'ALTER TABLE `' + projectId + '.' + DATASET_ID + '.clickup_task_actions` ADD COLUMN IF NOT EXISTS deliverable_link STRING';
    runBigQueryQuery(alterDeliverable);
    console.log('Ensured deliverable_link column exists in clickup_task_actions');
  } catch (e) {
    console.log('deliverable_link column in clickup_task_actions may already exist or ALTER failed:', e.message);
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

  // Create deduplication view for prompt_log (Append-Only Fix)
  // logPromptResponse inserts a new row instead of UPDATE to avoid streaming buffer errors
  try {
    var promptViewQuery = 'CREATE OR REPLACE VIEW `' + projectId + '.' + DATASET_ID + '.v_prompt_log` AS '
      + 'SELECT * EXCEPT(row_num) FROM ('
      + '  SELECT *, ROW_NUMBER() OVER (PARTITION BY prompt_id ORDER BY created_at DESC) as row_num '
      + '  FROM `' + projectId + '.' + DATASET_ID + '.prompt_log` '
      + ') WHERE row_num = 1';
    runBigQueryQuery(promptViewQuery);
    console.log('Created/Updated deduplication view v_prompt_log');
  } catch (e) {
    console.error('Failed to create v_prompt_log view:', e.message);
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

// ============================================
// AI EVALUATION HISTORICAL DATA (V2)
// ============================================

/**
 * Get weekly attendance stats for ALL team members (batched)
 * Returns: [{user_email, checkin_days, late_days, eod_days}]
 */
function getTeamWeeklyAttendanceStats() {
  var projectId = getProjectId();
  var query = 'SELECT '
    + '  c.user_email, '
    + '  COUNT(DISTINCT c.checkin_date) as checkin_days, '
    + '  SUM(CASE WHEN c.is_late THEN 1 ELSE 0 END) as late_days, '
    + '  COUNT(DISTINCT e.eod_date) as eod_days '
    + 'FROM `' + projectId + '.' + DATASET_ID + '.check_ins` c '
    + 'LEFT JOIN `' + projectId + '.' + DATASET_ID + '.v_eod_reports` e '
    + '  ON c.user_email = e.user_email AND c.checkin_date = e.eod_date '
    + 'WHERE c.checkin_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) '
    + 'GROUP BY c.user_email';
  return runBigQueryQuery(query);
}

/**
 * Get task completion stats for ALL team members (batched)
 * Returns: [{user_email, total_due, total_completed, total_moved, total_overdue, avg_completion_rate}]
 */
function getTeamTaskStats() {
  var projectId = getProjectId();
  var query = 'SELECT '
    + '  user_email, '
    + '  SUM(tasks_due_today) as total_due, '
    + '  SUM(tasks_completed_today) as total_completed, '
    + '  SUM(tasks_moved_tomorrow) as total_moved, '
    + '  SUM(tasks_overdue) as total_overdue, '
    + '  ROUND(AVG(completion_rate), 1) as avg_completion_rate '
    + 'FROM `' + projectId + '.' + DATASET_ID + '.clickup_daily_snapshot` '
    + 'WHERE snapshot_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY) '
    + 'GROUP BY user_email';
  return runBigQueryQuery(query);
}

/**
 * Get on-time check-in streaks for ALL team members (batched)
 * Returns: [{user_email, streak_length}]
 */
function getTeamStreaks() {
  var projectId = getProjectId();
  var query = 'WITH ranked AS ('
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
    + ' GROUP BY user_email';
  return runBigQueryQuery(query);
}

/**
 * Get yesterday's stated priorities (tomorrow_priority) for each user
 * Handles Monday → Friday lookback automatically
 * Returns: [{user_email, tomorrow_priority}]
 */
function getYesterdayEodPriorities() {
  var projectId = getProjectId();
  var query = 'SELECT user_email, tomorrow_priority '
    + 'FROM `' + projectId + '.' + DATASET_ID + '.v_eod_reports` '
    + 'WHERE eod_date = ( '
    + '  SELECT MAX(eod_date) FROM `' + projectId + '.' + DATASET_ID + '.v_eod_reports` '
    + '  WHERE eod_date < CURRENT_DATE() '
    + '  AND eod_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 4 DAY) '
    + ') '
    + 'AND tomorrow_priority IS NOT NULL '
    + 'AND tomorrow_priority != ""';
  return runBigQueryQuery(query);
}

/**
 * Get yesterday's stated priority for a single user
 * Returns: string or null
 */
function getUserYesterdayPriority(email) {
  var projectId = getProjectId();
  var query = 'SELECT tomorrow_priority '
    + 'FROM `' + projectId + '.' + DATASET_ID + '.v_eod_reports` '
    + 'WHERE user_email = "' + email + '" '
    + 'AND eod_date = ( '
    + '  SELECT MAX(eod_date) FROM `' + projectId + '.' + DATASET_ID + '.v_eod_reports` '
    + '  WHERE eod_date < CURRENT_DATE() '
    + '  AND eod_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 4 DAY) '
    + '  AND user_email = "' + email + '" '
    + ') '
    + 'AND tomorrow_priority IS NOT NULL '
    + 'AND tomorrow_priority != ""';
  var results = runBigQueryQuery(query);
  return results.length > 0 ? results[0].tomorrow_priority : null;
}

/**
 * Get the most recent AI evaluation for continuity
 * Returns: {evaluation_date, evaluation_text} or null
 */
function getLastAiEvaluation() {
  var projectId = getProjectId();
  var query = 'SELECT evaluation_date, evaluation_text '
    + 'FROM `' + projectId + '.' + DATASET_ID + '.ai_evaluations` '
    + 'WHERE evaluation_date < CURRENT_DATE() '
    + 'ORDER BY evaluation_date DESC '
    + 'LIMIT 1';
  var results = runBigQueryQuery(query);
  return results.length > 0 ? results[0] : null;
}

// ============================================
// PROMPT LOGGING (V2)
// ============================================

/**
 * Log a prompt sent to a user
 * Returns the prompt_id for tracking
 */
function logPromptSent(email, promptType) {
  var promptId = Utilities.getUuid();
  var now = new Date();
  var row = {
    prompt_id: promptId,
    user_email: email,
    prompt_type: promptType,
    sent_at: now.toISOString(),
    response_received: false,
    response_at: null,
    response_latency_minutes: null,
    created_at: now.toISOString()
  };
  insertIntoBigQuery('prompt_log', [row]);

  // Cache the prompt_id for this user+type so we can match the response
  // Using prompt type in key prevents collisions when multiple prompts sent before response
  var cache = CacheService.getScriptCache();
  cache.put('LAST_PROMPT_' + promptType + '_' + email, JSON.stringify({
    prompt_id: promptId,
    prompt_type: promptType,
    sent_at: now.toISOString()
  }), 14400); // 4 hour TTL
  return promptId;
}

/**
 * Log a prompt response from a user
 * Matches to the last sent prompt of given type and calculates latency
 * Uses append-only INSERT instead of UPDATE to avoid BigQuery streaming buffer errors
 * @param {string} email User email
 * @param {string} promptType The prompt type to match (e.g. 'CHECKIN', 'EOD')
 */
function logPromptResponse(email, promptType) {
  var cache = CacheService.getScriptCache();
  var raw = cache.get('LAST_PROMPT_' + promptType + '_' + email);
  if (!raw) return null;

  var promptData = JSON.parse(raw);
  var now = new Date();
  var sentAt = new Date(promptData.sent_at);
  var latencyMinutes = Math.round((now - sentAt) / 60000 * 10) / 10;

  // Append-only pattern: INSERT a new row with response data (avoids streaming buffer DML error)
  // Use v_prompt_log view to deduplicate by prompt_id (takes latest row)
  try {
    var row = {
      prompt_id: promptData.prompt_id,
      user_email: email,
      prompt_type: promptData.prompt_type,
      sent_at: promptData.sent_at,
      response_received: true,
      response_at: now.toISOString(),
      response_latency_minutes: latencyMinutes,
      created_at: now.toISOString()
    };
    insertIntoBigQuery('prompt_log', [row]);
  } catch (e) {
    console.warn('prompt_log INSERT failed:', e.message);
  }

  cache.remove('LAST_PROMPT_' + promptType + '_' + email);
  return { prompt_id: promptData.prompt_id, latency_minutes: latencyMinutes, prompt_type: promptData.prompt_type };
}

// ============================================
// TASK PUSH COUNT TRACKING (V2)
// ============================================

/**
 * Get push count for a task (how many times it was moved to "Tomorrow")
 */
function getTaskPushCount(taskId) {
  var projectId = getProjectId();
  var query = 'SELECT COUNT(*) as push_count FROM `' + projectId + '.' + DATASET_ID + '.clickup_task_actions` ' +
    'WHERE task_id = "' + taskId + '" AND action_type = "TOMORROW"';
  var results = runBigQueryQuery(query);
  return results.length > 0 ? parseInt(results[0].push_count) : 0;
}

/**
 * Get all tasks pushed 3+ times (chronic delays)
 */
function getChronicallyDelayedTasks() {
  var projectId = getProjectId();
  var query = 'SELECT task_id, task_name, user_email, COUNT(*) as push_count, ' +
    'MAX(timestamp) as last_pushed ' +
    'FROM `' + projectId + '.' + DATASET_ID + '.clickup_task_actions` ' +
    'WHERE action_type = "TOMORROW" ' +
    'GROUP BY task_id, task_name, user_email ' +
    'HAVING push_count >= 3 ' +
    'ORDER BY push_count DESC';
  return runBigQueryQuery(query);
}

// ============================================
// V2 TABLE CREATION
// ============================================

/**
 * Create all new BigQuery tables for V2 features
 * Run this once during setup
 */
function createV2Tables() {
  var projectId = getProjectId();

  var tables = [
    {
      name: 'prompt_log',
      schema: [
        { name: 'prompt_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'user_email', type: 'STRING', mode: 'REQUIRED' },
        { name: 'prompt_type', type: 'STRING', mode: 'REQUIRED' },
        { name: 'sent_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
        { name: 'response_received', type: 'BOOLEAN' },
        { name: 'response_at', type: 'TIMESTAMP' },
        { name: 'response_latency_minutes', type: 'FLOAT' },
        { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' }
      ]
    },
    {
      name: 'daily_adoption_metrics',
      schema: [
        { name: 'metric_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'metric_date', type: 'DATE', mode: 'REQUIRED' },
        { name: 'user_email', type: 'STRING', mode: 'REQUIRED' },
        { name: 'checkin_prompted', type: 'BOOLEAN' },
        { name: 'checkin_responded', type: 'BOOLEAN' },
        { name: 'checkin_latency_minutes', type: 'FLOAT' },
        { name: 'checkin_is_late', type: 'BOOLEAN' },
        { name: 'eod_prompted', type: 'BOOLEAN' },
        { name: 'eod_responded', type: 'BOOLEAN' },
        { name: 'eod_latency_minutes', type: 'FLOAT' },
        { name: 'eod_word_count', type: 'INTEGER' },
        { name: 'eod_hours_included', type: 'BOOLEAN' },
        { name: 'eod_blockers_included', type: 'BOOLEAN' },
        { name: 'eod_tomorrow_included', type: 'BOOLEAN' },
        { name: 'used_task_buttons', type: 'BOOLEAN' },
        { name: 'button_actions_count', type: 'INTEGER' },
        { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' }
      ]
    },
    {
      name: 'weekly_adoption_scores',
      schema: [
        { name: 'score_id', type: 'STRING', mode: 'REQUIRED' },
        { name: 'week_start', type: 'DATE', mode: 'REQUIRED' },
        { name: 'week_end', type: 'DATE', mode: 'REQUIRED' },
        { name: 'user_email', type: 'STRING', mode: 'REQUIRED' },
        { name: 'checkin_response_rate', type: 'INTEGER' },
        { name: 'eod_response_rate', type: 'INTEGER' },
        { name: 'avg_checkin_latency_minutes', type: 'FLOAT' },
        { name: 'avg_eod_latency_minutes', type: 'FLOAT' },
        { name: 'avg_eod_word_count', type: 'INTEGER' },
        { name: 'hours_inclusion_rate', type: 'INTEGER' },
        { name: 'tomorrow_inclusion_rate', type: 'INTEGER' },
        { name: 'button_adoption_rate', type: 'INTEGER' },
        { name: 'adoption_score', type: 'INTEGER' },
        { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED' }
      ]
    }
  ];

  tables.forEach(function (table) {
    try {
      var resource = {
        tableReference: {
          projectId: projectId,
          datasetId: DATASET_ID,
          tableId: table.name
        },
        schema: { fields: table.schema }
      };
      BigQuery.Tables.insert(resource, projectId, DATASET_ID);
      console.log('Created table: ' + table.name);
    } catch (e) {
      if (e.message.includes('Already Exists')) {
        console.log('Table already exists: ' + table.name);
      } else {
        console.error('Error creating table ' + table.name + ':', e.message);
      }
    }
  });
}

/**
 * Get recent EOD raw responses for a user (for anti-gaming comparison)
 */
function getRecentEodRawResponses(email, days) {
  var projectId = getProjectId();
  var safeEmail = sanitizeForBQ(email);
  var safeDays = parseInt(days) || 7;

  var query = 'SELECT eod_date, raw_response '
    + 'FROM `' + projectId + '.' + DATASET_ID + '.v_eod_reports` '
    + 'WHERE user_email = \'' + safeEmail + '\' '
    + 'AND eod_date >= DATE_SUB(CURRENT_DATE(), INTERVAL ' + safeDays + ' DAY) '
    + 'AND eod_date < CURRENT_DATE() '
    + 'AND raw_response IS NOT NULL '
    + 'ORDER BY eod_date DESC '
    + 'LIMIT 5';

  return runBigQueryQuery(query);
}
