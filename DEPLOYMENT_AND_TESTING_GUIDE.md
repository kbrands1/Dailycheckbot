# Daily Check-in Bot V2 - Deployment, Testing & Onboarding Guide

---

## Part 1: Pre-Deployment Setup

### 1.1 Google Cloud Project Requirements

| Requirement | Details |
|-------------|---------|
| GCP Project | Must have BigQuery API and Google Chat API enabled |
| Service Account | JSON key with BigQuery + Chat Bot scopes |
| BigQuery Dataset | `checkin_bot` dataset in your project |
| Apps Script | V8 runtime, advanced BigQuery service enabled |

### 1.2 Script Properties (Set in Apps Script > Project Settings > Script Properties)

| Property Key | Value | Required |
|-------------|-------|----------|
| `CONFIG_SHEET_ID` | Google Sheets ID for config spreadsheet | Yes |
| `BIGQUERY_PROJECT_ID` | Your GCP project ID | Yes |
| `SERVICE_ACCOUNT_KEY` | Full JSON key file content (paste entire JSON) | Yes |
| `OPENAI_API_KEY` | OpenAI API key | Yes |
| `SAGE_HR_API_KEY` | Sage HR API key | Yes (if using Sage HR) |
| `CLICKUP_API_TOKEN` | ClickUp personal/workspace token | Yes (if using ClickUp) |
| `ODOO_API_KEY` | Odoo API key | Optional |

### 1.3 Config Spreadsheet Setup

Create a Google Sheet with these tabs (exact tab names matter):

#### Tab: `settings`
| key | value |
|-----|-------|
| `manager_email` | manager@yourcompany.com |
| `ops_leader_email` | ops@yourcompany.com |
| `escalation_recipients` | manager@yourcompany.com,ops@yourcompany.com |
| `ai_eval_recipients` | manager@yourcompany.com |
| `weekly_summary_recipients` | manager@yourcompany.com |
| `adoption_report_recipients` | manager@yourcompany.com |
| `team_updates_space_id` | spaces/XXXXXXXXX (Google Chat space ID) |
| `team_channel_id` | spaces/XXXXXXXXX (for standup digests) |
| `enable_ai_eod_parsing` | true |
| `openai_model` | gpt-4o-mini |
| `late_threshold_min` | 15 |
| `blocker_escalation_days` | 2 |
| `enable_standup_digest` | true |
| `use_clickup_time_estimates` | false |

#### Tab: `team_members`
| email | name | department | manager_email | active | custom_start_time | custom_end_time | timezone | task_source | tracking_mode | custom_block2_start | custom_block2_end |
|-------|------|------------|---------------|--------|-------------------|-----------------|----------|-------------|---------------|---------------------|-------------------|
| john@co.com | John Smith | Engineering | manager@co.com | TRUE | 08:00 | 17:00 | America/Chicago | clickup | tracked | | |
| sara@co.com | Sara Jones | Design | manager@co.com | TRUE | 09:00 | 13:00 | America/Chicago | clickup | tracked | 20:00 | 23:00 |
| ceo@co.com | CEO | Executive | | TRUE | | | America/Chicago | | not_tracked | | |

**Column notes:**
- `tracking_mode`: `tracked` (default) = receives prompts and is tracked. `not_tracked` = no prompts, but still appears in reports as "not tracked". Can still DM the bot voluntarily.
- `custom_start_time` / `custom_end_time`: Block 1 work hours. Leave blank to use global defaults.
- `custom_block2_start` / `custom_block2_end`: Optional Block 2 for split-shift employees (e.g. Ramadan evening block). Leave blank for single-block schedules.

#### Tab: `work_hours`
| key | value |
|-----|-------|
| `default_start` | 08:00 |
| `default_end` | 17:00 |
| `friday_start` | 07:00 |
| `friday_end` | 11:30 |
| `default_hours_per_day` | 8 |
| `friday_hours_per_day` | 4 |
| `timezone` | 'America/Chicago' |

#### Tab: `holidays`
| date | name | type |
|------|------|------|
| 2025-12-25 | Christmas | full |
| 2025-12-31 | NYE | half_am |

