/**
 * Templates.gs - Message Templates
 * All message templates for check-ins, EOD, summaries, etc.
 *
 * ============================================
 * ODOO INTEGRATION POINTS:
 * ============================================
 *
 * 1. getMorningCheckInMessage() - Line ~9
 *    - Check member's task_source setting
 *    - If 'odoo' or 'both', call getOdooTaskSummary(email)
 *    - Include Odoo tasks in the morning message
 *    - Example:
 *      const odooTasks = member.task_source !== 'clickup'
 *        ? getOdooTasksForUser(member.email, 'today')
 *        : [];
 *
 * 2. getEodRequestMessage() - Line ~39
 *    - Same logic: check task_source, fetch Odoo tasks
 *    - Merge ClickUp and Odoo tasks if 'both'
 *    - Build cards for Odoo tasks (may need OdooCards.gs)
 *
 * 3. buildMorningTaskMessage() - Called from getMorningCheckInMessage
 *    - May need separate section for Odoo tasks
 *    - Example: "📋 ClickUp Tasks:\n...\n\n📊 Odoo Tasks:\n..."
 *
 * 4. buildEodTaskMessage() - Called from getEodRequestMessage
 *    - Need to handle mixed task sources
 *    - Odoo task cards may have different actions
 *
 * ============================================
 */

/**
 * Get morning check-in message
 */
function getMorningCheckInMessage(member, tasks, isMonday) {
  const config = getConfig();
  const userName = member.name || member.email.split('@')[0];
  
  // If Monday and weekly preview enabled
  if (isMonday && config.clickup_config.show_weekly_monday) {
    return buildWeeklyTaskPreview(tasks, userName);
  }
  
  // Regular day with tasks
  if (config.clickup_config.include_in_morning && tasks && tasks.length > 0) {
    return buildMorningTaskMessage(tasks, userName);
  }
  
  // No tasks or ClickUp disabled
  return `Good morning${userName ? ', ' + userName : ''}! 👋\n\n` +
    `Please confirm you're online by replying "here" or sharing your #1 priority for today.`;
}

/**
 * Get check-in follow-up message
 */
function getCheckInFollowUpMessage() {
  return `⏰ **Reminder:** Please confirm you're online.\n\n` +
    `Reply "here" or share what you're working on today.`;
}

/**
 * Get EOD request message with tasks
 */
function getEodRequestMessage(member, tasks) {
  const config = getConfig();
  
  if (config.clickup_config.include_in_eod && tasks && tasks.length > 0) {
    return buildEodTaskMessage(tasks);
  }
  
  // No tasks or ClickUp disabled
  return {
    text: `Time for your EOD report! 📝\n\n` +
      `Please share:\n` +
      `1. Tasks completed today\n` +
      `2. Blockers (if any)\n` +
      `3. Tomorrow's priority\n\n` +
      `⏰ Please include your hours worked today. Example: "Worked 7 hours. Completed X, Y, Z..."`,
    cardsV2: null
  };
}

/**
 * Get EOD follow-up message
 */
function getEodFollowUpMessage() {
  return `⏰ **EOD Reminder:** Please submit your end-of-day report.\n\n` +
    `Share what you accomplished, any blockers, and tomorrow's priority.\n` +
    `Don't forget to include your hours worked (e.g. "7 hours").`;
}

/**
 * Get check-in confirmation message
 */
function getCheckInConfirmation(isLate) {
  if (isLate) {
    return `✅ Check-in received (late). Thanks for confirming!`;
  }
  return `✅ Thanks for checking in! Have a productive day.`;
}

/**
 * Get EOD confirmation message
 */
function getEodConfirmation() {
  return `✅ EOD report received. Great work today! See you tomorrow.`;
}

/**
 * Get Friday EOD confirmation
 */
function getFridayEodConfirmation() {
  return `✅ EOD report received. Great work this week! Enjoy your weekend! 🎉`;
}

/**
 * Get escalation message for missed check-in
 */
function getMissedCheckInEscalation(memberEmail, memberName) {
  return `⚠️ **Missed Check-in Alert**\n\n` +
    `${memberName || memberEmail} has not checked in today.\n\n` +
    `Please follow up to confirm they are available.`;
}

/**
 * Get escalation message for missed EOD
 */
function getMissedEodEscalation(memberEmail, memberName) {
  return `⚠️ **Missed EOD Report**\n\n` +
    `${memberName || memberEmail} has not submitted their EOD report.\n\n` +
    `Please follow up to ensure their day's work is documented.`;
}

/**
 * Build weekly gamification message
 */
