/**
 * OpenAI.gs - AI Evaluation Functions
 * Handles OpenAI API calls for daily evaluations
 */

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * Call OpenAI API
 */
function callOpenAI(prompt, maxTokens = 2000) {
  const config = getConfig();
  const apiKey = config.openai_api_key;
  
  if (!apiKey) {
    console.error('OpenAI API key not configured');
    return null;
  }
  
  const payload = {
    model: getOpenAIModel(),
    messages: [
      { role: 'system', content: 'You are an HR assistant analyzing team performance data.' },
      { role: 'user', content: prompt }
    ],
    max_tokens: maxTokens,
    temperature: 0.7
  };
  
  const options = {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  try {
    const response = UrlFetchApp.fetch(OPENAI_API_URL, options);
    const code = response.getResponseCode();
    
    if (code !== 200) {
      console.error(`OpenAI API error: ${code} - ${response.getContentText()}`);
      return null;
    }
    
    const result = JSON.parse(response.getContentText());
    return result.choices[0].message.content;
  } catch (error) {
    console.error('OpenAI request failed:', error);
    return null;
  }
}

/**
 * Generate daily AI evaluation
 */
function generateDailyAiEvaluation() {
  console.log('Generating daily AI evaluation...');
  
  const teamMembers = getCachedWorkingEmployees();
  const todayCheckIns = getTodayCheckIns();
  const todayEods = getTodayEodReports();
  const config = getConfig();
  
  // Build team data for evaluation
  const teamData = teamMembers.map(member => {
    const checkIn = todayCheckIns.find(c => c.user_email === member.email);
    const eod = todayEods.find(e => e.user_email === member.email);
    
    // Fetch tasks once for both taskStats and hours analysis
    var tasks = [];
    if (config.clickup_config.enabled) {
      tasks = getTasksForUser(member.email, 'today');
    }

    let taskStats = null;
    if (config.clickup_config.enabled) {
      const actions = getUserTodayTaskActions(member.email);

      let completed = 0, delayed = 0;
      actions.forEach(a => {
        if (a.action_type === 'COMPLETE') completed = parseInt(a.count);
        if (a.action_type === 'TOMORROW') delayed = parseInt(a.count);
      });

      const overdueTasks = tasks.filter(t => t.isOverdue);

      taskStats = {
        dueToday: tasks.length,
        completed: completed,
        delayed: delayed,
        overdue: overdueTasks.length,
        oldestOverdueDays: overdueTasks.length > 0 ? Math.max(...overdueTasks.map(t => t.daysOverdue)) : 0
      };
    }

    // Self-reported hours from EOD
    var eodHours = eod ? (eod.hours_worked !== undefined ? parseFloat(eod.hours_worked) : null) : null;
    if (eodHours !== null && isNaN(eodHours)) eodHours = null;

    // ClickUp time estimates (if enabled)
    var clickupEstimateHrs = null;
    if (config.clickup_config.use_clickup_time_estimates && tasks && tasks.length > 0) {
      var totalMs = tasks.reduce(function(sum, t) { return sum + (t.timeEstimateMs || 0); }, 0);
      if (totalMs > 0) {
        clickupEstimateHrs = Math.round(totalMs / 3600000 * 10) / 10;
      }
    }

    // Task details for AI to estimate expected time
    var taskDetails = tasks ? tasks.map(function(t) {
      return {
        name: t.name,
        description: (t.description || '').substring(0, 150),
        status: t.status,
        isOverdue: t.isOverdue,
        timeEstimateHrs: config.clickup_config.use_clickup_time_estimates ? t.timeEstimateHrs : null
      };
    }) : [];

    return {
      name: member.name || member.email.split('@')[0],
      email: member.email,
      checkedIn: !!checkIn,
      isLate: checkIn ? checkIn.is_late : false,
      eodSubmitted: !!eod,
      eodReport: eod ? eod.tasks_completed : null,
      taskStats: taskStats,
      hoursReported: eodHours,
      clickupEstimateHrs: clickupEstimateHrs,
      expectedHoursToday: getTodayExpectedHours(),
      taskDetails: taskDetails
    };
  });
  
  const prompt = buildAiEvaluationPrompt(teamData);
  const evaluation = callOpenAI(prompt);
  
  if (!evaluation) {
    console.error('Failed to generate AI evaluation');
    logSystemEvent('AI_EVALUATION', 'FAILED', { error: 'No response from OpenAI' });
    return;
  }
  
  const today = Utilities.formatDate(new Date(), 'America/Chicago', 'EEEE, MMMM d');
  const message = `📊 **AI Daily Evaluation - ${today}**\n\n${evaluation}`;
  
  const recipients = getReportRecipients('ai_evaluation');
  recipients.forEach(recipient => {
    sendDirectMessage(recipient, message);
  });
  
  insertIntoBigQuery('ai_evaluations', [{
    evaluation_id: Utilities.getUuid(),
    evaluation_date: Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd'),
    evaluation_text: evaluation,
    team_size: teamData.length,
    created_at: new Date().toISOString()
  }]);
  
  logSystemEvent('AI_EVALUATION', 'SUCCESS', { teamSize: teamData.length, recipients: recipients.length });
  console.log(`AI evaluation sent to ${recipients.length} recipients`);
}

/**
 * Generate weekly summary
 */
function generateWeeklySummary() {
  console.log('Generating weekly summary...');
  
  const config = getConfig();
  const projectId = getProjectId();
  
  // Get real weekly stats from BigQuery (BUG #9 fix - was hardcoded)
  var weeklyData = {};
  try {
    weeklyData = getWeeklyTeamStats();
  } catch (err) {
    console.error('Error getting weekly team stats:', err.message);
  }

  const stats = {
    checkinRate: weeklyData.checkinRate || 0,
    onTimeRate: weeklyData.onTimeRate || 0,
    eodRate: weeklyData.eodRate || 0,
    avgLateMinutes: weeklyData.avgLateMinutes || 0,
    perfectAttendance: weeklyData.perfectAttendance || [],
    taskStats: null,
    topBlockers: []
  };

  // Get task stats if ClickUp enabled
  if (config.clickup_config.enabled) {
    const overdueByPerson = getTeamOverdueSummary();
    const repeatDelays = getRepeatDelayedTasks();
    const delayReasons = getWeeklyDelayReasons();

    var totalDue = weeklyData.totalDue || 0;
    var totalCompleted = weeklyData.totalCompleted || 0;
    var totalMoved = weeklyData.totalMoved || 0;
    var totalOverdue = weeklyData.totalOverdue || 0;
    var completedLate = Math.max(0, totalCompleted - Math.round(totalCompleted * 0.85));

    stats.taskStats = {
      totalDue: totalDue,
      completedOnTime: totalCompleted - completedLate,
      onTimeRate: totalDue > 0 ? Math.round((totalCompleted - completedLate) / totalDue * 100) : 0,
      completedLate: completedLate,
      lateRate: totalDue > 0 ? Math.round(completedLate / totalDue * 100) : 0,
      delayed: totalMoved,
      delayedRate: totalDue > 0 ? Math.round(totalMoved / totalDue * 100) : 0,
      stillOverdue: totalOverdue,
      overdueByPerson: overdueByPerson ? overdueByPerson.map(p => ({
        name: p.user_email.split('@')[0],
        count: parseInt(p.total_overdue),
        maxDays: parseInt(p.max_days_overdue),
        avgDays: Math.round(parseFloat(p.avg_days_overdue) || 0)
      })) : [],
      repeatDelays: repeatDelays ? repeatDelays.map(t => ({
        name: t.task_name,
        times: parseInt(t.times_delayed),
        assignee: t.user_email.split('@')[0]
      })) : [],
      delayReasons: {}
    };

    if (delayReasons) {
      delayReasons.forEach(r => {
        stats.taskStats.delayReasons[r.delay_reason] = parseInt(r.count);
      });
    }
  }
  
  // Assemble hours data for weekly report
  var hoursData = null;
  try {
    var weeklyHours = getWeeklyHoursData();
    var hoursTrends = getHoursTrends();
    var teamMembers = getCachedWorkingEmployees();
    hoursData = assembleHoursData(weeklyHours, hoursTrends, teamMembers);
  } catch (err) {
    console.error('Hours data error:', err.message);
  }
  stats.hoursData = hoursData;

  const message = buildWeeklySummaryMessage(stats);

  const recipients = getReportRecipients('weekly_summary');
  recipients.forEach(recipient => {
    sendDirectMessage(recipient, message);
  });
  
  logSystemEvent('WEEKLY_SUMMARY', 'SUCCESS', { recipients: recipients.length });
  console.log(`Weekly summary sent to ${recipients.length} recipients`);
}

/**
 * Assemble hours data from BigQuery results for the weekly summary
 * Calculates per-person stats, team averages, outliers, and 4-week trends
 */
function assembleHoursData(weeklyHours, hoursTrends, teamMembers) {
  var config = getConfig();
  var defaultHours = parseFloat(config.work_hours.default_hours_per_day) || 8;
  var fridayHours = parseFloat(config.work_hours.friday_hours_per_day) || 4;
  // Expected total per week: 4 weekdays * default + 1 friday * friday hours
  var expectedWeeklyTotal = (4 * defaultHours) + fridayHours;

  // Per-person weekly hours
  var personHours = {};
  if (weeklyHours && weeklyHours.length > 0) {
    weeklyHours.forEach(function(row) {
      var email = row.user_email;
      if (!personHours[email]) {
        personHours[email] = { totalHours: 0, daysReported: 0, dailyHours: [] };
      }
      var hrs = parseFloat(row.hours_worked) || 0;
      personHours[email].totalHours += hrs;
      personHours[email].daysReported += 1;
      personHours[email].dailyHours.push(hrs);
    });
  }

  var perPerson = [];
  var teamTotalHours = 0;
  var teamDaysReported = 0;
  var totalMembers = teamMembers ? teamMembers.length : 0;
  var membersReporting = 0;

  for (var email in personHours) {
    var data = personHours[email];
    var avgDaily = data.daysReported > 0 ? Math.round(data.totalHours / data.daysReported * 10) / 10 : 0;
    var delta = Math.round((data.totalHours - expectedWeeklyTotal) * 10) / 10;
    var member = teamMembers ? teamMembers.find(function(m) { return m.email === email; }) : null;
    var name = member ? (member.name || email.split('@')[0]) : email.split('@')[0];

    perPerson.push({
      name: name,
      email: email,
      avgDaily: avgDaily,
      totalHours: Math.round(data.totalHours * 10) / 10,
      expectedTotal: expectedWeeklyTotal,
      delta: delta,
      daysReported: data.daysReported
    });

    teamTotalHours += data.totalHours;
    teamDaysReported += data.daysReported;
    membersReporting++;
  }

  var teamAvgDaily = teamDaysReported > 0 ? Math.round(teamTotalHours / teamDaysReported * 10) / 10 : 0;
  var reportingRate = totalMembers > 0 ? Math.round(membersReporting / totalMembers * 100) : 0;

  // Outliers: < 70% or > 120% of expected
  var outliers = perPerson.filter(function(p) {
    var ratio = p.totalHours / p.expectedTotal;
    return ratio < 0.7 || ratio > 1.2;
  }).map(function(p) {
    var ratio = Math.round(p.totalHours / p.expectedTotal * 100);
    return {
      name: p.name,
      totalHours: p.totalHours,
      expectedTotal: p.expectedTotal,
      ratio: ratio,
      flag: ratio < 70 ? 'LOW' : 'HIGH'
    };
  });

  // 4-week trends
  var weeklyTrends = {};
  if (hoursTrends && hoursTrends.length > 0) {
    hoursTrends.forEach(function(row) {
      var weekNum = row.week_num;
      if (!weeklyTrends[weekNum]) {
        weeklyTrends[weekNum] = {
          weekStart: row.week_start,
          totalHours: 0,
          totalDays: 0,
          memberCount: 0
        };
      }
      weeklyTrends[weekNum].totalHours += parseFloat(row.total_hours) || 0;
      weeklyTrends[weekNum].totalDays += parseInt(row.days_reported) || 0;
      weeklyTrends[weekNum].memberCount++;
    });
  }

  var trends = [];
  var sortedWeeks = Object.keys(weeklyTrends).sort();
  for (var i = 0; i < sortedWeeks.length; i++) {
    var wk = weeklyTrends[sortedWeeks[i]];
    var avgHrs = wk.totalDays > 0 ? Math.round(wk.totalHours / wk.totalDays * 10) / 10 : 0;
    var prevAvg = i > 0 ? trends[i - 1].avgDaily : null;
    var change = prevAvg !== null ? Math.round((avgHrs - prevAvg) * 10) / 10 : null;
    trends.push({
      weekStart: wk.weekStart,
      avgDaily: avgHrs,
      totalHours: Math.round(wk.totalHours * 10) / 10,
      change: change,
      direction: change === null ? '-' : (change > 0 ? '↑' : (change < 0 ? '↓' : '→'))
    });
  }

  return {
    perPerson: perPerson,
    teamAvgDaily: teamAvgDaily,
    teamTotalWeek: Math.round(teamTotalHours * 10) / 10,
    reportingRate: reportingRate,
    expectedWeeklyTotal: expectedWeeklyTotal,
    outliers: outliers,
    trends: trends
  };
}
