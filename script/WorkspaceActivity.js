/**
 * WorkspaceActivity.gs
 * Fetches user activity from Google Workspace Admin SDK Reports API.
 * Captures Chat messages, Meet duration, and Drive file touches for EOD stats.
 */

var ADMIN_IMPERSONATE_EMAIL = 'khalid@k-brands.com';

/**
 * Get an OAuth token using the service account, explicitly impersonating the admin.
 * Requires Domain-Wide Delegation in Google Admin Console for the service account client ID
 * with the scope: https://www.googleapis.com/auth/admin.reports.audit.readonly
 */
function getAdminImpersonatedToken() {
    var scope = 'https://www.googleapis.com/auth/admin.reports.audit.readonly';
    var cacheKey = 'sa_admin_token_' + Utilities.base64EncodeWebSafe(scope);

    var cache = CacheService.getScriptCache();
    var cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
        var props = PropertiesService.getScriptProperties();
        var saKeyJson = props.getProperty('SERVICE_ACCOUNT_KEY');
        if (!saKeyJson) {
            console.error('SERVICE_ACCOUNT_KEY missing for Workspace Activity');
            return null;
        }
        var saKey = JSON.parse(saKeyJson);

        var header = { alg: 'RS256', typ: 'JWT' };
        var now = Math.floor(Date.now() / 1000);
        var claimSet = {
            iss: saKey.client_email,
            sub: ADMIN_IMPERSONATE_EMAIL, // Impersonate the admin
            scope: scope,
            aud: 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: now + 3600
        };

        var signatureInput = Utilities.base64EncodeWebSafe(JSON.stringify(header)) + '.' +
            Utilities.base64EncodeWebSafe(JSON.stringify(claimSet));
        var signature = Utilities.computeRsaSha256Signature(signatureInput, saKey.private_key);
        var jwt = signatureInput + '.' + Utilities.base64EncodeWebSafe(signature);

        var response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
            method: 'post',
            payload: {
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: jwt
            },
            muteHttpExceptions: true
        });

        if (response.getResponseCode() !== 200) {
            console.error('Admin impersonation failed:', response.getContentText());
            return null;
        }

        var tokenData = JSON.parse(response.getContentText());
        cache.put(cacheKey, tokenData.access_token, 3000);
        return tokenData.access_token;
    } catch (e) {
        console.error('Error getting impersonated token:', e.message);
        return null;
    }
}

/**
 * Fetch logs from Admin SDK Reports API using raw UrlFetchApp.
 * This ensures we pass our impersonated token rather than default ScriptApp.getOAuthToken().
 */
function fetchAdminReportsData(applicationName, userEmail, startTime) {
    var token = getAdminImpersonatedToken();
    if (!token) return null; // No token = graceful exit

    var url = 'https://admin.googleapis.com/admin/reports/v1/activity/all/' + applicationName +
        '?userKey=' + encodeURIComponent(userEmail) +
        '&startTime=' + encodeURIComponent(startTime);

    try {
        var response = UrlFetchApp.fetch(url, {
            method: 'get',
            headers: { Authorization: 'Bearer ' + token },
            muteHttpExceptions: true
        });

        if (response.getResponseCode() === 200) {
            return JSON.parse(response.getContentText());
        } else {
            console.error('Admin Reports API error for', applicationName, response.getContentText());
            return null;
        }
    } catch (e) {
        console.error('Error fetching Admin Reports:', e.message);
        return null;
    }
}

/**
 * Get Chat Activity (Messages sent & top contacts)
 */
function getChatActivityForUser(email, startTimeIo) {
    var data = fetchAdminReportsData('chat', email, startTimeIo);
    if (!data || !data.items) return null;

    var messagesSent = 0;
    var contacts = {};

    data.items.forEach(function (item) {
        if (item.events) {
            item.events.forEach(function (event) {
                if (event.name === 'message_posted' || event.name === 'add_message') {
                    // It's a message sent by the user
                    messagesSent++;

                    // Try to extract recipient/space info if available
                    var typeParam = event.parameters ? event.parameters.find(function (p) { return p.name === 'message_type'; }) : null;
                    var spaceParam = event.parameters ? event.parameters.find(function (p) { return p.name === 'space_id' || p.name === 'room_id'; }) : null;
                    var threadParam = event.parameters ? event.parameters.find(function (p) { return p.name === 'thread_id'; }) : null;

                    var targetId = (spaceParam ? spaceParam.value : null) || (threadParam ? threadParam.value : 'group/space');
                    if (targetId) {
                        contacts[targetId] = (contacts[targetId] || 0) + 1;
                    }
                }
            });
        }
    });

    // Top 3 contacts/spaces by volume
    var topContacts = Object.keys(contacts)
        .map(function (k) { return { id: k, count: contacts[k] }; })
        .sort(function (a, b) { return b.count - a.count; })
        .slice(0, 3);

    return { messagesSent: messagesSent, topContacts: topContacts };
}