function buildWeeklyGamificationMessage(leaderboard, badges) {
  let message = `🏆 **Weekly Leaderboard**\n\n`;
  
  // Attendance section
  message += `📊 **Attendance Champions:**\n`;
  if (leaderboard.attendance && leaderboard.attendance.length > 0) {
    const medals = ['🥇', '🥈', '🥉'];
    leaderboard.attendance.slice(0, 3).forEach((person, i) => {
      message += `${medals[i]} ${person.name} - ${person.onTimeRate}% on-time\n`;
    });
  }
  message += '\n';
  
  // Task completion section
  if (leaderboard.taskCompletion && leaderboard.taskCompletion.length > 0) {
    message += `📋 **Task Completion:**\n`;
    const medals = ['🥇', '🥈', '🥉'];
    leaderboard.taskCompletion.slice(0, 3).forEach((person, i) => {
      message += `${medals[i]} ${person.name} - ${person.completionRate}% (${person.completed}/${person.total})\n`;
    });
    message += '\n';
  }
  
  // Zero overdue
  if (leaderboard.zeroOverdue && leaderboard.zeroOverdue.length > 0) {
    message += `⚡ **Zero Overdue:**\n`;
    message += leaderboard.zeroOverdue.map(p => p.name).join(', ') + '\n\n';
  }
  
  // Badges earned
  if (badges && badges.length > 0) {
    message += `🏅 **Badges Earned This Week:**\n`;
    badges.forEach(b => {
      message += `• ${b.name}: ${b.badge} ${b.badgeName}\n`;
    });
  }
  
  return message;
}

/**
 * Build weekly summary message for managers
 */
function buildWeeklySummaryMessage(stats) {
  const weekStart = Utilities.formatDate(
    new Date(Date.now() - 4 * 24 * 60 * 60 * 1000), 
    'America/Chicago', 
    'MMM d'
  );
  const weekEnd = Utilities.formatDate(new Date(), 'America/Chicago', 'MMM d');
  
  let message = `📊 **Weekly Report - ${weekStart} to ${weekEnd}**\n\n`;
  
  // Attendance
  message += `──────────────────────────────\n`;
  message += `👥 ATTENDANCE\n`;
  message += `──────────────────────────────\n\n`;
  message += `• Check-in rate: ${stats.checkinRate}%\n`;
  message += `• On-time rate: ${stats.onTimeRate}%\n`;
  message += `• EOD submission rate: ${stats.eodRate}%\n`;
  message += `• Average late arrivals: ${stats.avgLateMinutes} min\n\n`;
  
  if (stats.perfectAttendance && stats.perfectAttendance.length > 0) {
    message += `🌟 Perfect attendance: ${stats.perfectAttendance.join(', ')}\n\n`;
  }

  // Hours section
  if (stats.hoursData) {
    var hd = stats.hoursData;
    message += `──────────────────────────────\n`;
    message += `⏱️ HOURS\n`;
    message += `──────────────────────────────\n\n`;
    message += `• Team avg daily hours: ${hd.teamAvgDaily}h (expected: ${hd.expectedWeeklyTotal / 5}h)\n`;
    message += `• Team total weekly hours: ${hd.teamTotalWeek}h\n`;
    message += `• Hours reporting rate: ${hd.reportingRate}%\n\n`;

    if (hd.perPerson && hd.perPerson.length > 0) {
      message += `**Per-Person Hours:**\n`;
      message += `| Name | Avg/Day | Total | Expected | Delta |\n`;
      message += `|------|---------|-------|----------|-------|\n`;
      hd.perPerson.forEach(function(p) {
        var deltaStr = p.delta >= 0 ? '+' + p.delta : '' + p.delta;
        message += `| ${p.name} | ${p.avgDaily}h | ${p.totalHours}h | ${p.expectedTotal}h | ${deltaStr}h |\n`;
      });
      message += '\n';
    }

    // 4-week trends
    if (hd.trends && hd.trends.length > 0) {
      message += `**Week-over-Week Trends (last ${hd.trends.length} weeks):**\n`;
      hd.trends.forEach(function(t) {
        var changeStr = t.change !== null ? ' ' + t.direction + ' ' + Math.abs(t.change) + 'h' : '';
        message += `• Week of ${t.weekStart}: avg ${t.avgDaily}h/day (total ${t.totalHours}h)${changeStr}\n`;
      });
      message += '\n';
    }

    // Outliers
    if (hd.outliers && hd.outliers.length > 0) {
      message += `**⚠️ Hours Outliers:**\n`;
      hd.outliers.forEach(function(o) {
        var flagEmoji = o.flag === 'LOW' ? '🔻' : '🔺';
        message += `• ${flagEmoji} ${o.name}: ${o.totalHours}h / ${o.expectedTotal}h expected (${o.ratio}%)\n`;
      });
      message += '\n';
    }
  }

  // Task performance
  if (stats.taskStats) {
    message += `──────────────────────────────\n`;
    message += `📋 TASK PERFORMANCE\n`;
    message += `──────────────────────────────\n\n`;
    message += `**Team Totals:**\n`;
    message += `• Tasks due: ${stats.taskStats.totalDue}\n`;
    message += `• Completed on time: ${stats.taskStats.completedOnTime} (${stats.taskStats.onTimeRate}%)\n`;
    message += `• Completed late: ${stats.taskStats.completedLate} (${stats.taskStats.lateRate}%)\n`;
    message += `• Delayed: ${stats.taskStats.delayed} (${stats.taskStats.delayedRate}%)\n`;
    message += `• Still overdue: ${stats.taskStats.stillOverdue}\n\n`;
    
    // Overdue breakdown by person
    if (stats.taskStats.overdueByPerson && stats.taskStats.overdueByPerson.length > 0) {
      message += `**Overdue Breakdown:**\n`;
      message += `| Person | Overdue | Oldest | Avg Days |\n`;
      message += `|--------|---------|--------|----------|\n`;
      stats.taskStats.overdueByPerson.forEach(p => {
        message += `| ${p.name} | ${p.count} | ${p.maxDays} days | ${p.avgDays} |\n`;
      });
      message += '\n';
    }
    
    // Chronic overdue
    if (stats.taskStats.chronicOverdue && stats.taskStats.chronicOverdue.length > 0) {
      message += `**Chronic Overdue (3+ days):**\n`;
      stats.taskStats.chronicOverdue.slice(0, 5).forEach(t => {
        message += `• "${t.name}" - ${t.assignee} - ${t.daysOverdue} days\n`;
      });
      message += '\n';
    }
    
    // Most delayed tasks
    if (stats.taskStats.repeatDelays && stats.taskStats.repeatDelays.length > 0) {
      message += `**Most Delayed Tasks:**\n`;
      stats.taskStats.repeatDelays.slice(0, 3).forEach(t => {
        message += `• "${t.name}" - moved ${t.times} times (${t.assignee})\n`;
      });
      message += '\n';
    }
    
    // Delay reasons
    if (stats.taskStats.delayReasons && Object.keys(stats.taskStats.delayReasons).length > 0) {
      message += `**Delay Reasons:**\n`;
      const totalDelays = Object.values(stats.taskStats.delayReasons).reduce((a, b) => a + b, 0);
      Object.entries(stats.taskStats.delayReasons).forEach(([reason, count]) => {
        const pct = Math.round(count / totalDelays * 100);
        message += `• ${formatDelayReason(reason)}: ${count} (${pct}%)\n`;
      });
      message += '\n';
    }
  }
  
  // Blockers
  if (stats.topBlockers && stats.topBlockers.length > 0) {
    message += `──────────────────────────────\n`;
    message += `🚧 TOP BLOCKERS\n`;
    message += `──────────────────────────────\n\n`;
    stats.topBlockers.forEach(b => {
      message += `• ${b.description} (mentioned ${b.count}x)\n`;
    });
    message += '\n';
  }
  
  return message;
}

