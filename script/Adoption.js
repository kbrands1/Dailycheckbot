/**
 * Adoption.gs - Adoption Tracking & Compliance Reporting
 * Tracks team engagement with the bot and generates compliance reports
 */

/**
 * Compute daily adoption metrics for all team members
 * Run this as an end-of-day trigger (after EOD summary)
 */
function computeDailyAdoptionMetrics() {
  var allMembers = getCachedWorkingEmployees();
  var config = getConfig();
  // Filter to tracked users only for adoption metrics
  var teamMembers = allMembers.filter(function(m) {
    var fullMember = config.team_members.find(function(tm) { return tm.email === m.email; });
    return !fullMember || (fullMember.tracking_mode || 'tracked') === 'tracked';
  });
  var today = new Date();
  var dateStr = Utilities.formatDate(today, 'America/Chicago', 'yyyy-MM-dd');
  var projectId = getProjectId();

  // Get today's prompts
  var promptQuery = 'SELECT user_email, prompt_type, response_received, response_latency_minutes ' +
    'FROM `' + projectId + '.' + DATASET_ID + '.prompt_log` ' +
    'WHERE DATE(sent_at, "America/Chicago") = "' + dateStr + '"';
  var prompts = runBigQueryQuery(promptQuery);

  // Get today's check-ins
  var todayCheckIns = getTodayCheckIns();
  var checkinMap = {};
  todayCheckIns.forEach(function(c) { checkinMap[c.user_email] = c; });

  // Get today's EODs
  var todayEods = getTodayEodReports();
  var eodMap = {};
  todayEods.forEach(function(e) { eodMap[e.user_email] = e; });

  // Get today's task actions (button clicks)
  var actionQuery = 'SELECT user_email, COUNT(*) as action_count ' +
    'FROM `' + projectId + '.' + DATASET_ID + '.clickup_task_actions` ' +
    'WHERE DATE(timestamp, "America/Chicago") = "' + dateStr + '" ' +
    'GROUP BY user_email';
  var actions = runBigQueryQuery(actionQuery);
  var actionMap = {};
  actions.forEach(function(a) { actionMap[a.user_email] = parseInt(a.action_count); });

  // Build prompt maps
  var promptMap = {};
  prompts.forEach(function(p) {
    if (!promptMap[p.user_email]) promptMap[p.user_email] = {};
    var type = p.prompt_type;
    if (type === 'CHECKIN' || type === 'CHECKIN_FOLLOWUP') {
      promptMap[p.user_email].checkin_prompted = true;
      if (p.response_received === true || p.response_received === 'true') {
        promptMap[p.user_email].checkin_responded = true;
        var latency = parseFloat(p.response_latency_minutes);
        if (!isNaN(latency)) {
          promptMap[p.user_email].checkin_latency = latency;
        }
      }
    }
    if (type === 'EOD' || type === 'EOD_FOLLOWUP') {
      promptMap[p.user_email].eod_prompted = true;
      if (p.response_received === true || p.response_received === 'true') {
        promptMap[p.user_email].eod_responded = true;
        var eodLatency = parseFloat(p.response_latency_minutes);
        if (!isNaN(eodLatency)) {
          promptMap[p.user_email].eod_latency = eodLatency;
        }
      }
    }
  });

  var rows = [];

  teamMembers.forEach(function(member) {
    var email = member.email;
    var pm = promptMap[email] || {};
    var checkin = checkinMap[email];
    var eod = eodMap[email];
    var buttonCount = actionMap[email] || 0;

    // EOD quality signals
    var eodWordCount = null;
    var eodHoursIncluded = false;
    var eodBlockersIncluded = false;
    var eodTomorrowIncluded = false;

    if (eod) {
      var rawText = eod.raw_response || eod.tasks_completed || '';
      eodWordCount = rawText.split(/\s+/).filter(function(w) { return w.length > 0; }).length;
      eodHoursIncluded = eod.hours_worked !== null && eod.hours_worked !== undefined && eod.hours_worked !== '';
      eodBlockersIncluded = eod.blockers !== null && eod.blockers !== undefined && eod.blockers !== '';
      eodTomorrowIncluded = eod.tomorrow_priority !== null && eod.tomorrow_priority !== undefined && eod.tomorrow_priority !== '';
    }

    rows.push({
      metric_id: Utilities.getUuid(),
      metric_date: dateStr,
      user_email: email,
      checkin_prompted: !!pm.checkin_prompted,
      checkin_responded: !!pm.checkin_responded || !!checkin,
      checkin_latency_minutes: pm.checkin_latency || null,
      checkin_is_late: checkin ? (checkin.is_late === true || checkin.is_late === 'true') : false,
      eod_prompted: !!pm.eod_prompted,
      eod_responded: !!pm.eod_responded || !!eod,
      eod_latency_minutes: pm.eod_latency || null,
      eod_word_count: eodWordCount,
      eod_hours_included: eodHoursIncluded,
      eod_blockers_included: eodBlockersIncluded,
      eod_tomorrow_included: eodTomorrowIncluded,
      used_task_buttons: buttonCount > 0,
      button_actions_count: buttonCount,
      created_at: new Date().toISOString()
    });
  });

  if (rows.length > 0) {
    insertIntoBigQuery('daily_adoption_metrics', rows);
  }

  console.log('Computed daily adoption metrics for ' + rows.length + ' members');
  return rows;
}

