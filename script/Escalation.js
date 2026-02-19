/**
 * Escalation.gs - Escalation Handling
 * Manages alerts and escalations for missed check-ins, overdue tasks, etc.
 */

/**
 * Send escalation for missed check-in
 */
function escalateMissedCheckIn(memberEmail, memberName) {
  const config = getConfig();
  const recipients = getReportRecipients('escalation');
  
  // Send individual DMs to employee and managers (BUG #5 fix)
  const allRecipients = [memberEmail, ...recipients.filter(r => r !== memberEmail)];

  const message = getMissedCheckInEscalation(memberEmail, memberName);

  sendEscalationToRecipients(allRecipients, message);
  
  // Log escalation
  insertIntoBigQuery('escalations', [{
    escalation_id: Utilities.getUuid(),
    escalation_type: 'MISSED_CHECKIN',
    user_email: memberEmail,
    recipients: JSON.stringify(recipients),
    created_at: new Date().toISOString()
  }]);
  
  logSystemEvent('ESCALATION', 'MISSED_CHECKIN', { user: memberEmail });
}

/**
 * Send escalation for missed EOD
 */
function escalateMissedEod(memberEmail, memberName) {
  const config = getConfig();
  const recipients = getReportRecipients('escalation');
  
  const allRecipients = [memberEmail, ...recipients.filter(r => r !== memberEmail)];

  const message = getMissedEodEscalation(memberEmail, memberName);

  sendEscalationToRecipients(allRecipients, message);
  
  insertIntoBigQuery('escalations', [{
    escalation_id: Utilities.getUuid(),
    escalation_type: 'MISSED_EOD',
    user_email: memberEmail,
    recipients: JSON.stringify(recipients),
    created_at: new Date().toISOString()
  }]);
  
  logSystemEvent('ESCALATION', 'MISSED_EOD', { user: memberEmail });
}

/**
 * Send overdue task escalation
 */
function escalateOverdueTask(taskId, taskName, assigneeEmail, daysOverdue) {
  const config = getConfig();
  const recipients = getReportRecipients('escalation');
  
  const task = getTaskById(taskId);
  const taskUrl = task ? task.url : '';
  
  const message = `🚨 **Overdue Task Alert**\n\n` +
    `Task: "${taskName}"\n` +
    `Assigned to: ${assigneeEmail}\n` +
    `Days overdue: ${daysOverdue}\n\n` +
    `This task has been overdue for ${daysOverdue} days.\n` +
    `Please review and take action.\n\n` +
    (taskUrl ? `[View in ClickUp](${taskUrl})` : '');
  
  recipients.forEach(recipient => {
    sendDirectMessage(recipient, message);
  });
  
  insertIntoBigQuery('escalations', [{
    escalation_id: Utilities.getUuid(),
    escalation_type: 'OVERDUE_TASK',
    user_email: assigneeEmail,
    task_id: taskId,
    task_name: taskName,
    days_overdue: daysOverdue,
    recipients: JSON.stringify(recipients),
    created_at: new Date().toISOString()
  }]);
  
  logSystemEvent('ESCALATION', 'OVERDUE_TASK', { 
    user: assigneeEmail, 
    task: taskName, 
    days: daysOverdue 
  });
}

/**
 * Check and send morning escalations
 */
function checkMorningEscalations() {
  const teamMembers = getCachedWorkingEmployees();
  const config = getConfig();
  const todayCheckIns = getTodayCheckIns();
  const checkedInEmails = new Set(todayCheckIns.map(c => c.user_email));

  // Skip not-tracked users from escalation
  const missing = teamMembers.filter(function(m) {
    if (checkedInEmails.has(m.email)) return false;
    var fullMember = config.team_members.find(function(tm) { return tm.email === m.email; });
    if (fullMember && fullMember.tracking_mode === 'not_tracked') return false;
    return true;
  });
  
  for (const member of missing) {
    // Log missed check-in
    logMissedCheckIn(member.email, new Date(), 'CHECKIN');
    
    // Send escalation
    escalateMissedCheckIn(member.email, member.name);
  }
  
  // Also check for chronic overdue
  checkChronicOverdueAlerts();

  // Check team threshold
  checkTeamOverdueThreshold();

  // Check for persistent blockers
  checkPersistentBlockers();

  return {
    escalated: missing.length,
    members: missing.map(m => m.email)
  };
}

/**
 * Check and send EOD escalations
 */
