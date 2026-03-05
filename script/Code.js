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
 * States: AWAITING_EOD, IDLE
 * Uses PropertiesService for persistence across execution contexts
 */
function setUserState(email, state) {
  var props = PropertiesService.getScriptProperties();
  var value = state + '|' + new Date().toISOString();
  props.setProperty('USER_STATE_' + email.replace(/[^a-zA-Z0-9]/g, '_'), value);
}

/**
 * Get conversation state for a user
 * Returns IDLE if state is missing or expired (8 hour TTL)
 */
function getUserState(email) {
  var props = PropertiesService.getScriptProperties();
  var key = 'USER_STATE_' + email.replace(/[^a-zA-Z0-9]/g, '_');
  var raw = props.getProperty(key);
  if (!raw) return 'IDLE';

  var parts = raw.split('|');
  var state = parts[0];
  var timestamp = parts[1] ? new Date(parts[1]) : null;

  // Expire after 8 hours (extended to prevent premature EOD state expiry)
  if (timestamp && (Date.now() - timestamp.getTime() > 8 * 3600 * 1000)) {
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
// CLICKUP COMPLIANCE TRACKING
// ============================================

/**
 * Track consecutive days with 0 tasks at EOD.
 * Returns a warning string if streak > 0, otherwise null.
 */
function handleClickUpCompliance(email, taskCount) {
  try {
    var props = PropertiesService.getScriptProperties();
    var key = 'NO_TASKS_STREAK_' + email.replace(/[^a-zA-Z0-9]/g, '_');

    // User has tasks -> reset streak and exit
    if (taskCount > 0) {
      props.deleteProperty(key);
      return null;
    }

    // User has 0 tasks
    var currentStreakStr = props.getProperty(key);
    var streak = currentStreakStr ? parseInt(currentStreakStr, 10) : 0;
    streak++;

    props.setProperty(key, streak.toString());

    var warning = '🚨 This is tracked - you did not follow directions to create ClickUp tasks. Please make sure to do it tomorrow.';

    if (streak >= 3) {
      warning += '\n\n⚠️ **WARNING: You have had no tasks for ' + streak + ' consecutive days. This is now being reported to management.**';

      // Trigger escalation (safe check if function exists)
      if (typeof escalateClickUpCompliance === 'function') {
        escalateClickUpCompliance(email, streak);
      } else {
        console.warn('escalateClickUpCompliance function missing, skipping escalation for ' + email);
      }
    }

    return warning;

  } catch (e) {
    console.error('handleClickUpCompliance error for ' + email + ':', e.message);
    return null;
  }
}

// ============================================
// LATE MINUTES HELPER
// ============================================

/**
 * Get how many minutes late a user checked in today.
 * @param {string} email - User email
 * @param {Array|null} checkInsCache - Pre-fetched today check-ins (optional)
 * @returns {number} Minutes late (0 if on time or not checked in)
 */
function getLateMinutesForUser(email, checkInsCache) {
  try {
    var checkIns = checkInsCache || getTodayCheckIns();
    var userCheckIn = checkIns.find(function (c) { return c.user_email === email; });
    if (!userCheckIn) return 0;
    var isLate = userCheckIn.is_late === true || userCheckIn.is_late === 'true';
    if (!isLate) return 0;

    // Calculate minutes late from checkin_timestamp vs schedule start parsing local time
    var schedule = getUserWorkSchedule(email);
    var startMins = timeToMinutes(schedule.blocks[0].start);
    var graceMinutes = getLateThresholdMin();

    var checkinTimeStr = Utilities.formatDate(new Date(userCheckIn.checkin_timestamp), 'America/Chicago', 'HH:mm');
    var checkinMins = timeToMinutes(checkinTimeStr);

    var diffMins = checkinMins - (startMins + graceMinutes);
    return diffMins > 0 ? diffMins : 0;
  } catch (e) {
    console.error('getLateMinutesForUser error for ' + email + ':', e.message);
    return 0;
  }
}

// ============================================
// EOD RETRY MANAGEMENT
// ============================================

function getEodRetryCount(email) {
  var props = PropertiesService.getScriptProperties();
  var key = 'EOD_RETRY_' + email.replace(/[^a-zA-Z0-9]/g, '_');
  var raw = props.getProperty(key);
  if (!raw) return 0;
  var parts = raw.split('|');
  var count = parseInt(parts[0]) || 0;
  var dateStr = parts[1] || '';
  var today = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');
  if (dateStr !== today) {
    props.deleteProperty(key);
    return 0;
  }
  return count;
}

function incrementEodRetryCount(email) {
  var props = PropertiesService.getScriptProperties();
  var key = 'EOD_RETRY_' + email.replace(/[^a-zA-Z0-9]/g, '_');
  var today = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');
  var current = getEodRetryCount(email);
  props.setProperty(key, (current + 1) + '|' + today);
  return current + 1;
}

function clearEodRetryCount(email) {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('EOD_RETRY_' + email.replace(/[^a-zA-Z0-9]/g, '_'));
}

function validateEodSubmission(text) {
  var missing = [];
  var lowerText = text.toLowerCase();

  // 1. Hours worked — total hours
  var hours = extractHoursWorked(text);
  if (hours === null) missing.push('hours_worked');

  // 2. Meetings — must mention meetings even if 0
  var meetingKeywords = ['meeting', 'meetings', '0 meetings', 'no meetings',
    'standup', 'stand-up', 'sync', 'call', 'huddle', 'retro', 'sprint',
    'planning', 'review meeting', '1-on-1', '1:1', 'workshop'];
  var hasMeetings = meetingKeywords.some(function (kw) {
    return lowerText.indexOf(kw) !== -1;
  });
  if (!hasMeetings) missing.push('meetings');

  // 3. Tomorrow's priority
  var tomorrowPriority = extractTomorrowPriority(text);
  var tomorrowKeywords = ['tomorrow', 'next', 'plan', 'priority', 'will do',
    'going to', 'focus on', 'continue', 'start', 'upcoming', 'next week'];
  var hasTomorrow = tomorrowPriority !== null || tomorrowKeywords.some(function (kw) {
    return lowerText.indexOf(kw) !== -1;
  });
  if (!hasTomorrow) missing.push('tomorrow_priority');

  return { isValid: missing.length === 0, missingFields: missing, detectedHours: hours };
}

function buildEodRejectionMessage(missingFields, retryCount, noTasksCompleted) {
  var msg = '⚠️ **Your EOD report is missing some required information.**\n\n';

  if (noTasksCompleted) {
    msg += '🚨 **You haven\'t completed any tasks today.** Please update your task cards above or explain why no tasks were completed.\n\n';
  }

  msg += '**Missing:**\n';
  var fieldLabels = {
    'hours_worked': '⏰ **Total Hours** — How many hours did you work? (e.g. "Hours: 7h 30m")',
    'meetings': '📅 **Meetings** — List meetings with time, or say "0 meetings" if none',
    'tomorrow_priority': '📌 **Tomorrow** — 1-3 tasks you\'ll focus on tomorrow'
  };
  for (var i = 0; i < missingFields.length; i++) {
    msg += '  ' + (i + 1) + '. ' + (fieldLabels[missingFields[i]] || missingFields[i]) + '\n';
  }
  var attemptsLeft = 2 - retryCount;
  if (attemptsLeft > 0) {
    msg += '\n(' + attemptsLeft + ' attempt' + (attemptsLeft > 1 ? 's' : '') + ' remaining before auto-accept)\n';
  }
  msg += '\n📝 **Required format:**\n';
  msg += '―――――――――――――――――――\n';
  msg += '*Hours:* [Total, e.g. 7h 30m]\n';
  msg += '*Meetings:* [count] | [total time] | [names + durations]\n';
  msg += '  _(or "0 meetings" if none)_\n';
  msg += '*Tomorrow:* [Task 1 + CU link] | [Task 2 + CU link]\n';
  msg += '*Blockers/Issues:* [what > owner > deadline] _(if any)_\n';
  msg += '―――――――――――――――――――\n';
  msg += '\n💡 *Example:*\n';
  msg += '_Hours: 7h 30m_\n';
  msg += '_Meetings: 2 | 1.5h | Sprint planning (1h), Design review (30m)_\n';
  msg += '_Tomorrow: Continue API refactor (CU link) | Start unit tests (CU link)_\n';
  msg += '_No blockers_';
  return msg;
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

    // Ping FIRST — before any config/state reads to guarantee fast response
    var lowerText = text.toLowerCase().trim();
    if (lowerText === 'ping') {
      return createChatResponse("🏓 Pong! Bot is working.");
    }

    // Store DM space for future proactive messaging
    if (space.type === 'DM' && space.name && sender.email) {
      storeDMSpace(sender.email, space.name);
    }

    var userState = getUserState(sender.email);

    // Weekend/after-hours guard: acknowledge but don't process as check-in/EOD
    if (!isWorkday()) {
      if (!['help', '?', 'ping', 'hi', 'hello', 'runeod', 'runcheckin'].includes(lowerText)) {
        return createChatResponse('📅 It\'s outside work hours. I\'ll be available on the next workday. If this is urgent, contact your manager directly.');
      }
    }

    // === Simple commands (always handled regardless of state) ===
    if (lowerText === 'hi' || lowerText === 'hello') {
      return createChatResponse("👋 Hi " + (sender.displayName || "there") + "! I'm the Daily Check-in Bot. Type \"help\" for available commands.");
    }

    if (lowerText === 'help' || lowerText === '?') {
      return createChatResponse(
        "📋 *Daily Check-in Bot Help*\n\n" +
        "*How it works:*\n" +
        "• Morning: I'll send you a ✅ *Check In* button with your task summary\n" +
        "• Click the button to confirm attendance and see your tasks\n" +
        "• EOD: I'll send you a 📝 *Start EOD* button\n" +
        "• Click it to load task cards, then reply with your EOD summary\n\n" +
        "*Commands:*\n" +
        "• `refresh` — Reload ClickUp tasks during EOD\n" +
        "• `ping` — Check if bot is responding\n" +
        "• `help` — Show this message"
      );
    }

    if (lowerText === 'refresh' || lowerText === 'refresh lists') {
      if (userState !== 'AWAITING_EOD') {
        clearClickUpCache();
        return createChatResponse("🔄 ClickUp data refreshed!");
      }
      // If they ARE in AWAITING_EOD, do nothing here and let it fall through 
      // to the EOD-specific refresh handler below
    }

    // Test commands — return card directly from handler (no REST API call)
    if (lowerText === 'runcheckin') {
      try {
        var ciSummary = { overdue: 0, inProgress: 0, dueToday: 0 };
        // Use real task counts if user can be resolved (sheet mapping or warm cache)
        try {
          var ciTestCache = CacheService.getScriptCache();
          var ciTestConfig = getConfig();
          var ciTestUserMap = ciTestConfig.clickup_user_map || {};
          var canResolveCI = !!(ciTestUserMap[sender.email] || ciTestUserMap[sender.email.toLowerCase()] || ciTestCache.get('clickup_workspace'));
          if (canResolveCI) {
            if (ciTestConfig.clickup_config && ciTestConfig.clickup_config.enabled) {
              var ciTestTasks = getTasksForUser(sender.email, 'today');
              var ciTestCat = categorizeTasks(ciTestTasks, sender.email);
              ciSummary = { overdue: ciTestCat.overdue.length, inProgress: ciTestCat.inProgress.length, dueToday: ciTestCat.dueTodayNotStarted.length };
            }
          } else {
            // Warm cache in background so it's ready when they click the button
            scheduleBackgroundTaskFetch(sender.email, 'checkin');
          }
        } catch (e) {
          console.error('runcheckin task count error:', e.message);
        }
        var ciCards = buildCheckInCard(sender.displayName || sender.email.split('@')[0], ciSummary);
        return createChatResponse({ text: 'Click the button below to check in and load your tasks.', cardsV2: ciCards });
      } catch (err) {
        console.error('runcheckin error:', err.message, err.stack);
        return createChatResponse('Error: ' + err.message);
      }
    }

    if (lowerText === 'runeod') {
      try {
        // Clear any existing EOD state so test can be re-run
        clearUserState(sender.email);
        clearEodRetryCount(sender.email);
        var eodSummary = { overdue: 0, inProgress: 0, dueToday: 0, completed: 0 };
        // Use real task counts if user can be resolved (sheet mapping or warm cache)
        try {
          var eodTestCache = CacheService.getScriptCache();
          var eodTestConfig = getConfig();
          var eodTestUserMap = eodTestConfig.clickup_user_map || {};
          var canResolveEod = !!(eodTestUserMap[sender.email] || eodTestUserMap[sender.email.toLowerCase()] || eodTestCache.get('clickup_workspace'));
          if (canResolveEod && eodTestConfig.clickup_config && eodTestConfig.clickup_config.enabled) {
            var eodTestTasks = getTasksForUser(sender.email, 'today');
            var eodTestCat = categorizeTasks(eodTestTasks, sender.email);
            eodSummary = { overdue: eodTestCat.overdue.length, inProgress: eodTestCat.inProgress.length, dueToday: eodTestCat.dueTodayNotStarted.length, completed: eodTestCat.completedCount || 0 };
          } else if (!canResolveEod) {
            scheduleBackgroundTaskFetch(sender.email, 'eod');
          }
        } catch (e) {
          console.error('runeod task count error:', e.message);
        }
        var eodCards = buildStartEodCard('', '', eodSummary);
        // Set AWAITING_EOD so user can type EOD directly (matches production flow)
        setUserState(sender.email, 'AWAITING_EOD');
        return createChatResponse({ text: 'Click the button below to start your EOD report, or type your EOD directly.', cardsV2: eodCards });
      } catch (err) {
        console.error('runeod error:', err.message, err.stack);
        return createChatResponse('Error: ' + err.message);
      }
    }

    // 1-on-1 prep command
    if (lowerText.startsWith('prep ') || lowerText.startsWith('/prep ')) {
      var targetName = text.replace(/^\/?prep\s+/i, '').trim();
      return handlePrepCommand(sender.email, targetName);
    }

    // === State-based routing (BUG #2, #3, #4 fix) ===
    console.log("User state for " + sender.email + ": " + userState);

    if (userState === 'AWAITING_EOD' || (TEST_MODE && lowerText === 'completed testing tasks. no blockers. tomorrow: continue testing.')) {

      // --- REFRESH: re-pull ClickUp tasks and re-send EOD cards ---
      if (lowerText === 'refresh' || lowerText === 'refresh tasks' || lowerText === 'reload') {
        try {
          // Check if user can be resolved quickly (sheet mapping or workspace cache)
          var refreshCache = CacheService.getScriptCache();
          var refreshConfig = getConfig();
          var refreshUserMap = refreshConfig.clickup_user_map || {};
          var canResolveRefresh = !!(refreshUserMap[sender.email] || refreshUserMap[sender.email.toLowerCase()] || refreshCache.get('clickup_workspace'));
          if (!canResolveRefresh) {
            scheduleBackgroundTaskFetch(sender.email, 'refresh');
            return createChatResponse('⏳ Loading ClickUp data in the background. Tasks will appear shortly...');
          }

          // Clear task-specific cache only (NOT workspace structure)
          try {
            refreshCache.remove('clickup_tasks_' + sender.email);
          } catch (e) { }

          var config2 = getConfig();
          var refreshTasks = [];
          if (config2.clickup_config && config2.clickup_config.enabled) {
            refreshTasks = getTasksForUser(sender.email, 'today');
          }

          // Build task cards using buildEodTaskMessage (simpler, no workspace stats to avoid timeout)
          var refreshEodMsg = buildEodTaskMessage(refreshTasks, '');

          // Send refreshed task cards via REST API
          if (refreshEodMsg.cardsV2) {
            var refreshFullText = refreshEodMsg.text;
            if (refreshEodMsg.followUpText) refreshFullText += '\n\n' + refreshEodMsg.followUpText;
            sendDirectMessage(sender.email, refreshFullText, refreshEodMsg.cardsV2);
          } else {
            sendDirectMessage(sender.email, refreshEodMsg.text);
          }

          // Reset retry count since it's a fresh EOD prompt
          clearEodRetryCount(sender.email);

          console.log('EOD refreshed for ' + sender.email + ' with ' + refreshTasks.length + ' tasks');
          return createChatResponse('🔄 **Tasks refreshed!** ' + refreshTasks.length + ' task(s) re-sent above. Update your task cards, then submit your EOD summary.');
        } catch (refreshErr) {
          console.error('Error refreshing EOD for ' + sender.email + ':', refreshErr.message);
          return createChatResponse('❌ Error refreshing tasks: ' + refreshErr.message + '. Please try again.');
        }
      }
      var retryCount = getEodRetryCount(sender.email);
      var validation = validateEodSubmission(text);

      // Check if user completed any tasks today (via bot cards OR directly in ClickUp)
      var noTasksCompleted = false;
      try {
        // Check 1: Bot card actions in BigQuery
        var todayActions = getTodayTaskActions(sender.email);
        var botCompletedCount = todayActions.filter(function (a) { return a.action_type === 'COMPLETE'; }).length;
        console.log('EOD completion check: BQ actions=' + todayActions.length + ' completed=' + botCompletedCount + ' for ' + sender.email);

        // Check 2: ClickUp API — tasks with closed status closed today
        var clickUpCompletedCount = 0;
        try {
          var eodConfig = getConfig();
          if (eodConfig.clickup_config && eodConfig.clickup_config.enabled) {
            var allTasks = getTasksForUser(sender.email, 'today');
            clickUpCompletedCount = allTasks.filter(function (t) {
              return t.statusType === 'closed';
            }).length;
            console.log('EOD completion check: ClickUp total=' + allTasks.length + ' closed=' + clickUpCompletedCount + ' for ' + sender.email);
          }
        } catch (cuErr) {
          console.error('ClickUp completion check failed:', cuErr.message);
        }

        var totalCompleted = botCompletedCount + clickUpCompletedCount;
        console.log('EOD completion check: totalCompleted=' + totalCompleted + ' for ' + sender.email);

        // Only flag if ZERO completions from both sources AND user doesn't explain
        if (totalCompleted === 0 && !lowerText.match(/no tasks|didn.t complete|couldn.t|was in meetings|meetings all day|sick|pto|out of office|off today|no clickup|not in clickup|worked on other|admin work|support|emails|training|onboarding|completed.*in clickup|updated.*clickup|closed.*task/)) {
          noTasksCompleted = true;
        }
      } catch (e) {
        console.error('Task completion check failed:', e.message);
      }

      if ((!validation.isValid || (noTasksCompleted && retryCount === 0)) && retryCount < 2) {
        // If their text format is perfect, don't force a retry just for unclicked tasks if they've already been warned once
        if (validation.isValid && noTasksCompleted && retryCount > 0) {
          // Fall through to accept
        } else if (!validation.isValid || noTasksCompleted) {
          var newCount = incrementEodRetryCount(sender.email);
          var allMissing = validation.missingFields;
          console.log('EOD rejected for ' + sender.email + ': missing ' + allMissing.join(', ') + (noTasksCompleted ? ' + no tasks completed' : '') + ' (retry ' + newCount + '/2)');
          return createChatResponse(buildEodRejectionMessage(allMissing, newCount, noTasksCompleted));
        }
      }
      clearUserState(sender.email);
      clearEodRetryCount(sender.email);
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

    // Guide users to use button instead of text check-in
    if (['here', 'i\'m here', 'im here', 'present'].includes(lowerText)) {
      return createChatResponse('Please use the ✅ *Check In* button above to confirm your attendance.');
    }

    // Default response
    return createChatResponse("✅ Got your message: \"" + text + "\"\n\nType \"help\" for available commands.");

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
        "• Morning check-in cards — click to confirm and see tasks\n" +
        "• EOD cards — click to start your end-of-day report\n\n" +
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
    case 'handleCompleteWithHours':
      return handleCompleteWithHours(event);
    case 'handleCheckIn':
      return handleCheckIn(event);
    case 'handleStartEod':
      return handleStartEod(event);
    default:
      console.warn('Unknown action: ' + actionName);
      return createChatResponse('Unknown action');
  }
}

/**
 * Handle Check In button click from morning card
 * Logs attendance, fetches tasks, sends interactive task cards
 */
function handleCheckIn(event) {
  try {
    var email = event.chat.user.email;
    var name = event.chat.user.displayName || email.split('@')[0];

    // Double-click protection: check if already checked in today
    try {
      var todayCheckIns = getTodayCheckIns();
      var alreadyCheckedIn = todayCheckIns.some(function(c) { return c.user_email === email; });
      if (alreadyCheckedIn) {
        return createChatResponse({
          actionResponse: { type: 'UPDATE_MESSAGE' },
          text: '✅ You\'ve already checked in today.'
        });
      }
    } catch (e) {
      console.error('handleCheckIn: dedup check failed:', e.message);
    }

    // Clear any leftover state after check-in
    clearUserState(email);

    // Log attendance
    var now = new Date();
    var nowChicago = Utilities.formatDate(now, 'America/Chicago', 'HH:mm');
    var isLate = false;
    try {
      logPromptResponse(email, 'CHECKIN');
      var schedule = getUserWorkSchedule(email);
      var graceMinutes = getLateThresholdMin();
      var scheduleMinutes = timeToMinutes(schedule.blocks[0].start) + graceMinutes;
      var nowMinutes = timeToMinutes(nowChicago);
      isLate = nowMinutes > scheduleMinutes;
      logCheckIn(email, now, 'Button check-in', isLate);
    } catch (logErr) {
      console.error('handleCheckIn: attendance logging failed:', logErr.message);
    }

    // Fetch and send tasks — only if user can be resolved quickly (avoids 30s timeout)
    var tasksFetched = false;
    try {
      var ciCache = CacheService.getScriptCache();
      var config = getConfig();
      var tasks = [];
      // v125+ fast path: check sheet mapping OR workspace cache for quick user ID resolution
      var ciUserMap = config.clickup_user_map || {};
      var canResolveUser = !!(ciUserMap[email] || ciUserMap[email.toLowerCase()] || ciCache.get('clickup_workspace'));
      if (canResolveUser && config.clickup_config && config.clickup_config.enabled) {
        try {
          tasks = getTasksForUser(email, 'today');
          tasksFetched = true;
        } catch (err) {
          console.error('handleCheckIn: task fetch failed:', err.message);
        }

        var checkinMsg = isLate
          ? '⏰ *Checked in (late) at ' + nowChicago + '*'
          : '✅ *Checked in at ' + nowChicago + '*. Have a productive day!';

        if (tasksFetched && tasks.length > 0) {
          var cat = categorizeTasks(tasks, email);
          var confirmText = checkinMsg + '\n\n';
          if (cat.completedCount > 0) {
            confirmText += '✅ *' + cat.completedCount + ' task(s) completed today so far*\n\n';
          }
          var allOpenTasks = cat.overdue.concat(cat.inProgress).concat(cat.dueTodayNotStarted);
          if (allOpenTasks.length > 0) {
            var taskCards = allOpenTasks.slice(0, 10).map(function(task, i) { return buildTaskCard(task, i); });
            var cardText = confirmText + '📋 Here are your tasks for today (' + allOpenTasks.length + ' task' + (allOpenTasks.length === 1 ? '' : 's') + '):';
            if (cat.overdue.length > 0) cardText += '\n⚠️ *' + cat.overdue.length + ' overdue* — please prioritize these.';
            if (cat.inProgress.length > 0) cardText += '\n🔄 *' + cat.inProgress.length + ' in progress*';
            sendDirectMessage(email, cardText, taskCards);
          } else {
            sendDirectMessage(email, confirmText + '📋 No open tasks due today.');
          }
        } else {
          sendDirectMessage(email, checkinMsg + '\n\n📋 No open tasks due today.');
        }
      } else {
        // Cache cold — schedule background fetch (6-min limit trigger)
        var checkinMsg2 = isLate
          ? '⏰ *Checked in (late) at ' + nowChicago + '*'
          : '✅ *Checked in at ' + nowChicago + '*. Have a productive day!';
        scheduleBackgroundTaskFetch(email, 'checkin');
        sendDirectMessage(email, checkinMsg2 + '\n\n⏳ Loading your ClickUp tasks in the background...');
      }
    } catch (taskErr) {
      console.error('handleCheckIn: task send failed:', taskErr.message);
    }

    // Replace the check-in card with confirmation
    return createChatResponse({
      actionResponse: { type: 'UPDATE_MESSAGE' },
      text: isLate
        ? '⏰ Checked in (late) at ' + nowChicago + '. ' + (tasksFetched ? 'Tasks sent above.' : 'Tasks loading in background...')
        : '✅ Checked in at ' + nowChicago + '. ' + (tasksFetched ? 'Tasks sent above.' : 'Tasks loading in background...')
    });
  } catch (fatalErr) {
    console.error('handleCheckIn FATAL:', fatalErr.message, fatalErr.stack);
    return createChatResponse({
      actionResponse: { type: 'UPDATE_MESSAGE' },
      text: '❌ Check-in error: ' + fatalErr.message
    });
  }
}

/**
 * Handle Start EOD button click
 * Fetches tasks, sends interactive task cards + EOD format guide, sets AWAITING_EOD
 */
function handleStartEod(event) {
  try {
    var email = event.chat.user.email;
    var name = event.chat.user.displayName || email.split('@')[0];

    // State may already be AWAITING_EOD (set by scheduled trigger) — that's fine,
    // clicking the button loads task cards. Only reset retry count on fresh click.
    var currentState = getUserState(email);
    if (currentState !== 'AWAITING_EOD') {
      setUserState(email, 'AWAITING_EOD');
      clearEodRetryCount(email);
    }

    // Dedup: prevent duplicate task cards if button clicked multiple times
    var eodDedupCache = CacheService.getScriptCache();
    var eodDedupKey = 'eod_started_' + email.replace(/[^a-zA-Z0-9]/g, '_');
    if (eodDedupCache.get(eodDedupKey)) {
      return createChatResponse({
        actionResponse: { type: 'UPDATE_MESSAGE' },
        text: '📝 EOD already started. Reply with your EOD summary when ready.'
      });
    }
    eodDedupCache.put(eodDedupKey, '1', 120); // 2-minute dedup window

    // Fetch tasks if user can be resolved quickly (sheet mapping or workspace cache)
    var tasks = [];
    var tasksFetched = false;
    try {
      var cache = CacheService.getScriptCache();
      var config = getConfig();
      var eodUserMap = config.clickup_user_map || {};
      var canResolveUser = !!(eodUserMap[email] || eodUserMap[email.toLowerCase()] || cache.get('clickup_workspace'));
      if (canResolveUser && config.clickup_config && config.clickup_config.enabled) {
        tasks = getTasksForUser(email, 'today');
        tasksFetched = true;
      }
    } catch (err) {
      console.error('handleStartEod: task fetch failed:', err.message);
    }

    // Send task cards via REST API
    try {
      if (tasksFetched && tasks.length > 0) {
        var eodMessage = buildEodTaskMessage(tasks, '');
        var fullText = eodMessage.text;
        if (eodMessage.followUpText) fullText += '\n\n' + eodMessage.followUpText;
        if (eodMessage.cardsV2) {
          sendDirectMessage(email, fullText, eodMessage.cardsV2);
        } else {
          sendDirectMessage(email, fullText);
        }
      } else {
        // Cache cold — schedule background task fetch + show format guide
        scheduleBackgroundTaskFetch(email, 'eod');
        sendDirectMessage(email, '📝 Time for your EOD report!\n\n⏳ Loading your ClickUp tasks in the background...\n\n' +
          '📝 **Reply format:**\n―――――――――――――――――――\n' +
          '*Hours:* [Total, e.g. 7h 30m]\n' +
          '*Meetings:* [count] | [total time] | [names + durations]\n' +
          '*Tomorrow:* [Task 1 + CU link] | [Task 2 + CU link]\n' +
          '*Blockers/Issues:* [what > owner > deadline] _(if any)_\n' +
          '―――――――――――――――――――');
      }
    } catch (sendErr) {
      console.error('handleStartEod: send failed:', sendErr.message);
    }

    return createChatResponse({
      actionResponse: { type: 'UPDATE_MESSAGE' },
      text: '📝 EOD started! ' + (tasksFetched ? 'Update your task cards above, then' : 'Your tasks are loading in the background. Once they appear,') + ' reply with your EOD summary.'
    });
  } catch (fatalErr) {
    console.error('handleStartEod FATAL:', fatalErr.message, fatalErr.stack);
    return createChatResponse({
      actionResponse: { type: 'UPDATE_MESSAGE' },
      text: '❌ EOD error: ' + fatalErr.message
    });
  }
}

/**
 * Handle EOD response - now async to prevent 30s timeout
 */
function handleEodResponse(email, name, text) {
  // Save payload to process asynchronously
  var props = PropertiesService.getScriptProperties();
  var eodId = 'EOD_QUEUE_' + new Date().getTime() + '_' + Math.floor(Math.random() * 1000);
  props.setProperty(eodId, JSON.stringify({
    email: email,
    name: name,
    text: text,
    timestamp: new Date().getTime()
  }));

  // Return instantly to avoid 30s timeout on Google Chat request
  // NOTE: A separate 1-minute time-driven trigger MUST be manually created for processEodBackground
  return createChatResponse('⏳ *Processing your EOD report...*\nI am evaluating your tasks and hours. I will send your results in a new message shortly!');
}

/**
 * Schedule a background task fetch (runs with 6-min trigger limit, avoids 30s timeout)
 * @param {string} email - User email
 * @param {string} type - 'checkin', 'eod', or 'refresh'
 */
function scheduleBackgroundTaskFetch(email, type) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('TASK_FETCH_' + email.replace(/[^a-zA-Z0-9]/g, '_'),
    JSON.stringify({ email: email, type: type, timestamp: Date.now() }));
  ScriptApp.newTrigger('backgroundTaskFetch')
    .timeBased()
    .after(1000)
    .create();
  console.log('Scheduled backgroundTaskFetch for ' + email + ' type=' + type);
}

/**
 * Background trigger handler: fetch ClickUp tasks and send via REST API
 * Has 6-minute execution limit (vs 30s for onMessage/card click handlers)
 */
function backgroundTaskFetch() {
  console.log('backgroundTaskFetch triggered');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log('backgroundTaskFetch: could not acquire lock');
    return;
  }

  try {
    var props = PropertiesService.getScriptProperties();
    var allKeys = props.getKeys().filter(function(k) { return k.startsWith('TASK_FETCH_'); });
    console.log('backgroundTaskFetch: found ' + allKeys.length + ' pending requests: ' + allKeys.join(', '));

    if (allKeys.length === 0) {
      console.log('backgroundTaskFetch: no pending requests, exiting');
      lock.releaseLock();
      return;
    }

    allKeys.forEach(function(key) {
      try {
        var raw = props.getProperty(key);
        console.log('backgroundTaskFetch: processing ' + key + ' = ' + raw);
        var data = JSON.parse(raw);
        props.deleteProperty(key);

        // Skip stale requests (older than 5 minutes)
        if (Date.now() - data.timestamp > 5 * 60 * 1000) {
          console.log('backgroundTaskFetch: skipping stale request for ' + data.email);
          return;
        }

        var config = getConfig();
        if (!config.clickup_config || !config.clickup_config.enabled) {
          console.log('backgroundTaskFetch: clickup not enabled, skipping');
          return;
        }

        console.log('backgroundTaskFetch: fetching tasks for ' + data.email + ' type=' + data.type);
        var tasks = getTasksForUser(data.email, 'today');
        console.log('backgroundTaskFetch: got ' + tasks.length + ' tasks for ' + data.email);

        if (data.type === 'checkin') {
          var cat = categorizeTasks(tasks, data.email);
          var confirmText = '';
          if (cat.completedCount > 0) {
            confirmText += '✅ *' + cat.completedCount + ' task(s) completed today so far*\n\n';
          }
          var allOpenTasks = cat.overdue.concat(cat.inProgress).concat(cat.dueTodayNotStarted);
          if (allOpenTasks.length > 0) {
            var taskCards = allOpenTasks.slice(0, 10).map(function(task, i) { return buildTaskCard(task, i); });
            var cardText = confirmText + '📋 Here are your tasks for today (' + allOpenTasks.length + '):';
            if (cat.overdue.length > 0) cardText += '\n⚠️ *' + cat.overdue.length + ' overdue* — please prioritize these.';
            if (cat.inProgress.length > 0) cardText += '\n🔄 *' + cat.inProgress.length + ' in progress*';
            var sendResult = sendDirectMessage(data.email, cardText, taskCards);
            console.log('backgroundTaskFetch: checkin sendDirectMessage result: ' + JSON.stringify(sendResult));
          } else {
            var sendResult2 = sendDirectMessage(data.email, '📋 No open tasks due today.');
            console.log('backgroundTaskFetch: no tasks sendDirectMessage result: ' + JSON.stringify(sendResult2));
          }

        } else if (data.type === 'eod' || data.type === 'refresh') {
          var eodMessage = buildEodTaskMessage(tasks, '');
          var fullText = eodMessage.text;
          if (eodMessage.followUpText) fullText += '\n\n' + eodMessage.followUpText;
          if (eodMessage.cardsV2) {
            var sendResult3 = sendDirectMessage(data.email, fullText, eodMessage.cardsV2);
            console.log('backgroundTaskFetch: eod with cards sendDirectMessage result: ' + JSON.stringify(sendResult3));
          } else {
            var sendResult4 = sendDirectMessage(data.email, fullText);
            console.log('backgroundTaskFetch: eod text-only sendDirectMessage result: ' + JSON.stringify(sendResult4));
          }
        }
      } catch (err) {
        console.error('backgroundTaskFetch error for ' + key + ':', err.message, err.stack);
      }
    });
  } finally {
    lock.releaseLock();
  }

  // Clean up one-time triggers for this function
  try {
    var triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(function(t) {
      if (t.getHandlerFunction() === 'backgroundTaskFetch') {
        ScriptApp.deleteTrigger(t);
      }
    });
  } catch (e) { }
}

