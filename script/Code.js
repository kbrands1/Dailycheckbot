/**
 * Code.gs - Main Entry Points & Triggers
 * Primary bot logic and scheduled trigger handlers
 *
 * This file uses Google Chat Add-on style event handlers.
 * Event structure: https://developers.google.com/chat/api/guides/message-formats/events
 */

const TEST_MODE = false; // Set to true only for development testing

// ============================================
// USER STATE MANAGEMENT (BUG #4 fix)
// ============================================

/**
 * Set conversation state for a user
 * States: AWAITING_CHECKIN, AWAITING_EOD, IDLE
 * Uses PropertiesService for persistence across execution contexts
 */
function setUserState(email, state) {
  var props = PropertiesService.getScriptProperties();
  var value = state + '|' + new Date().toISOString();
  props.setProperty('USER_STATE_' + email.replace(/[^a-zA-Z0-9]/g, '_'), value);
}

/**
 * Get conversation state for a user
 * Returns IDLE if state is missing or expired (4 hour TTL)
 */
function getUserState(email) {
  var props = PropertiesService.getScriptProperties();
  var key = 'USER_STATE_' + email.replace(/[^a-zA-Z0-9]/g, '_');
  var raw = props.getProperty(key);
  if (!raw) return 'IDLE';

  var parts = raw.split('|');
  var state = parts[0];
  var timestamp = parts[1] ? new Date(parts[1]) : null;

  // Expire after 4 hours
  if (timestamp && (Date.now() - timestamp.getTime() > 4 * 3600 * 1000)) {
    props.deleteProperty(key);
    return 'IDLE';
  }
  return state;
}

/**
 * Clear conversation state for a user
 */
function clearUserState(email) {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('USER_STATE_' + email.replace(/[^a-zA-Z0-9]/g, '_'));
}

// ============================================
// CHAT EVENT HANDLERS
// ============================================

/**
 * Responds to a MESSAGE event triggered
 * in Google Chat.
 * Handle incoming messages from Google Chat (Add-on style)
 * BUG #2, #3, #4 fix: Routes messages based on user state
 * @param event the event object from Google Chat
 * @return JSON-formatted response
 */
function onMessage(event) {
  console.log("onMessage triggered at", new Date().toISOString());
  console.log("Event:", JSON.stringify(event));

  try {
    var message = event.chat.messagePayload.message || {};
    var sender = event.chat.user || {};
    var space = event.chat.messagePayload.space || {};

    var text = message.argumentText || message.text || '';

    console.log("User:", sender.displayName, "Text:", text);

    // Store DM space for future proactive messaging
    if (space.type === 'DM' && space.name && sender.email) {
      storeDMSpace(sender.email, space.name);
    }

    var lowerText = text.toLowerCase().trim();

    // Weekend/after-hours guard: acknowledge but don't process as check-in/EOD
    if (!isWorkday()) {
      if (!['help', '?', 'ping', 'hi', 'hello'].includes(lowerText)) {
        return createChatResponse('📅 It\'s outside work hours. I\'ll be available on the next workday. If this is urgent, contact your manager directly.');
      }
    }

    // === Simple commands (always handled regardless of state) ===
    if (lowerText === 'hi' || lowerText === 'hello') {
      return createChatResponse("👋 Hi " + (sender.displayName || "there") + "! I'm the Daily Check-in Bot. Type \"help\" for available commands.");
    }

    if (lowerText === 'ping') {
      return createChatResponse("🏓 Pong! Bot is working.");
    }

    if (lowerText === 'help' || lowerText === '?') {
      return createChatResponse(
        "📋 *Daily Check-in Bot Help*\n\n" +
        "*Commands:*\n" +
        "• `help` - Show this message\n" +
        "• `ping` - Check if bot is responding\n" +
        "• `refresh` - Refresh ClickUp data\n\n" +
        "*How it works:*\n" +
        "• Morning: I'll send you your tasks for the day\n" +
        "• Reply \"here\" or share your priority to check in\n" +
        "• EOD: I'll ask you to update task progress\n" +
        "• Reply with your EOD summary when prompted"
      );
    }

    if (lowerText === 'refresh' || lowerText === 'refresh lists') {
      clearClickUpCache();
      return createChatResponse("🔄 ClickUp data refreshed!");
    }

    // Test commands (for development)
    if (lowerText === 'test eod' || lowerText === 'testeod') {
      var testTasks = getTasksForUser(sender.email, 'today');
      var testEodMessage = getEodRequestMessage({ email: sender.email, name: sender.displayName }, testTasks);
      if (testEodMessage.cardsV2) {
        return createChatResponse({
          text: testEodMessage.text,
          cardsV2: testEodMessage.cardsV2
        });
      }
      return createChatResponse(testEodMessage.text);
    }

    if (lowerText === 'test checkin' || lowerText === 'testcheckin') {
      var testCheckInTasks = getTasksForUser(sender.email, 'today');
      var testMsg = getMorningCheckInMessage({ email: sender.email, name: sender.displayName }, testCheckInTasks, false);
      return createChatResponse(testMsg);
    }

    // 1-on-1 prep command
    if (lowerText.startsWith('prep ') || lowerText.startsWith('/prep ')) {
      var targetName = text.replace(/^\/?prep\s+/i, '').trim();
      return handlePrepCommand(sender.email, targetName);
    }

    // === State-based routing (BUG #2, #3, #4 fix) ===
    var userState = getUserState(sender.email);
    console.log("User state for " + sender.email + ": " + userState);

    if (userState === 'AWAITING_CHECKIN') {
      // Any reply during check-in window is treated as check-in
      clearUserState(sender.email);
      return handleCheckInResponse(sender.email, sender.displayName, text);
    }

    if (userState === 'AWAITING_EOD' || (TEST_MODE && lowerText === 'completed testing tasks. no blockers. tomorrow: continue testing.')) {
      // Any reply during EOD window is treated as EOD report
      clearUserState(sender.email);
      return handleEodResponse(sender.email, sender.displayName, text);
    }

    // Hours follow-up: bare number updates today's EOD hours
    var bareNum = text.trim().match(/^(\d+\.?\d*)$/);
    if (bareNum) {
      var hrs = parseFloat(bareNum[1]);
      if (hrs >= 0 && hrs <= 24) {
        updateTodayEodHours(sender.email, hrs);
        return createChatResponse('✅ Logged ' + hrs + ' hours for today. Thanks!');
      } else if (hrs > 24) {
        return createChatResponse('⚠️ ' + hrs + ' hours seems too high (max 24). Please reply with your actual hours worked today (e.g. "8").');
      }
    }

    // === Fallback: check if "here" even without state (BUG #2 fix) ===
    if (['here', 'i\'m here', 'im here', 'present'].includes(lowerText) ||
      (TEST_MODE && ['here - testing check-in flow', 'here - late test'].includes(lowerText))) {
      return handleCheckInResponse(sender.email, sender.displayName, text);
    }

    // Default response
    return createChatResponse("✅ Got your message: \"" + text + "\"\n\nIf you're checking in, reply \"here\". For help, type \"help\".");

  } catch (error) {
    console.error("Error in onMessage:", error.message, error.stack);
    return createChatResponse("Sorry, something went wrong. Please try again.");
  }
}

