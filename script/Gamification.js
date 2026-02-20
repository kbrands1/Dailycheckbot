/**
 * Gamification.gs - Badges, Streaks & Leaderboards
 * Handles gamification features
 */

/**
 * Badge definitions
 */
const BADGES = {
  // Attendance badges
  EARLY_BIRD: { emoji: '🌅', name: 'Early Bird', description: 'Checked in before start time every day this week' },
  IRONMAN: { emoji: '🦾', name: 'Ironman', description: '20+ consecutive workdays with check-in and EOD' },
  PUNCTUAL: { emoji: '⏰', name: 'Punctual Pro', description: '100% on-time check-ins this week' },

  // Task badges
  TASK_CRUSHER: { emoji: '🎯', name: 'Task Crusher', description: '100% completion rate for the week' },
  ZERO_OVERDUE: { emoji: '⚡', name: 'Zero Overdue', description: 'No overdue tasks all week' },
  BACKLOG_BUSTER: { emoji: '📉', name: 'Backlog Buster', description: 'Cleared 5+ overdue tasks in one day' },
  NO_DELAYS: { emoji: '🔥', name: 'No Delays', description: 'Didn\'t move any tasks all week' },
  PRODUCTIVITY_STAR: { emoji: '🚀', name: 'Productivity Star', description: 'Most tasks completed this week (Top 1)' },
  ON_TIME_CHAMPION: { emoji: '🏅', name: 'On-Time Champion', description: '100% tasks completed by due date this week' },

  // Consistency badges
  CONSISTENCY_KING: { emoji: '👑', name: 'Consistency King', description: '100% monthly check-in rate' },
  BLOCKER_BUSTER: { emoji: '💪', name: 'Blocker Buster', description: '0 blockers reported for 2+ consecutive weeks' },

  // Streak badges
  STREAK_5: { emoji: '🔥', name: '5-Day Streak', description: '5 consecutive on-time check-ins' },
  STREAK_10: { emoji: '🔥🔥', name: '10-Day Streak', description: '10 consecutive on-time check-ins' },
  STREAK_20: { emoji: '🔥🔥🔥', name: '20-Day Streak', description: '20 consecutive on-time check-ins' }
};

/**
 * Calculate badges earned this week
 */