/**
 * Build AI evaluation prompt (enhanced with hours analysis)
 */
function buildAiEvaluationPrompt(teamData) {
  var expectedHours = teamData.length > 0 ? teamData[0].expectedHoursToday : 8;

  var prompt = 'You are evaluating daily team performance for a remote team. Today is a ' + expectedHours + '-hour workday.\n\n';
  prompt += 'Analyze the following data and provide a direct, specific assessment for management.\n\n';
  prompt += '## Team Data for Today\n\n';

  teamData.forEach(function(member) {
    prompt += '### ' + member.name + ' (' + member.email + ')\n';
    prompt += '- Check-in: ' + (member.checkedIn ? 'Yes' : 'NO') + (member.isLate ? ' (Late)' : '') + '\n';
    prompt += '- EOD Submitted: ' + (member.eodSubmitted ? 'Yes' : 'NO') + '\n';
    prompt += '- Hours Reported: ' + (member.hoursReported !== null ? member.hoursReported + 'h' : 'NOT REPORTED') + '\n';
    prompt += '- Expected Hours: ' + expectedHours + 'h\n';

    if (member.clickupEstimateHrs !== null) {
      prompt += '- ClickUp Time Estimates Total: ' + member.clickupEstimateHrs + 'h\n';
    }

    if (member.taskStats) {
      prompt += '- Tasks due today: ' + member.taskStats.dueToday + '\n';
      prompt += '- Tasks completed: ' + member.taskStats.completed + '\n';
      prompt += '- Tasks delayed: ' + member.taskStats.delayed + '\n';
      prompt += '- Overdue tasks: ' + member.taskStats.overdue + '\n';
      if (member.taskStats.overdue > 0) {
        prompt += '- Oldest overdue: ' + member.taskStats.oldestOverdueDays + ' days\n';
      }
    }

    // Full task list with details
    if (member.taskDetails && member.taskDetails.length > 0) {
      prompt += '- Task List:\n';
      member.taskDetails.forEach(function(t) {
        prompt += '  * "' + t.name + '" [' + t.status + ']';
        if (t.isOverdue) prompt += ' (OVERDUE)';
        if (t.timeEstimateHrs) prompt += ' (est: ' + t.timeEstimateHrs + 'h)';
        if (t.description) prompt += ' — ' + t.description;
        prompt += '\n';
      });
    }

    if (member.eodReport) {
      prompt += '- EOD Summary: "' + member.eodReport.substring(0, 300) + '"\n';
    }

    prompt += '\n';
  });

  prompt += '## Instructions\n\n';
  prompt += 'For each team member, provide:\n';
  prompt += '1. **Rating**: Excellent / Good / Needs Attention / Concern\n';
  prompt += '2. **Hours Analysis**: Estimate how long the completed tasks should have taken based on task names and descriptions. Compare your estimate to reported hours. Flag discrepancies.\n';
  prompt += '3. **Productivity Check**: Tasks completed vs tasks due relative to available hours\n';
  prompt += '4. **Risk Flags**: List any concerns\n';
  prompt += '5. **Recommended Action**: What management should do (if anything)\n\n';

  prompt += '## Patterns to Flag\n';
  prompt += '- Reported 8h but only 1-2 small/simple tasks completed (slack)\n';
  prompt += '- Hours < 70% of expected with no explanation\n';
  prompt += '- Hours not reported at all\n';
  prompt += '- Reported hours much higher than task complexity warrants (padding)\n';
  prompt += '- 3+ overdue tasks\n';
  prompt += '- Same task delayed 3+ times\n';
  prompt += '- "No time" delays (may indicate overload or avoidance)\n';
  prompt += '- Missing check-in or EOD without explanation\n';
  prompt += '- Low hours + high output could mean underreporting (flag for praise, not concern)\n\n';

  prompt += 'Be direct and specific. Name names. This is for management, not the team.\n';
  prompt += 'Use markdown formatting. Keep response concise but thorough.';

  return prompt;
}

