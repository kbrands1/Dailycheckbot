/**
 * EodCards.js - Structured EOD Card Flow
 * Multi-step card system for daily end-of-day reports per SOP spec.
 *
 * Flow: Header -> Task Cards -> Meetings -> Unplanned (optional) -> Tomorrow -> Validate & Submit
 * State tracked via CacheService keyed by email (6h TTL).
 *
 * Card builders: buildEodHeaderCard, buildEodTaskCard, buildEodMeetingsCard,
 *   buildEodUnplannedCard, buildEodTomorrowCard, buildEodWarningCard, buildEodSuccessCard
 *
 * Handlers (registered in Code.js onCardClick):
 *   handleEodHeader, handleEodTask, handleEodMeetings,
 *   handleEodUnplanned, handleEodTomorrow
 */

// ============================================
// STATE MANAGEMENT
// ============================================

var EOD_CACHE_TTL = 21600; // 6 hours in seconds

/**
 * Get structured EOD state from cache
 * @param {string} email
 * @returns {object|null} state object or null if expired/missing
 */
function _getEodState(email) {
  var cache = CacheService.getScriptCache();
  var key = 'EOD_STRUCT_' + email.replace(/[^a-zA-Z0-9]/g, '_');
  var raw = cache.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * Save structured EOD state to cache
 * @param {string} email
 * @param {object} state
 */
function _saveEodState(email, state) {
  var cache = CacheService.getScriptCache();
  var key = 'EOD_STRUCT_' + email.replace(/[^a-zA-Z0-9]/g, '_');
  cache.put(key, JSON.stringify(state), EOD_CACHE_TTL);
}

/**
 * Clear structured EOD state from cache
 * @param {string} email
 */
function _clearEodState(email) {
  var cache = CacheService.getScriptCache();
  var key = 'EOD_STRUCT_' + email.replace(/[^a-zA-Z0-9]/g, '_');
  cache.remove(key);
}

// ============================================
// FORM INPUT HELPERS
// ============================================

/**
 * Safely extract a text or dropdown value from card form inputs
 */
function _getEodFormValue(event, fieldName) {
  try {
    var formInputs = event.common && event.common.formInputs;
    if (formInputs && formInputs[fieldName]) {
      return (formInputs[fieldName][''].stringInputs.value[0] || '').trim();
    }
  } catch (e) {
    // Field not present or unexpected format
  }
  return '';
}

/**
 * Safely extract a checkbox value from card form inputs
 */
function _getEodCheckboxValue(event, fieldName) {
  try {
    var formInputs = event.common && event.common.formInputs;
    if (formInputs && formInputs[fieldName]) {
      var val = formInputs[fieldName][''].stringInputs.value;
      return val && val[0] === 'true';
    }
  } catch (e) {}
  return false;
}

// ============================================
// CARD BUILDERS
// ============================================

/**
 * Build the EOD header card (Step 1)
 * @param {string} userName - display name
 * @param {string} dateStr - formatted date string
 * @param {number} taskCount - number of ClickUp tasks found
 */
function buildEodHeaderCard(userName, dateStr, taskCount) {
  var subtitle = dateStr || Utilities.formatDate(new Date(), 'America/Chicago', 'MMM dd, yyyy');
  var taskNote = taskCount > 0
    ? 'I found <b>' + taskCount + ' ClickUp task' + (taskCount > 1 ? 's' : '') + '</b> for today. We\'ll go through them one by one.'
    : 'No ClickUp tasks found for today. You can add tasks manually.';

  return {
    cardId: 'eod_header',
    card: {
      header: {
        title: 'End-of-Day Report',
        subtitle: subtitle
      },
      sections: [
        {
          widgets: [
            {
              textParagraph: {
                text: 'Hi ' + (userName || 'there') + '! Time to submit your daily summary.\n\n' + taskNote
              }
            },
            {
              textInput: {
                name: 'totalHours',
                label: 'Total hours worked today',
                type: 'SINGLE_LINE',
                hintText: 'e.g. 8.5'
              }
            },
            {
              buttonList: {
                buttons: [
                  {
                    text: 'Start Tasks \u2192',
                    onClick: {
                      action: {
                        function: 'handleEodHeader',
                        parameters: []
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
 * Build a task card (Step 2, repeated per task)
 * @param {number} taskIndex - 0-based index of the current task
 * @param {number} totalClickUpTasks - total ClickUp tasks available for pre-fill
 * @param {object|null} clickUpTask - ClickUp task data for pre-fill, or null for manual entry
 */
function buildEodTaskCard(taskIndex, totalClickUpTasks, clickUpTask) {
  var taskNum = taskIndex + 1;
  var isUntracked = !clickUpTask;
  var title = isUntracked
    ? 'Task #' + taskNum + ' (Manual Entry)'
    : 'Task ' + taskNum + ' of ' + Math.max(totalClickUpTasks, taskNum);
  var subtitle = clickUpTask ? clickUpTask.name : 'Enter task details below';

  // Pre-fill values from ClickUp
  var prefillName = clickUpTask ? clickUpTask.name : '';
  var prefillLink = clickUpTask ? (clickUpTask.url || '') : '';
  var prefillStatus = clickUpTask ? _mapClickUpStatus(clickUpTask.status) : 'in_progress';

  // Determine carry-over default for overdue tasks
  var carryOverDefault = 'new';
  if (clickUpTask && clickUpTask.isOverdue && clickUpTask.daysOverdue >= 1) {
    var day = Math.min(clickUpTask.daysOverdue + 1, 5);
    carryOverDefault = 'carry_' + day;
  }

  // --- Section 1: Main task fields ---
  var mainWidgets = [];

  mainWidgets.push({
    textInput: {
      name: 'taskName',
      label: 'Task Name',
      type: 'SINGLE_LINE',
      value: prefillName
    }
  });

  mainWidgets.push({
    textInput: {
      name: 'taskHours',
      label: 'Hours spent on this task',
      type: 'SINGLE_LINE',
      hintText: 'e.g. 2.5'
    }
  });

  mainWidgets.push({
    selectionInput: {
      name: 'carryOver',
      label: 'Carry-over',
      type: 'DROPDOWN',
      items: [
        { text: 'New', value: 'new', selected: carryOverDefault === 'new' },
        { text: 'Carry-over Day 2', value: 'carry_2', selected: carryOverDefault === 'carry_2' },
        { text: 'Carry-over Day 3', value: 'carry_3', selected: carryOverDefault === 'carry_3' },
        { text: 'Carry-over Day 4', value: 'carry_4', selected: carryOverDefault === 'carry_4' },
        { text: 'Carry-over Day 5+', value: 'carry_5', selected: carryOverDefault === 'carry_5' }
      ]
    }
  });

  mainWidgets.push({
    textInput: {
      name: 'clickUpLink',
      label: 'ClickUp Link',
      type: 'SINGLE_LINE',
      value: prefillLink,
      hintText: 'https://app.clickup.com/t/...'
    }
  });

  // "No ClickUp task" checkbox — only shown if no pre-filled link
  if (!prefillLink) {
    mainWidgets.push({
      selectionInput: {
        name: 'noClickUpTask',
        label: '',
        type: 'CHECK_BOX',
        items: [
          { text: 'No ClickUp task \u2014 needs creation', value: 'true', selected: false }
        ]
      }
    });
  }

  mainWidgets.push({
    selectionInput: {
      name: 'taskStatus',
      label: 'Status',
      type: 'DROPDOWN',
      items: [
        { text: 'Completed', value: 'completed', selected: prefillStatus === 'completed' },
        { text: 'In Review', value: 'in_review', selected: prefillStatus === 'in_review' },
        { text: 'In Progress', value: 'in_progress', selected: prefillStatus === 'in_progress' }
      ]
    }
  });

  mainWidgets.push({
    textInput: {
      name: 'outcome',
      label: 'What was accomplished? (Be specific)',
      type: 'MULTIPLE_LINE',
      hintText: 'Include quantities, deliverables, or measurable outcomes'
    }
  });

  // --- Section 2: Conditional fields ---
  var conditionalWidgets = [
    {
      textParagraph: {
        text: '<b>Conditional Fields</b> (fill what applies)'
      }
    },
    {
      textInput: {
        name: 'progressPct',
        label: 'Progress % (required if In Progress)',
        type: 'SINGLE_LINE',
        hintText: '1-99'
      }
    },
    {
      textInput: {
        name: 'deliverableLink',
        label: 'Deliverable Link (required if Completed/In Review)',
        type: 'SINGLE_LINE',
        hintText: 'Drive, Figma, Google Sheet link...'
      }
    }
  ];

  // --- Section 3: Optional blocker/issue + navigation ---
  var optionalWidgets = [
    {
      textParagraph: {
        text: '<b>Optional: Blocker or Issue</b> (leave blank if none)'
      }
    },
    {
      textInput: {
        name: 'blockerWhat',
        label: 'Blocker \u2014 What?',
        type: 'SINGLE_LINE'
      }
    },
    {
      textInput: {
        name: 'blockerOwner',
        label: 'Blocker \u2014 Owner',
        type: 'SINGLE_LINE'
      }
    },
    {
      textInput: {
        name: 'blockerDeadline',
        label: 'Blocker \u2014 Deadline',
        type: 'SINGLE_LINE',
        hintText: 'Date or "escalation needed"'
      }
    },
    {
      textInput: {
        name: 'issueWhat',
        label: 'Issue \u2014 What?',
        type: 'SINGLE_LINE'
      }
    },
    {
      textInput: {
        name: 'issueAction',
        label: 'Issue \u2014 Action Taken / Next Step',
        type: 'SINGLE_LINE'
      }
    }
  ];

  // Navigation buttons
  var buttons = [
    {
      text: 'Save & Next Task \u2192',
      onClick: {
        action: {
          function: 'handleEodTask',
          parameters: [
            { key: 'nextAction', value: 'nextTask' },
            { key: 'taskIndex', value: String(taskIndex) }
          ]
        }
      }
    },
    {
      text: 'Done \u2192 Meetings',
      onClick: {
        action: {
          function: 'handleEodTask',
          parameters: [
            { key: 'nextAction', value: 'doneTasks' },
            { key: 'taskIndex', value: String(taskIndex) }
          ]
        }
      }
    }
  ];

  optionalWidgets.push({ buttonList: { buttons: buttons } });

  return {
    cardId: 'eod_task_' + taskIndex,
    card: {
      header: {
        title: title,
        subtitle: subtitle
      },
      sections: [
        { header: 'Task Details', widgets: mainWidgets },
        { widgets: conditionalWidgets },
        { widgets: optionalWidgets }
      ]
    }
  };
}

/**
 * Build the meetings card (Step 3)
 */
function buildEodMeetingsCard() {
  return {
    cardId: 'eod_meetings',
    card: {
      header: {
        title: 'Meetings',
        subtitle: 'Meeting summary for today'
      },
      sections: [
        {
          widgets: [
            {
              textInput: {
                name: 'meetingCount',
                label: 'Number of meetings today',
                type: 'SINGLE_LINE',
                hintText: 'e.g. 3 (enter 0 if none)'
              }
            },
            {
              textInput: {
                name: 'meetingTotalTime',
                label: 'Total meeting time (hours)',
                type: 'SINGLE_LINE',
                hintText: 'e.g. 1.5'
              }
            },
            {
              textInput: {
                name: 'meetingList',
                label: 'Meeting details (name: duration each)',
                type: 'MULTIPLE_LINE',
                hintText: 'Standup: 0.25h, Sprint Planning: 1h, ...'
              }
            },
            {
              textInput: {
                name: 'highMeetingNote',
                label: 'Why > 2h of meetings? (leave blank if \u2264 2h)',
                type: 'MULTIPLE_LINE'
              }
            },
            {
              buttonList: {
                buttons: [
                  {
                    text: 'Add Unplanned Work',
                    onClick: {
                      action: {
                        function: 'handleEodMeetings',
                        parameters: [
                          { key: 'nextAction', value: 'unplanned' }
                        ]
                      }
                    }
                  },
                  {
                    text: 'Skip \u2192 Tomorrow\'s Priorities',
                    onClick: {
                      action: {
                        function: 'handleEodMeetings',
                        parameters: [
                          { key: 'nextAction', value: 'tomorrow' }
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
 * Build the unplanned work card (Step 4, optional)
 */
function buildEodUnplannedCard() {
  return {
    cardId: 'eod_unplanned',
    card: {
      header: {
        title: 'Unplanned Work',
        subtitle: 'Work that wasn\'t originally planned'
      },
      sections: [
        {
          widgets: [
            {
              textInput: {
                name: 'unplannedDesc',
                label: 'What was the unplanned work?',
                type: 'MULTIPLE_LINE'
              }
            },
            {
              textInput: {
                name: 'unplannedHours',
                label: 'Hours spent',
                type: 'SINGLE_LINE',
                hintText: 'e.g. 1.5'
              }
            },
            {
              textInput: {
                name: 'unplannedPulledFrom',
                label: 'What planned task did it pull you from?',
                type: 'SINGLE_LINE'
              }
            },
            {
              buttonList: {
                buttons: [
                  {
                    text: 'Next \u2192 Tomorrow\'s Priorities',
                    onClick: {
                      action: {
                        function: 'handleEodUnplanned',
                        parameters: []
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
 * Build the tomorrow priorities card (Step 5)
 */
function buildEodTomorrowCard() {
  return {
    cardId: 'eod_tomorrow',
    card: {
      header: {
        title: 'Tomorrow\'s Priorities',
        subtitle: 'Plan your top 1-3 tasks for tomorrow'
      },
      sections: [
        {
          widgets: [
            {
              textParagraph: {
                text: 'List 1\u20133 priority tasks for tomorrow with ClickUp links.'
              }
            },
            {
              textInput: {
                name: 'priority1Name',
                label: 'Priority 1 \u2014 Task name (required)',
                type: 'SINGLE_LINE'
              }
            },
            {
              textInput: {
                name: 'priority1Link',
                label: 'Priority 1 \u2014 ClickUp link',
                type: 'SINGLE_LINE',
                hintText: 'https://app.clickup.com/t/...'
              }
            },
            {
              textInput: {
                name: 'priority2Name',
                label: 'Priority 2 \u2014 Task name (optional)',
                type: 'SINGLE_LINE'
              }
            },
            {
              textInput: {
                name: 'priority2Link',
                label: 'Priority 2 \u2014 ClickUp link',
                type: 'SINGLE_LINE'
              }
            },
            {
              textInput: {
                name: 'priority3Name',
                label: 'Priority 3 \u2014 Task name (optional)',
                type: 'SINGLE_LINE'
              }
            },
            {
              textInput: {
                name: 'priority3Link',
                label: 'Priority 3 \u2014 ClickUp link',
                type: 'SINGLE_LINE'
              }
            },
            {
              buttonList: {
                buttons: [
                  {
                    text: 'Submit EOD Report',
                    onClick: {
                      action: {
                        function: 'handleEodTomorrow',
                        parameters: []
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
 * Build warning card for submission-level issues (non-blocking)
 * Shows warnings and lets user submit anyway or go back
 */
function buildEodWarningCard(warnings) {
  var warningText = '<b>Review before submitting:</b>\n\n';
  for (var i = 0; i < warnings.length; i++) {
    warningText += '\u26A0\uFE0F ' + warnings[i] + '\n';
  }
  warningText += '\nYou can submit anyway or type "test eod" to restart.';

  return {
    cardId: 'eod_warning',
    card: {
      header: {
        title: 'Review Warnings',
        subtitle: 'Some items need attention'
      },
      sections: [
        {
          widgets: [
            {
              textParagraph: {
                text: warningText
              }
            },
            {
              buttonList: {
                buttons: [
                  {
                    text: 'Submit Anyway',
                    onClick: {
                      action: {
                        function: 'handleEodTomorrow',
                        parameters: [
                          { key: 'confirmed', value: 'true' }
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
 * Build validation error card for hard errors (blocks submission)
 */
function buildEodValidationErrorCard(errors) {
  var errorText = '<b>Please fix the following:</b>\n\n';
  for (var i = 0; i < errors.length; i++) {
    errorText += '\u274C ' + errors[i] + '\n';
  }
  errorText += '\nType "test eod" to restart the structured EOD form.';

  return {
    cardId: 'eod_validation_error',
    card: {
      header: {
        title: 'Validation Error',
        subtitle: 'Cannot submit yet'
      },
      sections: [
        {
          widgets: [
            {
              textParagraph: {
                text: errorText
              }
            }
          ]
        }
      ]
    }
  };
}

/**
 * Build success confirmation card
 */
function buildEodSuccessCard(summaryPreview) {
  return {
    cardId: 'eod_success',
    card: {
      header: {
        title: 'EOD Report Submitted',
        subtitle: 'Your daily summary has been posted'
      },
      sections: [
        {
          widgets: [
            {
              textParagraph: {
                text: summaryPreview
              }
            }
          ]
        }
      ]
    }
  };
}

// ============================================
// HANDLERS
// ============================================

/**
 * Handle header card submission -> show first task card
 */
function handleEodHeader(event) {
  var email = event.chat.user.email;
  var userName = event.chat.user.displayName || email.split('@')[0];

  var totalHoursRaw = _getEodFormValue(event, 'totalHours');
  var totalHours = parseFloat(totalHoursRaw);

  if (!totalHoursRaw || isNaN(totalHours) || totalHours <= 0 || totalHours > 24) {
    // Re-show header card with error
    var taskCount = 0;
    var existing = _getEodState(email);
    if (existing && existing.clickUpTasks) taskCount = existing.clickUpTasks.length;
    return createChatResponse({
      actionResponse: { type: 'UPDATE_MESSAGE' },
      text: '\u26A0\uFE0F Please enter valid hours (between 0.5 and 24).',
      cardsV2: [buildEodHeaderCard(userName, null, taskCount)]
    });
  }

  // Get or create state
  var state = _getEodState(email) || {};
  state.step = 'task';
  state.totalHours = totalHours;
  state.userName = userName;
  state.email = email;
  state.dateStr = Utilities.formatDate(new Date(), 'America/Chicago', 'MMM dd, yyyy');
  state.tasks = state.tasks || [];
  state.currentTaskIndex = 0;

  // Fetch ClickUp tasks if not already cached in state
  if (!state.clickUpTasks) {
    try {
      var tasks = getTasksForUser(email, 'today') || [];
      // Store lightweight copies for cache (avoid exceeding 100KB limit)
      state.clickUpTasks = tasks.slice(0, 10).map(function(t) {
        return {
          id: t.id,
          name: t.name,
          url: t.url || '',
          status: t.status || '',
          listName: t.listName || '',
          isOverdue: t.isOverdue || false,
          daysOverdue: t.daysOverdue || 0
        };
      });
    } catch (e) {
      console.error('Failed to fetch ClickUp tasks for EOD card:', e.message);
      state.clickUpTasks = [];
    }
  }

  _saveEodState(email, state);

  // Show first task card
  var firstTask = state.clickUpTasks.length > 0 ? state.clickUpTasks[0] : null;
  var card = buildEodTaskCard(0, state.clickUpTasks.length, firstTask);

  return createChatResponse({
    actionResponse: { type: 'UPDATE_MESSAGE' },
    cardsV2: [card]
  });
}

/**
 * Handle task card submission -> save task, show next card
 */
function handleEodTask(event) {
  var params = _extractCardParams(event);
  var email = event.chat.user.email;
  var nextAction = params.nextAction || 'nextTask';
  var taskIndex = parseInt(params.taskIndex) || 0;

  var state = _getEodState(email);
  if (!state) {
    return createChatResponse({
      actionResponse: { type: 'UPDATE_MESSAGE' },
      text: '\u26A0\uFE0F Session expired. Type "test eod" to restart.'
    });
  }

  // Extract form values
  var taskData = {
    taskName: _getEodFormValue(event, 'taskName'),
    taskHours: _getEodFormValue(event, 'taskHours'),
    carryOver: _getEodFormValue(event, 'carryOver'),
    clickUpLink: _getEodFormValue(event, 'clickUpLink'),
    noClickUpTask: _getEodCheckboxValue(event, 'noClickUpTask'),
    taskStatus: _getEodFormValue(event, 'taskStatus'),
    outcome: _getEodFormValue(event, 'outcome'),
    progressPct: _getEodFormValue(event, 'progressPct'),
    deliverableLink: _getEodFormValue(event, 'deliverableLink'),
    blockerWhat: _getEodFormValue(event, 'blockerWhat'),
    blockerOwner: _getEodFormValue(event, 'blockerOwner'),
    blockerDeadline: _getEodFormValue(event, 'blockerDeadline'),
    issueWhat: _getEodFormValue(event, 'issueWhat'),
    issueAction: _getEodFormValue(event, 'issueAction')
  };

  // Validate required fields
  var errors = _validateTaskFields(taskData);
  if (errors.length > 0) {
    // Re-show the same card with error text
    var clickUpTask = (state.clickUpTasks && taskIndex < state.clickUpTasks.length)
      ? state.clickUpTasks[taskIndex] : null;
    var errorCard = buildEodTaskCard(taskIndex, (state.clickUpTasks || []).length, clickUpTask);
    return createChatResponse({
      actionResponse: { type: 'UPDATE_MESSAGE' },
      text: '\u26A0\uFE0F ' + errors.join(' \u2022 '),
      cardsV2: [errorCard]
    });
  }

  // Save task to state
  state.tasks[taskIndex] = taskData;
  state.currentTaskIndex = taskIndex + 1;

  // Flag carry-over > 3 days for lead review (non-blocking)
  if (taskData.carryOver === 'carry_4' || taskData.carryOver === 'carry_5') {
    console.log('EOD: Carry-over > 3 days flagged for task "' + taskData.taskName + '" by ' + email);
  }

  // Route to next card based on action
  if (nextAction === 'doneTasks') {
    // Must have at least 1 task
    if (state.tasks.length === 0) {
      _saveEodState(email, state);
      return createChatResponse({
        actionResponse: { type: 'UPDATE_MESSAGE' },
        text: '\u26A0\uFE0F At least one task is required.'
      });
    }
    state.step = 'meetings';
    _saveEodState(email, state);
    return createChatResponse({
      actionResponse: { type: 'UPDATE_MESSAGE' },
      cardsV2: [buildEodMeetingsCard()]
    });
  }

  // nextTask: show next task card
  _saveEodState(email, state);
  var nextIndex = taskIndex + 1;
  var clickUpTasks = state.clickUpTasks || [];
  var nextClickUpTask = nextIndex < clickUpTasks.length ? clickUpTasks[nextIndex] : null;
  var card = buildEodTaskCard(nextIndex, clickUpTasks.length, nextClickUpTask);

  return createChatResponse({
    actionResponse: { type: 'UPDATE_MESSAGE' },
    cardsV2: [card]
  });
}

/**
 * Handle meetings card submission -> show unplanned or tomorrow card
 */
function handleEodMeetings(event) {
  var params = _extractCardParams(event);
  var email = event.chat.user.email;
  var nextAction = params.nextAction || 'tomorrow';

  var state = _getEodState(email);
  if (!state) {
    return createChatResponse({
      actionResponse: { type: 'UPDATE_MESSAGE' },
      text: '\u26A0\uFE0F Session expired. Type "test eod" to restart.'
    });
  }

  // Extract meeting data
  var countRaw = _getEodFormValue(event, 'meetingCount');
  var timeRaw = _getEodFormValue(event, 'meetingTotalTime');
  var meetingCount = parseInt(countRaw) || 0;
  var meetingTotalTime = parseFloat(timeRaw) || 0;
  var meetingList = _getEodFormValue(event, 'meetingList');
  var highMeetingNote = _getEodFormValue(event, 'highMeetingNote');

  // Validate
  var meetingErrors = [];
  if (meetingCount > 0 && meetingTotalTime <= 0) {
    meetingErrors.push('Meeting time must be > 0 when count > 0');
  }
  if (meetingCount > 0 && !meetingList) {
    meetingErrors.push('Please list meeting names with durations');
  }
  if (meetingTotalTime > 2 && !highMeetingNote) {
    meetingErrors.push('Total meeting time > 2h requires a justification note');
  }
  if (meetingCount === 0 && meetingTotalTime > 0) {
    meetingErrors.push('Meeting count is 0 but meeting time > 0');
  }

  if (meetingErrors.length > 0) {
    return createChatResponse({
      actionResponse: { type: 'UPDATE_MESSAGE' },
      text: '\u26A0\uFE0F ' + meetingErrors.join(' \u2022 '),
      cardsV2: [buildEodMeetingsCard()]
    });
  }

  // Save meeting data
  state.meetings = {
    count: meetingCount,
    totalTime: meetingTotalTime,
    meetingList: meetingList,
    highMeetingNote: highMeetingNote
  };
  state.step = nextAction === 'unplanned' ? 'unplanned' : 'tomorrow';
  _saveEodState(email, state);

  if (nextAction === 'unplanned') {
    return createChatResponse({
      actionResponse: { type: 'UPDATE_MESSAGE' },
      cardsV2: [buildEodUnplannedCard()]
    });
  }

  return createChatResponse({
    actionResponse: { type: 'UPDATE_MESSAGE' },
    cardsV2: [buildEodTomorrowCard()]
  });
}

/**
 * Handle unplanned work card submission -> show tomorrow card
 */
function handleEodUnplanned(event) {
  var email = event.chat.user.email;

  var state = _getEodState(email);
  if (!state) {
    return createChatResponse({
      actionResponse: { type: 'UPDATE_MESSAGE' },
      text: '\u26A0\uFE0F Session expired. Type "test eod" to restart.'
    });
  }

  var desc = _getEodFormValue(event, 'unplannedDesc');
  var hoursRaw = _getEodFormValue(event, 'unplannedHours');
  var pulledFrom = _getEodFormValue(event, 'unplannedPulledFrom');

  // Validate: if any field is filled, all three are required
  if (desc || hoursRaw || pulledFrom) {
    var errors = [];
    if (!desc) errors.push('Description is required');
    var hrs = parseFloat(hoursRaw);
    if (!hoursRaw || isNaN(hrs) || hrs <= 0) errors.push('Hours must be > 0');
    if (!pulledFrom) errors.push('Specify what planned task it pulled you from');

    if (errors.length > 0) {
      return createChatResponse({
        actionResponse: { type: 'UPDATE_MESSAGE' },
        text: '\u26A0\uFE0F ' + errors.join(' \u2022 '),
        cardsV2: [buildEodUnplannedCard()]
      });
    }

    state.unplanned = {
      description: desc,
      hours: parseFloat(hoursRaw),
      pulledFrom: pulledFrom
    };
  }

  state.step = 'tomorrow';
  _saveEodState(email, state);

  return createChatResponse({
    actionResponse: { type: 'UPDATE_MESSAGE' },
    cardsV2: [buildEodTomorrowCard()]
  });
}

/**
 * Handle tomorrow priorities card submission -> validate all & submit
 * Also handles "Submit Anyway" from warning card (confirmed=true)
 */
function handleEodTomorrow(event) {
  var params = _extractCardParams(event);
  var email = event.chat.user.email;
  var confirmed = params.confirmed === 'true';

  var state = _getEodState(email);
  if (!state) {
    return createChatResponse({
      actionResponse: { type: 'UPDATE_MESSAGE' },
      text: '\u26A0\uFE0F Session expired. Type "test eod" to restart.'
    });
  }

  // Only extract priorities from form if NOT coming from warning card
  if (!confirmed) {
    var priorities = [];
    for (var i = 1; i <= 3; i++) {
      var name = _getEodFormValue(event, 'priority' + i + 'Name');
      var link = _getEodFormValue(event, 'priority' + i + 'Link');
      if (name) {
        priorities.push({ name: name, clickUpLink: link });
      }
    }

    if (priorities.length === 0) {
      return createChatResponse({
        actionResponse: { type: 'UPDATE_MESSAGE' },
        text: '\u26A0\uFE0F At least 1 priority task for tomorrow is required.',
        cardsV2: [buildEodTomorrowCard()]
      });
    }

    state.tomorrow = { priorities: priorities };
    _saveEodState(email, state);
  }

  // Run submission-level validation
  var warnings = _validateEodSubmission(state);
  if (warnings.length > 0 && !confirmed) {
    return createChatResponse({
      actionResponse: { type: 'UPDATE_MESSAGE' },
      cardsV2: [buildEodWarningCard(warnings)]
    });
  }

  // ========== SUBMIT ==========

  // Build formatted summary
  var summary = formatStructuredEodSummary(state);

  // Post to team channel
  try {
    var config = getConfig();
    var teamChannelId = config.settings.team_channel_id;
    if (teamChannelId) {
      sendChannelMessage(teamChannelId, summary);
    }
  } catch (e) {
    console.error('Failed to post structured EOD to team channel:', e.message);
  }

  // Log to BigQuery (reuse existing logEodReport with structured data)
  try {
    var tasksText = state.tasks.map(function(t) {
      return t.taskName + ' (' + t.taskHours + 'h, ' +
        (t.taskStatus === 'completed' ? 'Done' : t.taskStatus === 'in_review' ? 'Review' : t.progressPct + '%') + ')';
    }).join('; ');

    var blockersText = state.tasks
      .filter(function(t) { return t.blockerWhat; })
      .map(function(t) { return t.blockerWhat + ' > ' + t.blockerOwner + ' > ' + t.blockerDeadline; })
      .join('; ') || null;

    var tomorrowText = state.tomorrow.priorities
      .map(function(p) { return p.name + (p.clickUpLink ? ' (' + p.clickUpLink + ')' : ''); })
      .join('; ');

    logEodReport(
      email,
      new Date(),
      tasksText,
      blockersText,
      tomorrowText,
      summary,
      state.totalHours
    );
  } catch (e) {
    console.error('Failed to log structured EOD to BigQuery:', e.message);
  }

  // Clear state
  _clearEodState(email);
  clearUserState(email);

  // Build success preview
  var taskCount = state.tasks.length;
  var totalTaskHours = 0;
  state.tasks.forEach(function(t) { totalTaskHours += parseFloat(t.taskHours) || 0; });
  var meetingCount = state.meetings ? state.meetings.count : 0;
  var meetingHours = state.meetings ? state.meetings.totalTime : 0;

  var preview = '<b>Summary:</b>\n' +
    '\u2022 ' + taskCount + ' task' + (taskCount !== 1 ? 's' : '') + ' (' + totalTaskHours.toFixed(1) + 'h)\n' +
    '\u2022 ' + meetingCount + ' meeting' + (meetingCount !== 1 ? 's' : '') + ' (' + meetingHours + 'h)\n' +
    '\u2022 Total: ' + state.totalHours + 'h\n';

  if (state.unplanned) {
    preview += '\u2022 Unplanned: ' + state.unplanned.hours + 'h\n';
  }

  preview += '\u2022 Tomorrow: ' + state.tomorrow.priorities.map(function(p) { return p.name; }).join(', ') + '\n';

  if (warnings.length > 0) {
    preview += '\n<b>Notes:</b>\n';
    warnings.forEach(function(w) { preview += '\u26A0\uFE0F ' + w + '\n'; });
  }

  preview += '\nYour formatted summary has been posted to the team channel.';

  return createChatResponse({
    actionResponse: { type: 'UPDATE_MESSAGE' },
    cardsV2: [buildEodSuccessCard(preview)]
  });
}

// ============================================
// VALIDATION
// ============================================

/**
 * Validate individual task fields (hard errors that block saving)
 * @param {object} taskData - task form data
 * @returns {string[]} array of error messages (empty if valid)
 */
function _validateTaskFields(taskData) {
  var errors = [];

  // Task name required
  if (!taskData.taskName) {
    errors.push('Task name is required');
  }

  // Hours required and valid
  var hours = parseFloat(taskData.taskHours);
  if (!taskData.taskHours || isNaN(hours) || hours <= 0) {
    errors.push('Hours must be a positive number');
  } else if (hours > 24) {
    errors.push('Hours cannot exceed 24');
  }

  // Outcome required and not vague
  if (!taskData.outcome) {
    errors.push('Outcome is required');
  } else if (_isVagueOutcome(taskData.outcome)) {
    errors.push('Outcome is too vague \u2014 add specifics (quantities, deliverables, actions taken)');
  }

  // ClickUp link validation
  if (!taskData.clickUpLink && !taskData.noClickUpTask) {
    errors.push('ClickUp link required, or check "No ClickUp task"');
  } else if (taskData.clickUpLink && !taskData.noClickUpTask) {
    if (!taskData.clickUpLink.match(/^https:\/\/app\.clickup\.com\/t\//)) {
      errors.push('ClickUp link must start with https://app.clickup.com/t/');
    }
  }

  // Status-conditional: deliverable link for Completed/In Review
  if (taskData.taskStatus === 'completed' || taskData.taskStatus === 'in_review') {
    if (!taskData.deliverableLink) {
      var statusLabel = taskData.taskStatus === 'completed' ? 'Completed' : 'In Review';
      errors.push('Deliverable link is required for ' + statusLabel + ' tasks');
    }
  }

  // Status-conditional: progress % for In Progress
  if (taskData.taskStatus === 'in_progress') {
    var pct = parseInt(taskData.progressPct);
    if (!taskData.progressPct || isNaN(pct) || pct < 1 || pct > 99) {
      errors.push('Progress % (1-99) is required for In Progress tasks');
    }
  }

  // Blocker completeness: if any part filled, all three required
  if (taskData.blockerWhat || taskData.blockerOwner || taskData.blockerDeadline) {
    if (!taskData.blockerWhat) errors.push('Blocker: "What" is required');
    if (!taskData.blockerOwner) errors.push('Blocker: "Owner" is required');
    if (!taskData.blockerDeadline) errors.push('Blocker: "Deadline" is required');
  }

  // Issue completeness: if any part filled, both required
  if (taskData.issueWhat || taskData.issueAction) {
    if (!taskData.issueWhat) errors.push('Issue: "What" is required');
    if (!taskData.issueAction) errors.push('Issue: "Action/Next Step" is required');
  }

  return errors;
}

/**
 * Run submission-level validation across all EOD data
 * Returns warnings (shown to user, can be overridden with "Submit Anyway")
 * @param {object} state - full EOD state
 * @returns {string[]} array of warning messages
 */
function _validateEodSubmission(state) {
  var warnings = [];

  // 1. Hours must add up: tasks + meetings + unplanned = total (within 5 min)
  var taskHoursSum = 0;
  (state.tasks || []).forEach(function(t) {
    taskHoursSum += parseFloat(t.taskHours) || 0;
  });
  var meetingHours = state.meetings ? state.meetings.totalTime : 0;
  var unplannedHours = state.unplanned ? state.unplanned.hours : 0;
  var calculatedTotal = taskHoursSum + meetingHours + unplannedHours;
  var discrepancy = Math.abs(state.totalHours - calculatedTotal);

  if (discrepancy > 0.083) { // > 5 minutes
    warnings.push(
      'Hours mismatch: you reported ' + state.totalHours + 'h total, but tasks (' +
      taskHoursSum.toFixed(1) + 'h) + meetings (' + meetingHours + 'h)' +
      (unplannedHours > 0 ? ' + unplanned (' + unplannedHours + 'h)' : '') +
      ' = ' + calculatedTotal.toFixed(1) + 'h (diff: ' + discrepancy.toFixed(1) + 'h)'
    );
  }

  // 2. Minimum 6h task time for full-time members
  if (taskHoursSum < 6) {
    warnings.push(
      'Task hours (' + taskHoursSum.toFixed(1) + 'h) are below the 6h minimum. ' +
      'If this is correct, click "Submit Anyway" to confirm.'
    );
  }

  // 3. Carry-over > 3 days flagging (informational, logged for lead review)
  (state.tasks || []).forEach(function(t) {
    if (t.carryOver === 'carry_4' || t.carryOver === 'carry_5') {
      var dayText = t.carryOver === 'carry_4' ? '4' : '5+';
      warnings.push(
        'Task "' + t.taskName + '" is carry-over day ' + dayText +
        '. This will be flagged for lead review.'
      );
    }
  });

  // 4. Tasks needing ClickUp creation
  var needsCu = (state.tasks || []).filter(function(t) { return t.noClickUpTask; });
  if (needsCu.length > 0) {
    warnings.push(
      needsCu.length + ' task' + (needsCu.length > 1 ? 's' : '') +
      ' flagged as needing ClickUp task creation: ' +
      needsCu.map(function(t) { return '"' + t.taskName + '"'; }).join(', ')
    );
  }

  return warnings;
}

/**
 * Detect vague outcomes per SOP spec patterns
 * @param {string} text - outcome text
 * @returns {boolean} true if outcome is vague
 */
function _isVagueOutcome(text) {
  if (!text) return true;
  var lower = text.toLowerCase().trim();

  // Pattern checks: "Worked on X", "Continued X", etc. without further detail
  var vaguePatterns = [
    /^worked on\s+\w+(\s+\w+)?\s*\.?$/,
    /^continued\s+\w+(\s+\w+)?\s*\.?$/,
    /^did some\s+/,
    /^made progress on\s+\w+(\s+\w+)?\s*\.?$/
  ];

  for (var i = 0; i < vaguePatterns.length; i++) {
    if (vaguePatterns[i].test(lower)) return true;
  }

  // Under 10 words without specifics
  var words = text.split(/\s+/).filter(function(w) { return w.length > 0; });
  if (words.length < 10) {
    var actionVerbs = /\b(created|drafted|sent|uploaded|reviewed|approved|fixed|resolved|migrated|deployed|designed|built|implemented|completed|delivered|submitted|merged|tested|configured|organized|published|updated|added|removed|refactored|debugged|integrated|optimized)\b/i;
    var hasNumber = /\d/.test(text);
    var hasActionVerb = actionVerbs.test(text);
    if (!hasNumber && !hasActionVerb) return true;
  }

  return false;
}

// ============================================
// HELPERS
// ============================================

/**
 * Map ClickUp task status to our dropdown value
 */
function _mapClickUpStatus(cuStatus) {
  if (!cuStatus) return 'in_progress';
  var statusStr = typeof cuStatus === 'string' ? cuStatus : (cuStatus.status || '');
  var lower = statusStr.toLowerCase();
  if (lower.includes('close') || lower.includes('done') || lower.includes('complete')) return 'completed';
  if (lower.includes('review')) return 'in_review';
  return 'in_progress';
}

/**
 * Format the structured EOD data into the spec output format
 * Used for posting to team channel
 */
function formatStructuredEodSummary(state) {
  var lines = [];

  // Header line
  lines.push((state.userName || 'Unknown') + ' | ' + (state.dateStr || 'N/A') +
    ' | Total Hours: ' + _formatHoursDisplay(state.totalHours));
  lines.push('');

  // Task blocks
  (state.tasks || []).forEach(function(t) {
    // Carry-over text
    var carryOverText = 'New';
    if (t.carryOver && t.carryOver.startsWith('carry_')) {
      carryOverText = 'Carry-over Day ' + t.carryOver.replace('carry_', '');
    }

    // Status text
    var statusText;
    if (t.taskStatus === 'completed') statusText = 'Completed';
    else if (t.taskStatus === 'in_review') statusText = 'In Review';
    else statusText = 'In Progress (' + (t.progressPct || '?') + '%)';

    // ClickUp link text
    var linkText = t.noClickUpTask ? '[Needs CU task creation]' : (t.clickUpLink || 'N/A');

    lines.push('Task: ' + t.taskName + ' | ' + t.taskHours + 'h | ' + carryOverText + ' | ' + linkText);
    lines.push(t.outcome);

    if ((t.taskStatus === 'completed' || t.taskStatus === 'in_review') && t.deliverableLink) {
      lines.push('Deliverable: ' + t.deliverableLink);
    }

    lines.push('Status: ' + statusText);

    if (t.blockerWhat) {
      lines.push('Blocker: ' + t.blockerWhat + ' > ' + t.blockerOwner + ' > ' + t.blockerDeadline);
    }
    if (t.issueWhat) {
      lines.push('Issue: ' + t.issueWhat + ' > ' + t.issueAction);
    }

    lines.push('');
  });

  // Meetings
  var m = state.meetings || { count: 0, totalTime: 0, meetingList: '' };
  var meetingLine = 'Meetings: ' + m.count + ' | ' + m.totalTime + 'h';
  if (m.meetingList) meetingLine += ' (' + m.meetingList + ')';
  lines.push(meetingLine);
  lines.push('');

  // Unplanned work
  if (state.unplanned) {
    lines.push('Unplanned: ' + state.unplanned.description + ' | ' +
      state.unplanned.hours + 'h | ' + state.unplanned.pulledFrom);
    lines.push('');
  }

  // Tomorrow priorities
  if (state.tomorrow && state.tomorrow.priorities) {
    var prioTexts = state.tomorrow.priorities.map(function(p) {
      return p.name + (p.clickUpLink ? ' (' + p.clickUpLink + ')' : '');
    });
    lines.push('Tomorrow: ' + prioTexts.join(' | '));
  }

  return lines.join('\n');
}

/**
 * Format hours as "Xh Xm" for display
 */
function _formatHoursDisplay(hours) {
  if (!hours || isNaN(hours)) return '0h';
  var h = Math.floor(hours);
  var m = Math.round((hours - h) * 60);
  if (m === 0) return h + 'h';
  return h + 'h ' + m + 'm';
}