function calculateWeeklyBadges() {
  const teamMembers = getCachedWorkingEmployees();
  const config = getConfig();
  const badges = [];

  // We need task leaderboard to determine Productivity Star (top 1)
  var topCompleter = null;
  if (config.clickup_config.enabled) {
    try {
      var taskLb = buildTaskCompletionLeaderboard();
      if (taskLb.length > 0 && taskLb[0].completed > 0) {
        topCompleter = taskLb[0].email;
      }
    } catch (err) {
      console.error('Error building task leaderboard for badges:', err.message);
    }
  }

  for (const member of teamMembers) {
    const memberBadges = [];
    const name = member.name || member.email.split('@')[0];

    // Get weekly stats
    const weeklyStats = getUserWeeklyStats(member.email);
    const streak = getUserStreak(member.email);

    // ── Attendance badges ──

    // Punctual Pro: 100% on-time check-ins this week (5/5 on-time, full week)
    if (parseInt(weeklyStats.checkin_days) >= 5 && parseInt(weeklyStats.late_days) === 0) {
      memberBadges.push(BADGES.PUNCTUAL);
    }

    // Early Bird: Checked in on-time every day checked in (at least 3 days, 0 late)
    // Different from Punctual — can earn with partial week if always on-time
    var checkinDays = parseInt(weeklyStats.checkin_days) || 0;
    var lateDays = parseInt(weeklyStats.late_days) || 0;
    if (checkinDays >= 3 && checkinDays < 5 && lateDays === 0) {
      memberBadges.push(BADGES.EARLY_BIRD);
    }

    // Ironman: 20+ consecutive workdays with both check-in AND EOD
    // Use streak (on-time check-ins) as proxy; also verify EODs
    if (streak >= 20 && parseInt(weeklyStats.eod_days) >= 5) {
      memberBadges.push(BADGES.IRONMAN);
    }

    // ── Streak badges ──
    if (streak >= 20) {
      memberBadges.push(BADGES.STREAK_20);
    } else if (streak >= 10) {
      memberBadges.push(BADGES.STREAK_10);
    } else if (streak >= 5) {
      memberBadges.push(BADGES.STREAK_5);
    }

    // ── Task badges (if ClickUp/Odoo enabled) ──
    if (config.clickup_config.enabled) {
      const taskStats = getUserTaskStats(member.email);

      if (taskStats) {
        const completionRate = parseFloat(taskStats.avg_completion_rate) || 0;
        const totalOverdue = parseInt(taskStats.total_overdue) || 0;
        const totalMoved = parseInt(taskStats.total_moved) || 0;
        const totalCompleted = parseInt(taskStats.total_completed) || 0;
        const totalDue = parseInt(taskStats.total_due) || 0;

        // Task Crusher: 100% completion rate
        if (completionRate >= 1.0 && totalDue > 0) {
          memberBadges.push(BADGES.TASK_CRUSHER);
        }

        // Zero Overdue: no overdue tasks all week (must have had tasks due)
        if (totalOverdue === 0 && totalDue > 0) {
          memberBadges.push(BADGES.ZERO_OVERDUE);
        }

        // No Delays: didn't move any tasks all week
        if (totalMoved === 0 && totalDue > 0) {
          memberBadges.push(BADGES.NO_DELAYS);
        }

        // On-Time Champion: 100% tasks completed by due date (completion rate = 1.0 AND zero overdue)
        if (completionRate >= 1.0 && totalOverdue === 0 && totalDue > 0) {
          memberBadges.push(BADGES.ON_TIME_CHAMPION);
        }

        // Productivity Star: Most tasks completed this week (Top 1)
        if (topCompleter && member.email === topCompleter && totalCompleted > 0) {
          memberBadges.push(BADGES.PRODUCTIVITY_STAR);
        }

        // Backlog Buster: Check if cleared 5+ overdue tasks in a single day this week
        try {
          var backlogBusted = checkBacklogBuster(member.email);
          if (backlogBusted) {
            memberBadges.push(BADGES.BACKLOG_BUSTER);
          }
        } catch (err) {
          // Silently skip
        }
      }
    }

    // ── Consistency badges ──

    // Consistency King: 100% monthly check-in rate
    try {
      var monthlyRate = getMonthlyCheckinRate(member.email);
      if (monthlyRate >= 100) {
        memberBadges.push(BADGES.CONSISTENCY_KING);
      }
    } catch (err) {
      // Silently skip
    }

    // Blocker Buster: 0 blockers for 2+ consecutive weeks
    try {
      var noBlockerWeeks = getConsecutiveNoBlockerWeeks(member.email);
      if (noBlockerWeeks >= 2) {
        memberBadges.push(BADGES.BLOCKER_BUSTER);
      }
    } catch (err) {
      // Silently skip
    }

    // Add to badges list
    memberBadges.forEach(badge => {
      badges.push({
        email: member.email,
        name: name,
        badge: badge.emoji,
        badgeName: badge.name,
        description: badge.description
      });
    });
  }

  return badges;
}

/**
 * Check if user cleared 5+ overdue tasks in a single day this week
 * Cross-references completed tasks with overdue snapshots to count only overdue completions
 */
