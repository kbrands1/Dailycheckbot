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
  const todayCheckIns = getTodayCheckIns();
  const checkedInEmails = new Set(todayCheckIns.map(c => c.user_email));
  
  const missing = teamMembers.filter(m => !checkedInEmails.has(m.email));
  
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
  const todayEods = getTodayEodReports();
  const submittedEmails = new Set(todayEods.map(e => e.user_email));
  
  const missing = teamMembers.filter(m => !submittedEmails.has(m.email));
  
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