#### Tab: `clickup_config`
| key | value |
|-----|-------|
| `enabled` | true |
| `include_in_morning` | true |
| `include_in_eod` | true |
| `auto_update` | true |
| `add_comments` | true |
| `show_weekly_monday` | true |
| `overdue_warning` | true |
| `use_clickup_time_estimates` | false |

#### Tab: `clickup_user_map`
| email | clickup_user_id | clickup_username |
|-------|-----------------|------------------|
| john@co.com | 12345678 | johnsmith |

#### Tab: `odoo_config`
| key | value |
|-----|-------|
| `enabled` | false |
| `include_in_morning` | false |
| `include_in_eod` | false |

#### Tab: `odoo_user_map`
| email | odoo_user_id | odoo_username |
|-------|-------------|---------------|

#### Tab: `special_hours` (for Ramadan, crunch periods, etc.)
| period_name | start_date | end_date | mt_start | mt_end | fri_start | fri_end | mt_block2_start | mt_block2_end | fri_block2_start | fri_block2_end |
|-------------|------------|----------|----------|--------|-----------|---------|-----------------|---------------|------------------|----------------|
| Ramadan 2025 | 2025-02-28 | 2025-03-30 | 09:00 | 13:00 | 09:00 | 12:00 | 20:00 | 23:00 | | |
| Q4 Crunch | 2025-11-01 | 2025-12-15 | 08:00 | 18:00 | 08:00 | 14:00 | | | | |

**Column notes:**
- `mt_start` / `mt_end`: Mon-Thu Block 1 hours during this period
- `fri_start` / `fri_end`: Friday Block 1 hours during this period
- `mt_block2_start` / `mt_block2_end`: Optional Mon-Thu Block 2 (e.g. Ramadan evening shift 20:00-23:00). Leave blank for single-block.
- `fri_block2_start` / `fri_block2_end`: Optional Friday Block 2. Leave blank if no Friday evening shift.
- When a special period is active, it overrides global `work_hours` for ALL employees (unless an employee has per-user custom hours, which take priority).

#### Tab: `email_mapping` (for Sage HR email mismatches)
| sage_hr_email | google_email | notes |
|---------------|-------------|-------|

---

## Part 2: Deployment Steps