function checkBacklogBuster(email) {
  var projectId = getProjectId();
  var safeEmail = sanitizeForBQ(email);

  // Get latest action per task, then join with overdue_snapshots to count only tasks whose final action is COMPLETE
  var result = runBigQueryQuery(
    'SELECT DATE(a.timestamp) as action_date, COUNT(*) as completed_overdue'
    + ' FROM ('
    + '   SELECT task_id, user_email, action_type, timestamp FROM ('
    + '     SELECT task_id, user_email, action_type, timestamp,'
    + '       ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY timestamp DESC) as rn'
    + '     FROM `' + projectId + '.checkin_bot.clickup_task_actions`'
    + '     WHERE user_email = \'' + safeEmail + '\''
    + '       AND timestamp >= TIMESTAMP_TRUNC(CURRENT_TIMESTAMP(), WEEK(MONDAY))'
    + '   ) WHERE rn = 1 AND action_type = \'COMPLETE\''
    + ' ) a'
    + ' INNER JOIN `' + projectId + '.checkin_bot.overdue_snapshots` o'
    + '   ON a.task_id = o.task_id AND a.user_email = o.user_email'
    + ' GROUP BY DATE(a.timestamp)'
    + ' HAVING COUNT(*) >= 5'
    + ' LIMIT 1'
  );

  return result && result.length > 0;
}

/**
 * Get monthly check-in rate for a user (current month)
 */
function getMonthlyCheckinRate(email) {
  var projectId = getProjectId();
  var safeEmail = sanitizeForBQ(email);

  var result = runBigQueryQuery(
    'SELECT COUNT(DISTINCT checkin_date) as checkin_days'
    + ' FROM `' + projectId + '.checkin_bot.check_ins`'
    + ' WHERE user_email = \'' + safeEmail + '\''
    + '   AND checkin_date >= DATE_TRUNC(CURRENT_DATE(), MONTH)'
  );

  if (!result || result.length === 0) return 0;

  var checkinDays = parseInt(result[0].checkin_days) || 0;
  // Calculate workdays elapsed this month
  var today = new Date();
  var firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  var workdaysElapsed = 0;
  var d = new Date(firstOfMonth);
  while (d <= today) {
    var dow = d.getDay();
    if (dow !== 0 && dow !== 6) workdaysElapsed++;
    d.setDate(d.getDate() + 1);
  }

  return workdaysElapsed > 0 ? Math.round(checkinDays / workdaysElapsed * 100) : 0;
}

/**
 * Get number of consecutive weeks with 0 blockers reported
 */
function getConsecutiveNoBlockerWeeks(email) {
  var projectId = getProjectId();
  var safeEmail = sanitizeForBQ(email);

  // Check last 4 weeks for blocker reports
  var result = runBigQueryQuery(
    'SELECT EXTRACT(ISOWEEK FROM eod_date) as week_num,'
    + ' SUM(CASE WHEN blockers IS NOT NULL AND blockers != \'\' THEN 1 ELSE 0 END) as blocker_count'
    + ' FROM `' + projectId + '.checkin_bot.v_eod_reports`'
    + ' WHERE user_email = \'' + safeEmail + '\''
    + '   AND eod_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 28 DAY)'
    + ' GROUP BY week_num'
    + ' ORDER BY week_num DESC'
  );

  if (!result || result.length === 0) return 0;

  var consecutive = 0;
  for (var i = 0; i < result.length; i++) {
    if (parseInt(result[i].blocker_count) === 0) {
      consecutive++;
    } else {
      break;
    }
  }

  return consecutive;
}

/**
 * Build attendance leaderboard
 */
function buildAttendanceLeaderboard() {
  const teamMembers = getCachedWorkingEmployees();
  const leaderboard = [];

  for (const member of teamMembers) {
    const weeklyStats = getUserWeeklyStats(member.email);
    const name = member.name || member.email.split('@')[0];

    const totalCheckIns = parseInt(weeklyStats.checkin_days) || 0;
    const lateDays = parseInt(weeklyStats.late_days) || 0;
    const onTimeRate = totalCheckIns > 0
      ? Math.round((totalCheckIns - lateDays) / totalCheckIns * 100)
      : 0;

    leaderboard.push({
      email: member.email,
      name: name,
      checkIns: totalCheckIns,
      onTimeRate: onTimeRate,
      streak: getUserStreak(member.email)
    });
  }

  // Sort by on-time rate, then by check-ins
  leaderboard.sort((a, b) => {
    if (b.onTimeRate !== a.onTimeRate) return b.onTimeRate - a.onTimeRate;
    return b.checkIns - a.checkIns;
  });

  return leaderboard;
}