/**
 * Responds to an ADDED_TO_SPACE event in Google Chat.
 * @param {object} event the event object from Google Chat
 * @return {object} JSON-formatted response
 * @see https://developers.google.com/workspace/chat/receive-respond-interactions
 */
function onAddToSpace(event) {
  console.log("onAddToSpace triggered at", new Date().toISOString());
  console.log("Event:", JSON.stringify(event));

  try {
    var space = event.chat.addedToSpacePayload.space || {};
    var user = event.chat.user || {};

    console.log("Space:", JSON.stringify(space));
    console.log("User:", JSON.stringify(user));

    var welcomeMessage = "";

    var isDM = space.singleUserBotDm || space.type === 'DM' || space.spaceType === 'DIRECT_MESSAGE';

    if (isDM) {
      welcomeMessage = "👋 Hi! I'm the Daily Check-in Bot.\n\n" +
        "I'll send you:\n" +
        "• Morning check-ins with your ClickUp tasks\n" +
        "• EOD requests to update task progress\n\n" +
        "Commands:\n" +
        "• `help` - Show help message\n" +
        "• `ping` - Check if bot is working";

      if (space.name && user.email) {
        storeDMSpace(user.email, space.name);
      }
    } else {
      welcomeMessage = "👋 Thanks for adding me to " + (space.displayName || "this chat") + "!\n\n" +
        "I'll post team summaries and updates here.";
    }

    console.log("Welcome message:", welcomeMessage);

    return createChatResponse(welcomeMessage);

  } catch (error) {
    console.error("Error in onAddToSpace:", error.message, error.stack);
    return createChatResponse("👋 Hi! I'm the Daily Check-in Bot. Type 'help' for commands.");
  }
}

/**
 * Responds to a REMOVED_FROM_SPACE event in Google Chat.
 * @param {object} event the event object from Google Chat
 * @see https://developers.google.com/workspace/chat/receive-respond-interactions
 */
function onRemoveFromSpace(event) {
  console.log("onRemoveFromSpace triggered at", new Date().toISOString());
  console.log("Event:", JSON.stringify(event));
  var space = event.chat.removedFromSpacePayload.space;
  console.log("Bot removed from space:", space ? space.name : "unknown");
}

/**
 * Handle card action clicks (Add-on style)
 */
function onCardClick(event) {
  console.log("onCardClick triggered at", new Date().toISOString());
  console.log("Event:", JSON.stringify(event));

  var action = event.action || {};
  var common = event.common || {};
  var actionName = action.actionMethodName || common.invokedFunction || '';

  switch (actionName) {
    case 'handleTaskAction':
      return handleTaskAction(event);
    case 'handleDelayAction':
      return handleDelayAction(event);
    case 'handleDelayReasonSelected':
      return handleDelayReasonSelected(event);
    default:
      console.warn('Unknown action: ' + actionName);
      return createChatResponse('Unknown action');
  }
}

/**
 * Handle check-in response
 */
function handleCheckInResponse(email, name, text) {
  // Log prompt response for adoption tracking
  logPromptResponse(email, 'CHECKIN');

  // Use per-user schedule for late threshold
  var schedule = getUserWorkSchedule(email);
  var now = new Date();

  var parts = schedule.blocks[0].start.split(':');
  var startHour = parseInt(parts[0]);
  var startMin = parseInt(parts[1]);
  var graceMinutes = getLateThresholdMin();
  var totalGraceMin = startMin + graceMinutes;
  var lateThreshold = new Date(now);
  lateThreshold.setHours(startHour + Math.floor(totalGraceMin / 60), totalGraceMin % 60, 0, 0);
  var lowerText = text.toLowerCase();

  var isLate = TEST_MODE && lowerText === 'here - late test' ? true : (TEST_MODE && lowerText === 'here - testing check-in flow' ? false : now > lateThreshold);

  logCheckIn(email, now, text, isLate);

  return createChatResponse(getCheckInConfirmation(isLate));
}

/**
 * Handle EOD response
 */
function handleEodResponse(email, name, text) {
  // Log prompt response for adoption tracking
  logPromptResponse(email, 'EOD');

  var now = new Date();
  var isFriday = now.getDay() === 5;
  var config = getConfig();

  // Try AI parsing first if enabled, fall back to regex
  var parsed = null;
  if (config.settings.enable_ai_eod_parsing !== false) {
    try {
      parsed = parseEodWithAI(text);
    } catch (e) {
      console.error('AI EOD parsing failed, using regex fallback:', e.message);
    }
  }

  var tasksCompleted = parsed ? parsed.tasks_completed : text;
  var blockers = parsed ? parsed.blockers : extractBlockers(text);
  var tomorrowPriority = parsed ? parsed.tomorrow_priority : extractTomorrowPriority(text);
  var hoursWorked = parsed ? parsed.hours_worked : extractHoursWorked(text);

  logEodReport(email, now, tasksCompleted, blockers, tomorrowPriority, text, hoursWorked);

  // --- Build personalized EOD feedback ---
  var feedback = {};

  // Get yesterday's stated priority for follow-through check
  try {
    feedback.yesterdayPriority = getUserYesterdayPriority(email);
  } catch (e) {
    console.error('Failed to fetch yesterday priority for EOD feedback:', e.message);
    feedback.yesterdayPriority = null;
  }

  // Get today's task stats
  try {
    if (config.clickup_config && config.clickup_config.enabled) {
      var member = config.team_members.find(function(m) { return m.email === email; });
      var taskSource = member ? member.task_source : 'clickup';

      if (taskSource === 'clickup') {
        var tasks = getTasksForUser(email, 'today');
        if (tasks && tasks.length > 0) {
          var completed = tasks.filter(function(t) { return t.status && t.status.toLowerCase().includes('close'); }).length;
          var inProgress = tasks.filter(function(t) { return t.status && t.status.toLowerCase().includes('progress'); }).length;
          var overdue = tasks.filter(function(t) { return t.isOverdue; }).length;
          feedback.taskStats = {
            total: tasks.length,
            completed: completed,
            inProgress: inProgress,
            overdue: overdue,
            notStarted: tasks.length - completed - inProgress
          };
        }
      }
    }
  } catch (e) {
    console.error('Failed to fetch task stats for EOD feedback:', e.message);
  }

  // Get expected hours
  try {
    feedback.expectedHours = getTodayExpectedHours(email);
  } catch (e) {
    feedback.expectedHours = 8;
  }
  feedback.hoursWorked = hoursWorked;

  var response = isFriday ? getFridayEodConfirmation(feedback) : getEodConfirmation(feedback);

  if (hoursWorked === null) {
    response += '\n\n⏰ I didn\'t catch your hours worked today. Reply with just a number (e.g. "6.5") to log your hours.';
  }

  return createChatResponse(response);
}

