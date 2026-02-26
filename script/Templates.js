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
 * Get EOD request message with structured card flow
 * Returns the EOD header card to start the multi-step form.
 * Also pre-caches ClickUp tasks for the card flow.
 */
function getEodRequestMessage(member, tasks) {
  var userName = member.name || member.email.split('@')[0];
  var dateStr = Utilities.formatDate(new Date(), 'America/Chicago', 'MMM dd, yyyy');
  var taskList = tasks || [];

  // Pre-cache ClickUp tasks in EOD state for the card flow
  var eodState = {
    clickUpTasks: taskList.slice(0, 10).map(function(t) {
      return {
        id: t.id, name: t.name, url: t.url || '',
        status: t.status || '', listName: t.listName || '',
        isOverdue: t.isOverdue || false, daysOverdue: t.daysOverdue || 0
      };
    })
  };
  _saveEodState(member.email, eodState);

  var headerCard = buildEodHeaderCard(userName, dateStr, taskList.length);

  return {
    text: 'Time for your structured EOD report! \uD83D\uDCDD',
    cardsV2: [headerCard],
    followUpText: null
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
function getEodConfirmation(feedback) {
  var msg = '✅ EOD report received.\n\n';
  msg += buildEodFeedback(feedback);
  msg += '\nSee you tomorrow!';
  return msg;
}

/**
 * Get Friday EOD confirmation
 */
function getFridayEodConfirmation(feedback) {
  var msg = '✅ EOD report received.\n\n';
  msg += buildEodFeedback(feedback);
  msg += '\nEnjoy your weekend! 🎉';
  return msg;
}

/**
 * Build personalized EOD feedback with task stats, follow-through, and hours
 */
function buildEodFeedback(feedback) {
  if (!feedback) return '';
  var lines = [];

  // Task completion summary
  if (feedback.taskStats) {
    var ts = feedback.taskStats;
    var completionPct = ts.total > 0 ? Math.round(ts.completed / ts.total * 100) : 0;
    lines.push('📊 **Today\'s Snapshot:** ' + ts.completed + '/' + ts.total + ' tasks completed (' + completionPct + '%)');

    if (ts.inProgress > 0) {
      lines.push('   🔄 ' + ts.inProgress + ' still in progress');
    }
    if (ts.overdue > 0) {
      lines.push('   ⚠️ ' + ts.overdue + ' overdue — let\'s make these a priority tomorrow');
    }
    if (ts.notStarted > 0 && ts.notStarted > ts.inProgress) {
      lines.push('   📋 ' + ts.notStarted + ' not yet started');
    }

    // Completion feedback
    if (completionPct < 50 && ts.total >= 3) {
      lines.push('\n💡 Looks like it was a tough day — less than half of your tasks were completed. If something is blocking you, let us know so we can help clear the way.');
    } else if (completionPct >= 80) {
      lines.push('\n🌟 Great productivity today — keep it up!');
    }
  }

  // Hours feedback
  if (feedback.hoursWorked !== null && feedback.expectedHours) {
    var hoursPct = Math.round(feedback.hoursWorked / feedback.expectedHours * 100);
    if (feedback.hoursWorked < feedback.expectedHours * 0.7) {
      lines.push('\n⏰ **Hours:** ' + feedback.hoursWorked + 'h logged today (expected ' + feedback.expectedHours + 'h). Just a heads-up — that\'s ' + hoursPct + '% of your expected hours. If anything came up, no worries, just make sure your hours reflect your actual day.');
    }

    // AI hours estimation mismatch
    if (feedback.hoursEstimate && feedback.hoursEstimate.estimatedHours) {
      var est = feedback.hoursEstimate.estimatedHours;
      var gap = feedback.hoursWorked - est;
      if (gap >= 2) {
        lines.push('\n🔍 **Quick Note on Hours:** You logged ' + feedback.hoursWorked + 'h and the tracked tasks look like roughly ~' + est + 'h of work.');
        if (feedback.hoursEstimate.reasoning) {
          lines.push('   _' + feedback.hoursEstimate.reasoning + '_');
        }
        lines.push('   That\'s totally fine if you worked on other things — just make sure those tasks are created in ClickUp so your effort is properly tracked and visible. 🙏');
      }
    }
  } else if (feedback.hoursWorked === null) {
    lines.push('\n⚠️ **Hours not reported.** Please reply with your hours worked today (e.g. "6.5"). Daily hours reporting is required.');
  }

  // Follow-through check
  if (feedback.yesterdayPriority) {
    lines.push('\n📌 **Follow-Through:**');
    lines.push('Yesterday you planned to: _"' + feedback.yesterdayPriority.substring(0, 200) + '"_');
    if (feedback.taskStats && feedback.taskStats.completed === 0) {
      lines.push('It looks like none of today\'s tracked tasks were completed. If priorities shifted, that\'s OK — just note what changed so we stay aligned.');
    } else {
      lines.push('✔️ Nice — did today\'s work match this plan? Staying consistent helps build great momentum.');
    }
  }

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
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
function buildAiEvaluationPrompt(teamData, lastEvaluation) {
  var today = new Date();
  var dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][today.getDay()];

  var prompt = 'You are evaluating daily team performance for a remote team. Today is ' + dayName + '.\n\n';
  prompt += 'You have BOTH today\'s data AND historical context (last 7 days + 4-week trends). ';
  prompt += 'Use each person\'s own historical baseline to make specific, evidence-based assessments. ';
  prompt += 'Do NOT make generic observations — compare today to their personal patterns.\n\n';

  // --- Last evaluation for continuity ---
  if (lastEvaluation && lastEvaluation.evaluation_text) {
    prompt += '## Previous Evaluation (' + lastEvaluation.evaluation_date + ')\n';
    prompt += lastEvaluation.evaluation_text.substring(0, 500);
    if (lastEvaluation.evaluation_text.length > 500) prompt += '...';
    prompt += '\n\nNote any changes from the above — did flagged issues improve or persist?\n\n';
  }

  // --- Compute department benchmarks ---
  var deptStats = {};
  teamData.forEach(function(m) {
    var dept = m.department || 'Unknown';
    if (!deptStats[dept]) {
      deptStats[dept] = { members: 0, totalAvgHours: 0, hoursCount: 0, totalCompleted: 0, totalDue: 0, taskCount: 0 };
    }
    deptStats[dept].members++;
    if (m.weeklyHours && m.weeklyHours.avgDaily > 0) {
      deptStats[dept].totalAvgHours += m.weeklyHours.avgDaily;
      deptStats[dept].hoursCount++;
    }
    if (m.weeklyTaskStats) {
      deptStats[dept].totalCompleted += (parseInt(m.weeklyTaskStats.total_completed) || 0);
      deptStats[dept].totalDue += (parseInt(m.weeklyTaskStats.total_due) || 0);
      deptStats[dept].taskCount++;
    }
  });
  // Calculate averages
  for (var dept in deptStats) {
    var ds = deptStats[dept];
    ds.avgHoursPerDay = ds.hoursCount > 0 ? Math.round(ds.totalAvgHours / ds.hoursCount * 10) / 10 : null;
    ds.avgCompletionRate = ds.totalDue > 0 ? Math.round(ds.totalCompleted / ds.totalDue * 100) : null;
  }

  // Department benchmarks section
  var deptKeys = Object.keys(deptStats).sort();
  if (deptKeys.length > 1 || (deptKeys.length === 1 && deptKeys[0] !== 'Unknown')) {
    prompt += '## Department Benchmarks (7-day averages)\n';
    deptKeys.forEach(function(dept) {
      var ds = deptStats[dept];
      prompt += '- **' + dept + '** (' + ds.members + ' people): ';
      if (ds.avgHoursPerDay !== null) prompt += 'avg ' + ds.avgHoursPerDay + 'h/day';
      if (ds.avgCompletionRate !== null) prompt += ', ' + ds.avgCompletionRate + '% task completion';
      prompt += '\n';
    });
    prompt += '\n';
  }

  prompt += '## Team Data\n\n';

  teamData.forEach(function(member) {
    // Header with role context
    prompt += '### ' + member.name + ' (' + member.email + ')';
    if (member.department || member.position) {
      prompt += ' | ' + (member.department || '') + (member.department && member.position ? ' - ' : '') + (member.position || '');
    }
    prompt += '\n';

    // Today's data
    prompt += '**Today:** Check-in: ' + (member.checkedIn ? 'Yes' : 'NO') + (member.isLate ? ' (Late)' : '');
    prompt += ' | EOD: ' + (member.eodSubmitted ? 'Yes' : 'NO');
    prompt += ' | Hours: ' + (member.hoursReported !== null ? member.hoursReported + 'h' : 'NOT REPORTED');
    prompt += ' (expected: ' + member.expectedHoursToday + 'h)\n';

    if (member.clickupEstimateHrs !== null) {
      prompt += 'ClickUp Time Estimates Total: ' + member.clickupEstimateHrs + 'h\n';
    }

    if (member.blockers) {
      prompt += 'Blockers: "' + member.blockers.substring(0, 200) + '"\n';
    }

    // Task stats
    if (member.taskStats) {
      prompt += 'Tasks: ' + member.taskStats.dueToday + ' due, ' + member.taskStats.completed + ' done, ' + member.taskStats.delayed + ' delayed, ' + member.taskStats.overdue + ' overdue';
      if (member.taskStats.overdue > 0) {
        prompt += ' (oldest: ' + member.taskStats.oldestOverdueDays + ' days)';
      }
      prompt += '\n';
    }

    // Task details (capped at 5)
    if (member.taskDetails && member.taskDetails.length > 0) {
      prompt += 'Task List:\n';
      member.taskDetails.forEach(function(t) {
        prompt += '  * "' + t.name + '" [' + t.status + ']';
        if (t.isOverdue) prompt += ' (OVERDUE)';
        if (t.timeEstimateHrs) prompt += ' (est: ' + t.timeEstimateHrs + 'h)';
        if (t.description) prompt += ' — ' + t.description;
        prompt += '\n';
      });
    }

    if (member.eodReport) {
      prompt += 'EOD Summary: "' + member.eodReport.substring(0, 200) + '"\n';
    }

    // Follow-through check
    if (member.yesterdayPriority) {
      prompt += '\n**Follow-Through:** Yesterday said they\'d do: "' + member.yesterdayPriority.substring(0, 200) + '"\n';
    }

    // Historical: 7-day attendance
    prompt += '\n**7-Day History:**\n';
    if (member.weeklyAttendance) {
      var wa = member.weeklyAttendance;
      prompt += '  Attendance: ' + (parseInt(wa.checkin_days) || 0) + '/5 check-ins, ' + (parseInt(wa.late_days) || 0) + ' late, ' + (parseInt(wa.eod_days) || 0) + ' EODs';
      prompt += ' | On-time streak: ' + member.onTimeStreak + ' days\n';
    } else {
      prompt += '  Attendance: No history available | Streak: ' + member.onTimeStreak + ' days\n';
    }

    // Historical: 7-day hours + department comparison
    if (member.weeklyHours) {
      var wh = member.weeklyHours;
      prompt += '  Hours: avg ' + wh.avgDaily + 'h/day (' + wh.daysReported + ' days reported), total: ' + Math.round(wh.totalHours * 10) / 10 + 'h';
      var memberDept = member.department || 'Unknown';
      if (deptStats[memberDept] && deptStats[memberDept].avgHoursPerDay !== null && deptStats[memberDept].members > 1) {
        prompt += ' | Dept avg: ' + deptStats[memberDept].avgHoursPerDay + 'h/day';
      }
      prompt += '\n';
    } else {
      prompt += '  Hours: No history available\n';
    }

    // Historical: 7-day task throughput + department comparison
    if (member.weeklyTaskStats) {
      var wt = member.weeklyTaskStats;
      var avgRate = parseFloat(wt.avg_completion_rate) || 0;
      prompt += '  Tasks: ' + (parseInt(wt.total_completed) || 0) + '/' + (parseInt(wt.total_due) || 0) + ' completed (' + avgRate + '%), ' + (parseInt(wt.total_moved) || 0) + ' delayed';
      var memberDeptT = member.department || 'Unknown';
      if (deptStats[memberDeptT] && deptStats[memberDeptT].avgCompletionRate !== null && deptStats[memberDeptT].members > 1) {
        prompt += ' | Dept avg: ' + deptStats[memberDeptT].avgCompletionRate + '%';
      }
      prompt += '\n';
    }

    // 4-week hours trend (compact one-liner)
    if (member.hoursTrend && member.hoursTrend.length > 0) {
      prompt += '  4-Week Trend: ';
      prompt += member.hoursTrend.map(function(w) {
        return 'Wk' + w.week_num + ': ' + w.avg_daily_hours + 'h/day';
      }).join(' | ');
      prompt += '\n';
    }

    // Chronic issues
    if (member.repeatDelayedTasks && member.repeatDelayedTasks.length > 0) {
      prompt += '  Chronic Delays: ';
      prompt += member.repeatDelayedTasks.map(function(t) {
        return '"' + t.task_name + '" delayed ' + t.times_delayed + 'x';
      }).join(', ');
      prompt += '\n';
    }

    prompt += '\n';
  });

  // Instructions
  prompt += '## Instructions\n\n';
  prompt += 'For each team member, provide:\n';
  prompt += '1. **Rating**: Excellent / Good / Needs Attention / Concern\n';
  prompt += '2. **Hours Analysis**: Compare reported hours to (a) their own 7-day average, (b) their department average, (c) expected hours. Flag significant deviations.\n';
  prompt += '3. **Follow-Through**: Did they work on what they said they would yesterday? Flag mismatches.\n';
  prompt += '4. **Productivity Check**: Today\'s output vs their own 7-day average AND their department\'s average completion rate. Is this an up or down day?\n';
  prompt += '5. **Trend Direction**: Based on 4-week data — is this person trending up, down, or stable?\n';
  prompt += '6. **Peer Comparison**: How does this person compare to others in the same department? Are they an outlier (high or low)?\n';
  prompt += '7. **Risk Flags**: Specific concerns with evidence from the data.\n';
  prompt += '8. **Recommended Action**: What management should do (if anything).\n\n';

  prompt += '## Patterns to Flag\n';
  prompt += '- Hours significantly below their own 7-day average (not just the team standard)\n';
  prompt += '- Declining hours trend over 4 weeks\n';
  prompt += '- Stated priority yesterday not reflected in today\'s tasks (follow-through gap)\n';
  prompt += '- Task completion rate below their own average\n';
  prompt += '- On-time streak broken after 5+ days (momentum loss)\n';
  prompt += '- Repeat-delayed tasks — same task pushed 3+ times = avoidance pattern\n';
  prompt += '- Blockers mentioned with no management escalation\n';
  prompt += '- Reported 8h but only 1-2 small tasks completed (compare to their typical throughput)\n';
  prompt += '- Missing check-in or EOD — is this a one-off or pattern? Check 7-day attendance\n';
  prompt += '- Low hours + high output = possible underreporting (flag for praise, not concern)\n';
  prompt += '- Improvement from previous evaluation flags (acknowledge progress)\n\n';

  prompt += '- Person consistently below their department average hours or completion rate\n';
  prompt += '- Person significantly above department average (recognize top performers)\n\n';
  prompt += 'Be direct and specific. Name names. Reference the data — cite numbers.\n';
  prompt += 'Compare each person to BOTH their own historical baseline AND their department peers.\n';
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
