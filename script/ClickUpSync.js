/**
 * ClickUpSync.gs - Scheduled Sync & Snapshot Functions
 * Handles daily ClickUp syncs and metric snapshots
 */

/**
 * Daily ClickUp sync - runs at 6:15 AM
 * Refreshes cache and prepares task data for the day
 */
function dailyClickUpSync() {
  console.log('Starting daily ClickUp sync...');
  
  if (!isWorkday()) {
    console.log('Not a workday, skipping ClickUp sync');
    return;
  }
  
  const config = getConfig();
  if (!config.clickup_config.enabled) {
    console.log('ClickUp integration disabled');
    return;
  }
  
  // Clear cache to force fresh data
  clearClickUpCache();
  
  // Refresh workspace structure
  const structure = getWorkspaceStructure();
  
  if (!structure) {
    logSystemEvent('CLICKUP_SYNC', 'FAILED', { error: 'Could not fetch workspace structure' });
    
    // Alert manager
    sendDirectMessage(
      config.settings.manager_email,
      '⚠️ **ClickUp Sync Failed**\n\nCould not connect to ClickUp API. Task features will be limited today.'
    );
    return;
  }
  
  console.log(`Synced ${structure.lists.length} lists, ${Object.keys(structure.members).length} members`);
  
  // Get all working team members
  const teamMembers = getCachedWorkingEmployees();
  
  // Pre-fetch tasks for metrics
  let totalTasksToday = 0;
  let totalOverdue = 0;
  const overdueByPerson = {};
  
  for (const member of teamMembers) {
    const tasks = getTasksDueForUser(member.email, 'today');
    totalTasksToday += tasks.filter(t => !t.isOverdue).length;
    
    const overdue = tasks.filter(t => t.isOverdue);
    totalOverdue += overdue.length;
    
    if (overdue.length > 0) {
      overdueByPerson[member.email] = {
        count: overdue.length,
        maxDays: Math.max(...overdue.map(t => t.daysOverdue)),
        tasks: overdue
      };
    }
  }
  
  // Log sync completion
  logSystemEvent('CLICKUP_SYNC', 'SUCCESS', {
    lists: structure.lists.length,
    members: Object.keys(structure.members).length,
    tasksToday: totalTasksToday,
    totalOverdue: totalOverdue,
    peopleWithOverdue: Object.keys(overdueByPerson).length
  });
  
  console.log(`ClickUp sync complete: ${totalTasksToday} tasks due today, ${totalOverdue} overdue`);
  
  // Store overdue snapshot
  saveOverdueSnapshot(overdueByPerson);
  
  // Check for chronic overdue alerts
  checkChronicOverdueAlerts();
  
  // Check team overdue threshold
  checkTeamOverdueThreshold();
}

/**
 * Save overdue snapshot to BigQuery
 */
function saveOverdueSnapshot(overdueByPerson) {
  const snapshots = [];
  
  for (const [email, data] of Object.entries(overdueByPerson)) {
    for (const task of data.tasks) {
      snapshots.push({
        user_email: email,
        task_id: task.id,
        task_name: task.name,
        list_name: task.listName,
        original_due_date: task.dueDate ? Utilities.formatDate(task.dueDate, 'America/Chicago', 'yyyy-MM-dd') : null,
        days_overdue: task.daysOverdue,
        delay_count: getTaskDelayCount(task.id)
      });
    }
  }
  
  if (snapshots.length > 0) {
    logOverdueSnapshot(snapshots);
  }
}

/**
 * Daily ClickUp snapshot - runs at 5:15 PM
 * Saves completion metrics to BigQuery
 */
