# K-Brands Daily Check-in Bot — Deployment Guide

**Version:** v45
**Last Updated:** February 5, 2026
**For:** Developer deploying the bot to production
**Current Deployment:** v45 — `AKfycbx_6goe4eIQ7ZXms5bxfUTV7ZoiTADYVOdtC8A22gMV8CRKA5gS9AtydPpc3cpAy32T`

---

## 1. Prerequisites

### GCP Project Setup

| Requirement | Details |
|-------------|---------|
| Google Cloud Project | Active GCP project with billing enabled |
| APIs Enabled | Google Chat API, BigQuery API, Google Drive API, Google Sheets API |
| Service Account | Created with domain-wide delegation for Chat API card rendering |
| BigQuery Dataset | `checkin_bot` dataset created in the GCP project |

### External Service Accounts

| Service | What You Need |
|---------|---------------|
| ClickUp | Personal API token (Settings > Apps > API Token) |
| Odoo | API key + database name (via database selector) |
| Sage HR | API key (Settings > Integrations > API) |
| OpenAI | API key with gpt-4o access |

### Tools Required

| Tool | Purpose |
|------|---------|
| Node.js | Required for clasp CLI |
| clasp | Google Apps Script CLI (`npm install -g @google/clasp`) |
| Google account | With access to target Apps Script project |

---

## 2. Initial Setup (First-Time Deployment)

### Step 1: Clone the Project

```bash
# Login to clasp
clasp login

# Clone existing project (if project ID known)
clasp clone <SCRIPT_ID>

# OR create new project
clasp create --title "K-Brands Check-in Bot" --type standalone
```

### Step 2: Push Code Files

The project has 14 .js files + 1 manifest:

```bash
# From the checkin-bot-deploy directory
clasp push
```

**Files pushed (clasp converts .js to .gs automatically):**
- Code.js, Config.js, SageHR.js, Chat.js, BigQuery.js, OpenAI.js
- Gamification.js, Templates.js, Utils.js, Escalation.js
- ClickUp.js, ClickUpCards.js, ClickUpSync.js, OdooService.js
- appsscript.json (manifest)

### Step 3: Configure Script Properties

In Apps Script editor: **Project Settings (gear icon) > Script Properties**

Add each property:

| Property | Value | Notes |
|----------|-------|-------|
| `CONFIG_SHEET_ID` | `<Google Sheet ID>` | The spreadsheet with 10 config tabs |
| `BIGQUERY_PROJECT_ID` | `k-brands-ops` | Your GCP project ID |
| `SAGE_HR_API_KEY` | `<Sage HR token>` | From Sage HR admin |
| `OPENAI_API_KEY` | `<OpenAI key>` | Must have gpt-4o access |
| `CLICKUP_API_TOKEN` | `<ClickUp token>` | Personal API token |
| `ODOO_API_KEY` | `<Odoo key>` | Odoo API key/password |
| `ODOO_DB` | `<database name>` | Run `discoverOdooDatabases()` to find it |

### Step 4: Set Up Service Account

1. Create a service account in GCP Console
2. Download the JSON key file
3. In Code.js, find the `setupServiceAccountKey()` function
4. Paste the JSON key contents into the function
5. Run `setupServiceAccountKey()` once
6. **Delete the key from the code immediately after**
7. Verify with `testServiceAccount()`

### Step 5: Set Up Config Sheet

Create a Google Sheet with these 10 tabs (exact names matter):

| Tab | Purpose | Key Fields |
|-----|---------|------------|
| `settings` | Key-value pairs for bot settings | manager_email, team_updates_space_id, openai_model (set to gpt-4o), late_threshold_min, escalation_recipients, ai_eval_recipients |
| `team_members` | Employee roster | email, name, department, manager_email, active, task_source |
| `work_hours` | Work schedule | default_start (08:00), default_end (17:00), friday_start (07:00), friday_end (11:00) |
| `holidays` | Holiday calendar | date, description, type (full/half_pm) |
| `special_hours` | Ramadan etc. | period_name, start_date, end_date, mon-thu start/end, fri start/end |
| `clickup_config` | ClickUp settings | enabled, include_in_morning, include_in_eod, auto_update, etc. |
| `clickup_user_map` | Google-to-ClickUp mapping | google_email, clickup_user_id, clickup_username |
| `odoo_config` | Odoo settings | enabled, include_in_morning, include_in_eod |
| `odoo_user_map` | Google-to-Odoo mapping | google_email, odoo_user_id, odoo_username |
| `email_mapping` | Sage HR-to-Google mapping | sage_hr_email, google_email |