/**
 * Build task completion leaderboard
 */
function buildTaskCompletionLeaderboard() {
  const config = getConfig();
  if (!config.clickup_config.enabled) return [];

  const teamMembers = getCachedWorkingEmployees();
  const leaderboard = [];

  for (const member of teamMembers) {
    const taskStats = getUserTaskStats(member.email);
    const name = member.name || member.email.split('@')[0];

    if (taskStats) {
      const total = parseInt(taskStats.total_due) || 0;
      const completed = parseInt(taskStats.total_completed) || 0;
      const completionRate = total > 0 ? Math.round(completed / total * 100) : 0;

      leaderboard.push({
        email: member.email,
        name: name,
        total: total,
        completed: completed,
        completionRate: completionRate
      });
    }
  }

  // Sort by completion rate, then by total completed
  leaderboard.sort((a, b) => {
    if (b.completionRate !== a.completionRate) return b.completionRate - a.completionRate;
    return b.completed - a.completed;
  });

  return leaderboard;
}

/**
 * Get people with zero overdue tasks
 */
function getZeroOverdueList() {
  const config = getConfig();
  if (!config.clickup_config.enabled) return [];

  const teamMembers = getCachedWorkingEmployees();
  const zeroOverdue = [];

  for (const member of teamMembers) {
    const tasks = getTasksForUser(member.email, 'today');
    const overdue = tasks.filter(t => t.isOverdue);

    if (overdue.length === 0) {
      zeroOverdue.push({
        email: member.email,
        name: member.name || member.email.split('@')[0]
      });
    }
  }

  return zeroOverdue;
}

/**
 * Post weekly gamification to channel
 */
function postWeeklyGamification() {
  console.log('Posting weekly gamification...');

  if (!isWorkday()) {
    console.log('Not a workday, skipping gamification');
    return;
  }

  const attendanceLeaderboard = buildAttendanceLeaderboard();
  const taskLeaderboard = buildTaskCompletionLeaderboard();
  const zeroOverdue = getZeroOverdueList();
  const badges = calculateWeeklyBadges();

  const leaderboard = {
    attendance: attendanceLeaderboard.slice(0, 5),
    taskCompletion: taskLeaderboard.slice(0, 5),
    zeroOverdue: zeroOverdue
  };

  const message = buildWeeklyGamificationMessage(leaderboard, badges);

  const spaceId = getTeamUpdatesChannel();
  if (spaceId) {
    sendChannelMessage(spaceId, message);
  }

  // BUG #15 fix: Actually award badges (log to BigQuery + notify users)
  if (badges && badges.length > 0) {
    for (var i = 0; i < badges.length; i++) {
      try {
        // Find the badge key from BADGES constant
        var badgeKey = null;
        for (var key in BADGES) {
          if (BADGES[key].name === badges[i].badgeName) {
            badgeKey = key;
            break;
          }
        }
        if (badgeKey) {
          awardBadge(badges[i].email, badgeKey);
        }
      } catch (err) {
        console.error('Error awarding badge to ' + badges[i].email + ':', err.message);
      }
    }
  }

  logSystemEvent('WEEKLY_GAMIFICATION', 'SUCCESS', {
    badgesAwarded: badges.length
  });

  console.log('Weekly gamification posted');
}

/**
 * Award badge to user
 */
function awardBadge(userEmail, badgeKey) {
  const badge = BADGES[badgeKey];
  if (!badge) return;

  // Log to BigQuery
  insertIntoBigQuery('badges_awarded', [{
    badge_id: Utilities.getUuid(),
    user_email: userEmail,
    badge_key: badgeKey,
    badge_emoji: badge.emoji,
    badge_name: badge.name,
    awarded_at: new Date().toISOString()
  }]);

  // Optionally notify user
  const message = `🎉 **Badge Earned!**\n\n${badge.emoji} **${badge.name}**\n${badge.description}`;
  sendDirectMessage(userEmail, message);
}