function dailyClickUpSnapshot() {
  console.log('Creating daily ClickUp snapshot...');
  
  if (!isWorkday()) {
    console.log('Not a workday, skipping ClickUp snapshot');
    return;
  }
  
  const config = getConfig();
  if (!config.clickup_config.enabled) {
    return;
  }
  
  const today = new Date();
  const teamMembers = getCachedWorkingEmployees();
  const rows = [];
  
  for (const member of teamMembers) {
    // Get tasks that were due today
    const tasksDueToday = getTasksDueForUser(member.email, 'today');
    
    // Get today's actions from BigQuery
    const todayActions = getUserTodayTaskActions(member.email);
    
    let completed = 0;
    let moved = 0;
    let inProgress = 0;
    
    todayActions.forEach(action => {
      if (action.action_type === 'COMPLETE') completed = parseInt(action.count);
      if (action.action_type === 'TOMORROW') moved = parseInt(action.count);
      if (action.action_type === 'IN_PROGRESS') inProgress = parseInt(action.count);
    });
    
    const overdue = tasksDueToday.filter(t => t.isOverdue).length;
    const totalDue = tasksDueToday.length;
    
    rows.push({
      snapshot_date: Utilities.formatDate(today, 'America/Chicago', 'yyyy-MM-dd'),
      user_email: member.email,
      tasks_due_today: totalDue,
      tasks_overdue: overdue,
      tasks_due_this_week: getTasksDueForUser(member.email, 'week').length,
      tasks_completed_today: completed,
      tasks_moved_tomorrow: moved,
      completion_rate: totalDue > 0 ? (completed / totalDue) : 1.0
    });
  }
  
  // Insert into BigQuery
  logClickUpDailySnapshot(rows);
  
  logSystemEvent('CLICKUP_SNAPSHOT', 'SUCCESS', { members: rows.length });
  console.log(`Snapshot saved for ${rows.length} team members`);
}

/**
 * Get team task stats for channel summary
 */
function getTeamTaskStats() {
  const teamMembers = getCachedWorkingEmployees();
  
  let completed = 0;
  let delayed = 0;
  let stillOverdue = 0;
  const delayReasons = {};
  const newlyOverdue = [];
  
  for (const member of teamMembers) {
    const actions = getUserTodayTaskActions(member.email);
    
    actions.forEach(action => {
      if (action.action_type === 'COMPLETE') completed += parseInt(action.count);
      if (action.action_type === 'TOMORROW') delayed += parseInt(action.count);
    });
    
    // Check for still overdue
    const tasks = getTasksDueForUser(member.email, 'today');
    const overdue = tasks.filter(t => t.isOverdue);
    stillOverdue += overdue.length;
  }
  
  // Get delay reasons from BigQuery
  const reasons = getWeeklyDelayReasons();
  reasons.forEach(r => {
    delayReasons[r.delay_reason] = parseInt(r.count);
  });
  
  return {
    completed,
    delayed,
    stillOverdue,
    delayReasons,
    newlyOverdue
  };
}

/**
 * Get team overdue stats for morning summary
 */
function getTeamOverdueStats() {
  const summary = getTeamOverdueSummary();
  
  if (!summary || summary.length === 0) {
    return null;
  }
  
  let totalOverdue = 0;
  let chronicCount = 0;
  const topOffenders = [];
  
  summary.forEach(row => {
    const count = parseInt(row.total_overdue);
    totalOverdue += count;
    chronicCount += parseInt(row.chronic_count || 0);
    
    // Get name from email
    const name = row.user_email.split('@')[0];
    
    topOffenders.push({
      email: row.user_email,
      name: name,
      count: count,
      maxDays: parseInt(row.max_days_overdue)
    });
  });
  
  // Sort by count descending
  topOffenders.sort((a, b) => b.count - a.count);
  
  return {
    totalOverdue,
    peopleWithOverdue: summary.length,
    chronicCount,
    topOffenders: topOffenders.slice(0, 5)
  };
}

/**
 * Get weekly team task load for Monday kickoff
 */
function getWeeklyTeamTaskLoad() {
  const teamMembers = getCachedWorkingEmployees();
  const stats = {
    monday: 0,
    tuesday: 0,
    wednesday: 0,
    thursday: 0,
    friday: 0,
    overdue: 0
  };
  
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
  const today = new Date();
  
  for (const member of teamMembers) {
    const tasks = getTasksDueForUser(member.email, 'week');
    
    tasks.forEach(task => {
      if (task.isOverdue) {
        stats.overdue++;
      } else if (task.dueDate) {
        const dayIndex = task.dueDate.getDay() - 1;
        if (dayIndex >= 0 && dayIndex < 5) {
          stats[days[dayIndex]]++;
        }
      }
    });
  }
  
  return stats;
}