function checkEodEscalations() {
  const teamMembers = getCachedWorkingEmployees();
  const config = getConfig();
  const todayEods = getTodayEodReports();
  const submittedEmails = new Set(todayEods.map(e => e.user_email));

  // Skip not-tracked users from escalation
  const missing = teamMembers.filter(function(m) {
    if (submittedEmails.has(m.email)) return false;
    var fullMember = config.team_members.find(function(tm) { return tm.email === m.email; });
    if (fullMember && fullMember.tracking_mode === 'not_tracked') return false;
    return true;
  });
  
  for (const member of missing) {
    // Log missed EOD
    logMissedCheckIn(member.email, new Date(), 'EOD');
    
    // Send escalation
    escalateMissedEod(member.email, member.name);
  }
  
  return {
    escalated: missing.length,
    members: missing.map(m => m.email)
  };
}

/**
 * Daily check for capacity warnings
 * Alerts if someone has "no time" delay reason too many times
 */
function checkCapacityWarnings() {
  const config = getConfig();
  const projectId = getProjectId();
  const threshold = 5; // 5+ "no time" delays in a week
  
  const query = `
    SELECT 
      user_email,
      COUNT(*) as no_time_count
    FROM \`${projectId}.checkin_bot.task_delays\`
    WHERE delay_reason = 'NO_TIME'
      AND timestamp >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), WEEK(MONDAY))
    GROUP BY user_email
    HAVING COUNT(*) >= ${threshold}
  `;
  
  const results = runBigQueryQuery(query);
  
  if (results && results.length > 0) {
    const recipients = getReportRecipients('escalation');
    
    results.forEach(row => {
      const message = `⚠️ **Capacity Warning**\n\n` +
        `${row.user_email} has used "No time today" as a delay reason **${row.no_time_count} times** this week.\n\n` +
        `This may indicate workload issues. Consider reviewing their task assignments.`;
      
      recipients.forEach(recipient => {
        sendDirectMessage(recipient, message);
      });
    });
    
    logSystemEvent('CAPACITY_WARNING', 'SENT', {
      peopleWarned: results.length
    });
  }
}

/**
 * Check for persistent blockers (same blocker 2+ consecutive days)
 * Called as part of morning escalations
 */
function checkPersistentBlockers() {
  var projectId = getProjectId();
  var today = new Date();
  var config = getConfig();
  var blockerDays = parseInt(config.settings.blocker_escalation_days) || 2;
  var lookback = new Date(today);
  lookback.setDate(today.getDate() - (blockerDays + 1));
  var startStr = Utilities.formatDate(lookback, 'America/Chicago', 'yyyy-MM-dd');

  var query = 'SELECT user_email, blockers, eod_date ' +
    'FROM `' + projectId + '.' + DATASET_ID + '.eod_reports` ' +
    'WHERE eod_date >= "' + startStr + '" AND blockers IS NOT NULL AND blockers != "" ' +
    'ORDER BY user_email, eod_date';

  var results = runBigQueryQuery(query);

  // Group by user
  var userBlockers = {};
  results.forEach(function(r) {
    if (!userBlockers[r.user_email]) userBlockers[r.user_email] = [];
    userBlockers[r.user_email].push({ date: r.eod_date, blocker: r.blockers });
  });

  var teamMembers = getCachedWorkingEmployees();
  var nameMap = {};
  teamMembers.forEach(function(m) { nameMap[m.email] = m.name || m.email.split('@')[0]; });

  // Check for consecutive days with blockers
  Object.keys(userBlockers).forEach(function(email) {
    var entries = userBlockers[email];
    if (entries.length >= blockerDays) {
      var name = nameMap[email] || email;
      var blockerTexts = entries.map(function(e) { return e.date + ': ' + e.blocker; }).join('\n');

      var message = '🔴 *Persistent Blocker Alert*\n\n' +
        name + ' has reported blockers for ' + entries.length + ' consecutive days:\n\n' +
        blockerTexts + '\n\n' +
        'This may need manager intervention.';

      sendDirectMessage(config.settings.manager_email, message);

      insertIntoBigQuery('escalations', [{
        escalation_id: Utilities.getUuid(),
        escalation_type: 'PERSISTENT_BLOCKER',
        user_email: email,
        recipients: JSON.stringify([config.settings.manager_email]),
        created_at: new Date().toISOString()
      }]);
    }
  });
}
