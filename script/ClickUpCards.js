/**
 * ClickUpCards.gs - Task Card Builders & Action Handlers
 * Builds Google Chat cards for ClickUp tasks and handles button actions
 */

/**
 * Build a task card for EOD with action buttons
 */
function buildTaskCard(task, index) {
  const overdueText = task.isOverdue
    ? `⚠️ OVERDUE (${task.daysOverdue} days)`
    : `Due: ${task.dueDateStr || 'Today'}`;

  const severityIcon = task.daysOverdue >= 3 ? '🔴' : (task.daysOverdue >= 1 ? '🟠' : '📋');

  return {
    cardId: `task_${task.id}_${index}`,
    card: {
      header: {
        title: `${severityIcon} ${task.name}`,
        subtitle: `📁 ${task.listName}`
      },
      sections: [
        {
          widgets: [
            {
              decoratedText: {
                text: overdueText,
                startIcon: { knownIcon: 'CLOCK' }
              }
            },
            {
              buttonList: {
                buttons: [
                  {
                    text: '✅ Done',
                    onClick: {
                      action: {
                        function: 'handleTaskAction',
                        parameters: [
                          { key: 'taskId', value: task.id },
                          { key: 'listId', value: task.listId },
                          { key: 'taskName', value: task.name },
                          { key: 'action', value: 'COMPLETE' },
                          { key: 'source', value: task.source || 'clickup' }
                        ]
                      }
                    }
                  },
                  {
                    text: '🔄 In Progress',
                    onClick: {
                      action: {
                        function: 'handleTaskAction',
                        parameters: [
                          { key: 'taskId', value: task.id },
                          { key: 'listId', value: task.listId },
                          { key: 'taskName', value: task.name },
                          { key: 'action', value: 'IN_PROGRESS' },
                          { key: 'source', value: task.source || 'clickup' }
                        ]
                      }
                    }
                  },
                  {
                    text: '➡️ Tomorrow',
                    onClick: {
                      action: {
                        function: 'handleDelayAction',
                        parameters: [
                          { key: 'taskId', value: task.id },
                          { key: 'listId', value: task.listId },
                          { key: 'taskName', value: task.name },
                          { key: 'source', value: task.source || 'clickup' }
                        ]
                      }
                    }
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  };
}

/**
 * Build delay reason selection card
 */
function buildDelayReasonCard(taskId, listId, taskName, source) {
  var taskSource = source || 'clickup';
  return {
    cardId: `delay_reason_${taskId}`,
    card: {
      header: {
        title: '➡️ Moving to Tomorrow',
        subtitle: taskName
      },
      sections: [
        {
          widgets: [
            {
              textParagraph: {
                text: 'Quick note - why is this moving?'
              }
            },
            {
              buttonList: {
                buttons: [
                  {
                    text: '📦 Waiting on input',
                    onClick: {
                      action: {
                        function: 'handleDelayReasonSelected',
                        parameters: [
                          { key: 'taskId', value: taskId },
                          { key: 'listId', value: listId },
                          { key: 'taskName', value: taskName },
                          { key: 'reason', value: 'WAITING_INPUT' },
                          { key: 'source', value: taskSource }
                        ]
                      }
                    }
                  },
                  {
                    text: '⏰ No time today',
                    onClick: {
                      action: {
                        function: 'handleDelayReasonSelected',
                        parameters: [
                          { key: 'taskId', value: taskId },
                          { key: 'listId', value: listId },
                          { key: 'taskName', value: taskName },
                          { key: 'reason', value: 'NO_TIME' },
                          { key: 'source', value: taskSource }
                        ]
                      }
                    }
                  },
                  {
                    text: '🔄 Scope changed',
                    onClick: {
                      action: {
                        function: 'handleDelayReasonSelected',
                        parameters: [
                          { key: 'taskId', value: taskId },
                          { key: 'listId', value: listId },
                          { key: 'taskName', value: taskName },
                          { key: 'reason', value: 'SCOPE_CHANGED' },
                          { key: 'source', value: taskSource }
                        ]
                      }
                    }
                  },
                  {
                    text: '❓ Other',
                    onClick: {
                      action: {
                        function: 'handleDelayReasonSelected',
                        parameters: [
                          { key: 'taskId', value: taskId },
                          { key: 'listId', value: listId },
                          { key: 'taskName', value: taskName },
                          { key: 'reason', value: 'OTHER' },
                          { key: 'source', value: taskSource }
                        ]
                      }
                    }
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  };
}

/**
 * Build morning task list message (text, no action buttons)
 */
function buildMorningTaskMessage(tasks, userName) {
  const todayTasks = tasks.filter(t => !t.isOverdue);
  const overdueTasks = tasks.filter(t => t.isOverdue);

  let message = `Good morning${userName ? ', ' + userName : ''}! 👋\n\n`;

  if (todayTasks.length > 0) {
    message += `📋 **Tasks due today:** ${todayTasks.length}\n`;
    todayTasks.forEach((task, i) => {
      message += `${i + 1}. ${task.name}\n   📁 ${task.listName}\n`;
    });
    message += '\n';
  }

  if (overdueTasks.length > 0) {
    message += `⚠️ **OVERDUE (Action Required):** ${overdueTasks.length}\n`;
    overdueTasks.forEach((task, i) => {
      const severity = task.daysOverdue >= 3 ? '🔴' : '🟠';
      message += `${severity} ${task.name}\n`;
      message += `   📁 ${task.listName} • Was due: ${task.dueDateStr} (${task.daysOverdue} days ago)\n`;
    });
    message += '\nThese need immediate attention. Please prioritize or update status.\n\n';
  }

  if (tasks.length === 0) {
    message += `✅ No tasks due today in ClickUp.\n\n`;
  }

  message += `Reply "here" to confirm you're online, or share your #1 priority.`;

  return message;
}

/**
 * Build EOD task message with cards
 */
function buildEodTaskMessage(tasks) {
  var eodFormatGuide = '\n📝 **After updating your task cards above, reply with:**\n' +
    '―――――――――――――――――――\n' +
    '*Hours:* [Total, e.g. 7h 30m]\n' +
    '*Meetings:* [count] | [total time] | [names + durations]\n' +
    '  _(or "0 meetings" if none)_\n' +
    '*Tomorrow:* [Task 1 + CU link] | [Task 2 + CU link]\n' +
    '*Blockers/Issues:* [what > owner > deadline] _(if any)_\n' +
    '―――――――――――――――――――\n' +
    '⚠️ You must update your task cards (✅ Done / 🔄 In Progress / ➡️ Tomorrow) before submitting.\n' +
    'If you didn\'t complete any tasks today, explain why in your reply.';

  if (!tasks || tasks.length === 0) {
    return {
      text: 'Time for your EOD report! 📝\n\n' +
        '🚨 **No ClickUp tasks were due today.** If you worked on tasks not in ClickUp, please describe them.\n\n' +
        '📝 **Reply with:**\n' +
        '―――――――――――――――――――\n' +
        '*Hours:* [Total, e.g. 7h 30m]\n' +
        '*Meetings:* [count] | [total time] | [names + durations]\n' +
        '  _(or "0 meetings" if none)_\n' +
        '*Tomorrow:* [Task 1 + CU link] | [Task 2 + CU link]\n' +
        '*Blockers/Issues:* [what > owner > deadline] _(if any)_\n' +
        '―――――――――――――――――――',
      cardsV2: null
    };
  }

  const cards = tasks.slice(0, 10).map((task, i) => buildTaskCard(task, i)); // Limit to 10 cards

  let text = `Time for your EOD report! 📝\n\n📋 **Tasks due today:** ${tasks.length}\nUpdate each task card below, then reply with your EOD summary.`;

  if (tasks.length > 10) {
    text += `\n\n(Showing first 10 of ${tasks.length} tasks)`;
  }

  return {
    text: text,
    cardsV2: cards,
    followUpText: eodFormatGuide
  };
}

/**
 * Build weekly task preview for Monday
 */
function buildWeeklyTaskPreview(tasks, userName) {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const today = new Date();
  const tasksByDay = {};
  const overdue = [];

  // Initialize days
  days.forEach(day => tasksByDay[day] = []);

  // Sort tasks by day
  tasks.forEach(task => {
    if (task.isOverdue) {
      overdue.push(task);
    } else if (task.dueDate) {
      const dayIndex = task.dueDate.getDay() - 1; // Monday = 0
      if (dayIndex >= 0 && dayIndex < 5) {
        tasksByDay[days[dayIndex]].push(task);
      }
    }
  });

  let message = `Good morning${userName ? ', ' + userName : ''}! 👋\n\n`;
  message += `🗓️ **Your tasks this week:**\n\n`;

  days.forEach((day, index) => {
    const dayTasks = tasksByDay[day];
    const isToday = index === (today.getDay() - 1);

    message += `**${day}${isToday ? ' (Today)' : ''}:**\n`;
    if (dayTasks.length === 0) {
      message += `• (none)\n`;
    } else {
      dayTasks.forEach(task => {
        message += `• ${task.name}\n`;
      });
    }
    message += '\n';
  });

  if (overdue.length > 0) {
    message += `⚠️ **Overdue from last week:**\n`;
    overdue.forEach(task => {
      const severity = task.daysOverdue >= 3 ? '🔴' : '🟠';
      message += `${severity} ${task.name} (${task.daysOverdue} days overdue)\n`;
    });
    message += '\n';
  }

  message += `Reply "here" to confirm you're online!`;

  return message;
}

/**
 * Safely extract parameters from card action event (BUG #8 fix)
 * Handles both array format and object format from Google Chat
 */
function _extractCardParams(event) {
  var params = {};

  // Try common.parameters (array format)
  var commonParams = event.commonEventObject && event.commonEventObject.parameters;
  if (commonParams) {
    if (Array.isArray(commonParams)) {
      commonParams.forEach(function (p) { params[p.key] = p.value; });
    } else if (typeof commonParams === 'object') {
      // Object format: { key1: value1, key2: value2 }
      params = commonParams;
    }
  }

  // Try action.parameters (array format)
  var actionParams = event.action && event.action.parameters;
  if (actionParams && Object.keys(params).length === 0) {
    if (Array.isArray(actionParams)) {
      actionParams.forEach(function (p) { params[p.key] = p.value; });
    } else if (typeof actionParams === 'object') {
      params = actionParams;
    }
  }

  return params;
}

/**
 * Handle task action button click
 */
function handleTaskAction(event) {
  var params = _extractCardParams(event);

  console.log('handleTaskAction event = ', JSON.stringify(event));
  console.log('handleTaskAction params = ', JSON.stringify(params));
  const taskId = params.taskId;
  const listId = params.listId;
  const taskName = params.taskName;
  const action = params.action;
  const source = params.source || 'clickup';
  const userEmail = event.chat.user.email;
  const userName = event.chat.user.displayName;

  // Route Odoo tasks to Odoo handler
  if (source === 'odoo') {
    return createChatResponse(handleOdooTaskAction(taskId, taskName, action, listId, event));
  }

  let result;
  let responseText;
  let newStatus = null;

  // Get current task state for logging (ClickUp)
  const task = getTaskById(taskId);
  const oldStatus = task ? task.status?.status : null;
  const oldDueDate = task && task.due_date ? new Date(parseInt(task.due_date)) : null;

  switch (action) {
    case 'COMPLETE':
      // Show hours input card instead of immediately completing
      var hoursCard = buildCompleteWithHoursCard(taskId, listId, taskName);
      return createChatResponse({
        actionResponse: { type: 'UPDATE_MESSAGE' },
        cardsV2: [hoursCard]
      });

    case 'IN_PROGRESS':
      result = setTaskInProgress(taskId, listId, userName);
      newStatus = getInProgressStatus(listId);
      responseText = result
        ? `🔄 Updated to In Progress: "${taskName}"`
        : `❌ Error updating task. Please try again.`;
      break;

    default:
      responseText = `❌ Unknown action`;
      result = false;
  }

  // Log to BigQuery
  logTaskAction(
    userEmail,
    taskId,
    taskName,
    listId,
    task?.list?.name || '',
    action,
    oldStatus,
    newStatus,
    oldDueDate ? Utilities.formatDate(oldDueDate, 'America/Chicago', 'yyyy-MM-dd') : null,
    null,
    result ? 'SUCCESS' : 'FAILED',
    'clickup'
  );

  return createChatResponse({
    actionResponse: {
      type: 'UPDATE_MESSAGE'
    },
    text: responseText
  });
}

/**
 * Handle delay button click - show reason selection
 */
function handleDelayAction(event) {
  var params = _extractCardParams(event);

  const card = buildDelayReasonCard(params.taskId, params.listId, params.taskName, params.source || 'clickup');

  return createChatResponse({
    actionResponse: {
      type: 'UPDATE_MESSAGE'
    },
    cardsV2: [card]
  });
}

/**
 * Handle delay reason selection
 */
function handleDelayReasonSelected(event) {
  var params = _extractCardParams(event);

  console.log('handleDelayReasonSelected event = ', JSON.stringify(event));
  console.log('handleDelayReasonSelected params = ', JSON.stringify(params));
  const taskId = params.taskId;
  const listId = params.listId;
  const taskName = params.taskName;
  const reason = params.reason;
  const source = params.source || 'clickup';
  const userEmail = event.chat.user.email;
  const userName = event.chat.user.displayName;

  // Handle Odoo task delay
  if (source === 'odoo') {
    var tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    var tomorrowStr = Utilities.formatDate(tomorrow, 'America/Chicago', 'yyyy-MM-dd');
    var numericId = parseInt(taskId, 10);
    updateTaskDeadline(numericId, tomorrowStr);

    var delayCount = getTaskDelayCount(taskId) + 1;
    logTaskDelay(userEmail, taskId, taskName, null, tomorrowStr, reason, delayCount, 'odoo');
    logTaskAction(userEmail, taskId, taskName, listId, '', 'TOMORROW', null, null, null, tomorrowStr, 'SUCCESS', 'odoo');

    if (delayCount >= 3) {
      sendRepeatDelayAlert(userEmail, taskId, taskName, delayCount);
    }

    var reasonText = formatDelayReason(reason);
    return createChatResponse({
      actionResponse: { type: 'UPDATE_MESSAGE' },
      text: '➡️ Moved to tomorrow: "' + taskName + '"\n📝 Reason: ' + reasonText
    });
  }

  // ClickUp task delay
  const task = getTaskById(taskId);
  const oldDueDate = task && task.due_date ? new Date(parseInt(task.due_date)) : null;

  // Move task to tomorrow
  var delayReasonText = formatDelayReason(reason);
  const result = moveTaskToTomorrow(taskId, userName, delayReasonText);

  if (result) {
    // Get delay count
    const delayCount = getTaskDelayCount(taskId) + 1;

    // Calculate new due date
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Log delay
    logTaskDelay(
      userEmail,
      taskId,
      taskName,
      oldDueDate ? Utilities.formatDate(oldDueDate, 'America/Chicago', 'yyyy-MM-dd') : null,
      Utilities.formatDate(tomorrow, 'America/Chicago', 'yyyy-MM-dd'),
      reason,
      delayCount,
      'clickup'
    );

    // Log task action
    logTaskAction(
      userEmail,
      taskId,
      taskName,
      listId,
      task?.list?.name || '',
      'TOMORROW',
      null,
      null,
      oldDueDate ? Utilities.formatDate(oldDueDate, 'America/Chicago', 'yyyy-MM-dd') : null,
      Utilities.formatDate(tomorrow, 'America/Chicago', 'yyyy-MM-dd'),
      'SUCCESS',
      'clickup'
    );

    // Check for repeat delay alert
    if (delayCount >= 3) {
      sendRepeatDelayAlert(userEmail, taskId, taskName, delayCount);
    }

    return createChatResponse({
      actionResponse: {
        type: 'UPDATE_MESSAGE'
      },
      text: `➡️ Moved to tomorrow: "${taskName}"\n📝 Reason: ${delayReasonText}`
    });
  } else {
    return createChatResponse({
      actionResponse: {
        type: 'UPDATE_MESSAGE'
      },
      text: `❌ Error moving task. Please try again.`
    });
  }
}

/**
 * Send alert for repeat delayed task
 */
function sendRepeatDelayAlert(userEmail, taskId, taskName, delayCount) {
  const config = getConfig();
  const recipients = getReportRecipients('escalation');

  const task = getTaskById(taskId);
  const taskUrl = task ? task.url : '';

  const message = `⚠️ **Repeated Delay Alert**\n\n` +
    `Task: "${taskName}"\n` +
    `Assigned to: ${userEmail}\n\n` +
    `This task has been moved to "tomorrow" **${delayCount} times**.\n\n` +
    `Pattern suggests this task may need reassignment or the assignee needs support.\n\n` +
    (taskUrl ? `[View in ClickUp](${taskUrl})` : '');

  // Send to escalation recipients
  recipients.forEach(recipient => {
    if (recipient !== userEmail) { // Don't alert the user themselves
      sendDirectMessage(recipient, message);
    }
  });

  // Also notify the user
  sendDirectMessage(userEmail,
    `⚠️ **Heads up:** You've moved "${taskName}" ${delayCount} times.\n\n` +
    `If you're blocked or need help, please reach out to your manager.`
  );
}

/**
 * Handle task actions for Odoo-sourced tasks
 * Routes COMPLETE, IN_PROGRESS, and TOMORROW to Odoo APIs
 */
function handleOdooTaskAction(taskId, taskName, actionType, listId, event) {
  var numericId = parseInt(taskId, 10);
  var userEmail = event.user.email;

  if (actionType === 'COMPLETE') {
    // Find the "Done" stage for this task's project
    try {
      var stages = getTaskStages();
      var doneStage = stages.find(function (s) { return s.fold === true; })
        || stages.find(function (s) { return s.name.toLowerCase().includes('done'); });

      if (doneStage) {
        updateTaskStage(numericId, doneStage.id);
      }
    } catch (err) {
      console.error('Odoo stage update error:', err.message);
    }

    logTaskAction(userEmail, taskId, taskName, listId, '', 'COMPLETE', null, null, null, null, 'SUCCESS', 'odoo');

    return {
      actionResponse: { type: 'UPDATE_MESSAGE' },
      text: '✅ Marked complete: "' + taskName + '"'
    };

  } else if (actionType === 'IN_PROGRESS') {
    try {
      var stages = getTaskStages();
      var ipStage = stages.find(function (s) { return s.name.toLowerCase().includes('progress'); });
      if (ipStage) {
        updateTaskStage(numericId, ipStage.id);
      }
    } catch (err) {
      console.error('Odoo stage update error:', err.message);
    }

    logTaskAction(userEmail, taskId, taskName, listId, '', 'IN_PROGRESS', null, null, null, null, 'SUCCESS', 'odoo');

    return {
      actionResponse: { type: 'UPDATE_MESSAGE' },
      text: '🔄 Updated to In Progress: "' + taskName + '"'
    };

  } else {
    return {
      actionResponse: { type: 'UPDATE_MESSAGE' },
      text: '❌ Unknown action for Odoo task'
    };
  }
}

/**
 * Safely extract form input value from Add-on card event.
 */
function _extractFormInput(event, fieldName) {
  try {
    var formInputs = null;
    if (event.common && event.common.formInputs) {
      formInputs = event.common.formInputs;
    } else if (event.commonEventObject && event.commonEventObject.formInputs) {
      formInputs = event.commonEventObject.formInputs;
    }
    if (!formInputs || !formInputs[fieldName]) return '';

    var input = formInputs[fieldName];
    if (input.stringInputs && input.stringInputs.value) {
      return (input.stringInputs.value[0] || '').trim();
    }
    if (input[''] && input[''].stringInputs && input[''].stringInputs.value) {
      return (input[''].stringInputs.value[0] || '').trim();
    }
  } catch (e) {
    console.error('Error extracting form input "' + fieldName + '":', e.message);
  }
  return '';
}

/**
 * Build card asking for hours spent on a completed task
 */
function buildCompleteWithHoursCard(taskId, listId, taskName) {
  return {
    cardId: 'complete_hours_' + taskId,
    card: {
      header: {
        title: '✅ Complete Task',
        subtitle: taskName
      },
      sections: [
        {
          widgets: [
            {
              textParagraph: {
                text: '<b>Fill in your task details:</b>'
              }
            },
            {
              textInput: {
                label: 'Hours spent',
                type: 'SINGLE_LINE',
                name: 'hoursSpent',
                hintText: 'e.g. 2.5'
              }
            },
            {
              textInput: {
                label: 'Outcome — what was accomplished?',
                type: 'MULTIPLE_LINE',
                name: 'taskOutcome',
                hintText: 'e.g. Resolved null pointer on payment form, deployed to staging'
              }
            },
            {
              textInput: {
                label: 'Deliverable link (optional)',
                type: 'SINGLE_LINE',
                name: 'deliverableLink',
                hintText: 'e.g. Drive/Figma/Sheet link (leave blank if N/A)'
              }
            },
            {
              buttonList: {
                buttons: [
                  {
                    text: '✅ Complete',
                    onClick: {
                      action: {
                        function: 'handleCompleteWithHours',
                        parameters: [
                          { key: 'taskId', value: taskId },
                          { key: 'listId', value: listId },
                          { key: 'taskName', value: taskName }
                        ]
                      }
                    }
                  },
                  {
                    text: '⏭️ Skip details',
                    onClick: {
                      action: {
                        function: 'handleCompleteWithHours',
                        parameters: [
                          { key: 'taskId', value: taskId },
                          { key: 'listId', value: listId },
                          { key: 'taskName', value: taskName },
                          { key: 'skipHours', value: 'true' }
                        ]
                      }
                    }
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  };
}

/**
 * Handle task completion with hours logging
 */
function handleCompleteWithHours(event) {
  var params = _extractCardParams(event);
  var taskId = params.taskId;
  var listId = params.listId;
  var taskName = params.taskName;
  var skipHours = params.skipHours === 'true';
  var userEmail = event.chat.user.email;
  var userName = event.chat.user.displayName;

  var hoursStr = _extractFormInput(event, 'hoursSpent');
  var hours = hoursStr ? parseFloat(hoursStr) : NaN;
  var outcome = _extractFormInput(event, 'taskOutcome') || '';
  var deliverableLink = _extractFormInput(event, 'deliverableLink') || '';

  var task = getTaskById(taskId);
  var oldStatus = task ? (task.status && task.status.status ? task.status.status : null) : null;
  var oldDueDate = task && task.due_date ? new Date(parseInt(task.due_date)) : null;

  var result = markTaskComplete(taskId, listId, userName);
  var newStatus = getClosedStatus(listId);

  var responseText;
  if (result) {
    responseText = '✅ Marked complete: "' + taskName + '"';
    if (!skipHours && !isNaN(hours) && hours > 0 && hours <= 24) {
      var durationMs = Math.round(hours * 3600000);
      var timeResult = addTimeEntry(taskId, durationMs, userName);
      if (timeResult) {
        responseText += '\n⏱️ Logged ' + hours + ' hours';
      } else {
        responseText += '\n⚠️ Task completed but time entry failed';
      }
    } else if (!skipHours && hoursStr) {
      responseText += '\n⚠️ Invalid hours value, skipped time logging';
    }
    if (outcome) {
      responseText += '\n📝 Outcome: ' + outcome;
    }
    if (deliverableLink) {
      responseText += '\n🔗 Deliverable: ' + deliverableLink;
    }
  } else {
    responseText = '❌ Error updating task. Please try again.';
  }

  logTaskAction(userEmail, taskId, taskName, listId,
    task && task.list ? task.list.name : '', 'COMPLETE',
    oldStatus, newStatus,
    oldDueDate ? Utilities.formatDate(oldDueDate, 'America/Chicago', 'yyyy-MM-dd') : null,
    null, result ? 'SUCCESS' : 'FAILED', 'clickup',
    outcome, deliverableLink);

  return createChatResponse({
    actionResponse: { type: 'UPDATE_MESSAGE' },
    text: responseText
  });
}

// formatDelayReason is defined in Chat.js (BUG #13 fix - removed duplicate)