/**
 * Get per-person task completion data for EOD summary
 * Returns array sorted by completed count descending
 */
function getPerPersonCompletions(teamMembers) {
  var config = getConfig();
  if (!config.clickup_config.enabled) return [];

  var results = [];
  for (var i = 0; i < teamMembers.length; i++) {
    var member = teamMembers[i];
    try {
      var actions = getUserTodayTaskActions(member.email);
      var completed = 0;
      var delayed = 0;

      actions.forEach(function(action) {
        if (action.action_type === 'COMPLETE') completed = parseInt(action.count) || 0;
        if (action.action_type === 'TOMORROW') delayed = parseInt(action.count) || 0;
      });

      if (completed > 0 || delayed > 0) {
        results.push({
          name: member.name || member.email.split('@')[0],
          email: member.email,
          completed: completed,
          delayed: delayed
        });
      }
    } catch (err) {
      console.error('Error getting completions for ' + member.email + ':', err.message);
    }
  }

  // Sort by completed descending
  results.sort(function(a, b) { return b.completed - a.completed; });
  return results;
}

/**
 * Check for chronic overdue and send alerts
 */
function checkChronicOverdueAlerts() {
  const config = getConfig();
  
  if (!config.settings.escalate_chronic_overdue) {
    return;
  }
  
  const escalateDays = config.settings.overdue_escalate_days || 5;
  const overdueTasks = getAllOverdueTasks();
  
  const chronicTasks = overdueTasks.filter(t => t.daysOverdue >= escalateDays);
  
  if (chronicTasks.length === 0) {
    return;
  }
  
  // Group by assignee
  const byAssignee = {};
  chronicTasks.forEach(task => {
    if (!task.assigneeEmail) return;
    if (!byAssignee[task.assigneeEmail]) {
      byAssignee[task.assigneeEmail] = [];
    }
    byAssignee[task.assigneeEmail].push(task);
  });
  
  // Send alerts
  const recipients = getReportRecipients('escalation');
  
  for (const [email, tasks] of Object.entries(byAssignee)) {
    const taskList = tasks.slice(0, 5).map(t => 
      `• "${t.name}" - ${t.daysOverdue} days overdue\n  ${t.url || ''}`
    ).join('\n');
    
    const message = `🚨 **Chronic Overdue Alert**\n\n` +
      `${tasks.length} task(s) for ${email} have been overdue for ${escalateDays}+ days:\n\n` +
      taskList + 
      (tasks.length > 5 ? `\n\n...and ${tasks.length - 5} more` : '') +
      `\n\nPlease review and take action.`;
    
    // Send to escalation recipients
    recipients.forEach(recipient => {
      sendDirectMessage(recipient, message);
    });
  }
  
  logSystemEvent('CHRONIC_OVERDUE_ALERTS', 'SUCCESS', { 
    tasksAlerted: chronicTasks.length,
    peopleAlerted: Object.keys(byAssignee).length 
  });
}

/**
 * Check team overdue threshold and alert
 */
function checkTeamOverdueThreshold() {
  const config = getConfig();
  const threshold = config.settings.team_overdue_threshold || 20;
  
  const overdueTasks = getAllOverdueTasks();
  
  if (overdueTasks.length >= threshold) {
    const message = `⚠️ **Team Overdue Threshold Alert**\n\n` +
      `Total overdue tasks: **${overdueTasks.length}** (threshold: ${threshold})\n\n` +
      `This indicates a systemic backlog that may need attention.`;
    
    sendDirectMessage(config.settings.manager_email, message);
    
    logSystemEvent('TEAM_OVERDUE_THRESHOLD', 'ALERT', { 
      count: overdueTasks.length, 
      threshold: threshold 
    });
  }
}
