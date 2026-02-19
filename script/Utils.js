/**
 * Utils.gs - Utility Functions & Trigger Setup
 */

/**
 * Create all scheduled triggers - run once after deployment
 * Uses daily triggers with day-of-week checks in the functions to stay under 20 trigger limit
 */
function createScheduledTriggers() {
  deleteAllTriggers();
  console.log('Creating scheduled triggers...');

  // 6:00 AM - Sage HR Sync (daily) - skips weekends in function
  ScriptApp.newTrigger('triggerSageHRSync').timeBased().atHour(6).nearMinute(0).everyDays(1).inTimezone('America/Chicago').create();

  // 6:15 AM - ClickUp Sync (daily) - skips weekends in function
  ScriptApp.newTrigger('triggerClickUpSync').timeBased().atHour(6).nearMinute(15).everyDays(1).inTimezone('America/Chicago').create();

  // 7:00 AM - Morning Check-ins for Friday
  ScriptApp.newTrigger('triggerMorningCheckInsFriday').timeBased().atHour(7).nearMinute(0).everyDays(1).inTimezone('America/Chicago').create();

  // 8:00 AM - Morning Check-ins for Mon-Thu
  ScriptApp.newTrigger('triggerMorningCheckIns').timeBased().atHour(8).nearMinute(0).everyDays(1).inTimezone('America/Chicago').create();

  // 7:20 AM - Check-in Follow-ups for Friday
  ScriptApp.newTrigger('triggerCheckInFollowUpFriday').timeBased().atHour(7).nearMinute(20).everyDays(1).inTimezone('America/Chicago').create();

  // 8:20 AM - Check-in Follow-ups for Mon-Thu
  ScriptApp.newTrigger('triggerCheckInFollowUp').timeBased().atHour(8).nearMinute(20).everyDays(1).inTimezone('America/Chicago').create();

  // 7:35 AM - Morning Summary for Friday
  ScriptApp.newTrigger('triggerMorningSummaryFriday').timeBased().atHour(7).nearMinute(35).everyDays(1).inTimezone('America/Chicago').create();

  // 8:35 AM - Morning Summary for Mon-Thu
  ScriptApp.newTrigger('triggerMorningSummary').timeBased().atHour(8).nearMinute(35).everyDays(1).inTimezone('America/Chicago').create();

  // 10:30 AM - EOD Requests for Friday
  ScriptApp.newTrigger('triggerEodRequestsFriday').timeBased().atHour(10).nearMinute(30).everyDays(1).inTimezone('America/Chicago').create();

  // 4:30 PM - EOD Requests for Mon-Thu
  ScriptApp.newTrigger('triggerEodRequests').timeBased().atHour(16).nearMinute(30).everyDays(1).inTimezone('America/Chicago').create();

  // 10:50 AM - EOD Follow-ups for Friday
  ScriptApp.newTrigger('triggerEodFollowUpFriday').timeBased().atHour(10).nearMinute(50).everyDays(1).inTimezone('America/Chicago').create();

  // 4:50 PM - EOD Follow-ups for Mon-Thu
  ScriptApp.newTrigger('triggerEodFollowUp').timeBased().atHour(16).nearMinute(50).everyDays(1).inTimezone('America/Chicago').create();

  // 11:00 AM - EOD Summary for Friday
  ScriptApp.newTrigger('triggerEodSummaryFriday').timeBased().atHour(11).nearMinute(0).everyDays(1).inTimezone('America/Chicago').create();

  // 5:00 PM - EOD Summary for Mon-Thu
  ScriptApp.newTrigger('triggerEodSummary').timeBased().atHour(17).nearMinute(0).everyDays(1).inTimezone('America/Chicago').create();

  // 5:15 PM - ClickUp Snapshot (daily)
  ScriptApp.newTrigger('triggerClickUpSnapshot').timeBased().atHour(17).nearMinute(15).everyDays(1).inTimezone('America/Chicago').create();

  // 11:30 AM - AI Evaluation for Friday
  ScriptApp.newTrigger('triggerAiEvaluationFriday').timeBased().atHour(11).nearMinute(30).everyDays(1).inTimezone('America/Chicago').create();

  // 5:30 PM - AI Evaluation for Mon-Thu
  ScriptApp.newTrigger('triggerAiEvaluation').timeBased().atHour(17).nearMinute(30).everyDays(1).inTimezone('America/Chicago').create();

  // 10:15 AM - Weekly Gamification (Friday only, checked in function)
  ScriptApp.newTrigger('triggerWeeklyGamification').timeBased().atHour(10).nearMinute(15).everyDays(1).inTimezone('America/Chicago').create();

  // V2 TRIGGERS

  // 5:20 PM - Daily Adoption Metrics (Mon-Thu, checked in function)
  ScriptApp.newTrigger('triggerDailyAdoptionMetrics').timeBased().atHour(17).nearMinute(20).everyDays(1).inTimezone('America/Chicago').create();

  // 10:00 AM Wednesday - Midweek Compliance Check (checked in function)
  ScriptApp.newTrigger('triggerMidweekCompliance').timeBased().atHour(10).nearMinute(0).everyDays(1).inTimezone('America/Chicago').create();

  // 10:30 AM Friday - Weekly Adoption Report (checked in function)
  ScriptApp.newTrigger('triggerWeeklyAdoptionReport').timeBased().atHour(10).nearMinute(30).everyDays(1).inTimezone('America/Chicago').create();

  // 11:20 AM Friday - Daily Adoption Metrics for Friday (checked in function)
  ScriptApp.newTrigger('triggerDailyAdoptionMetricsFriday').timeBased().atHour(11).nearMinute(20).everyDays(1).inTimezone('America/Chicago').create();

  // Every 30 minutes - Schedule Dispatcher for custom/split-shift users
  ScriptApp.newTrigger('triggerScheduleDispatcher').timeBased().everyMinutes(30).inTimezone('America/Chicago').create();

  const count = ScriptApp.getProjectTriggers().length;
  console.log(`All triggers created! Total: ${count}`);
}

function deleteAllTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => ScriptApp.deleteTrigger(t));
  console.log(`Deleted ${triggers.length} triggers`);
}

function listAllTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => console.log(`${t.getHandlerFunction()}`));
  return triggers.length;
}

// Connection Tests
function testClickUpConnection() {
  const structure = getWorkspaceStructure();
  if (structure) {
    console.log(`✅ ClickUp: ${structure.lists.length} lists, ${Object.keys(structure.members).length} members`);
    return true;
  }
  console.log('❌ ClickUp failed'); return false;
}

function testSageHRConnection() {
  const employees = getSageHREmployees();
  if (employees && employees.length > 0) {
    console.log(`✅ Sage HR: ${employees.length} employees`);
    return true;
  }
  console.log('❌ Sage HR failed'); return false;
}

function testOpenAIConnection() {
  const result = callOpenAI('Say "test ok"');
  if (result) { console.log('✅ OpenAI connected'); return true; }
  console.log('❌ OpenAI failed'); return false;
}

function testBigQueryConnection() {
  try {
    runBigQueryQuery('SELECT 1');
    console.log('✅ BigQuery connected'); return true;
  } catch (e) {
    console.log('❌ BigQuery failed'); return false;
  }
}

function runAllTests() {
  console.log('=== Connection Tests ===');
  return {
    clickup: testClickUpConnection(),
    sageHR: testSageHRConnection(),
    openai: testOpenAIConnection(),
    bigquery: testBigQueryConnection()
  };
}

/**
 * Get access token using service account credentials
 * @param {string} scope The OAuth scope to request
 * @return {string} Access token or null
 */
function getServiceAccountToken(scope) {
  const targetScope = scope || 'https://www.googleapis.com/auth/chat.bot';
  const cacheKey = 'sa_token_' + Utilities.base64EncodeWebSafe(targetScope);

  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const props = PropertiesService.getScriptProperties();
    const saKeyJson = props.getProperty('SERVICE_ACCOUNT_KEY');

    if (!saKeyJson) {
      console.error('SERVICE_ACCOUNT_KEY not found in Script Properties');
      return null;
    }

    const saKey = JSON.parse(saKeyJson);

    // Create JWT
    const header = { alg: 'RS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const claimSet = {
      iss: saKey.client_email,
      scope: targetScope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    };

    const signatureInput = Utilities.base64EncodeWebSafe(JSON.stringify(header)) + '.' +
      Utilities.base64EncodeWebSafe(JSON.stringify(claimSet));
    const signature = Utilities.computeRsaSha256Signature(signatureInput, saKey.private_key);
    const jwt = signatureInput + '.' + Utilities.base64EncodeWebSafe(signature);

    // Exchange for token
    const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
      method: 'post',
      payload: {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      },
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      console.error('Token exchange failed:', response.getContentText());
      return null;
    }

    const tokenData = JSON.parse(response.getContentText());
    // Cache for 50 minutes (3000 seconds)
    cache.put(cacheKey, tokenData.access_token, 3000);

    return tokenData.access_token;
  } catch (error) {
    console.error('Error getting SA token:', error.message);
    return null;
  }
}