/**
 * Background trigger to process EOD reports
 * @param {Object} e - Trigger event
 */
function processEodBackground(e) {
  var lock = LockService.getScriptLock();
  // Wait up to 30 seconds for other executions to finish
  if (!lock.tryLock(30000)) {
    console.warn('Could not acquire lock for processEodBackground. Retrying next minute.');
    return;
  }

  try {
    var props = PropertiesService.getScriptProperties();
    var allProps = props.getProperties();

    for (var key in allProps) {
      // Only process pending EODs, strict prefix match to avoid collisions
      if (key.indexOf('EOD_QUEUE_') === 0) {
        try {
          var payload = JSON.parse(allProps[key]);
          _processSingleEod(payload.email, payload.name, payload.text, new Date(payload.timestamp));
          // Delete after successful processing
          props.deleteProperty(key);
        } catch (err) {
          console.error('Error processing background EOD (' + key + '):', err.message);
          // Notify user their EOD failed, then delete to prevent infinite loop
          try {
            if (payload && payload.email) {
              sendDirectMessage(payload.email, '⚠️ There was an error processing your EOD report. Please try resending it.');
            }
          } catch (e2) { /* best effort notification */ }
          props.deleteProperty(key);
        }
      }

    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * The original heavy EOD processing logic
 */
function _processSingleEod(email, name, text, now) {
  // Log prompt response for adoption tracking
  logPromptResponse(email, 'EOD');

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
  var tasks = [];
  try {
    if (config.clickup_config && config.clickup_config.enabled) {
      var member = config.team_members.find(function (m) { return m.email === email; });
      var taskSource = member ? member.task_source : 'clickup';

      if (taskSource === 'clickup' || taskSource === 'both') {
        tasks = getTasksForUser(email, 'today') || [];
        if (tasks.length > 0) {
          var completed = tasks.filter(function (t) { return t.statusType === 'closed'; }).length;
          var inProgress = tasks.filter(function (t) { return t.statusType === 'custom' && t.status && t.status.toLowerCase().includes('progress'); }).length;
          var overdue = tasks.filter(function (t) { return t.isOverdue; }).length;
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

  // ClickUp time tracking — fetch actual tracked hours
  try {
    if (config.clickup_config && config.clickup_config.enabled) {
      var timeData = getTodayTimeEntries(email);
      if (timeData) {
        feedback.clickUpTrackedHours = timeData.totalHours;
        feedback.clickUpTimeEntries = timeData.entries;
      }
    }
  } catch (e) {
    console.error('Failed to fetch ClickUp time entries:', e.message);
  }

  // AI hours estimation — compare reported hours to task complexity
  if (hoursWorked !== null && tasks.length > 0) {
    try {
      var estimate = estimateTaskHours(tasks, text, hoursWorked);
      if (estimate && estimate.estimatedHours) {
        feedback.hoursEstimate = estimate;
      }
    } catch (e) {
      console.error('Hours estimation failed:', e.message);
    }
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
    response += '\n\n🚨 **Action Required:** Reply with your hours worked today (e.g. "6.5"). Hours reporting is mandatory.';
  }

  // Forward EOD report + feedback to manager(s) in real-time
  try {
    var managerRecipients = getReportRecipients('eod_forward');
    var displayName = name || email.split('@')[0];
    var forwardMsg = '📨 **EOD Report from ' + displayName + '** (' + email + ')\n';
    forwardMsg += '―――――――――――――――――――\n';
    forwardMsg += text + '\n';
    forwardMsg += '―――――――――――――――――――\n\n';
    forwardMsg += '📊 **Bot Feedback:**\n' + response;

    // Include task outcomes from card submissions
    try {
      var taskOutcomes = getTodayTaskActions(email);
      var completedTasks = taskOutcomes.filter(function (a) { return a.action_type === 'COMPLETE'; });
      if (completedTasks.length > 0) {
        forwardMsg += '\n\n📋 **Task Card Actions Today:** ' + completedTasks.length + ' completed';
        completedTasks.forEach(function (t) {
          forwardMsg += '\n  • ' + t.task_name;
        });
      } else {
        forwardMsg += '\n\n⚠️ **No tasks completed via cards today**';
      }
    } catch (taskErr) {
      console.error('Failed to fetch task outcomes for manager forward:', taskErr.message);
    }

    for (var r = 0; r < managerRecipients.length; r++) {
      if (managerRecipients[r] && managerRecipients[r] !== email) {
        sendDirectMessage(managerRecipients[r], forwardMsg);
      }
    }
  } catch (fwdErr) {
    console.error('Failed to forward EOD to manager:', fwdErr.message);
  }

  sendDirectMessage(email, response);
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
    /total\s*(?:time|hours?)\s*:?\s*(\d+\.?\d*)\s*(?:hours?|hrs?|h)?/i,
    /time\s*:?\s*(\d+\.?\d*)\s*(?:hours?|hrs?|h)?/i,
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

  console.log('Morning check-in: ' + teamMembers.length + ' working employees, splitSpecialActive=' + splitSpecialActive);

  // Filter to tracked users on default schedule (dispatcher handles custom/split)
  var defaultMembers = teamMembers.filter(function (m) {
    var fullMember = config.team_members.find(function (tm) { return tm.email === m.email; });
    if (!fullMember) return true;
    if (fullMember.tracking_mode === 'not_tracked') return false;
    if (splitSpecialActive) return false; // Dispatcher handles everyone during split special periods
    return !fullMember.custom_start_time; // Skip custom-schedule users (dispatcher handles them)
  });

  console.log('Morning check-in: ' + defaultMembers.length + ' default members after filtering (splitSpecial=' + splitSpecialActive + ')');

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
      if (config.clickup_config && config.clickup_config.enabled) {
        tasks = isMonday
          ? getTasksForUser(member.email, 'week')
          : getTasksForUser(member.email, 'today');
      }

      // Send button card — skip BQ query at morning (no completions yet, saves ~2s per user)
      var cat = categorizeTasks(tasks, member.email, true);
      var checkInCards = buildCheckInCard(
        member.name || member.email.split('@')[0],
        cat.summary
      );
      var ciResult = sendDirectMessage(member.email, '👋 Good morning! Click below to check in.', checkInCards);
      if (!ciResult || !ciResult.sent) {
        console.error('Morning check-in FAILED for ' + member.email + ': ' + (ciResult ? ciResult.error : 'no DM space'));
      }
      logPromptSent(member.email, 'CHECKIN');
      // No AWAITING_CHECKIN state — button handler handles check-in
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
      var followUpTasks = [];
      try {
        if (config.clickup_config && config.clickup_config.enabled) {
          followUpTasks = getTasksForUser(notCheckedIn[j].email, 'today');
        }
      } catch (ftErr) {
        console.error('Follow-up task fetch failed for ' + notCheckedIn[j].email + ':', ftErr.message);
      }
      var followUpCat = categorizeTasks(followUpTasks, notCheckedIn[j].email, true);
      var followUpCards = buildCheckInCard(
        notCheckedIn[j].name || notCheckedIn[j].email.split('@')[0],
        followUpCat.summary
      );
      sendDirectMessage(notCheckedIn[j].email, '⏰ *Reminder:* Please check in.', followUpCards);
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

    try {
      var schedule = getUserWorkSchedule(m.email);
      if (schedule && schedule.blocks && schedule.blocks.length > 0) {
        var startMin = timeToMinutes(schedule.blocks[0].start);
        var localTimeStr = Utilities.formatDate(new Date(), 'America/Chicago', 'HH:mm');
        var nowMin = timeToMinutes(localTimeStr);
        // If their shift hasn't started (plus 30m grace), they aren't "missing" yet
        if (nowMin < startMin + 30) return false;
      }
    } catch (e) {
      // Ignore err
    }

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

  // Clear per-user task caches so we pick up tasks created/completed during the day
  // NOTE: Do NOT clear workspace structure cache — it's expensive to rebuild and
  // only needed for list name enrichment (not for task fetching)
  try {
    var eodCache = CacheService.getScriptCache();
    var eodConfig = getConfig();
    var eodMembers = eodConfig.team_members || [];
    for (var ci = 0; ci < eodMembers.length; ci++) {
      eodCache.remove('clickup_tasks_' + eodMembers[ci].email);
    }
    console.log('Per-user ClickUp task caches cleared for fresh EOD task pull');
  } catch (cacheErr) {
    console.error('Error clearing ClickUp caches:', cacheErr.message);
  }

  var teamMembers = getCachedWorkingEmployees();
  var config = getConfig();
  var splitSpecialActive = hasActiveSplitSpecialPeriod();

  // Pre-fetch today's check-ins once for late-minutes lookup
  var todayCheckIns = getTodayCheckIns();

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
      if (config.clickup_config && config.clickup_config.enabled) {
        tasks = getTasksForUser(member.email, 'today');
      }

      var lateMinutes = getLateMinutesForUser(member.email, todayCheckIns);
      var workspaceStats = null;
      try {
        if (typeof getUserWorkspaceStats === 'function') {
          workspaceStats = getUserWorkspaceStats(member.email);
        }
      } catch (wsErr) {
        console.error('Error fetching workspace stats for ' + member.email + ':', wsErr.message);
      }

      var complianceWarning = handleClickUpCompliance(member.email, tasks.length);

      // Send button card instead of full task cards
      var cat = categorizeTasks(tasks, member.email);
      var lateNote = '';
      if (lateMinutes && lateMinutes > 0) {
        lateNote = 'You checked in ' + lateMinutes + ' minute' + (lateMinutes === 1 ? '' : 's') + ' late this morning.';
      }
      var eodCards = buildStartEodCard(lateNote, complianceWarning || '', cat.summary);

      // Workspace stats go in text (markdown renders in text, not in card widgets)
      var eodText = '';
      if (workspaceStats) {
        eodText = formatWorkspaceStatsBlock(workspaceStats);
      }
      sendDirectMessage(member.email, eodText, eodCards);
      logPromptSent(member.email, 'EOD');
      // Set AWAITING_EOD so users can type EOD directly without clicking button
      setUserState(member.email, 'AWAITING_EOD');
      clearEodRetryCount(member.email);
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
      var eodFollowTasks = [];
      try {
        if (config.clickup_config && config.clickup_config.enabled) {
          eodFollowTasks = getTasksForUser(notSubmitted[j].email, 'today');
        }
      } catch (eftErr) {
        console.error('EOD follow-up task fetch failed for ' + notSubmitted[j].email + ':', eftErr.message);
      }
      var eodFollowCat = categorizeTasks(eodFollowTasks, notSubmitted[j].email);
      var eodFollowCards = buildStartEodCard('', '', eodFollowCat.summary);
      sendDirectMessage(notSubmitted[j].email, '⏰ *EOD Reminder:* Please submit your end-of-day report.', eodFollowCards);
      logPromptSent(notSubmitted[j].email, 'EOD_FOLLOWUP');
      // Ensure AWAITING_EOD is set so users can type EOD directly
      setUserState(notSubmitted[j].email, 'AWAITING_EOD');
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

    try {
      var schedule = getUserWorkSchedule(m.email);
      if (schedule && schedule.blocks && schedule.blocks.length > 0) {
        var endMin = timeToMinutes(schedule.blocks[schedule.blocks.length - 1].end);
        var localTimeStr = Utilities.formatDate(new Date(), 'America/Chicago', 'HH:mm');
        var nowMin = timeToMinutes(localTimeStr);
        // If their shift hasn't ended, they aren't "missing" EOD yet
        if (nowMin < endMin) return false;
      }
    } catch (e) {
      // Ignore err
    }

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

  // Compiled EOD batch is now sent dynamically after the latest shift ends
  // (handled by _checkAndSendCompiledBatch via triggerScheduleDispatcher / triggerAiEvaluation)

  console.log('EOD summary posted');
}

/**
 * Send compiled EOD batch to manager(s) — all reports in one message
 */
function _sendCompiledEodBatch(todayEods, teamMembers) {
  if (!todayEods || todayEods.length === 0) return;

  var recipients = getReportRecipients('eod_forward');
  if (!recipients || recipients.length === 0) return;

  var today = Utilities.formatDate(new Date(), 'America/Chicago', 'EEEE, MMMM d');
  var nameMap = {};
  teamMembers.forEach(function (m) { nameMap[m.email] = m.name || m.email.split('@')[0]; });

  var batch = '📋 **Compiled EOD Reports — ' + today + '**\n';
  batch += todayEods.length + ' reports received\n';
  batch += '═══════════════════════════\n\n';

  todayEods.forEach(function (eod) {
    var name = nameMap[eod.user_email] || eod.user_email.split('@')[0];
    var hours = eod.hours_worked !== null && eod.hours_worked !== undefined ? eod.hours_worked + 'h' : 'not reported';

    batch += '👤 **' + name + '** | ' + hours + '\n';

    if (eod.raw_response) {
      // Truncate long reports
      var report = eod.raw_response.length > 300 ? eod.raw_response.substring(0, 300) + '...' : eod.raw_response;
      batch += report + '\n';
    } else if (eod.tasks_completed) {
      batch += eod.tasks_completed.substring(0, 200) + '\n';
    }

    if (eod.blockers) {
      batch += '🚫 Blocker: ' + eod.blockers + '\n';
    }
    if (eod.tomorrow_priority) {
      batch += '📌 Tomorrow: ' + eod.tomorrow_priority + '\n';
    }

    batch += '―――――――――――――――――――\n';
  });

  // Send to each manager recipient
  for (var i = 0; i < recipients.length; i++) {
    try {
      sendDirectMessage(recipients[i], batch);
    } catch (err) {
      console.error('Error sending EOD batch to ' + recipients[i] + ':', err.message);
    }
  }

  console.log('Sent compiled EOD batch to ' + recipients.length + ' recipients');
}

/**
 * Get the latest shift end time (in minutes since midnight) across all tracked employees today.
 * Uses each employee's actual schedule (custom, special period, or default).
 */
function _getLatestShiftEndMinutes() {
  var config = getConfig();
  var workingEmployees = getCachedWorkingEmployees();
  var latestEnd = 0;

  for (var i = 0; i < workingEmployees.length; i++) {
    var email = workingEmployees[i].email;
    var fullMember = config.team_members.find(function (tm) { return tm.email === email; });
    if (fullMember && (fullMember.tracking_mode || 'tracked') !== 'tracked') continue;

    try {
      var schedule = getUserWorkSchedule(email);
      if (schedule && schedule.blocks && schedule.blocks.length > 0) {
        var lastBlock = schedule.blocks[schedule.blocks.length - 1];
        var endMin = timeToMinutes(lastBlock.end);
        if (endMin > latestEnd) latestEnd = endMin;
      }
    } catch (err) {
      console.error('Error getting schedule for ' + email + ':', err.message);
    }
  }

  // Fallback: if no employees found or all errored, use default 5 PM (1020 min)
  return latestEnd > 0 ? latestEnd : 17 * 60;
}

/**
 * Check if it's time to send the compiled EOD batch and send it if so.
 * Waits until 15 minutes after the latest employee's shift ends.
 * Uses cache dedup to avoid sending twice in one day.
 */
function _checkAndSendCompiledBatch() {
  var cache = CacheService.getScriptCache();
  var todayStr = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');
  var dedupKey = 'COMPILED_EOD_BATCH_' + todayStr;

  // Already sent today?
  if (cache.get(dedupKey)) return;

  var now = new Date();
  var nowMinutes = parseInt(Utilities.formatDate(now, 'America/Chicago', 'HH')) * 60 +
    parseInt(Utilities.formatDate(now, 'America/Chicago', 'mm'));

  var latestEnd = _getLatestShiftEndMinutes();
  var BUFFER = 15; // 15 minutes after last shift ends

  if (nowMinutes < latestEnd + BUFFER) {
    console.log('Compiled batch: waiting — latest shift ends at ' +
      Math.floor(latestEnd / 60) + ':' + String(latestEnd % 60).padStart(2, '0') +
      ', now is ' + Math.floor(nowMinutes / 60) + ':' + String(nowMinutes % 60).padStart(2, '0'));
    return;
  }

  // Time to send — gather data and send
  var teamMembers = getCachedWorkingEmployees();
  var todayEods = getTodayEodReports();

  if (!todayEods || todayEods.length === 0) {
    console.log('Compiled batch: no EOD reports to send');
    cache.put(dedupKey, 'none', 21600);
    return;
  }

  _sendCompiledEodBatch(todayEods, teamMembers);
  cache.put(dedupKey, 'sent', 21600); // 6 hour TTL

  console.log('Compiled batch sent after latest shift end (' +
    Math.floor(latestEnd / 60) + ':' + String(latestEnd % 60).padStart(2, '0') + ')');
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

  // ClickUp snapshot merged here to save triggers (was separate triggerClickUpSnapshot at 5:15 PM)
  try { dailyClickUpSnapshot(); } catch (e) { console.error('ClickUp snapshot failed:', e.message); }

  // Daily adoption metrics merged here to free trigger slot (was triggerDailyAdoptionMetrics at 5:20 PM)
  try { computeDailyAdoptionMetrics(); } catch (e) { console.error('Daily adoption metrics failed:', e.message); }
}

/**
 * 5:30 PM (Mon-Thu) - AI Evaluation
 */
function triggerAiEvaluation() {
  if (!isEodWorkday()) return;
  var today = new Date();
  if (today.getDay() === 5) return;

  // Safety net: send compiled EOD batch if not already sent by dispatcher
  try {
    _checkAndSendCompiledBatch();
  } catch (err) {
    console.error('Error checking compiled EOD batch in AI eval trigger:', err.message);
  }

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

  // ClickUp snapshot merged here (was separate triggerClickUpSnapshot)
  try { dailyClickUpSnapshot(); } catch (e) { console.error('ClickUp snapshot failed:', e.message); }
}

/**
 * 11:30 AM Friday - AI Evaluation + Weekly Summary (Friday only)
 */
function triggerAiEvaluationFriday() {
  var today = new Date();
  if (today.getDay() !== 5) return;
  if (!isWorkday()) return;

  // Safety net: send compiled EOD batch if not already sent by dispatcher
  try {
    _checkAndSendCompiledBatch();
  } catch (err) {
    console.error('Error checking compiled EOD batch in Friday AI eval:', err.message);
  }

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
    // Gamification merged here (was separate triggerWeeklyGamification at 10:15 AM)
    try { postWeeklyGamification(); } catch (e) { console.error('Weekly gamification failed:', e.message); }
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

  // Always check if compiled EOD batch should be sent (schedule-aware)
  try {
    _checkAndSendCompiledBatch();
  } catch (err) {
    console.error('Error checking compiled EOD batch:', err.message);
  }

  var config = getConfig();
  var workingEmployees = getCachedWorkingEmployees();
  var splitSpecialActive = hasActiveSplitSpecialPeriod();

  console.log('Dispatcher: ' + workingEmployees.length + ' working, splitSpecial=' + splitSpecialActive);

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

  console.log('Dispatcher: ' + dispatchUsers.length + ' dispatch users');

  if (dispatchUsers.length === 0) return;

  var checkinTypes = ['CHECKIN', 'CHECKIN_FOLLOWUP', 'ESCALATION_CHECKIN'];
  var eodTypes = ['EOD', 'EOD_FOLLOWUP', 'ESCALATION_EOD'];
  var cache = CacheService.getScriptCache();
  var todayStr = Utilities.formatDate(new Date(), 'America/Chicago', 'yyyy-MM-dd');

  var todayCheckIns = null;
  var todayEods = null;

  for (var i = 0; i < dispatchUsers.length; i++) {
    var member = dispatchUsers[i];

    // Evaluate CHECKIN series sequentially per user
    for (var j = 0; j < checkinTypes.length; j++) {
      var promptType = checkinTypes[j];
      if (isTimeForPrompt(member.email, promptType)) {
        var dedupKey = 'DISPATCH_' + promptType + '_' + member.email + '_' + todayStr;
        if (!cache.get(dedupKey)) {
          if (!todayCheckIns) todayCheckIns = getTodayCheckIns();
          try {
            dispatchPrompt(member, promptType, config, todayCheckIns, todayEods);
            cache.put(dedupKey, 'sent', 21600); // 6 hour TTL
          } catch (err) {
            console.error('Dispatcher error for ' + member.email + ' ' + promptType + ':', err.message);
          }
          break; // Stop evaluating check-in series for this user (max 1 per run)
        }
      }
    }

    // Evaluate EOD series sequentially per user
    for (var k = 0; k < eodTypes.length; k++) {
      var eodType = eodTypes[k];
      if (isTimeForPrompt(member.email, eodType)) {
        var dedupKey = 'DISPATCH_' + eodType + '_' + member.email + '_' + todayStr;
        if (!cache.get(dedupKey)) {
          if (!todayCheckIns) todayCheckIns = getTodayCheckIns(); // Issue 11 Fix
          if (!todayEods) todayEods = getTodayEodReports();
          try {
            dispatchPrompt(member, eodType, config, todayCheckIns, todayEods);
            cache.put(dedupKey, 'sent', 21600); // 6 hour TTL
          } catch (err) {
            console.error('Dispatcher error for ' + member.email + ' ' + eodType + ':', err.message);
          }
          break; // Stop evaluating EOD series for this user (max 1 per run)
        }
      }
    }
  }
}

/**
 * Check if NOW is the right time to send a prompt to this user.
 * Uses a 29-minute window to match dispatcher's 30-min interval + GAS trigger jitter.
 * Dedup cache prevents double-sends within the window.
 */
function isTimeForPrompt(email, promptType) {
  var schedule = getUserWorkSchedule(email);
  // Fixed Issue 5, 9, 10: Use exact local time to avoid UTC mismatch in trigger environment
  var localTimeStr = Utilities.formatDate(new Date(), 'America/Chicago', 'HH:mm');
  var nowMinutes = timeToMinutes(localTimeStr);
  var WINDOW = 29;

  var block1Start = timeToMinutes(schedule.blocks[0].start);
  var lastBlockEnd = timeToMinutes(schedule.blocks[schedule.blocks.length - 1].end);

  // Issues 5: narrowed windows from 3 hours to 15 mins to prevent overlap
  switch (promptType) {
    case 'CHECKIN':
      return nowMinutes >= block1Start && nowMinutes <= block1Start + WINDOW;
    case 'CHECKIN_FOLLOWUP':
      return nowMinutes >= block1Start + 20 && nowMinutes <= block1Start + 20 + WINDOW;
    case 'ESCALATION_CHECKIN':
      return nowMinutes >= block1Start + 45 && nowMinutes <= block1Start + 45 + WINDOW;
    case 'EOD':
      return nowMinutes >= lastBlockEnd - 45 && nowMinutes <= lastBlockEnd - 45 + WINDOW;
    case 'EOD_FOLLOWUP':
      return nowMinutes >= lastBlockEnd - 10 && nowMinutes <= lastBlockEnd - 10 + WINDOW;
    case 'ESCALATION_EOD':
      return nowMinutes >= lastBlockEnd + 15 && nowMinutes <= lastBlockEnd + 15 + WINDOW;
    default:
      return false;
  }
}

/**
 * Send the appropriate prompt to a user based on type.
 */
function dispatchPrompt(member, promptType, config, todayCheckIns, todayEods) {
  switch (promptType) {
    case 'CHECKIN':
      if (todayCheckIns && todayCheckIns.some(function (c) { return c.user_email === member.email; })) {
        break; // Already checked in organically
      }
      var tasks = config.clickup_config && config.clickup_config.enabled ? getTasksForUser(member.email, 'today') : [];
      var dispCiCat = categorizeTasks(tasks, member.email, true);
      var dispCiCards = buildCheckInCard(member.name || member.email.split('@')[0], dispCiCat.summary);
      sendDirectMessage(member.email, '👋 Good morning! Click below to check in.', dispCiCards);
      logPromptSent(member.email, 'CHECKIN');
      // No AWAITING_CHECKIN state — button click handles it
      break;
    case 'CHECKIN_FOLLOWUP':
      if (!todayCheckIns || !todayCheckIns.some(function (c) { return c.user_email === member.email; })) {
        var dispFollowTasks = config.clickup_config && config.clickup_config.enabled ? getTasksForUser(member.email, 'today') : [];
        var dispFollowCat = categorizeTasks(dispFollowTasks, member.email, true);
        var dispFollowCards = buildCheckInCard(member.name || member.email.split('@')[0], dispFollowCat.summary);
        sendDirectMessage(member.email, '⏰ *Reminder:* Please check in.', dispFollowCards);
        logPromptSent(member.email, 'CHECKIN_FOLLOWUP');
      }
      break;
    case 'ESCALATION_CHECKIN':
      if (!todayCheckIns || !todayCheckIns.some(function (c) { return c.user_email === member.email; })) {
        logMissedCheckIn(member.email, new Date(), 'CHECKIN');
        escalateMissedCheckIn(member.email, member.name || member.email.split('@')[0]);
        logPromptSent(member.email, 'ESCALATION_CHECKIN');
      }
      break;
    case 'EOD':
      if (todayEods && todayEods.some(function (e) { return e.user_email === member.email; })) {
        break; // Already submitted EOD organically
      }
      var eodTasks = config.clickup_config && config.clickup_config.enabled ? getTasksForUser(member.email, 'today') : [];
      var lateMin = getLateMinutesForUser(member.email, todayCheckIns);
      var complianceWarn = handleClickUpCompliance(member.email, eodTasks.length);
      var dispEodCat = categorizeTasks(eodTasks, member.email);
      var dispLateNote = lateMin > 0 ? 'You checked in ' + lateMin + ' minutes late this morning.' : '';
      var dispEodCards = buildStartEodCard(dispLateNote, complianceWarn || '', dispEodCat.summary);

      var dispEodText = '';
      try {
        if (typeof getUserWorkspaceStats === 'function') {
          var wStats = getUserWorkspaceStats(member.email);
          if (wStats) dispEodText = formatWorkspaceStatsBlock(wStats);
        }
      } catch (wsErr) {
        console.error('Error fetching workspace stats for ' + member.email + ':', wsErr.message);
      }

      sendDirectMessage(member.email, dispEodText, dispEodCards);
      logPromptSent(member.email, 'EOD');
      setUserState(member.email, 'AWAITING_EOD');
      clearEodRetryCount(member.email);
      break;
    case 'EOD_FOLLOWUP':
      if (!todayEods || !todayEods.some(function (e) { return e.user_email === member.email; })) {
        var dispEodFollowTasks = config.clickup_config && config.clickup_config.enabled ? getTasksForUser(member.email, 'today') : [];
        var dispEodFollowCat = categorizeTasks(dispEodFollowTasks, member.email);
        var dispEodFollowCards = buildStartEodCard('', '', dispEodFollowCat.summary);
        sendDirectMessage(member.email, '⏰ *EOD Reminder:* Please submit your end-of-day report.', dispEodFollowCards);
        logPromptSent(member.email, 'EOD_FOLLOWUP');
        setUserState(member.email, 'AWAITING_EOD');
      }
      break;
    case 'ESCALATION_EOD':
      if (!todayEods || !todayEods.some(function (e) { return e.user_email === member.email; })) {
        logMissedCheckIn(member.email, new Date(), 'EOD');
        escalateMissedEod(member.email, member.name || member.email.split('@')[0]);
        logPromptSent(member.email, 'ESCALATION_EOD');
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
