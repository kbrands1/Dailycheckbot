/**
 * Chat.gs - Google Chat Integration
 * Handles DMs, channel posts, and message formatting
 * Uses REST API for app-initiated messages with Service Account for cards support
 */

// Cache for DM space IDs
const DM_SPACE_CACHE = {};



/**
 * Check if service account is configured
 */
function isServiceAccountConfigured() {
  const props = PropertiesService.getScriptProperties();
  return !!props.getProperty('SERVICE_ACCOUNT_KEY');
}

/**
 * Get DM space for a user (from storage only - does not create)
 * Spaces are stored when users message the bot
 */
function getDMSpace(userEmail) {
  // Check in-memory cache first
  if (DM_SPACE_CACHE[userEmail]) {
    return DM_SPACE_CACHE[userEmail];
  }

  // Check persistent storage (individual property per user)
  try {
    const props = PropertiesService.getScriptProperties();
    var key = 'DM_SPACE_' + userEmail.replace(/[^a-zA-Z0-9]/g, '_');
    var spaceName = props.getProperty(key);

    if (spaceName) {
      DM_SPACE_CACHE[userEmail] = spaceName;
      return spaceName;
    }
  } catch (error) {
    console.error(`Error getting DM space for ${userEmail}:`, error);
  }

  // No space found - user needs to message the bot first
  console.log(`No DM space stored for ${userEmail} - user must message bot first`);
  return null;
}

/**
 * Store DM space when user first interacts with bot
 * Stores as individual property: DM_SPACE_{email}
 */
function storeDMSpace(userEmail, spaceName) {
  try {
    // Update in-memory cache
    DM_SPACE_CACHE[userEmail] = spaceName;

    // Persist to Script Properties (individual property per user)
    const props = PropertiesService.getScriptProperties();
    var key = 'DM_SPACE_' + userEmail.replace(/[^a-zA-Z0-9]/g, '_');
    props.setProperty(key, spaceName);

    console.log(`Stored DM space for ${userEmail}: ${spaceName}`);
  } catch (error) {
    console.error(`Error storing DM space for ${userEmail}:`, error);
  }
}

/**
 * One-time migration: move DM spaces from JSON blob to individual properties
 * Run once after deploying V2
 */
function migrateDMSpaces() {
  try {
    var props = PropertiesService.getScriptProperties();
    var blobJson = props.getProperty('DM_SPACES');
    if (!blobJson) {
      console.log('No DM_SPACES blob to migrate');
      return;
    }

    var dmSpaces = JSON.parse(blobJson);
    var count = 0;
    for (var email in dmSpaces) {
      var key = 'DM_SPACE_' + email.replace(/[^a-zA-Z0-9]/g, '_');
      props.setProperty(key, dmSpaces[email]);
      count++;
    }

    // Delete the old blob
    props.deleteProperty('DM_SPACES');
    console.log('Migrated ' + count + ' DM spaces to individual properties');
  } catch (error) {
    console.error('Error migrating DM spaces:', error);
  }
}

/**
 * Send a direct message to a user
 */
function sendDirectMessage(userEmail, text, cards = null) {
  const spaceName = getDMSpace(userEmail);

  if (!spaceName) {
    console.error(`Cannot send DM to ${userEmail}: no space available`);
    return null;
  }

  return sendMessageToSpace(spaceName, text, cards);
}

/**
 * Send message to a space (DM or channel)
 * Uses Service Account for cards support, falls back to user OAuth for text-only
 */