/**
 * Extract blockers from text
 */
function extractBlockers(text) {
  var blockerPatterns = [
    /blocker[s]?:?\s*(.+?)(?:\n|$)/i,
    /blocked\s+(?:by|on):?\s*(.+?)(?:\n|$)/i,
    /waiting\s+(?:for|on):?\s*(.+?)(?:\n|$)/i
  ];

  for (var i = 0; i < blockerPatterns.length; i++) {
    var match = text.match(blockerPatterns[i]);
    if (match) return match[1].trim();
  }

  return null;
}

/**
 * Extract tomorrow's priority from text
 */
function extractTomorrowPriority(text) {
  var patterns = [
    /tomorrow['s]?\s+(?:priority|focus|plan):?\s*(.+?)(?:\n|$)/i,
    /(?:next|tomorrow)\s*:?\s*(.+?)$/i
  ];

  for (var i = 0; i < patterns.length; i++) {
    var match = text.match(patterns[i]);
    if (match) return match[1].trim();
  }

  return null;
}

/**
 * Extract hours worked from EOD text
 * Matches patterns like: "6.5 hours", "Worked 7h", "hours: 8", "6hrs", bare "6.5"
 */
function extractHoursWorked(text) {
  var patterns = [
    /hours?\s*(?:worked|today)?\s*:?\s*(\d+\.?\d*)/i,
    /(\d+\.?\d*)\s*(?:hours?|hrs?|h)\b/i,
    /worked\s+(\d+\.?\d*)\s*(?:hours?|hrs?|h)?/i,
    /^\s*(\d+\.?\d*)\s*$/  // bare number (for follow-up)
  ];

  for (var i = 0; i < patterns.length; i++) {
    var match = text.match(patterns[i]);
    if (match) {
      var hours = parseFloat(match[1]);
      if (hours >= 0 && hours <= 24) return hours;
    }
  }
  return null;
}

/**
 * Get help message
 */
function getHelpMessage() {
  return '👋 **Daily Check-in Bot Help**\n\n' +
    '**Morning Check-in:**\n' +
    'Reply "here" or share your #1 priority to confirm you\'re online.\n\n' +
    '**EOD Report:**\n' +
    'Share what you accomplished, blockers, and tomorrow\'s plan.\n\n' +
    '**Task Buttons:**\n' +
    '• ✅ Done - Mark task complete in ClickUp\n' +
    '• 🔄 In Progress - Update task status\n' +
    '• ➡️ Tomorrow - Move due date to tomorrow\n\n' +
    '**Commands:**\n' +
    '• `help` - Show this message\n' +
    '• `refresh` - Refresh ClickUp data';
}

// ============================================
// SHARED TRIGGER HELPERS (BUG #1, #11 fix)
// ============================================

/**
 * Send morning check-ins to all team members
 * Shared by Mon-Thu and Friday triggers
 */
function _sendMorningCheckIns(isMonday) {
  console.log('Sending morning check-ins...');

  var teamMembers = getCachedWorkingEmployees();
  var config = getConfig();
  var splitSpecialActive = hasActiveSplitSpecialPeriod();

  // Filter to tracked users on default schedule (dispatcher handles custom/split)
  var defaultMembers = teamMembers.filter(function (m) {
    var fullMember = config.team_members.find(function (tm) { return tm.email === m.email; });
    if (!fullMember) return true;
    if (fullMember.tracking_mode === 'not_tracked') return false;
    if (splitSpecialActive) return false; // Dispatcher handles everyone during split special periods
    return !fullMember.custom_start_time; // Skip custom-schedule users (dispatcher handles them)
  });

  // Post Monday kickoff if applicable (uses all working employees for team-wide message)
  if (isMonday) {
    try {
      var weekStats = getWeeklyTeamTaskLoad();

      // Get last week's wins
      var lastWeekWins = null;
      try {
        lastWeekWins = getLastWeekWins();
      } catch (err) {
        console.error('Error getting last week wins:', err.message);
      }

      // Get active streaks
      var activeStreaks = [];
      try {
        activeStreaks = getActiveStreaks();
      } catch (err) {
        console.error('Error getting active streaks:', err.message);
      }

      postMondayKickoff(weekStats, lastWeekWins, activeStreaks);
    } catch (err) {
      console.error('Error posting Monday kickoff:', err.message);
    }
  }

  // Send individual DMs with per-user error handling (BUG #11)
  for (var i = 0; i < defaultMembers.length; i++) {
    var member = defaultMembers[i];
    try {
      var tasks = [];
      if (config.clickup_config.enabled) {
        tasks = isMonday
          ? getTasksForUser(member.email, 'week')
          : getTasksForUser(member.email, 'today');
      }

      var msg = getMorningCheckInMessage(member, tasks, isMonday);
      sendDirectMessage(member.email, msg);
      logPromptSent(member.email, 'CHECKIN');

      // Set user state to AWAITING_CHECKIN (BUG #4)
      setUserState(member.email, 'AWAITING_CHECKIN');
    } catch (err) {
      console.error('Error sending check-in to ' + member.email + ':', err.message);
    }
  }

  logSystemEvent('MORNING_CHECKINS', 'SENT', { count: defaultMembers.length });
  console.log('Sent morning check-ins to ' + defaultMembers.length + ' team members (default schedule)');
}

/**
 * Send check-in follow-ups to those who haven't responded
 * Shared by Mon-Thu and Friday triggers
 */
function _sendCheckInFollowUps() {
  console.log('Sending check-in follow-ups...');

  var teamMembers = getCachedWorkingEmployees();
  var config = getConfig();
  var splitSpecialActive = hasActiveSplitSpecialPeriod();
  var todayCheckIns = getTodayCheckIns();
  var checkedInEmails = {};
  for (var i = 0; i < todayCheckIns.length; i++) {
    checkedInEmails[todayCheckIns[i].user_email] = true;
  }

  // Filter: not checked in, tracked, default schedule
  var notCheckedIn = teamMembers.filter(function (m) {
    if (checkedInEmails[m.email]) return false;
    var fullMember = config.team_members.find(function (tm) { return tm.email === m.email; });
    if (fullMember && fullMember.tracking_mode === 'not_tracked') return false;
    if (splitSpecialActive) return false;
    if (fullMember && fullMember.custom_start_time) return false;
    return true;
  });

  for (var j = 0; j < notCheckedIn.length; j++) {
    try {
      sendDirectMessage(notCheckedIn[j].email, getCheckInFollowUpMessage());
      logPromptSent(notCheckedIn[j].email, 'CHECKIN_FOLLOWUP');
    } catch (err) {
      console.error('Error sending follow-up to ' + notCheckedIn[j].email + ':', err.message);
    }
  }

  console.log('Sent follow-ups to ' + notCheckedIn.length + ' team members');
}

/**
 * Post morning summary and send escalations
 * Shared by Mon-Thu and Friday triggers
 */
function _postMorningSummary() {
  console.log('Posting morning summary...');

  var teamMembers = getCachedWorkingEmployees();
  var config = getConfig();
  var todayCheckIns = getTodayCheckIns();
  var checkedInEmails = {};
  for (var i = 0; i < todayCheckIns.length; i++) {
    checkedInEmails[todayCheckIns[i].user_email] = true;
  }

  var checkedIn = teamMembers.filter(function (m) { return checkedInEmails[m.email]; });
  // BigQuery returns is_late as string 'true'/'false', not boolean
  var late = todayCheckIns.filter(function (c) { return c.is_late === true || c.is_late === 'true'; }).map(function (c) {
    var member = teamMembers.find(function (m) { return m.email === c.user_email; });
    return { email: c.user_email, name: member ? (member.name || member.full_name) : null };
  });
  // Missing = not checked in AND tracked (not-tracked users aren't expected to check in)
  var missing = teamMembers.filter(function (m) {
    if (checkedInEmails[m.email]) return false;
    var fullMember = config.team_members.find(function (tm) { return tm.email === m.email; });
    if (fullMember && fullMember.tracking_mode === 'not_tracked') return false;
    return true;
  });

  // Get not-tracked team members for summary visibility
  var notTracked = getNotTrackedTeamMembers();

  var overdueStats = null;
  try {
    overdueStats = getTeamOverdueStats();
  } catch (err) {
    console.error('Error getting overdue stats:', err.message);
  }

  // Get PTO/Out Today data
  var onLeaveToday = [];
  try {
    onLeaveToday = getEmployeesOnLeaveToday();
  } catch (err) {
    console.error('Error getting employees on leave:', err.message);
  }

  // Get today's birthdays
  var todayBirthdays = [];
  try {
    todayBirthdays = getTodayBirthdays();
  } catch (err) {
    console.error('Error getting today birthdays:', err.message);
  }

  postMorningSummary(checkedIn, late, missing, overdueStats, onLeaveToday, todayBirthdays, notTracked);

  // Post standup digest to team channel
  try {
    var config2 = getConfig();
    var teamChannelId = config2.settings.team_channel_id;
    if (teamChannelId && config2.settings.enable_standup_digest !== false) {
      var digest = buildStandupDigest(todayCheckIns, teamMembers);
      sendChannelMessage(teamChannelId, digest);
    }
  } catch (err) {
    console.error('Error posting standup digest:', err.message);
  }

  try {
    checkMorningEscalations();
  } catch (err) {
    console.error('Error checking morning escalations:', err.message);
  }

  console.log('Morning summary posted');
}

/**
 * Send EOD requests to all team members
 * Shared by Mon-Thu and Friday triggers
 */
function _sendEodRequests() {
  console.log('Sending EOD requests...');

  var teamMembers = getCachedWorkingEmployees();
  var config = getConfig();
  var splitSpecialActive = hasActiveSplitSpecialPeriod();

  // Filter to tracked users on default schedule
  var defaultMembers = teamMembers.filter(function (m) {
    var fullMember = config.team_members.find(function (tm) { return tm.email === m.email; });
    if (!fullMember) return true;
    if (fullMember.tracking_mode === 'not_tracked') return false;
    if (splitSpecialActive) return false;
    return !fullMember.custom_start_time;
  });

  for (var i = 0; i < defaultMembers.length; i++) {
    var member = defaultMembers[i];
    try {
      var tasks = [];
      if (config.clickup_config.enabled) {
        tasks = getTasksForUser(member.email, 'today');
      }

      var eodMessage = getEodRequestMessage(member, tasks);

      if (eodMessage.cardsV2) {
        sendDirectMessage(member.email, eodMessage.text, eodMessage.cardsV2);
        if (eodMessage.followUpText) {
          sendDirectMessage(member.email, eodMessage.followUpText);
        }
      } else {
        sendDirectMessage(member.email, eodMessage.text);
      }

      logPromptSent(member.email, 'EOD');

      // Set user state to AWAITING_EOD (BUG #4)
      setUserState(member.email, 'AWAITING_EOD');
    } catch (err) {
      console.error('Error sending EOD to ' + member.email + ':', err.message);
    }
  }

  logSystemEvent('EOD_REQUESTS', 'SENT', { count: defaultMembers.length });
  console.log('Sent EOD requests to ' + defaultMembers.length + ' team members (default schedule)');
}

/**
 * Send EOD follow-ups to those who haven't submitted
 * Shared by Mon-Thu and Friday triggers
 */
function _sendEodFollowUps() {
  console.log('Sending EOD follow-ups...');

  var teamMembers = getCachedWorkingEmployees();
  var config = getConfig();
  var splitSpecialActive = hasActiveSplitSpecialPeriod();
  var todayEods = getTodayEodReports();
  var submittedEmails = {};
  for (var i = 0; i < todayEods.length; i++) {
    submittedEmails[todayEods[i].user_email] = true;
  }

  // Filter: not submitted, tracked, default schedule
  var notSubmitted = teamMembers.filter(function (m) {
    if (submittedEmails[m.email]) return false;
    var fullMember = config.team_members.find(function (tm) { return tm.email === m.email; });
    if (fullMember && fullMember.tracking_mode === 'not_tracked') return false;
    if (splitSpecialActive) return false;
    if (fullMember && fullMember.custom_start_time) return false;
    return true;
  });

  for (var j = 0; j < notSubmitted.length; j++) {
    try {
      sendDirectMessage(notSubmitted[j].email, getEodFollowUpMessage());
      logPromptSent(notSubmitted[j].email, 'EOD_FOLLOWUP');
    } catch (err) {
      console.error('Error sending EOD follow-up to ' + notSubmitted[j].email + ':', err.message);
    }
  }

  console.log('Sent EOD follow-ups to ' + notSubmitted.length + ' team members');
}

/**
 * Post EOD summary and send escalations
 * Shared by Mon-Thu and Friday triggers
 */
function _postEodSummary() {
  console.log('Posting EOD summary...');

  var teamMembers = getCachedWorkingEmployees();
  var config = getConfig();
  var todayEods = getTodayEodReports();
  var submittedEmails = {};
  for (var i = 0; i < todayEods.length; i++) {
    submittedEmails[todayEods[i].user_email] = true;
  }

  var submitted = teamMembers.filter(function (m) { return submittedEmails[m.email]; });
  // Missing = not submitted AND tracked
  var missing = teamMembers.filter(function (m) {
    if (submittedEmails[m.email]) return false;
    var fullMember = config.team_members.find(function (tm) { return tm.email === m.email; });
    if (fullMember && fullMember.tracking_mode === 'not_tracked') return false;
    return true;
  });
  var notTracked = getNotTrackedTeamMembers();

  var taskStats = null;
  try {
    taskStats = getTeamTaskStats();
  } catch (err) {
    console.error('Error getting task stats:', err.message);
  }

  // Gather per-person completion data
  var perPersonCompletions = [];
  try {
    perPersonCompletions = getPerPersonCompletions(teamMembers);
  } catch (err) {
    console.error('Error getting per-person completions:', err.message);
  }

  // Gather blockers from today's EOD reports
  var todayBlockers = [];
  try {
    todayEods.forEach(function (eod) {
      if (eod.blockers && eod.blockers.trim()) {
        var member = teamMembers.find(function (m) { return m.email === eod.user_email; });
        todayBlockers.push({
          name: member ? (member.name || eod.user_email.split('@')[0]) : eod.user_email.split('@')[0],
          blocker: eod.blockers
        });
      }
    });
  } catch (err) {
    console.error('Error gathering blockers:', err.message);
  }

  postEodSummary(submitted, missing, taskStats, perPersonCompletions, todayBlockers, notTracked);

  // Post EOD digest to team channel
  try {
    var config2 = getConfig();
    var teamChannelId = config2.settings.team_channel_id;
    if (teamChannelId && config2.settings.enable_standup_digest !== false) {
      var eodDigest = buildEodDigest(todayEods, teamMembers);
      sendChannelMessage(teamChannelId, eodDigest);
    }
  } catch (err) {
    console.error('Error posting EOD digest:', err.message);
  }

  try {
    checkEodEscalations();
  } catch (err) {
    console.error('Error checking EOD escalations:', err.message);
  }

  // Check for capacity warnings (5+ "no time" delays this week)
  try {
    checkCapacityWarnings();
  } catch (err) {
    console.error('Error checking capacity warnings:', err.message);
  }

  console.log('EOD summary posted');
}

// ============================================
// SCHEDULED TRIGGERS (Mon-Thu)
// ============================================

/**
 * 6:00 AM - Sage HR Sync
 */
function triggerSageHRSync() {
  if (!isWorkday()) return;
  safeExecute('SageHR Daily Sync', function () { dailySageHRSync(); });
}

/**
 * 6:15 AM - ClickUp Sync
 */
function triggerClickUpSync() {
  if (!isWorkday()) return;
  safeExecute('ClickUp Daily Sync', function () { dailyClickUpSync(); });
}

/**
 * 8:00 AM (Mon-Thu) - Send Morning Check-ins
 */
function triggerMorningCheckIns() {
  if (!isWorkday()) return;
  var today = new Date();
  if (today.getDay() === 5) return; // Friday handled by separate trigger

  var isMonday = today.getDay() === 1;
  _sendMorningCheckIns(isMonday);
}

/**
 * 8:20 AM (Mon-Thu) - Check-in Follow-ups
 */
function triggerCheckInFollowUp() {
  if (!isWorkday()) return;
  var today = new Date();
  if (today.getDay() === 5) return;

  _sendCheckInFollowUps();
}

/**
 * 8:35 AM (Mon-Thu) - Morning Summary + Escalations
 */
function triggerMorningSummary() {
  if (!isWorkday()) return;
  var today = new Date();
  if (today.getDay() === 5) return;

  _postMorningSummary();
}

/**
 * 4:30 PM (Mon-Thu) - Send EOD Requests
 * Skips on half_pm holidays (afternoon off)
 */
function triggerEodRequests() {
  if (!isEodWorkday()) return;
  var today = new Date();
  if (today.getDay() === 5) return; // Friday handled by separate trigger

  _sendEodRequests();
}

/**
 * 4:50 PM (Mon-Thu) - EOD Follow-ups
 */
function triggerEodFollowUp() {
  if (!isEodWorkday()) return;
  var today = new Date();
  if (today.getDay() === 5) return;

  _sendEodFollowUps();
}

/**
 * 5:00 PM (Mon-Thu) - EOD Summary + Escalations
 */
function triggerEodSummary() {
  if (!isEodWorkday()) return;
  var today = new Date();
  if (today.getDay() === 5) return;

  _postEodSummary();
}

/**
 * 5:15 PM - ClickUp Daily Snapshot
 */
function triggerClickUpSnapshot() {
  if (!isEodWorkday()) return;
  dailyClickUpSnapshot();
}

/**
 * 5:30 PM (Mon-Thu) - AI Evaluation
 */
function triggerAiEvaluation() {
  if (!isEodWorkday()) return;
  var today = new Date();
  if (today.getDay() === 5) return;

  generateDailyAiEvaluation();
}

/**
 * 10:15 AM Friday - Weekly Gamification
 */
function triggerWeeklyGamification() {
  var today = new Date();
  if (today.getDay() !== 5) return;
  if (!isWorkday()) return;

  postWeeklyGamification();
}

// ============================================
// FRIDAY-SPECIFIC TRIGGERS (BUG #1 fix)
// These now call shared helpers directly
// instead of delegating to Mon-Thu functions
// ============================================

/**
 * 7:00 AM Friday - Morning Check-ins (Friday only)
 */
function triggerMorningCheckInsFriday() {
  var today = new Date();
  if (today.getDay() !== 5) return;
  if (!isWorkday()) return;

  console.log('Sending Friday morning check-ins...');
  _sendMorningCheckIns(false); // Friday is never Monday
}

/**
 * 7:20 AM Friday - Check-in Follow-ups (Friday only)
 */
function triggerCheckInFollowUpFriday() {
  var today = new Date();
  if (today.getDay() !== 5) return;
  if (!isWorkday()) return;

  console.log('Sending Friday check-in follow-ups...');
  _sendCheckInFollowUps();
}

/**
 * 7:35 AM Friday - Morning Summary (Friday only)
 */
function triggerMorningSummaryFriday() {
  var today = new Date();
  if (today.getDay() !== 5) return;
  if (!isWorkday()) return;

  console.log('Posting Friday morning summary...');
  _postMorningSummary();
}

/**
 * 10:30 AM Friday - EOD Requests (Friday only)
 * BUG #1 fix: Calls shared helper directly instead of triggerEodRequests()
 */
function triggerEodRequestsFriday() {
  var today = new Date();
  if (today.getDay() !== 5) return;
  if (!isWorkday()) return;

  console.log('Sending Friday EOD requests...');
  _sendEodRequests();
}

/**
 * 10:50 AM Friday - EOD Follow-ups (Friday only)
 * BUG #1 fix: Calls shared helper directly instead of triggerEodFollowUp()
 */
function triggerEodFollowUpFriday() {
  var today = new Date();
  if (today.getDay() !== 5) return;
  if (!isWorkday()) return;

  console.log('Sending Friday EOD follow-ups...');
  _sendEodFollowUps();
}

/**
 * 11:00 AM Friday - EOD Summary (Friday only)
 * BUG #1 fix: Calls shared helper directly instead of triggerEodSummary()
 */
function triggerEodSummaryFriday() {
  var today = new Date();
  if (today.getDay() !== 5) return;
  if (!isWorkday()) return;

  console.log('Posting Friday EOD summary...');
  _postEodSummary();
}

/**
 * 11:30 AM Friday - AI Evaluation + Weekly Summary (Friday only)
 */
function triggerAiEvaluationFriday() {
  var today = new Date();
  if (today.getDay() !== 5) return;
  if (!isWorkday()) return;

  generateDailyAiEvaluation();
  generateWeeklySummary();
}

// ============================================
// V2 TRIGGERS - Adoption & Compliance
// ============================================

/**
 * 5:20 PM (Mon-Thu) - Compute daily adoption metrics
 * Must run AFTER EOD summary (5:00 PM)
 */
function triggerDailyAdoptionMetrics() {
  if (!isEodWorkday()) return;
  safeExecute('Daily Adoption Metrics', function () { computeDailyAdoptionMetrics(); });
}

/**
 * 10:30 AM Friday - Weekly adoption report
 * Must run AFTER weekly gamification (10:15 AM)
 */
function triggerWeeklyAdoptionReport() {
  var today = new Date();
  if (today.getDay() !== 5) return;
  if (!isWorkday()) return;

  safeExecute('Weekly Adoption Report', function () {
    computeDailyAdoptionMetrics(); // compute Friday's metrics first
    generateWeeklyAdoptionReport();
  });
}

/**
 * 10:00 AM Wednesday - Midweek compliance check
 */
function triggerMidweekCompliance() {
  var today = new Date();
  if (today.getDay() !== 3) return; // Wednesday only
  if (!isWorkday()) return;

  safeExecute('Midweek Compliance', function () { midweekComplianceCheck(); });
}

/**
 * Friday EOD adoption metrics
 */
function triggerDailyAdoptionMetricsFriday() {
  var today = new Date();
  if (today.getDay() !== 5) return;
  if (!isWorkday()) return;

  safeExecute('Friday Adoption Metrics', function () { computeDailyAdoptionMetrics(); });
}

// ============================================
// SCHEDULE DISPATCHER (Custom/Split Shifts)
// ============================================

/**
 * Dispatcher trigger - runs every 30 minutes.
 * Handles users with custom schedules or during split special periods.
 * Default-schedule users are handled by the existing global triggers.
 */
function triggerScheduleDispatcher() {
  if (!isWorkday()) return;

  var config = getConfig();
  var workingEmployees = getCachedWorkingEmployees();
  var splitSpecialActive = hasActiveSplitSpecialPeriod();

  // Determine which users the dispatcher should handle
  var dispatchUsers = workingEmployees.filter(function (m) {
    var fullMember = config.team_members.find(function (tm) { return tm.email === m.email; });
    if (!fullMember) return false;
    if ((fullMember.tracking_mode || 'tracked') !== 'tracked') return false;
    // During split special periods, dispatcher handles everyone
    if (splitSpecialActive) return true;
    // Otherwise only custom-schedule users
    return !!fullMember.custom_start_time;
  });

  if (dispatchUsers.length === 0) return;

  var promptTypes = ['CHECKIN', 'CHECKIN_FOLLOWUP', 'EOD', 'EOD_FOLLOWUP'];
  var cache = CacheService.getScriptCache();
  var todayStr = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');

  for (var i = 0; i < dispatchUsers.length; i++) {
    var member = dispatchUsers[i];
    for (var j = 0; j < promptTypes.length; j++) {
      var promptType = promptTypes[j];
      if (isTimeForPrompt(member.email, promptType)) {
        // Dedup: don't send same prompt type twice in one day
        var dedupKey = 'DISPATCH_' + promptType + '_' + member.email + '_' + todayStr;
        if (cache.get(dedupKey)) continue;

        try {
          dispatchPrompt(member, promptType, config);
          cache.put(dedupKey, 'sent', 21600);
        } catch (err) {
          console.error('Dispatcher error for ' + member.email + ' ' + promptType + ':', err.message);
        }
      }
    }
  }
}

/**
 * Check if NOW is the right time to send a prompt to this user.
 * Uses a 15-minute window after the target time.
 */
function isTimeForPrompt(email, promptType) {
  var schedule = getUserWorkSchedule(email);
  var now = new Date();
  var nowMinutes = now.getHours() * 60 + now.getMinutes();
  var WINDOW = 15;

  var block1Start = timeToMinutes(schedule.blocks[0].start);
  var lastBlockEnd = timeToMinutes(schedule.blocks[schedule.blocks.length - 1].end);

  switch (promptType) {
    case 'CHECKIN':
      return nowMinutes >= block1Start && nowMinutes <= block1Start + WINDOW;
    case 'CHECKIN_FOLLOWUP':
      return nowMinutes >= block1Start + 20 && nowMinutes <= block1Start + 35;
    case 'EOD':
      return nowMinutes >= lastBlockEnd - 30 && nowMinutes <= lastBlockEnd - 15;
    case 'EOD_FOLLOWUP':
      return nowMinutes >= lastBlockEnd - 10 && nowMinutes <= lastBlockEnd + 5;
    default:
      return false;
  }
}

/**
 * Send the appropriate prompt to a user based on type.
 */
function dispatchPrompt(member, promptType, config) {
  switch (promptType) {
    case 'CHECKIN':
      var tasks = config.clickup_config && config.clickup_config.enabled ? getTasksForUser(member.email, 'today') : [];
      var msg = getMorningCheckInMessage(member, tasks, new Date().getDay() === 1);
      sendDirectMessage(member.email, msg);
      logPromptSent(member.email, 'CHECKIN');
      setUserState(member.email, 'AWAITING_CHECKIN');
      break;
    case 'CHECKIN_FOLLOWUP':
      var todayCheckIns = getTodayCheckIns();
      var alreadyCheckedIn = todayCheckIns.some(function (c) { return c.user_email === member.email; });
      if (!alreadyCheckedIn) {
        sendDirectMessage(member.email, getCheckInFollowUpMessage());
        logPromptSent(member.email, 'CHECKIN_FOLLOWUP');
      }
      break;
    case 'EOD':
      var eodTasks = config.clickup_config && config.clickup_config.enabled ? getTasksForUser(member.email, 'today') : [];
      var eodMessage = getEodRequestMessage(member, eodTasks);
      if (eodMessage.cardsV2) {
        sendDirectMessage(member.email, eodMessage.text, eodMessage.cardsV2);
        if (eodMessage.followUpText) sendDirectMessage(member.email, eodMessage.followUpText);
      } else {
        sendDirectMessage(member.email, eodMessage.text);
      }
      logPromptSent(member.email, 'EOD');
      setUserState(member.email, 'AWAITING_EOD');
      break;
    case 'EOD_FOLLOWUP':
      var todayEods = getTodayEodReports();
      var alreadySubmitted = todayEods.some(function (e) { return e.user_email === member.email; });
      if (!alreadySubmitted) {
        sendDirectMessage(member.email, getEodFollowUpMessage());
        logPromptSent(member.email, 'EOD_FOLLOWUP');
      }
      break;
  }
}

// ============================================
// PREP COMMAND HANDLER
// ============================================

/**
 * Handle /prep command - generate 1-on-1 prep report for a team member
 */
function handlePrepCommand(requesterEmail, targetName) {
  var config = getConfig();

  // Only allow managers to use this
  var managerEmails = [config.settings.manager_email];
  if (config.settings.escalation_emails) {
    managerEmails = managerEmails.concat(
      Array.isArray(config.settings.escalation_emails) ? config.settings.escalation_emails : [config.settings.escalation_emails]
    );
  }

  if (managerEmails.indexOf(requesterEmail) === -1) {
    return createChatResponse('This command is only available to managers.');
  }

  // Find team member by name (fuzzy match)
  var teamMembers = getCachedWorkingEmployees();
  var target = teamMembers.find(function (m) {
    var name = (m.name || '').toLowerCase();
    var emailPrefix = m.email.split('@')[0].toLowerCase();
    return name.includes(targetName.toLowerCase()) || emailPrefix.includes(targetName.toLowerCase());
  });

  if (!target) {
    return createChatResponse('Could not find team member matching "' + targetName + '". Try their first name or email prefix.');
  }

  var targetEmail = target.email;
  var targetDisplayName = target.name || targetEmail.split('@')[0];
  var projectId = getProjectId();

  // Last 14 days of data
  var twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  var startStr = Utilities.formatDate(twoWeeksAgo, 'America/Chicago', 'yyyy-MM-dd');

  // Attendance
  var attendanceQuery = 'SELECT ' +
    'COUNTIF(checkin_responded) as checkins, ' +
    'COUNTIF(checkin_is_late) as late, ' +
    'COUNTIF(eod_responded) as eods, ' +
    'COUNT(*) as workdays, ' +
    'AVG(checkin_latency_minutes) as avg_latency, ' +
    'AVG(eod_word_count) as avg_eod_words ' +
    'FROM `' + projectId + '.' + DATASET_ID + '.daily_adoption_metrics` ' +
    'WHERE user_email = "' + targetEmail + '" AND metric_date >= "' + startStr + '"';
  var attendance = runBigQueryQuery(attendanceQuery);
  var att = attendance.length > 0 ? attendance[0] : {};

  // Recent blockers
  var blockerQuery = 'SELECT blockers, eod_date FROM `' + projectId + '.' + DATASET_ID + '.v_eod_reports` ' +
    'WHERE user_email = "' + targetEmail + '" AND eod_date >= "' + startStr + '" AND blockers IS NOT NULL AND blockers != "" ' +
    'ORDER BY eod_date DESC LIMIT 5';
  var blockers = runBigQueryQuery(blockerQuery);

  // Task stats
  var taskQuery = 'SELECT action_type, COUNT(*) as cnt FROM (' +
    '  SELECT task_id, action_type FROM (' +
    '    SELECT task_id, action_type, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY timestamp DESC) as rn' +
    '    FROM `' + projectId + '.' + DATASET_ID + '.clickup_task_actions`' +
    '    WHERE user_email = "' + targetEmail + '" AND DATE(timestamp) >= "' + startStr + '"' +
    '  ) WHERE rn = 1' +
    ') GROUP BY action_type';
  var taskActions = runBigQueryQuery(taskQuery);
  var taskMap = {};
  taskActions.forEach(function (a) { taskMap[a.action_type] = parseInt(a.cnt); });

  // Chronically delayed tasks
  var delayedTasks = getChronicallyDelayedTasks().filter(function (t) { return t.user_email === targetEmail; });

  // Hours trend
  var hoursQuery = 'SELECT eod_date, hours_worked FROM `' + projectId + '.' + DATASET_ID + '.v_eod_reports` ' +
    'WHERE user_email = "' + targetEmail + '" AND eod_date >= "' + startStr + '" AND hours_worked IS NOT NULL ' +
    'ORDER BY eod_date';
  var hourEntries = runBigQueryQuery(hoursQuery);

  // Build report
  var report = '📋 *1-on-1 Prep: ' + targetDisplayName + '*\n';
  report += '_(Last 14 days)_\n\n';

  // Attendance
  var workdays = parseInt(att.workdays) || 0;
  var checkins = parseInt(att.checkins) || 0;
  var eods = parseInt(att.eods) || 0;
  var late = parseInt(att.late) || 0;
  report += '*Attendance:* ' + checkins + '/' + workdays + ' check-ins, ' + eods + '/' + workdays + ' EODs';
  if (late > 0) report += ', ' + late + ' late';
  var avgLatency = parseFloat(att.avg_latency);
  if (!isNaN(avgLatency)) report += ', avg response: ' + Math.round(avgLatency) + ' min';
  report += '\n';

  // Tasks
  var completed = taskMap['COMPLETE'] || 0;
  var delayed = taskMap['TOMORROW'] || 0;
  var inProgress = taskMap['IN_PROGRESS'] || 0;
  report += '*Tasks:* ' + completed + ' completed, ' + delayed + ' delayed, ' + inProgress + ' in-progress\n';

  if (delayedTasks.length > 0) {
    report += '*Chronically Delayed (' + delayedTasks.length + '):*\n';
    delayedTasks.slice(0, 5).forEach(function (t) {
      report += '  "' + t.task_name + '" pushed ' + t.push_count + 'x\n';
    });
  }

  // Hours
  if (hourEntries.length > 0) {
    var totalHours = 0;
    hourEntries.forEach(function (h) { totalHours += parseFloat(h.hours_worked) || 0; });
    var avgHours = Math.round(totalHours / hourEntries.length * 10) / 10;
    report += '*Hours:* Avg ' + avgHours + '/day over ' + hourEntries.length + ' days reported\n';
  }

  // Blockers
  if (blockers.length > 0) {
    report += '\n*Recent Blockers:*\n';
    blockers.forEach(function (b) {
      report += '  ' + b.eod_date + ': ' + b.blockers + '\n';
    });
  }

  // EOD quality
  var avgWords = parseFloat(att.avg_eod_words);
  if (!isNaN(avgWords)) {
    report += '\n*EOD Quality:* Avg ' + Math.round(avgWords) + ' words/report';
    if (avgWords < 15) report += ' ⚠️ (very thin)';
    else if (avgWords < 30) report += ' (brief)';
    report += '\n';
  }

  return createChatResponse(report);
}

// ============================================
// TEST HELPER (kept for development)
// ============================================

function __testAllTriggers() {
  console.log('==============================');
  console.log('🚀 STARTING FULL TRIGGER TEST');
  console.log('TEST_MODE:', TEST_MODE);
  console.log('Timestamp:', new Date().toISOString());
  console.log('==============================');

  var steps = [
    { name: 'Sage HR Sync', fn: triggerSageHRSync },
    { name: 'ClickUp Sync', fn: triggerClickUpSync },

    { name: 'Morning Check-ins (Mon–Thu)', fn: triggerMorningCheckIns },
    { name: 'Check-in Follow-up', fn: triggerCheckInFollowUp },
    { name: 'Morning Summary', fn: triggerMorningSummary },

    { name: 'EOD Requests', fn: triggerEodRequests },
    { name: 'EOD Follow-up', fn: triggerEodFollowUp },
    { name: 'EOD Summary', fn: triggerEodSummary },

    { name: 'ClickUp Snapshot', fn: triggerClickUpSnapshot },
    { name: 'AI Evaluation', fn: triggerAiEvaluation },

    { name: 'Friday Morning Check-ins', fn: triggerMorningCheckInsFriday },
    { name: 'Friday Check-in Follow-up', fn: triggerCheckInFollowUpFriday },
    { name: 'Friday Morning Summary', fn: triggerMorningSummaryFriday },

    { name: 'Friday EOD Requests', fn: triggerEodRequestsFriday },
    { name: 'Friday EOD Follow-up', fn: triggerEodFollowUpFriday },
    { name: 'Friday EOD Summary', fn: triggerEodSummaryFriday },

    { name: 'Weekly Gamification', fn: triggerWeeklyGamification },
    { name: 'Friday AI + Weekly Summary', fn: triggerAiEvaluationFriday },

    { name: 'Daily Adoption Metrics', fn: triggerDailyAdoptionMetrics },
    { name: 'Midweek Compliance', fn: triggerMidweekCompliance },
    { name: 'Weekly Adoption Report', fn: triggerWeeklyAdoptionReport },
  ];

  var results = [];

  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    console.log('\n▶️ Running: ' + step.name);
    try {
      step.fn();
      console.log('✅ SUCCESS: ' + step.name);
      results.push({ step: step.name, status: 'OK' });
    } catch (err) {
      console.error('❌ FAILED: ' + step.name);
      console.error(err.message, err.stack);
      results.push({ step: step.name, status: 'ERROR', error: err.message });
    }
  }

  console.log('\n==============================');
  console.log('🏁 TRIGGER TEST COMPLETE');
  console.log('Results:', JSON.stringify(results));
  console.log('==============================');

  return results;
}