/**
 * Compute weekly adoption scores
 * Run every Friday after EOD summary
 */
function computeWeeklyAdoptionScores() {
  var projectId = getProjectId();
  var today = new Date();
  var weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay() + 1); // Monday
  var weekStartStr = Utilities.formatDate(weekStart, 'America/Chicago', 'yyyy-MM-dd');
  var todayStr = Utilities.formatDate(today, 'America/Chicago', 'yyyy-MM-dd');

  var query = 'SELECT ' +
    'user_email, ' +
    'COUNTIF(checkin_prompted) as days_prompted_checkin, ' +
    'COUNTIF(checkin_responded) as days_responded_checkin, ' +
    'AVG(CASE WHEN checkin_latency_minutes IS NOT NULL THEN checkin_latency_minutes END) as avg_checkin_latency, ' +
    'COUNTIF(eod_prompted) as days_prompted_eod, ' +
    'COUNTIF(eod_responded) as days_responded_eod, ' +
    'AVG(CASE WHEN eod_latency_minutes IS NOT NULL THEN eod_latency_minutes END) as avg_eod_latency, ' +
    'AVG(CASE WHEN eod_word_count IS NOT NULL THEN eod_word_count END) as avg_eod_word_count, ' +
    'COUNTIF(eod_hours_included) as days_hours_included, ' +
    'COUNTIF(eod_blockers_included) as days_blockers_included, ' +
    'COUNTIF(eod_tomorrow_included) as days_tomorrow_included, ' +
    'COUNTIF(used_task_buttons) as days_used_buttons, ' +
    'SUM(button_actions_count) as total_button_actions ' +
    'FROM `' + projectId + '.' + DATASET_ID + '.daily_adoption_metrics` ' +
    'WHERE metric_date BETWEEN "' + weekStartStr + '" AND "' + todayStr + '" ' +
    'GROUP BY user_email';

  var results = runBigQueryQuery(query);
  var rows = [];

  results.forEach(function(r) {
    var daysPromptedCheckin = parseInt(r.days_prompted_checkin) || 0;
    var daysRespondedCheckin = parseInt(r.days_responded_checkin) || 0;
    var daysPromptedEod = parseInt(r.days_prompted_eod) || 0;
    var daysRespondedEod = parseInt(r.days_responded_eod) || 0;
    var avgCheckinLatency = parseFloat(r.avg_checkin_latency) || 0;
    var avgEodLatency = parseFloat(r.avg_eod_latency) || 0;
    var avgWordCount = parseFloat(r.avg_eod_word_count) || 0;
    var daysHoursIncluded = parseInt(r.days_hours_included) || 0;
    var daysTomorrowIncluded = parseInt(r.days_tomorrow_included) || 0;
    var daysUsedButtons = parseInt(r.days_used_buttons) || 0;

    // Response rate: 40% weight
    var checkinRate = daysPromptedCheckin > 0 ? daysRespondedCheckin / daysPromptedCheckin : 0;
    var eodRate = daysPromptedEod > 0 ? daysRespondedEod / daysPromptedEod : 0;
    var responseScore = ((checkinRate + eodRate) / 2) * 40;

    // Timeliness: 25% weight
    var avgLatency = (avgCheckinLatency + avgEodLatency) / 2;
    var timelinessScore = 0;
    if (avgLatency <= 5) timelinessScore = 25;
    else if (avgLatency <= 10) timelinessScore = 20;
    else if (avgLatency <= 20) timelinessScore = 12.5;
    else timelinessScore = 0;

    // Response quality: 20% weight
    var daysWithEod = daysRespondedEod || 1;
    var hoursRate = daysHoursIncluded / daysWithEod;
    var tomorrowRate = daysTomorrowIncluded / daysWithEod;
    var wordCountAdequacy = avgWordCount >= 20 ? 1 : (avgWordCount >= 10 ? 0.5 : 0);
    var qualityScore = ((hoursRate + tomorrowRate + wordCountAdequacy) / 3) * 20;

    // Feature adoption: 15% weight
    var daysTotal = Math.max(daysPromptedCheckin, daysPromptedEod, 1);
    var buttonAdoptionRate = daysUsedButtons / daysTotal;
    var featureScore = buttonAdoptionRate * 15;

    var totalScore = Math.round(responseScore + timelinessScore + qualityScore + featureScore);

    rows.push({
      score_id: Utilities.getUuid(),
      week_start: weekStartStr,
      week_end: todayStr,
      user_email: r.user_email,
      checkin_response_rate: Math.round(checkinRate * 100),
      eod_response_rate: Math.round(eodRate * 100),
      avg_checkin_latency_minutes: Math.round(avgCheckinLatency * 10) / 10,
      avg_eod_latency_minutes: Math.round(avgEodLatency * 10) / 10,
      avg_eod_word_count: Math.round(avgWordCount),
      hours_inclusion_rate: Math.round(hoursRate * 100),
      tomorrow_inclusion_rate: Math.round(tomorrowRate * 100),
      button_adoption_rate: Math.round(buttonAdoptionRate * 100),
      adoption_score: totalScore,
      created_at: new Date().toISOString()
    });
  });

  if (rows.length > 0) {
    insertIntoBigQuery('weekly_adoption_scores', rows);
  }

  console.log('Computed weekly adoption scores for ' + rows.length + ' members');
  return rows;
}

