/**
 * Alerts.gs - Error Alerting & Notifications
 * Sends critical error alerts to the manager
 */

/**
 * Send a critical error alert to the manager
 * Use this for integration failures, not routine warnings
 */
function sendErrorAlert(source, errorMessage, details) {
  try {
    var config = getConfig();
    var managerEmail = config.settings.manager_email;
    if (!managerEmail) return;

    var message = '🚨 *Bot Error Alert*\n\n' +
      '*Source:* ' + source + '\n' +
      '*Error:* ' + errorMessage + '\n';

    if (details) {
      message += '*Details:* ' + (typeof details === 'string' ? details : JSON.stringify(details)) + '\n';
    }

    message += '*Time:* ' + new Date().toISOString();

    sendDirectMessage(managerEmail, message);
  } catch (e) {
    // Don't let alert failures cause cascading errors
    console.error('Failed to send error alert:', e.message);
  }
}

/**
 * Wrap a function call with error alerting
 * Usage: safeExecute('ClickUp Sync', function() { dailyClickUpSync(); });
 */
function safeExecute(operationName, fn) {
  try {
    return fn();
  } catch (error) {
    console.error(operationName + ' failed:', error.message, error.stack);
    sendErrorAlert(operationName, error.message);
    return null;
  }
}
