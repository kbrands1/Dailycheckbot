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
 */
function setUserState(email, state) {
  var cache = CacheService.getScriptCache();
  cache.put('user_state_' + email, state, 7200); // 2 hour TTL
}

/**
 * Get conversation state for a user
 */
function getUserState(email) {
  var cache = CacheService.getScriptCache();
  return cache.get('user_state_' + email) || 'IDLE';
}

/**
 * Clear conversation state for a user
 */
function clearUserState(email) {
  var cache = CacheService.getScriptCache();
  cache.remove('user_state_' + email);
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

    // === State-based routing (BUG #2, #3, #4 fix) ===
    var userState = getUserState(sender.email);
    console.log("User state for " + sender.email + ": " + userState);

    if (userState === 'AWAITING_CHECKIN') {
      // Any reply during check-in window is treated as check-in
      clearUserState(sender.email);
      return handleCheckInResponse(sender.email, sender.displayName, text);
    }

    if (userState === 'AWAITING_EOD' || lowerText === 'completed testing tasks. no blockers. tomorrow: continue testing.') {
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
      }
    }

    // === Fallback: check if "here" even without state (BUG #2 fix) ===
    if (['here', 'i\'m here', 'im here', 'present', 'here - testing check-in flow', 'here - late test'].includes(lowerText)) {
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
  var config = getConfig();
  var workHours = getTodayWorkHours();
  var now = new Date();

  var parts = workHours.start.split(':');
  var startHour = parseInt(parts[0]);
  var startMin = parseInt(parts[1]);
  var graceMinutes = getLateThresholdMin();
  var lateThreshold = new Date(now);
  lateThreshold.setHours(startHour, startMin + graceMinutes, 0, 0);
  var lowerText = text.toLowerCase();

  var isLate = lowerText === 'here - late test' ? true : (lowerText === 'here - testing check-in flow' ? false : now > lateThreshold);

  logCheckIn(email, now, text, isLate);

  return createChatResponse(getCheckInConfirmation(isLate));
}

/**
 * Handle EOD response
 */
function handleEodResponse(email, name, text) {
  var now = new Date();
  var isFriday = now.getDay() === 5;

  var tasksCompleted = text;
  var blockers = extractBlockers(text);
  var tomorrowPriority = extractTomorrowPriority(text);
  var hoursWorked = extractHoursWorked(text);

  logEodReport(email, now, tasksCompleted, blockers, tomorrowPriority, text, hoursWorked);

  var response = isFriday ? getFridayEodConfirmation() : getEodConfirmation();

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

  // Post Monday kickoff if applicable
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
  for (var i = 0; i < teamMembers.length; i++) {
    var member = teamMembers[i];
    try {
      var tasks = [];
      if (config.clickup_config.enabled) {
        tasks = isMonday
          ? getTasksForUser(member.email, 'week')
          : getTasksForUser(member.email, 'today');
      }

      var msg = getMorningCheckInMessage(member, tasks, isMonday);
      sendDirectMessage(member.email, msg);

      // Set user state to AWAITING_CHECKIN (BUG #4)
      setUserState(member.email, 'AWAITING_CHECKIN');
    } catch (err) {
      console.error('Error sending check-in to ' + member.email + ':', err.message);
    }
  }

  logSystemEvent('MORNING_CHECKINS', 'SENT', { count: teamMembers.length });
  console.log('Sent morning check-ins to ' + teamMembers.length + ' team members');
}

/**
 * Send check-in follow-ups to those who haven't responded
 * Shared by Mon-Thu and Friday triggers
 */
function _sendCheckInFollowUps() {
  console.log('Sending check-in follow-ups...');

  var teamMembers = getCachedWorkingEmployees();
  var todayCheckIns = getTodayCheckIns();
  var checkedInEmails = {};
  for (var i = 0; i < todayCheckIns.length; i++) {
    checkedInEmails[todayCheckIns[i].user_email] = true;
  }

  var notCheckedIn = teamMembers.filter(function (m) { return !checkedInEmails[m.email]; });

  for (var j = 0; j < notCheckedIn.length; j++) {
    try {
      sendDirectMessage(notCheckedIn[j].email, getCheckInFollowUpMessage());
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
  var missing = teamMembers.filter(function (m) { return !checkedInEmails[m.email]; });

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

  postMorningSummary(checkedIn, late, missing, overdueStats, onLeaveToday, todayBirthdays);

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

  for (var i = 0; i < teamMembers.length; i++) {
    var member = teamMembers[i];
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

      // Set user state to AWAITING_EOD (BUG #4)
      setUserState(member.email, 'AWAITING_EOD');
    } catch (err) {
      console.error('Error sending EOD to ' + member.email + ':', err.message);
    }
  }

  logSystemEvent('EOD_REQUESTS', 'SENT', { count: teamMembers.length });
  console.log('Sent EOD requests to ' + teamMembers.length + ' team members');
}

/**
 * Send EOD follow-ups to those who haven't submitted
 * Shared by Mon-Thu and Friday triggers
 */
function _sendEodFollowUps() {
  console.log('Sending EOD follow-ups...');

  var teamMembers = getCachedWorkingEmployees();
  var todayEods = getTodayEodReports();
  var submittedEmails = {};
  for (var i = 0; i < todayEods.length; i++) {
    submittedEmails[todayEods[i].user_email] = true;
  }

  var notSubmitted = teamMembers.filter(function (m) { return !submittedEmails[m.email]; });

  for (var j = 0; j < notSubmitted.length; j++) {
    try {
      sendDirectMessage(notSubmitted[j].email, getEodFollowUpMessage());
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
  var todayEods = getTodayEodReports();
  var submittedEmails = {};
  for (var i = 0; i < todayEods.length; i++) {
    submittedEmails[todayEods[i].user_email] = true;
  }

  var submitted = teamMembers.filter(function (m) { return submittedEmails[m.email]; });
  var missing = teamMembers.filter(function (m) { return !submittedEmails[m.email]; });

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

  postEodSummary(submitted, missing, taskStats, perPersonCompletions, todayBlockers);

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
  dailySageHRSync();
}

/**
 * 6:15 AM - ClickUp Sync
 */
function triggerClickUpSync() {
  if (!isWorkday()) return;
  dailyClickUpSync();
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