/**
 * Get Meet Activity (Number of meetings & total duration)
 */
function getMeetActivityForUser(email, startTimeIo) {
    var data = fetchAdminReportsData('meet', email, startTimeIo);
    if (!data || !data.items) return null;

    var meetings = new Set();
    var durationSecs = 0;

    data.items.forEach(function (item) {
        if (item.events) {
            item.events.forEach(function (event) {
                if (event.name === 'call_ended') {
                    var callIdParam = event.parameters ? event.parameters.find(function (p) { return p.name === 'meeting_code'; }) : null;
                    var durationParam = event.parameters ? event.parameters.find(function (p) { return p.name === 'duration_seconds'; }) : null;

                    if (callIdParam) meetings.add(callIdParam.value);
                    if (durationParam) durationSecs += parseInt(durationParam.intValue, 10) || 0;
                }
            });
        }
    });

    return {
        meetingCount: meetings.size,
        totalMinutes: Math.round(durationSecs / 60)
    };
}

/**
 * Get Drive Activity (Number of unique files worked on)
 * Note: Drive logs typically lag 1-3 days on average, so this might be 0 for today.
 */
function getDriveActivityForUser(email, startTimeIo) {
    var data = fetchAdminReportsData('drive', email, startTimeIo);
    if (!data || !data.items) return null;

    var filesWorkedOn = new Set();

    data.items.forEach(function (item) {
        if (item.events) {
            item.events.forEach(function (event) {
                if (['create', 'edit', 'upload', 'rename', 'move'].indexOf(event.name) !== -1) {
                    var docs = event.parameters ? event.parameters.filter(function (p) { return p.name === 'doc_id'; }) : [];
                    docs.forEach(function (d) { filesWorkedOn.add(d.value); });
                }
            });
        }
    });

    return { filesWorkedOn: filesWorkedOn.size };
}

/**
 * Orchestrator: Fetch all workspace stats for a user today.
 * Gracefully returns null for any stat that fails or has no setup.
 */
function getUserWorkspaceStats(email) {
    // ISO string for midnight today
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var startTimeIo = today.toISOString();
    console.log('Fetching workspace stats for ' + email + ' since ' + startTimeIo);

    var chatStats = null;
    try {
        chatStats = getChatActivityForUser(email, startTimeIo);
        console.log('Chat stats for ' + email + ': ' + JSON.stringify(chatStats));
    } catch (e) {
        console.error('Chat activity fetch failed for ' + email + ':', e.message);
    }

    var meetStats = null;
    try {
        meetStats = getMeetActivityForUser(email, startTimeIo);
        console.log('Meet stats for ' + email + ': ' + JSON.stringify(meetStats));
    } catch (e) {
        console.error('Meet activity fetch failed for ' + email + ':', e.message);
    }

    var driveStats = null;
    try {
        driveStats = getDriveActivityForUser(email, startTimeIo);
        console.log('Drive stats for ' + email + ': ' + JSON.stringify(driveStats));
    } catch (e) {
        console.error('Drive activity fetch failed for ' + email + ':', e.message);
    }

    var result = {
        chat: chatStats,
        meet: meetStats,
        drive: driveStats
    };
    console.log('Workspace stats result for ' + email + ': ' + JSON.stringify(result));
    return result;
}

/**
 * Convert stats payload into a formatted text block for EOD.
 * If all stats are null/0, does not render the block.
 */
function formatWorkspaceStatsBlock(stats) {
    if (!stats) return '';

    var hasData = false;
    var lines = [];

    // Chat
    if (stats.chat && stats.chat.messagesSent > 0) {
        hasData = true;
        var chatLine = '💬 *Messages:* ' + stats.chat.messagesSent + ' sent';
        // We only have room/space IDs from audit log, difficult to map to names without another API call.
        // For now we just show count.
        lines.push(chatLine);
    }

    // Meet
    if (stats.meet && stats.meet.meetingCount > 0) {
        hasData = true;
        var hrs = Math.floor(stats.meet.totalMinutes / 60);
        var mins = stats.meet.totalMinutes % 60;
        var timeStr = (hrs > 0 ? hrs + 'h ' : '') + mins + 'm';
        lines.push('📹 *Meetings:* ' + stats.meet.meetingCount + ' sessions (' + timeStr + ' total)');
    }

    // Drive
    if (stats.drive && stats.drive.filesWorkedOn > 0) {
        hasData = true;
        lines.push('📁 *Drive Files:* ' + stats.drive.filesWorkedOn + ' edited/created');
    }

    if (!hasData) return '';

    return '\ud83d\udcca *Today\'s Google Workspace Activity*\n' + lines.join('\n') + '\n\n';
}