/**
 * Generate and send weekly adoption report
 * Called by triggerWeeklyAdoptionReport (Friday after EOD)
 */
function generateWeeklyAdoptionReport() {
  console.log('Generating weekly adoption report...');

  // Compute fresh scores
  var scores = computeWeeklyAdoptionScores();

  if (!scores || scores.length === 0) {
    console.log('No adoption data to report');
    return;
  }

  // Sort by adoption score ascending (worst first)
  scores.sort(function(a, b) { return a.adoption_score - b.adoption_score; });

  var teamMembers = getCachedWorkingEmployees();
  var nameMap = {};
  teamMembers.forEach(function(m) {
    nameMap[m.email] = m.name || m.email.split('@')[0];
  });

  // Team averages
  var totalScore = 0;
  var totalCheckinRate = 0;
  var totalEodRate = 0;
  var totalLatency = 0;
  scores.forEach(function(s) {
    totalScore += s.adoption_score;
    totalCheckinRate += s.checkin_response_rate;
    totalEodRate += s.eod_response_rate;
    totalLatency += s.avg_checkin_latency_minutes;
  });
  var count = scores.length;
  var avgScore = Math.round(totalScore / count);
  var avgCheckin = Math.round(totalCheckinRate / count);
  var avgEod = Math.round(totalEodRate / count);
  var avgLatency = Math.round(totalLatency / count * 10) / 10;

  // Build message
  var message = '📊 *Weekly Adoption Report*\n\n';
  message += '*Team Overview:*\n';
  message += 'Avg Adoption Score: ' + avgScore + '/100\n';
  message += 'Check-in Rate: ' + avgCheckin + '% | EOD Rate: ' + avgEod + '%\n';
  message += 'Avg Response Time: ' + avgLatency + ' min\n\n';

  // Flag anyone below 70
  var flagged = scores.filter(function(s) { return s.adoption_score < 70; });
  if (flagged.length > 0) {
    message += '🚩 *Needs Attention (Score < 70):*\n';
    flagged.forEach(function(s) {
      var name = nameMap[s.user_email] || s.user_email;
      var gaps = [];
      if (s.checkin_response_rate < 80) gaps.push('check-in ' + s.checkin_response_rate + '%');
      if (s.eod_response_rate < 80) gaps.push('EOD ' + s.eod_response_rate + '%');
      if (s.hours_inclusion_rate < 50) gaps.push('no hours');
      if (s.button_adoption_rate < 20) gaps.push('ignores task buttons');
      if (s.avg_checkin_latency_minutes > 20) gaps.push('slow response ' + s.avg_checkin_latency_minutes + 'min');
      message += '  ' + name + ': ' + s.adoption_score + '/100';
      if (gaps.length > 0) message += ' (' + gaps.join(', ') + ')';
      message += '\n';
    });
    message += '\n';
  }

  // Top performers
  var topPerformers = scores.filter(function(s) { return s.adoption_score >= 90; });
  if (topPerformers.length > 0) {
    message += '⭐ *Top Performers (Score 90+):*\n';
    topPerformers.reverse().forEach(function(s) {
      var name = nameMap[s.user_email] || s.user_email;
      message += '  ' + name + ': ' + s.adoption_score + '/100\n';
    });
    message += '\n';
  }

  // Full breakdown sorted by score descending
  message += '*Full Team Breakdown:*\n';
  scores.reverse().forEach(function(s) {
    var name = nameMap[s.user_email] || s.user_email;
    message += '  ' + name + ': ' + s.adoption_score + ' | CI:' + s.checkin_response_rate + '% EOD:' + s.eod_response_rate + '% Btns:' + s.button_adoption_rate + '%\n';
  });

  // Send to manager and escalation recipients
  var recipients = getReportRecipients('adoption_report');
  if (!recipients || recipients.length === 0) {
    var config = getConfig();
    recipients = [config.settings.manager_email];
  }

  recipients.forEach(function(r) {
    sendDirectMessage(r, message);
  });

  logSystemEvent('ADOPTION_REPORT', 'SENT', { avg_score: avgScore, team_size: count });
  console.log('Weekly adoption report sent to ' + recipients.length + ' recipients');
}