### Step 6: Set Up BigQuery

```
1. Open the Apps Script editor
2. Run: setupBigQueryTables()
3. Verify 16 tables created in BigQuery console
```

### Step 7: Configure Google Chat API

In GCP Console > APIs & Services > Google Chat API:

1. **Configuration tab:**
   - App name: `K-Brands Check-in Bot`
   - Avatar URL: (optional)
   - Description: `Daily check-in and reporting bot`
   - Functionality: Check both "Receive 1:1 messages" and "Join spaces and group conversations"
   - Connection settings: Select "Apps Script project"
   - Deployment ID: (from Apps Script deployment, see Step 8)
   - Permissions: Your organization's domain

2. **Visibility:** Set to your domain (k-brands.com)

### Step 8: Deploy as Chat App

In Apps Script editor:

1. Click **Deploy > New deployment**
2. Select type: **Add-on** (for Chat apps)
3. Description: `v45 - Production deployment`
4. Click **Deploy**
5. Copy the **Deployment ID**
6. Paste the Deployment ID into GCP Console Google Chat API configuration

### Step 9: Create Triggers

```
1. Open Apps Script editor
2. Run: createScheduledTriggers()
3. Verify: Run listAllTriggers() — should show 18 triggers
```

### Step 10: Establish DM Spaces

Each team member must message the bot once to establish a DM space:

1. In Google Chat, search for the bot name
2. Send any message (e.g., "hi")
3. Bot responds and stores the DM space ID in `DM_SPACES` Script Property

**This is required before the bot can proactively DM users.**

---

## 3. OAuth Scopes

The `appsscript.json` manifest declares these 6 OAuth scopes:

```json
"oauthScopes": [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/script.external_request",
  "https://www.googleapis.com/auth/bigquery",
  "https://www.googleapis.com/auth/chat.messages.create",
  "https://www.googleapis.com/auth/chat.spaces.readonly"
]
```

Plus the BigQuery Advanced Service:
```json
"dependencies": {
  "enabledAdvancedServices": [{
    "userSymbol": "BigQuery",
    "version": "v2",
    "serviceId": "bigquery"
  }]
}
```

Users will be prompted to authorize these scopes on first interaction.

---

## 4. Updating an Existing Deployment

For code changes after initial deployment:

```bash
# 1. Make code changes locally
# 2. Push to Apps Script
clasp push

# 3. In Apps Script editor:
#    Deploy > Manage deployments > Edit (pencil icon)
#    Version: New version
#    Description: "v46 - description of changes"
#    Deploy

# 4. If triggers changed: Run createScheduledTriggers() again
```

**Important:** Always create a **new version** when deploying. The bot uses the latest deployment version — if you don't create a new version, changes won't take effect.

### Post-Deployment Verification

After every deployment:

1. Run `runAllTests()` to verify all connections still work
2. Run `testSendCheckIn()` to verify DMs still work
3. Run `testSendCardMessage()` to verify cards still render
4. Check Apps Script execution logs for any errors
5. Verify triggers are still active: `listAllTriggers()`

---

## 5. Environment Architecture

```
LOCAL DEVELOPMENT                    GOOGLE CLOUD
─────────────────                    ────────────
/checkin-bot-deploy/                 Apps Script Project
├── *.js files      ──clasp push──→  ├── *.gs files (converted)
└── appsscript.json ──────────────→  └── appsscript.json

                                     ┌─ Google Chat API (DMs + channels)
                                     ├─ BigQuery (16 tables)
                                     ├─ Google Sheets (config)
                                     ├─ ClickUp API
                                     ├─ Odoo JSON-RPC API
                                     ├─ Sage HR API
                                     └─ OpenAI API
```

---

## 6. Configuration Reference

### Settings Tab — Key Values

| Setting | Recommended Value | Description |
|---------|-------------------|-------------|
| `manager_email` | khalid@k-brands.com | Primary manager |
| `ops_leader_email` | danyal@k-brands.com | Ops leader |
| `ai_eval_recipients` | khalid@k-brands.com, danyal@k-brands.com | Who gets AI evals |
| `weekly_summary_recipients` | khalid@k-brands.com, danyal@k-brands.com | Who gets weekly summary |
| `escalation_recipients` | khalid@k-brands.com, danyal@k-brands.com | Who gets escalation alerts |
| `team_updates_space_id` | spaces/AAAA... | #team-updates channel ID |
| `late_threshold_min` | 15 | Minutes after work start = late |
| `openai_model` | gpt-4o | AI model for evaluations |
| `overdue_escalate_days` | 5 | Days overdue for chronic alert |
| `team_overdue_threshold` | 20 | Total team overdue for alert |
| `escalate_chronic_overdue` | TRUE | Enable chronic overdue alerts |