function sendMessageToSpace(spaceName, text, cards = null) {
  if (!spaceName) {
    console.error('sendMessageToSpace: spaceName is required');
    return { sent: false, error: 'Missing spaceName' };
  }

  try {
    let accessToken;
    let useServiceAccount = false;

    // Use service account if available for all message types
    if (isServiceAccountConfigured()) {
      accessToken = getServiceAccountToken('https://www.googleapis.com/auth/chat.bot');
      if (accessToken) {
        useServiceAccount = true;
      } else {
        console.warn('Service account token failed, falling back to text-only message');
      }
    }

    // Fall back to user OAuth if no service account or no cards
    if (!accessToken) {
      accessToken = ScriptApp.getOAuthToken();
    }

    // Build message payload
    const payload = {
      text: text
    };

    // Only add cards if using service account
    if (cards && useServiceAccount) {
      payload.cardsV2 = cards;
    } else if (cards) {
      console.log('Note: Cards require service account - sending text only');
    }

    // Configure HTTP request
    const options = {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': 'Bearer ' + accessToken
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    console.log('Sending message to ' + spaceName + ', useServiceAccount: ' + useServiceAccount);

    // Call Chat API
    const url = `https://chat.googleapis.com/v1/${spaceName}/messages`;
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();

    if (responseCode === 200 || responseCode === 201) {
      console.log(`Message sent successfully to ${spaceName}` + (useServiceAccount ? ' (with cards)' : ''));
      const responseData = JSON.parse(response.getContentText());
      return {
        sent: true,
        spaceName: spaceName,
        messageName: responseData.name,
        hasCards: useServiceAccount && !!cards
      };
    } else {
      const errorText = response.getContentText();
      console.error(`Failed to send message to ${spaceName}: ${responseCode}`);
      console.error(`Error details: ${errorText}`);
      return {
        sent: false,
        error: `HTTP ${responseCode}: ${errorText}`
      };
    }

  } catch (error) {
    console.error(`Exception in sendMessageToSpace for ${spaceName}:`);
    console.error(`Error: ${error.message}`);
    console.error(`Stack: ${error.stack}`);
    return {
      sent: false,
      error: error.message
    };
  }
}

/**
 * Send message to a channel/space
 */
function sendChannelMessage(spaceId, text, cards = null) {
  return sendMessageToSpace(spaceId, text, cards);
}

/**
 * Update an existing message (BUG #14 fix)
 * Uses Chat REST API with service account auth
 */
function updateMessage(messageName, text, cards) {
  if (!messageName) {
    console.error('updateMessage: messageName is required');
    return null;
  }

  try {
    var accessToken = null;
    var updateMask = 'text';

    if (isServiceAccountConfigured()) {
      accessToken = getServiceAccountToken();
    }
    if (!accessToken) {
      accessToken = ScriptApp.getOAuthToken();
    }

    var payload = { text: text };

    if (cards && isServiceAccountConfigured()) {
      payload.cardsV2 = cards;
      updateMask = 'text,cardsV2';
    }

    var url = 'https://chat.googleapis.com/v1/' + messageName + '?updateMask=' + updateMask;
    var options = {
      method: 'put',
      contentType: 'application/json',
      headers: {
        'Authorization': 'Bearer ' + accessToken
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    var response = UrlFetchApp.fetch(url, options);
    var responseCode = response.getResponseCode();

    if (responseCode === 200) {
      console.log('Message updated: ' + messageName);
      return JSON.parse(response.getContentText());
    } else {
      console.error('Failed to update message: ' + responseCode + ' - ' + response.getContentText());
      return null;
    }
  } catch (error) {
    console.error('Error updating message:', error.message);
    return null;
  }
}

/**
 * Send escalation to all recipients as individual DMs (BUG #5 fix)
 * Replaces placeholder createGroupDM - sends individual DMs instead
 */
function sendEscalationToRecipients(emails, message) {
  var results = [];
  for (var i = 0; i < emails.length; i++) {
    try {
      var result = sendDirectMessage(emails[i], message);
      results.push({ email: emails[i], sent: result ? result.sent : false });
    } catch (err) {
      console.error('Error sending escalation to ' + emails[i] + ':', err.message);
      results.push({ email: emails[i], sent: false, error: err.message });
    }
  }
  return results;
}

/**
 * Get the team updates channel space ID from config
 */
function getTeamUpdatesChannel() {
  const config = getConfig();
  return config.settings.team_updates_space_id;
}

/**
 * Post morning summary to team channel
 */
function postMorningSummary(checkedIn, late, missing, overdueStats, onLeaveToday, todayBirthdays, notTracked) {
  const spaceId = getTeamUpdatesChannel();
  if (!spaceId) {
    console.error('Team updates channel not configured');
    return;
  }

  const today = Utilities.formatDate(new Date(), 'America/Chicago', 'EEEE, MMMM d');

  let message = `📊 **Morning Summary - ${today}**\n\n`;
  // Total = checkedIn + missing (late are already included in checkedIn)
  message += `✅ Checked in: ${checkedIn.length}/${checkedIn.length + missing.length}\n`;

  if (late.length > 0) {
    message += `⏰ Late: ${late.length} (${late.map(e => e.name || e.email.split('@')[0]).join(', ')})\n`;
  }

  if (missing.length > 0) {
    message += `❌ Missing: ${missing.length} (${missing.map(e => e.name || e.email.split('@')[0]).join(', ')})\n`;
  }

  // OUT TODAY section - PTO / leave
  if (onLeaveToday && onLeaveToday.length > 0) {
    message += `\n──────────────────────────────\n\n`;
    message += `🏖️ **Out Today**\n\n`;
    onLeaveToday.forEach(function (person) {
      message += `• ${person.name} — ${person.leave_type}\n`;
    });
  }

  // BIRTHDAYS section
  if (todayBirthdays && todayBirthdays.length > 0) {
    message += `\n──────────────────────────────\n\n`;
    message += `🎂 **Birthdays Today**\n\n`;
    todayBirthdays.forEach(function (person) {
      message += `• Happy Birthday, ${person.name}! 🎉\n`;
    });
  }

  // Add overdue stats if available
  if (overdueStats && overdueStats.totalOverdue > 0) {
    message += `\n──────────────────────────────\n\n`;
    message += `⚠️ **Team Overdue Alert**\n\n`;
    message += `Total overdue tasks: ${overdueStats.totalOverdue} across ${overdueStats.peopleWithOverdue} people\n\n`;

    if (overdueStats.topOffenders && overdueStats.topOffenders.length > 0) {
      message += `Top overdue:\n`;
      overdueStats.topOffenders.slice(0, 3).forEach(o => {
        message += `• ${o.name}: ${o.count} overdue (oldest: ${o.maxDays} days)\n`;
      });
    }

    if (overdueStats.chronicCount > 0) {
      message += `\n🔴 Chronic (3+ days): ${overdueStats.chronicCount} tasks\n`;
    }
  }

  // Not tracked section
  if (notTracked && notTracked.length > 0) {
    message += `\n📌 Not tracked: ${notTracked.map(function(m) { return m.name || m.email.split('@')[0]; }).join(', ')}\n`;
  }

  sendChannelMessage(spaceId, message);
}

/**
 * Post EOD summary to team channel
 */
function postEodSummary(submitted, missing, taskStats, perPersonCompletions, todayBlockers, notTracked) {
  const spaceId = getTeamUpdatesChannel();
  if (!spaceId) return;

  const today = Utilities.formatDate(new Date(), 'America/Chicago', 'EEEE, MMMM d');

  let message = `📊 **EOD Summary - ${today}**\n\n`;
  message += `📝 Submitted: ${submitted.length}/${submitted.length + missing.length}\n`;

  if (missing.length > 0) {
    message += `❌ Missing: ${missing.length} (${missing.map(e => e.name || e.email.split('@')[0]).join(', ')})\n`;
  }

  // Add task completion stats
  if (taskStats) {
    message += `\n──────────────────────────────\n\n`;
    message += `📋 **Task Completion Today**\n\n`;
    message += `✅ Completed: ${taskStats.completed} tasks\n`;
    message += `➡️ Delayed to tomorrow: ${taskStats.delayed} tasks\n`;
    message += `🔴 Still overdue: ${taskStats.stillOverdue} tasks\n`;

    if (taskStats.delayReasons && Object.keys(taskStats.delayReasons).length > 0) {
      message += `\n**Delay Reasons:**\n`;
      Object.entries(taskStats.delayReasons).forEach(([reason, count]) => {
        message += `• ${formatDelayReason(reason)}: ${count}\n`;
      });
    }

    if (taskStats.newlyOverdue && taskStats.newlyOverdue.length > 0) {
      message += `\n**Newly Overdue Today:** ${taskStats.newlyOverdue.length} tasks\n`;
      taskStats.newlyOverdue.slice(0, 3).forEach(t => {
        message += `• ${t.userName}: ${t.taskName}\n`;
      });
    }
  }

  // Per-person completions (top performers)
  if (perPersonCompletions && perPersonCompletions.length > 0) {
    message += `\n──────────────────────────────\n\n`;
    message += `🏆 **Top Completions**\n\n`;
    perPersonCompletions.slice(0, 5).forEach(function (p) {
      var delayed = p.delayed > 0 ? ` (${p.delayed} delayed)` : '';
      message += `• ${p.name}: ${p.completed} completed${delayed}\n`;
    });
  }

  // Blockers section
  if (todayBlockers && todayBlockers.length > 0) {
    message += `\n──────────────────────────────\n\n`;
    message += `🚧 **Blockers Reported**\n\n`;
    todayBlockers.forEach(function (b) {
      message += `• **${b.name}**: ${b.blocker}\n`;
    });
  }

  // Not tracked section
  if (notTracked && notTracked.length > 0) {
    message += `\n📌 Not tracked: ${notTracked.map(function(m) { return m.name || m.email.split('@')[0]; }).join(', ')}\n`;
  }

  sendChannelMessage(spaceId, message);
}

/**
 * Post Monday kickoff message
 */
function postMondayKickoff(weekStats, lastWeekWins, activeStreaks) {
  const spaceId = getTeamUpdatesChannel();
  if (!spaceId) return;

  const weekStart = Utilities.formatDate(new Date(), 'America/Chicago', 'MMMM d');

  let message = `🗓️ **Week of ${weekStart}**\n\n`;
  message += `Good morning team! Here's a preview of what's due this week.\n\n`;

  // Last Week's Wins section
  if (lastWeekWins) {
    message += `──────────────────────────────\n\n`;
    message += `🏆 **Last Week's Wins**\n\n`;

    if (lastWeekWins.topCompleter && lastWeekWins.topCompleter.count > 0) {
      message += `🥇 Top Performer: **${lastWeekWins.topCompleter.name}** (${lastWeekWins.topCompleter.count} tasks completed)\n`;
    }
    if (lastWeekWins.totalCompleted > 0) {
      message += `📋 Team Total: ${lastWeekWins.totalCompleted} tasks completed\n`;
    }
    if (lastWeekWins.teamCheckinRate > 0) {
      message += `✅ Team Check-in Rate: ${lastWeekWins.teamCheckinRate}%\n`;
    }
    message += `\n`;
  }

  // Streaks on the Line section
  if (activeStreaks && activeStreaks.length > 0) {
    message += `──────────────────────────────\n\n`;
    message += `🔥 **Streaks on the Line**\n\n`;
    activeStreaks.slice(0, 5).forEach(function (s) {
      message += `• ${s.name}: ${s.streak}-day streak — keep it going!\n`;
    });
    message += `\n`;
  }

  // Weekly task load
  if (weekStats) {
    message += `──────────────────────────────\n\n`;
    message += `📊 **Team Task Load:**\n`;
    message += `• Monday: ${weekStats.monday || 0} tasks due\n`;
    message += `• Tuesday: ${weekStats.tuesday || 0} tasks due\n`;
    message += `• Wednesday: ${weekStats.wednesday || 0} tasks due\n`;
    message += `• Thursday: ${weekStats.thursday || 0} tasks due\n`;
    message += `• Friday: ${weekStats.friday || 0} tasks due\n\n`;

    if (weekStats.overdue > 0) {
      message += `⚠️ **Overdue from last week:** ${weekStats.overdue} tasks\n\n`;
    }
  }

  message += `Individual task lists are in your DMs. Let's have a great week! 💪`;

  sendChannelMessage(spaceId, message);
}

/**
 * Format delay reason for display
 */
function formatDelayReason(reason) {
  const labels = {
    'WAITING_INPUT': 'Waiting on input',
    'NO_TIME': 'No time today',
    'SCOPE_CHANGED': 'Scope changed',
    'OTHER': 'Other'
  };
  return labels[reason] || reason;
}

/**
 * Build a basic card
 */
function buildCard(cardId, header, sections) {
  return {
    cardId: cardId,
    card: {
      header: header,
      sections: sections
    }
  };
}

/**
 * Build header for card
 */
function buildCardHeader(title, subtitle = null, imageUrl = null) {
  const header = { title: title };
  if (subtitle) header.subtitle = subtitle;
  if (imageUrl) header.imageUrl = imageUrl;
  return header;
}

/**
 * Build text widget
 */
function buildTextWidget(text) {
  return {
    textParagraph: { text: text }
  };
}

/**
 * Build decorated text widget
 */
function buildDecoratedText(text, icon = null, topLabel = null) {
  const widget = {
    decoratedText: { text: text }
  };
  if (icon) widget.decoratedText.startIcon = { knownIcon: icon };
  if (topLabel) widget.decoratedText.topLabel = topLabel;
  return widget;
}

/**
 * Build button list widget
 */
function buildButtonList(buttons) {
  return {
    buttonList: { buttons: buttons }
  };
}

/**
 * Build a single button
 */
function buildButton(text, actionFunction, parameters = {}) {
  return {
    text: text,
    onClick: {
      action: {
        function: actionFunction,
        parameters: Object.entries(parameters).map(([key, value]) => ({
          key: key,
          value: String(value)
        }))
      }
    }
  };
}