// Manual test functions
function testSendCheckIn() {
  const config = getConfig();
  const email = config.settings.manager_email;
  const tasks = getTasksForUser(email, 'today');
  const msg = getMorningCheckInMessage({ email, name: 'Test' }, tasks, false);
  sendDirectMessage(email, msg);
  logPromptSent(email, 'CHECKIN');
  setUserState(email, 'AWAITING_CHECKIN');
  console.log(`Check-in sent to ${email}`);
}

function testSendEodRequest() {
  const config = getConfig();
  const email = config.settings.manager_email;
  const tasks = getTasksForUser(email, 'today');
  const eod = getEodRequestMessage({ email }, tasks);
  const result = sendDirectMessage(email, eod.text, eod.cardsV2);
  logPromptSent(email, 'EOD');
  setUserState(email, 'AWAITING_EOD');
  console.log(`EOD sent to ${email}`, result);
}

/**
 * Test service account configuration
 */
function testServiceAccount() {
  console.log('=== Service Account Test ===');

  // Check if configured
  if (!isServiceAccountConfigured()) {
    console.log('❌ Service account NOT configured');
    console.log('To configure: Add SERVICE_ACCOUNT_KEY to Script Properties');
    console.log('The value should be the entire JSON key file contents');
    return false;
  }

  console.log('✅ Service account key found in Script Properties');

  // Try to get a token
  const token = getServiceAccountToken();
  if (token) {
    console.log('✅ Successfully obtained service account token');
    console.log('Token preview:', token.substring(0, 20) + '...');
    return true;
  } else {
    console.log('❌ Failed to obtain service account token');
    return false;
  }
}

/**
 * Test sending a message with cards using service account
 */
function testSendCardMessage() {
  console.log('=== Test Card Message ===');

  const config = getConfig();
  const email = config.settings.manager_email;

  // Get DM space
  const spaceName = getDMSpace(email);
  if (!spaceName) {
    console.log(`❌ No DM space found for ${email}`);
    console.log('The user must first message the bot to establish a DM space');
    return false;
  }

  console.log(`Found DM space: ${spaceName}`);

  // Create a simple test card
  const testCards = [{
    cardId: 'test_card',
    card: {
      header: {
        title: '🧪 Test Card',
        subtitle: 'Service Account Test'
      },
      sections: [{
        widgets: [{
          decoratedText: {
            text: 'If you see this card, service account is working!',
            startIcon: { knownIcon: 'STAR' }
          }
        }]
      }]
    }
  }];

  const result = sendMessageToSpace(spaceName, 'Testing card delivery with service account:', testCards);

  if (result.sent) {
    console.log('✅ Message sent successfully!');
    console.log('Has cards:', result.hasCards);
    return true;
  } else {
    console.log('❌ Failed to send message:', result.error);
    return false;
  }
}

/**
 * Setup helper: Store service account key
 * Run this function after pasting your service account JSON key
 */
function setupServiceAccountKey() {
  // INSTRUCTIONS:
  // 1. Create a service account in GCP Console
  // 2. Download the JSON key file
  // 3. Copy the ENTIRE contents of the JSON file
  // 4. Replace the placeholder below with the JSON contents
  // 5. Run this function ONCE to store the key
  // 6. Delete the key from this code after running!

  const serviceAccountKey = {
    // PASTE YOUR SERVICE ACCOUNT JSON KEY HERE
    // Example structure (DO NOT USE THIS - use your actual key):
    // "type": "service_account",
    // "project_id": "your-project-id",
    // "private_key_id": "...",
    // "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
    // "client_email": "checkin-bot-service@your-project.iam.gserviceaccount.com",
    // "client_id": "...",
    // ...
  };

  if (!serviceAccountKey.type || !serviceAccountKey.private_key) {
    console.log('❌ Please paste your service account JSON key in the setupServiceAccountKey function');
    console.log('The key should have "type" and "private_key" fields');
    return;
  }

  PropertiesService.getScriptProperties().setProperty(
    'SERVICE_ACCOUNT_KEY',
    JSON.stringify(serviceAccountKey)
  );

  console.log('✅ Service account key stored successfully!');
  console.log('⚠️ IMPORTANT: Now delete the key from this code for security!');
}

/**
 * Helper to build a common Google Chat response for Add-on style events
 * @param {any} responseData The message text (string) or a message object (e.g. with cards)
 * @return {object} Structured JSON response
 */
function createChatResponse(responseData) {
  var message = typeof responseData === 'string' ? { text: responseData } : responseData;
  return {
    hostAppDataAction: {
      chatDataAction: {
        createMessageAction: {
          message: message
        }
      }
    }
  };
}