/**
 * Midweek compliance check (Wednesday)
 * Alerts manager if anyone has missed 2+ check-ins or EODs this week
 */
function midweekComplianceCheck() {
  var projectId = getProjectId();
  var today = new Date();
  var weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay() + 1); // Monday
  var weekStartStr = Utilities.formatDate(weekStart, 'America/Chicago', 'yyyy-MM-dd');
  var todayStr = Utilities.formatDate(today, 'America/Chicago', 'yyyy-MM-dd');

  // Count workdays so far this week
  var dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ..., 3=Wed
  var workdaysSoFar = dayOfWeek;

  if (workdaysSoFar < 2) return; // Not enough data before Tuesday

  var query = 'SELECT user_email, ' +
    'COUNTIF(checkin_responded) as checkins, ' +
    'COUNTIF(eod_responded) as eods, ' +
    'COUNT(*) as days_tracked ' +
    'FROM `' + projectId + '.' + DATASET_ID + '.daily_adoption_metrics` ' +
    'WHERE metric_date BETWEEN "' + weekStartStr + '" AND "' + todayStr + '" ' +
    'GROUP BY user_email';

  var results = runBigQueryQuery(query);
  var allMembers = getCachedWorkingEmployees();
  var config2 = getConfig();
  // Filter to tracked users only
  var teamMembers = allMembers.filter(function(m) {
    var fullMember = config2.team_members.find(function(tm) { return tm.email === m.email; });
    return !fullMember || (fullMember.tracking_mode || 'tracked') === 'tracked';
  });
  var nameMap = {};
  teamMembers.forEach(function(m) { nameMap[m.email] = m.name || m.email.split('@')[0]; });

  var flagged = [];
  results.forEach(function(r) {
    var daysTracked = parseInt(r.days_tracked) || 0;
    var checkins = parseInt(r.checkins) || 0;
    var eods = parseInt(r.eods) || 0;
    var missedCheckins = daysTracked - checkins;
    var missedEods = daysTracked - eods;

    if (missedCheckins >= 2 || missedEods >= 2) {
      var name = nameMap[r.user_email] || r.user_email;
      var issues = [];
      if (missedCheckins >= 2) issues.push(missedCheckins + ' missed check-ins');
      if (missedEods >= 2) issues.push(missedEods + ' missed EODs');
      flagged.push(name + ': ' + issues.join(', '));
    }
  });

  // Also flag anyone not in the metrics at all
  var trackedEmails = {};
  results.forEach(function(r) { trackedEmails[r.user_email] = true; });
  teamMembers.forEach(function(m) {
    if (!trackedEmails[m.email]) {
      flagged.push((m.name || m.email.split('@')[0]) + ': no activity recorded this week');
    }
  });

  if (flagged.length > 0) {
    var message = '⚠️ *Midweek Compliance Alert*\n\n' +
      'The following team members have compliance gaps this week:\n\n';
    flagged.forEach(function(f) {
      message += '  ' + f + '\n';
    });
    message += '\nConsider following up before Friday.';

    var config = getConfig();
    sendDirectMessage(config.settings.manager_email, message);
    logSystemEvent('MIDWEEK_COMPLIANCE', 'ALERT', { flagged_count: flagged.length });
  }

  console.log('Midweek compliance check: ' + flagged.length + ' flagged');
}