/**
 * Build morning standup digest from check-in responses
 * Posted to team channel for peer visibility
 */
function buildStandupDigest(checkIns, teamMembers) {
  var today = Utilities.formatDate(new Date(), 'America/Chicago', 'EEEE, MMMM d');
  var message = '📋 *Team Standup - ' + today + '*\n\n';

  var nameMap = {};
  teamMembers.forEach(function(m) { nameMap[m.email] = m.name || m.email.split('@')[0]; });

  if (checkIns.length === 0) {
    message += 'No check-ins received yet.';
    return message;
  }

  checkIns.forEach(function(ci) {
    var name = nameMap[ci.user_email] || ci.user_email;
    var response = ci.response_text || 'here';
    if (response.toLowerCase().trim() === 'here' || response.toLowerCase().trim() === 'present') {
      message += '*' + name + ':* ✅ Online\n';
    } else {
      message += '*' + name + ':* ' + response + '\n';
    }
  });

  var config = getConfig();
  var checkedInEmails = {};
  checkIns.forEach(function(c) { checkedInEmails[c.user_email] = true; });
  // Exclude not-tracked users from "missing" list
  var missing = teamMembers.filter(function(m) {
    if (checkedInEmails[m.email]) return false;
    var fullMember = config.team_members.find(function(tm) { return tm.email === m.email; });
    if (fullMember && fullMember.tracking_mode === 'not_tracked') return false;
    return true;
  });
  if (missing.length > 0) {
    message += '\n⏳ *Not yet checked in:* ' + missing.map(function(m) { return nameMap[m.email]; }).join(', ');
  }

  return message;
}

/**
 * Build EOD digest for team channel
 */
function buildEodDigest(eods, teamMembers) {
  var today = Utilities.formatDate(new Date(), 'America/Chicago', 'EEEE, MMMM d');
  var message = '📝 *Team EOD Summary - ' + today + '*\n\n';

  var nameMap = {};
  teamMembers.forEach(function(m) { nameMap[m.email] = m.name || m.email.split('@')[0]; });

  if (eods.length === 0) {
    message += 'No EOD reports received yet.';
    return message;
  }

  eods.forEach(function(eod) {
    var name = nameMap[eod.user_email] || eod.user_email;
    var summary = eod.tasks_completed || eod.raw_response || '(no details)';
    if (summary.length > 200) summary = summary.substring(0, 197) + '...';
    message += '*' + name + ':* ' + summary + '\n';
    if (eod.blockers) message += '  ⚠️ Blocker: ' + eod.blockers + '\n';
    message += '\n';
  });

  return message;
}