### Finding the team_updates_space_id

1. Open Google Chat in a browser
2. Navigate to the #team-updates space
3. The URL will be: `https://chat.google.com/room/XXXXXXXX`
4. The space ID is: `spaces/XXXXXXXX`

---

## 7. Monitoring & Maintenance

### Daily Checks

| What to Check | Where |
|---------------|-------|
| Trigger execution | Apps Script > Executions (sidebar) |
| Failed executions | Filter by "Failed" status in Executions |
| BigQuery data | Check today's rows in key tables |
| Bot responsiveness | Send a test message to the bot |

### Weekly Checks

| What to Check | Where |
|---------------|-------|
| Trigger count | Run `listAllTriggers()` — should be 18 |
| API quotas | GCP Console > APIs & Services > Dashboard |
| BigQuery costs | GCP Billing dashboard |
| Gamification | Verify Friday badges were awarded |

### Common Issues

| Issue | Diagnosis | Fix |
|-------|-----------|-----|
| Bot not responding | Check Executions for errors | Redeploy new version |
| Triggers stopped | Trigger quota exceeded or deleted | Run `createScheduledTriggers()` |
| Cards not showing | Service account token expired | Verify with `testServiceAccount()` |
| No DMs sent | DM_SPACES empty or missing user | Have user message bot first |
| ClickUp 401 | API token revoked or expired | Generate new token, update Script Property |
| BigQuery errors | Dataset or permissions changed | Verify project ID and dataset access |
| Odoo auth fails | API key changed or DB name wrong | Run `testOdooConnection()`, update credentials |
| Sage HR empty | API key expired | Generate new key, run `testSageHRConnection()` |

### Logs Location

| Log Type | Where to Find |
|----------|---------------|
| Execution logs | Apps Script > Executions |
| Console output | Apps Script > Execution log (per execution) |
| System events | BigQuery `system_events` table |
| Escalations | BigQuery `escalations` table |
| Errors | BigQuery `bot_errors` table (currently unused — dead code) |

---

## 8. Security Checklist

Before going to production, verify:

- [ ] All API tokens stored in Script Properties (not in code or sheets)
- [ ] Service account key removed from `setupServiceAccountKey()` code after setup
- [ ] `CLICKUP_API_TOKEN` rotated (not the one from development)
- [ ] `ODOO_API_KEY` is production credential
- [ ] `OPENAI_API_KEY` has usage limits set in OpenAI dashboard
- [ ] Config Sheet is restricted to authorized editors only
- [ ] Apps Script project is restricted to organization
- [ ] Google Chat API visibility restricted to organization domain
- [ ] BigQuery dataset access restricted to authorized users
- [ ] `DM_SPACES` is auto-populated (not manually set)

---

## 9. Rollback Procedure

If a deployment causes issues:

1. **Immediate:** In Apps Script > Deploy > Manage deployments > Edit
   - Select the **previous version** from the version dropdown
   - Click Deploy
   - This immediately rolls back to the previous code version

2. **Triggers:** If trigger functions changed, run `createScheduledTriggers()` to reset

3. **Data:** BigQuery data is append-only — no rollback needed for data

4. **Config:** Config sheet changes are independent of code deployments

---

## 10. Deployment Checklist

### Pre-Deployment

- [ ] All code changes tested locally with `clasp push`
- [ ] `runAllTests()` passes
- [ ] `testSendCardMessage()` passes
- [ ] Config sheet has all 10 tabs with correct data
- [ ] BigQuery dataset and tables exist
- [ ] All Script Properties set correctly
- [ ] Service account configured and tested

### Deployment Steps

1. [ ] `clasp push` — push code to Apps Script
2. [ ] Deploy > New deployment > New version > Deploy
3. [ ] Copy Deployment ID to GCP Chat API config (if first deploy)
4. [ ] Run `createScheduledTriggers()` (if triggers changed)
5. [ ] Run `setupBigQueryTables()` (if tables changed)
6. [ ] Run `runAllTests()` — verify all connections
7. [ ] Run `testSendCheckIn()` — verify DMs work
8. [ ] Run `testSendCardMessage()` — verify cards render

### Post-Deployment

- [ ] Monitor first trigger execution in Executions log
- [ ] Verify morning check-in DMs sent correctly
- [ ] Verify summary posted to #team-updates
- [ ] Check BigQuery for new data
- [ ] Confirm no error DMs sent to manager