### Step 1: Import the Project
1. Go to [script.google.com](https://script.google.com) > New Project
2. Go to **Project Settings** > check "Show appsscript.json in editor"
3. Delete the default `Code.gs` content
4. Open `Daily Check-in Bot V2.json` and copy each file's source into the editor:
   - Create new files matching each name (Code, BigQuery, Chat, Config, etc.)
   - Paste the source content into each file
   - For `appsscript.json`, replace the existing content

### Step 2: Set Script Properties
1. Go to **Project Settings** > **Script Properties**
2. Add all 7 properties from Section 1.2 above
3. Double-check the `SERVICE_ACCOUNT_KEY` is the complete JSON (starts with `{` ends with `}`)

### Step 3: Enable Advanced Services
1. In the Apps Script editor, click **Services** (+ icon on the left)
2. Add **BigQuery API** v2

### Step 4: Create BigQuery Tables
Run these in the Apps Script editor (Run > select function):
```
1. setupBigQueryTables()    ← Creates all core tables (16 tables + 1 view)
2. createV2Tables()         ← Creates 3 new V2 tables (prompt_log, daily_adoption_metrics, weekly_adoption_scores)
```

### Step 5: Deploy as Google Chat App
1. Go to **Deploy** > **New Deployment**
2. Type: **Add-on** > **Google Chat app**
3. Description: "Daily Check-in Bot V2"
4. Click **Deploy**
5. In [Google Cloud Console](https://console.cloud.google.com) > **APIs & Services** > **Google Chat API** > **Configuration**:
   - App name: Check-in Bot
   - Avatar URL: your icon
   - Connection settings: Apps Script project
   - Slash commands: (optional, bot uses text commands)
   - Visibility: People and groups in your organization

### Step 6: Deploy Triggers
Run in the Apps Script editor:
```
1. deleteAllTriggers()          ← Clean slate
2. createScheduledTriggers()    ← Deploys all 23 triggers (22 time-based + 1 dispatcher every 30 min)
3. listAllTriggers()            ← Verify all triggers are set (should show 23)
```

### Step 7: Migrate (V1 Upgrade Only)
If upgrading from V1, run:
```
migrateDMSpaces()    ← Converts old DM_SPACES JSON blob to individual properties
```

---

## Part 3: Functional Testing Guide

### 3.1 Connection Tests (Run Each in Apps Script Editor)

| # | Function | What It Verifies | Expected Result |
|---|----------|------------------|-----------------|
| 1 | `testServiceAccount()` | SA key is valid, token generation works | Logs "SA token obtained successfully" |
| 2 | `testSageHRConnection()` | Sage HR API key + endpoint | Returns employee count |
| 3 | `testClickUpConnection()` | ClickUp token + workspace access | Returns workspace structure |
| 4 | `testOpenAIConnection()` | OpenAI API key + model | Returns AI response |
| 5 | `testBigQueryConnection()` | BigQuery dataset access | Returns query results |
| 6 | `runAllTests()` | Runs all above at once | All pass with no errors |

### 3.2 Message Flow Tests (DM the Bot in Google Chat)

**Test A: Basic Responses**
| # | You Send | Expected Response |
|---|----------|-------------------|
| 1 | `hello` | Greeting with current status |
| 2 | `help` | Help message with all commands |
| 3 | `ping` | Uptime/status response |
| 4 | `refresh` | Config cache cleared confirmation |

**Test B: Check-in Flow**
| # | Step | Expected Behavior |
|---|------|-------------------|
| 1 | Wait for morning check-in prompt (or run `testSendCheckIn()`) | Bot DMs you asking to check in |
| 2 | Reply `here` | Bot confirms check-in, marks late/on-time |
| 3 | Check BigQuery `check_ins` table | New row with your email, date, is_late flag |
| 4 | Check BigQuery `prompt_log` table | Row with prompt_type=CHECKIN, response_received=true, latency calculated |

**Test C: EOD Flow**
| # | Step | Expected Behavior |
|---|------|-------------------|
| 1 | Wait for EOD prompt (or run `testSendEodRequest()`) | Bot DMs you asking for EOD report |
| 2 | Reply with a full EOD: `Completed the API integration and fixed login bug. Blocked by server access - waiting on IT. Tomorrow: deploy to staging. 7.5 hours` | Bot confirms, extracts all fields |
| 3 | Check BigQuery `eod_reports` table | Row with tasks, blockers, tomorrow, hours_worked=7.5 |
| 4 | Check BigQuery `prompt_log` table | Row with prompt_type=EOD, response_received=true |

**Test D: Hours Follow-up**
| # | Step | Expected Behavior |
|---|------|-------------------|
| 1 | Submit EOD without hours: `Done with tasks. No blockers. Deploy tomorrow.` | Bot confirms + asks for hours |
| 2 | Reply `8` | Bot logs 8 hours, confirms |
| 3 | Reply `30` (bad value) | Bot warns "30 hours seems too high (max 24)" |

**Test E: Weekend/After-Hours Guard**
| # | Step | Expected Behavior |
|---|------|-------------------|
| 1 | Message bot on Saturday or Sunday | Bot acknowledges but doesn't route to check-in/EOD flow |

**Test F: Task Card Buttons (Requires ClickUp)**
| # | Step | Expected Behavior |
|---|------|-------------------|
| 1 | Receive EOD prompt with task cards (or run `testSendEodRequest()`) | Cards show COMPLETE / TOMORROW / IN PROGRESS buttons |
| 2 | Click COMPLETE | Task status updated in ClickUp, logged to BigQuery |
| 3 | Click TOMORROW | Task due date moved +1 day, delay logged |

**Test G: Manager Commands**
| # | Step | Expected Behavior |
|---|------|-------------------|
| 1 | DM bot: `/prep john` (use actual team member name) | Bot returns 14-day 1-on-1 prep report: attendance, tasks, delays, hours, blockers, EOD quality |
| 2 | Non-manager DMs `/prep john` | Bot responds "only available to managers" |

### 3.3 Trigger Flow Tests (Run in Apps Script Editor)

Run `__testAllTriggers()` to execute all 24 triggers in sequence. Or test individually:

**Morning Flow (run in order):**
```
1. triggerSageHRSync()          ← Syncs employees, checks PTO
2. triggerClickUpSync()         ← Refreshes tasks, checks overdue
3. triggerMorningCheckIns()     ← Sends check-in prompts to all active team
4. triggerCheckInFollowUp()     ← Sends follow-ups to non-responders
5. triggerMorningSummary()      ← Posts summary + standup digest to channel
```

**Afternoon/EOD Flow (run in order):**
```
6. triggerEodRequests()         ← Sends EOD prompts with task cards
7. triggerEodFollowUp()         ← Sends follow-ups to non-submitters
8. triggerEodSummary()          ← Posts EOD summary + EOD digest to channel
9. triggerClickUpSnapshot()     ← Logs daily task completion metrics
10. triggerDailyAdoptionMetrics() ← Computes adoption metrics for each user
11. triggerAiEvaluation()       ← AI generates daily team analysis
```

**Weekly (Friday):**
```
12. triggerWeeklyGamification()        ← Awards badges, posts leaderboards
13. triggerWeeklyAdoptionReport()       ← Sends adoption scores to manager
14. triggerDailyAdoptionMetricsFriday() ← Friday adoption metrics
```

**Mid-Week (Wednesday):**
```
15. triggerMidweekCompliance()  ← Alerts for 2+ missed check-ins/EODs this week
```

### 3.4 Escalation Tests

| # | Test | How to Trigger | Expected |
|---|------|----------------|----------|
| 1 | Missed check-in | Don't respond to check-in, run `triggerMorningSummary()` | Escalation DM to manager + logged to `escalations` table |
| 2 | Missed EOD | Don't respond to EOD, run `triggerEodSummary()` | Escalation DM to manager |
| 3 | Persistent blocker | Submit EODs with same blocker 2+ consecutive days, run `triggerMorningSummary()` | Manager gets persistent blocker alert |
| 4 | Chronic overdue | Move same task to "tomorrow" 3+ times | Repeat delay alert sent |

### 3.5 Split-Shift & Custom Schedule Tests

**Test H: Per-User Custom Hours**
| # | Setup | Test | Expected |
|---|-------|------|----------|
| 1 | Set employee `custom_start_time=10:00`, `custom_end_time=14:00` in config sheet, run `refresh` | Run `triggerScheduleDispatcher()` at 10:00 AM | Employee receives check-in prompt |
| 2 | Same employee replies `here` at 10:20 AM | Check BigQuery `check_ins` | `is_late=true` (10:00 + 15min grace = 10:15, response at 10:20 is late) |
| 3 | Same employee, run `triggerMorningCheckIns()` at 8:00 AM | Check if this employee gets a prompt | Should NOT get a prompt from global trigger (dispatcher handles them) |

**Test I: Split-Shift (Ramadan)**
| # | Setup | Test | Expected |
|---|-------|------|----------|
| 1 | Add Ramadan entry to `special_hours`: mt_start=09:00, mt_end=13:00, mt_block2_start=20:00, mt_block2_end=23:00 | Run `triggerScheduleDispatcher()` at 09:00 AM | All tracked employees receive check-in prompts |
| 2 | Same period active, run `triggerScheduleDispatcher()` at 22:30 PM | Check if EOD prompts sent | Tracked employees should receive EOD prompts (30 min before block 2 ends) |
| 3 | Same period active, run `triggerMorningCheckIns()` at 8:00 AM | Check if any prompts sent | Should NOT send — dispatcher handles all users during split special periods |

**Test J: Tracking Exclusion**
| # | Setup | Test | Expected |
|---|-------|------|----------|
| 1 | Set employee `tracking_mode=not_tracked` in config sheet, run `refresh` | Run `triggerMorningCheckIns()` | Employee should NOT receive check-in prompt |
| 2 | Same employee DMs bot with `here` | Check response | Bot should accept and log the check-in normally (voluntary DM) |
| 3 | Run `triggerMorningSummary()` | Check morning summary in team channel | Employee should appear in "Not tracked" section, NOT in "Missing" section |
| 4 | Run `triggerMidweekCompliance()` | Check compliance alert | Employee should NOT be flagged for missed check-ins/EODs |
| 5 | Run `computeDailyAdoptionMetrics()` | Check `daily_adoption_metrics` table | Employee should NOT have a row (excluded from adoption tracking) |

### 3.6 BigQuery Data Verification

After running all tests, verify these tables have data:

```sql
-- Check core tables
SELECT COUNT(*) FROM `your_project.checkin_bot.check_ins`;
SELECT COUNT(*) FROM `your_project.checkin_bot.eod_reports`;
SELECT COUNT(*) FROM `your_project.checkin_bot.prompt_log`;
SELECT COUNT(*) FROM `your_project.checkin_bot.daily_adoption_metrics`;

-- Check deduplication view
SELECT * FROM `your_project.checkin_bot.v_eod_reports` WHERE eod_date = CURRENT_DATE();

-- Check adoption scores (after Friday run)
SELECT * FROM `your_project.checkin_bot.weekly_adoption_scores` ORDER BY week_start DESC LIMIT 10;
```

---

## Part 4: Complete Trigger Schedule Reference

All times in **America/Chicago (CST/CDT)**.

### Always Running
| Frequency | Function | Purpose |
|-----------|----------|---------|
| Every 30 min | `triggerScheduleDispatcher` | Sends prompts to custom/split-shift employees at their individual times |

### Monday - Thursday
| Time | Function | Purpose |
|------|----------|---------|
| 6:00 AM | `triggerSageHRSync` | Sync employee roster from Sage HR |
| 6:15 AM | `triggerClickUpSync` | Refresh ClickUp tasks, check overdue |
| 8:00 AM | `triggerMorningCheckIns` | Send morning check-in prompts (default-schedule employees only) |
| 8:20 AM | `triggerCheckInFollowUp` | Follow up with non-responders (default-schedule only) |
| 8:35 AM | `triggerMorningSummary` | Post morning summary + standup digest |
| 4:30 PM | `triggerEodRequests` | Send EOD report prompts (default-schedule only) |
| 4:50 PM | `triggerEodFollowUp` | Follow up with non-submitters (default-schedule only) |
| 5:00 PM | `triggerEodSummary` | Post EOD summary + EOD digest |
| 5:15 PM | `triggerClickUpSnapshot` | Snapshot daily task metrics |
| 5:20 PM | `triggerDailyAdoptionMetrics` | Compute adoption metrics |
| 5:30 PM | `triggerAiEvaluation` | AI daily team evaluation |

### Wednesday (Additional)
| Time | Function | Purpose |
|------|----------|---------|
| 10:00 AM | `triggerMidweekCompliance` | Compliance gap alerts |

### Friday
| Time | Function | Purpose |
|------|----------|---------|
| 6:00 AM | `triggerSageHRSync` | Sync employees |
| 6:15 AM | `triggerClickUpSync` | Refresh tasks |
| 7:00 AM | `triggerMorningCheckInsFriday` | Friday check-in (earlier) |
| 7:20 AM | `triggerCheckInFollowUpFriday` | Friday follow-up |
| 7:35 AM | `triggerMorningSummaryFriday` | Friday morning summary |
| 10:15 AM | `triggerWeeklyGamification` | Badges + leaderboards |
| 10:30 AM | `triggerEodRequestsFriday` | Friday EOD (earlier) |
| 10:30 AM | `triggerWeeklyAdoptionReport` | Weekly adoption report |
| 10:50 AM | `triggerEodFollowUpFriday` | Friday EOD follow-up |
| 11:00 AM | `triggerEodSummaryFriday` | Friday EOD summary |
| 11:20 AM | `triggerDailyAdoptionMetricsFriday` | Friday adoption metrics |
| 11:30 AM | `triggerAiEvaluationFriday` | AI weekly summary |

---

## Part 5: Employee Onboarding Guide

### 5.1 Admin Steps (Before the Employee's First Day)

**Step 1: Add to Config Spreadsheet**

Add a row in the `team_members` tab:

| Column | What to Fill |
|--------|-------------|
| `email` | Their Google Workspace email |
| `name` | Display name |
| `department` | Their department |
| `manager_email` | Their manager's email |
| `active` | TRUE |
| `custom_start_time` | Their Block 1 start time (e.g. `08:00`) or leave blank for default |
| `custom_end_time` | Their Block 1 end time (e.g. `17:00`) or leave blank for default |
| `timezone` | `America/Chicago` (or their timezone) |
| `task_source` | `clickup` or `odoo` or leave blank |
| `tracking_mode` | `tracked` (default) or `not_tracked` (senior staff, contractors who don't need daily prompts) |
| `custom_block2_start` | Block 2 start time if they work split shifts (e.g. `20:00`), otherwise leave blank |
| `custom_block2_end` | Block 2 end time if they work split shifts (e.g. `23:00`), otherwise leave blank |

**Step 2: Add ClickUp Mapping (if using ClickUp)**

Add a row in the `clickup_user_map` tab:

| Column | What to Fill |
|--------|-------------|
| `email` | Same email as team_members |
| `clickup_user_id` | Their ClickUp user ID (find in ClickUp > Settings > People) |
| `clickup_username` | Their ClickUp display name |

**Step 3: Add Odoo Mapping (if using Odoo)**

Same as ClickUp but in the `odoo_user_map` tab.

**Step 4: Add Email Mapping (if Sage HR email differs)**

If their Sage HR email differs from their Google email, add a row in `email_mapping`:

| sage_hr_email | google_email | notes |
|---------------|-------------|-------|
| john.smith@old.com | john@company.com | Legacy email |

**Step 5: Clear Config Cache**

Run `clearConfigCache()` in the Apps Script editor, or DM the bot `refresh` from the manager account. This ensures the new employee is picked up on the next trigger cycle.

### 5.2 Employee Steps

**Step 1: Start a DM with the Bot**
1. Open Google Chat
2. Click **+ New chat** or **Find people, spaces, bots**
3. Search for **Check-in Bot**
4. Click to start a conversation
5. Send any message (e.g. `hello`) - this registers your DM space so the bot can message you proactively

**Step 2: Understand the Daily Flow**

The bot will message you automatically at these times:

**Morning (8:00 AM Mon-Thu / 7:00 AM Fri, or at your custom start time if configured):**
- You'll receive a check-in prompt
- Reply with `here`, `present`, or `I'm here` to confirm you're online
- If you have ClickUp tasks, you'll see task cards with buttons:
  - **COMPLETE** - Mark task done
  - **TOMORROW** - Push to tomorrow (you'll be asked for a reason)
  - **IN PROGRESS** - Mark as working on it
- You have ~20 minutes before a follow-up reminder

**End of Day (4:30 PM Mon-Thu / 10:30 AM Fri, or 30 min before your last block ends if on custom schedule):**
- You'll receive an EOD report prompt
- Reply with a message covering:
  1. **What you completed** today
  2. **Any blockers** you're facing
  3. **Tomorrow's priority** / plan
  4. **Hours worked** (e.g. "8 hours" or just "8")
- Example response:
  ```
  Completed the API integration and code review for the auth module.
  Blocked by: waiting on staging server access from IT.
  Tomorrow: deploy auth module to staging, start unit tests.
  7.5 hours
  ```
- If you forget hours, the bot will ask - just reply with a number

**Step 3: Available Commands**

| Command | What It Does |
|---------|-------------|
| `hello` / `hi` | Bot greets you with current status |
| `help` | Shows all available commands and usage |
| `refresh` | Clears cached config (admin use) |
| Any number (e.g. `8`) | Logs hours for today's EOD |

**Step 4: What Happens If You Don't Respond**
- After ~20 minutes, you get a follow-up reminder
- If you still don't respond, your manager is notified
- Missed check-ins/EODs are tracked and visible in weekly reports

### 5.3 Manager-Specific Features

**1-on-1 Prep Report:**
DM the bot with `/prep {employee name}` to get a 14-day summary:
- Attendance record (on-time vs late, missed days)
- Task completion stats (completed, delayed, overdue)
- Chronic delays (tasks pushed 3+ times)
- Hours trend (average per day)
- Recent blockers
- EOD quality assessment

**Weekly Reports You'll Receive:**
- **Standup Digest** (daily) - Who's here, who's late, who's missing
- **EOD Digest** (daily) - Completion summary, blockers, hours
- **AI Evaluation** (daily) - AI-generated team performance analysis
- **Gamification** (Friday) - Badges earned, leaderboards
- **Adoption Report** (Friday) - Team engagement scores, flagged members (<70/100)
- **Midweek Compliance** (Wednesday) - Alert if anyone missed 2+ check-ins/EODs

**Escalation Alerts:**
- Missed check-in/EOD notifications
- Persistent blockers (same blocker 2+ consecutive days)
- Chronic task delays (same task pushed 3+ times)
- Capacity warnings (5+ "no time" delays in a week)

### 5.4 Quick-Start Checklist for New Employees

- [ ] Google Chat account is active
- [ ] Added to `team_members` tab in config sheet
- [ ] `tracking_mode` set correctly (`tracked` or `not_tracked`)
- [ ] Custom hours set if they don't follow the default schedule
- [ ] Split-shift Block 2 set if applicable (e.g. Ramadan evening hours)
- [ ] Added to `clickup_user_map` (if using ClickUp)
- [ ] Config cache cleared (`refresh` or `clearConfigCache()`)
- [ ] Employee has DM'd the bot at least once (to register DM space)
- [ ] Employee responded to first morning check-in (if tracked)
- [ ] Employee submitted first EOD report (if tracked)
- [ ] Verified data appears in BigQuery `check_ins` and `eod_reports` tables

---

## Part 6: Troubleshooting

| Problem | Likely Cause | Fix |
|---------|-------------|-----|
| Bot doesn't DM new employee | DM space not registered | Have employee DM the bot first with `hello` |
| "SA token missing" in logs | Service account key expired or invalid | Re-paste `SERVICE_ACCOUNT_KEY` in Script Properties |
| Cards show as text-only | SA token failing, falls back to text | Check service account has Chat Bot scope |
| Check-in not logged | BigQuery tables not created | Run `setupBigQueryTables()` |
| Adoption metrics empty | V2 tables not created | Run `createV2Tables()` |
| Employee not receiving prompts | Not in `team_members` or `active=FALSE` | Check config sheet, set active=TRUE, run `refresh` |
| "Built-in fallback" warnings | SA key issue with BigQuery | Verify `BIGQUERY_PROJECT_ID` matches SA project |
| Duplicate check-ins | Deduplication working correctly | This is expected - duplicates are silently skipped |
| Triggers not firing | Triggers not deployed | Run `listAllTriggers()` to check, then `createScheduledTriggers()` |
| OpenAI parsing failing | API key invalid or model not available | Check `OPENAI_API_KEY`, try `gpt-4o-mini` as model |
| Weekend messages not blocked | TEST_MODE is true | Set `TEST_MODE = false` in Code.gs |
| `/prep` not working | User is not a manager | Only `manager_email` or `ops_leader_email` can use `/prep` |
| Config changes not taking effect | Config is cached for 5 minutes | DM bot `refresh` or wait 5 minutes |
| Custom-schedule employee not getting prompts | Dispatcher not deployed | Run `listAllTriggers()` — should show 24. If missing, run `createScheduledTriggers()` |
| Custom-schedule employee gets prompts at wrong time | Dispatcher runs every 30 min | Prompts may arrive up to 15 min after the target time due to 30-min interval + 15-min window |
| Not-tracked employee still getting prompts | Config cache stale | Run `refresh` or `clearConfigCache()` after changing `tracking_mode` |
| Not-tracked employee showing as "missing" | Digest/summary not filtering | Verify `tracking_mode` column is exactly `not_tracked` (no typos, no extra spaces) |
| Split-shift Block 2 not working | Columns empty or misaligned | Check that `mt_block2_start` and `mt_block2_end` are both filled (both required for Block 2 to activate) |
| Everyone getting dispatched during Ramadan but not regular triggers | Expected behavior | During split special periods, the dispatcher handles ALL tracked users; global triggers skip everyone |
| Late threshold wrong for custom-schedule employee | Per-user schedule used | Late = after Block 1 start time + grace minutes (default 15). Verify `custom_start_time` is correct |
