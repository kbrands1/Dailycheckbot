# K-Brands Daily Check-in Bot — Testing Guide

**Version:** v45
**Last Updated:** February 5, 2026
**For:** Developer deploying and testing the bot

---

## 1. Pre-Testing Checklist

Before running any tests, verify the following are configured:

### Script Properties (Apps Script > Project Settings > Script Properties)

| Property | How to Verify |
|----------|---------------|
| `CONFIG_SHEET_ID` | Open Google Sheet with this ID — should have 10 tabs |
| `BIGQUERY_PROJECT_ID` | Run `testBigQueryConnection()` — should print "BigQuery connected" |
| `SAGE_HR_API_KEY` | Run `testSageHRConnection()` — should list employee count |
| `OPENAI_API_KEY` | Run `testOpenAIConnection()` — should print "OpenAI connected" |
| `CLICKUP_API_TOKEN` | Run `testClickUpConnection()` — should list workspace members |
| `ODOO_API_KEY` | Run `testOdooConnection()` — should authenticate successfully |
| `ODOO_DB` | Set to correct database name (find via `discoverOdooDatabases()`) |
| `SERVICE_ACCOUNT_KEY` | Run `testServiceAccount()` — should obtain token |

### Config Sheet Tabs (10 required)

| Tab Name | What to Check |
|----------|---------------|
| `settings` | Has all required keys (manager_email, team_updates_space_id, openai_model, etc.) |
| `team_members` | At least 1 active member with valid email, task_source column exists |
| `work_hours` | Has default_start, default_end, friday_start, friday_end |
| `holidays` | Has date, description, type columns |
| `special_hours` | Exists (can be empty if no special period) |
| `clickup_config` | Has enabled key set to TRUE or FALSE |
| `clickup_user_map` | Exists (can be empty if emails match) |
| `odoo_config` | Has enabled key set to TRUE or FALSE |
| `odoo_user_map` | Exists (can be empty if emails match) |
| `email_mapping` | Exists (can be empty if no mismatches) |

---

## 2. Connection Tests

Run these from Apps Script editor (Run > Select function):

### 2.1 Run All Connection Tests

**Function:** `runAllTests()`

**Expected Output:**
```
=== Connection Tests ===
✅ ClickUp: X lists, Y members
✅ Sage HR: Z employees
✅ OpenAI connected
✅ BigQuery connected
```

If any test fails, fix the corresponding Script Property before proceeding.

### 2.2 Individual Connection Tests

| Function | Tests | Expected |
|----------|-------|----------|
| `testClickUpConnection()` | ClickUp API token + workspace access | Lists and members count |
| `testSageHRConnection()` | Sage HR API key + employee fetch | Employee count > 0 |
| `testOpenAIConnection()` | OpenAI API key + model access | "test ok" response |
| `testBigQueryConnection()` | BigQuery project + dataset access | SELECT 1 succeeds |
| `testOdooConnection()` | Odoo API key + database + auth | "Connection successful" |
| `testServiceAccount()` | Service account key + token generation | Token obtained |

### 2.3 Service Account Card Test

**Function:** `testSendCardMessage()`

**What it tests:** Service account JWT auth + card rendering in DMs

**Prerequisite:** The manager (khalid@k-brands.com) must have first messaged the bot to establish a DM space.

**Expected:** Manager receives a DM with a rendered Card v2 (header: "Test Card").

---

## 3. BigQuery Setup Test

### 3.1 Create Tables

**Function:** `setupBigQueryTables()`

**Expected:** Creates 16 tables in the `checkin_bot` dataset. Run this once before first use.

**Verify:** Check BigQuery console for these 16 tables:
1. `check_ins`
2. `eod_reports`
3. `missed_checkins`
4. `clickup_task_actions`
5. `task_delays`
6. `overdue_snapshots`
7. `clickup_daily_snapshot`
8. `escalations`
9. `ai_evaluations`
10. `badges_awarded`
11. `system_events`
12. `sage_hr_syncs`
13. `employees`
14. `time_off`
15. `gamification_streaks`
16. `bot_errors`

### 3.2 Verify Migrations

The setup function also runs ALTER TABLE migrations:
- Adds `hours_worked` (FLOAT) to `eod_reports`
- Adds `source` (STRING) to `clickup_task_actions`
- Adds `source` (STRING) to `task_delays`

These are idempotent — safe to re-run.

---

## 4. Core Flow Tests

### 4.1 Morning Check-in Flow

**Test 1: Send a test check-in DM**
- **Function:** `testSendCheckIn()`
- **Expected:** Manager receives morning check-in DM with tasks (if any are due today)
- **Verify:** Message includes "Good morning" + task list

**Test 2: Respond to check-in**
- Open the bot DM and reply: `here - Testing check-in flow`
- **Expected:** Bot responds with "Thanks for checking in! Have a productive day."
- **Verify in BigQuery:** https://console.cloud.google.com/bigquery?authuser=0&project=dailycheckbot (`SELECT * FROM checkin_bot.check_ins ORDER BY created_at DESC LIMIT 1`)

**Test 3: Late check-in**
- Reply: `here - Late test`
- **Expected:** Bot responds with "Check-in received (late). Thanks for confirming!"
- **Verify:** `is_late` = true in BigQuery check_ins table (https://console.cloud.google.com/bigquery?authuser=0&project=dailycheckbot&ws=!1m5!1m4!4m3!1sdailycheckbot!2scheckin_bot!3scheck_ins)

### 4.2 EOD Report Flow

**Test 1: Send a test EOD request**
- **Function:** `testSendEodRequest()`
- **Expected:** Manager receives EOD request with interactive task cards (if tasks exist)
- **Verify:** Cards have Done/In Progress/Tomorrow buttons

**Test 2: Click task action buttons**
- Click "Done" on a task card
- **Expected:** Card updates to show "Completed" status, ClickUp/Odoo task status changes
- **Verify in BigQuery:** `SELECT * FROM checkin_bot.clickup_task_actions ORDER BY timestamp DESC LIMIT 1`

**Test 3: Click "Tomorrow" button**
- Click "Tomorrow" on a task card
- **Expected:** Bot asks for delay reason (dropdown)
- Select a reason
- **Expected:** Task due date moves to next calendar day (5 PM), delay logged
- **Verify in BigQuery:** `SELECT * FROM checkin_bot.task_delays ORDER BY timestamp DESC LIMIT 1`

**Test 4: Submit EOD report**
- Reply with: `Completed testing tasks. No blockers. Tomorrow: continue testing.`
- **Expected:** Bot confirms with "EOD report received. Great work today!"
- **Verify in BigQuery:** `SELECT * FROM checkin_bot.eod_reports ORDER BY created_at DESC LIMIT 1`

**Test 5: Submit hours**
- If bot prompts for hours, reply: `8`
- **Expected:** Bot confirms hours logged
- **Verify:** `hours_worked` = 8.0 in latest eod_reports row

### 4.3 Escalation Flow

**Test 1: Simulate missed check-in escalation**
- **Function:** `checkMorningEscalations()`
- **Prerequisite:** At least one team member hasn't checked in today
- **Expected:** Individual DMs sent to: the missing employee + each escalation recipient
- **Verify in BigQuery:** `SELECT * FROM checkin_bot.escalations ORDER BY created_at DESC LIMIT 5`
- **Verify in BigQuery:** `SELECT * FROM checkin_bot.missed_checkins ORDER BY created_at DESC LIMIT 5`

**Test 2: Verify escalation goes to individual DMs (not group)**
- Check that Khalid and Danyal each receive their own separate DM (not a shared group DM)

### 4.4 Summary Posts

**Test 1: Morning summary**
- **Function:** `_postMorningSummary()` (called internally by `triggerMorningSummary()`)
- **Expected:** Posts to #team-updates with checked-in, late, missing sections + PTO/birthdays
- **Verify:** Message appears in team-updates space

**Test 2: EOD summary**
- **Expected:** Posts to #team-updates with submitted, missing, per-person completions, blockers

---

## 5. Integration-Specific Tests

### 5.1 ClickUp Integration

| Test | How | Expected |
|------|-----|----------|
| Task fetch | Run `testSendCheckIn()` with a ClickUp user | Tasks appear in DM |
| Status update | Click "Done" on ClickUp task card | ClickUp task status changes to "complete" |
| Tomorrow move | Click "Tomorrow" + give reason | ClickUp due date = tomorrow 5 PM |
| Rate limit handling | Make rapid API calls | 429 detected, waits 60s, retries |
| Workspace cache | Run task fetch twice within 1 hour | Second call uses cache |
| Daily sync | Run `triggerClickUpSync()` | Overdue snapshots saved to BigQuery |

### 5.2 Odoo Integration

| Test | How | Expected |
|------|-----|----------|
| Connection | Run `testOdooConnection()` | Auth successful, task count shown |
| Task fetch | Set a user's `task_source` to `odoo`, run `getTasksForUser(email, 'today')` | Odoo tasks returned |
| Unified fetch | Set a user's `task_source` to `both`, run `getTasksForUser(email, 'today')` | ClickUp + Odoo tasks merged |
| Stage update | Click "Done" on Odoo task card | Odoo task stage changes |
| Task normalization | Compare Odoo task output format | Has id, name, status, dueDate, isOverdue, source:'odoo' |

### 5.3 Sage HR Integration

| Test | How | Expected |
|------|-----|----------|
| Employee sync | Run `triggerSageHRSync()` | Employees synced, count logged to BigQuery |
| PTO detection | Check if employees on leave are excluded | On-leave employees skip check-in DMs |
| Birthday fetch | Run `getTodayBirthdays()` | Returns today's birthdays (if any) |
| Fallback | Set invalid Sage HR key, run sync | Falls back to team_members config tab |

### 5.4 OpenAI Integration

| Test | How | Expected |
|------|-----|----------|
| Daily eval | Run `triggerAiEvaluation()` | AI evaluation DM sent to recipients |
| Model config | Set `openai_model` to `gpt-4o` in settings tab | Uses gpt-4o for evaluation |
| Weekly summary | Run on Friday or manually call `generateWeeklySummary()` | Weekly summary with hours analysis |
| Failure handling | Set invalid API key, run eval | Skips evaluation, logs to system_events |

---

## 6. Schedule & Trigger Tests

### 6.1 Create Triggers

**Function:** `createScheduledTriggers()`

**Expected:** Creates exactly 18 triggers. Verify with `listAllTriggers()`.

**All 18 triggers:**

| # | Function | Time (CT) | Day |
|---|----------|-----------|-----|
| 1 | `triggerSageHRSync` | 6:00 AM | Daily |
| 2 | `triggerClickUpSync` | 6:15 AM | Daily |
| 3 | `triggerMorningCheckInsFriday` | 7:00 AM | Daily (Friday guard) |
| 4 | `triggerMorningCheckIns` | 8:00 AM | Daily (Mon-Thu guard) |
| 5 | `triggerCheckInFollowUpFriday` | 7:20 AM | Daily (Friday guard) |
| 6 | `triggerCheckInFollowUp` | 8:20 AM | Daily (Mon-Thu guard) |
| 7 | `triggerMorningSummaryFriday` | 7:35 AM | Daily (Friday guard) |
| 8 | `triggerMorningSummary` | 8:35 AM | Daily (Mon-Thu guard) |
| 9 | `triggerEodRequestsFriday` | 10:30 AM | Daily (Friday guard) |
| 10 | `triggerEodRequests` | 4:30 PM | Daily (Mon-Thu guard) |
| 11 | `triggerEodFollowUpFriday` | 10:50 AM | Daily (Friday guard) |
| 12 | `triggerEodFollowUp` | 4:50 PM | Daily (Mon-Thu guard) |
| 13 | `triggerEodSummaryFriday` | 11:00 AM | Daily (Friday guard) |
| 14 | `triggerEodSummary` | 5:00 PM | Daily (Mon-Thu guard) |
| 15 | `triggerClickUpSnapshot` | 5:15 PM | Daily |
| 16 | `triggerAiEvaluationFriday` | 11:30 AM | Daily (Friday guard) |
| 17 | `triggerAiEvaluation` | 5:30 PM | Daily (Mon-Thu guard) |
| 18 | `triggerWeeklyGamification` | 10:15 AM | Daily (Friday guard) |

### 6.2 Day-of-Week Guards

All triggers fire daily but have day-of-week guards inside the handler functions:
- **Mon-Thu triggers:** Exit early if `day === 5` (Friday), `day === 0` (Sunday), or `day === 6` (Saturday)
- **Friday triggers:** Exit early if `day !== 5`
- **Daily triggers (sync, snapshot):** Exit early on weekends only

**Test:** Run a Friday trigger (e.g., `triggerMorningCheckInsFriday()`) on a non-Friday. Expected: function exits early with no action.

### 6.3 Holiday Guards

- **Full holiday:** Run `triggerMorningCheckIns()` on a full holiday date. Expected: `isWorkday()` returns false, trigger skips.
- **Half-day (half_pm):** Run `triggerEodRequests()` on a half_pm holiday. Expected: `isEodWorkday()` returns false, EOD trigger skips. But morning triggers still run.

### 6.4 Special Period (Ramadan)

- Set a special period in the `special_hours` config tab with today's date range
- Run `getTodayWorkHours()` — Expected: returns special period hours instead of defaults
- **Note:** `getLateThresholdMin()` returns the static grace period (e.g., 15m) from settings. The bot calculates the final lateness deadline by adding this to the dynamic start time from `getTodayWorkHours()`.

---

## 7. Gamification Tests

### 7.1 Badge Calculation

**Function:** `calculateWeeklyBadges()` (called by `postWeeklyGamification()`)

**Test:** After a full week of data, run `triggerWeeklyGamification()` on Friday.

**Expected:**
- Badges calculated for all 14 types
- Badges posted to #team-updates channel
- Each badge awarded via `awardBadge()`:
  - Logged to `badges_awarded` BigQuery table
  - DM notification sent to badge recipient

**Verify in BigQuery:**
```sql
SELECT * FROM checkin_bot.badges_awarded ORDER BY awarded_at DESC LIMIT 20
```

### 7.2 Leaderboards

Verify these functions return data after a week of check-ins:
- `buildAttendanceLeaderboard()` — Top 5 by on-time rate
- `buildTaskCompletionLeaderboard()` — Top 5 by completion rate
- `getZeroOverdueList()` — Users with 0 overdue

### 7.3 Streak Tracking

- Check in on-time for 5 consecutive workdays
- **Expected:** `STREAK_5` badge awarded on Friday
- **Verify:** `SELECT * FROM checkin_bot.gamification_streaks WHERE user_email = 'test@k-brands.com'`

### 7.4 Monday Kickoff

**Function:** `postMondayKickoff()` (called inside `triggerMorningCheckIns()` on Monday)

**Test:** Run on a Monday or manually invoke.

**Expected:** Posts to #team-updates with:
- Last week's wins (top performer, total tasks, check-in rate)
- Active streaks
- Weekly task load preview

---

## 8. Edge Case Tests

| # | Test | How to Reproduce | Expected |
|---|------|-----------------|----------|
| 1 | Employee on PTO | Put employee on leave in Sage HR, run sync | Employee excluded from check-in DMs |
| 2 | No DM space | Use email of someone who hasn't messaged bot | Skips that user, continues others |
| 3 | Response outside window | Send "here" when user state is IDLE | Handled as default message, not duplicate |
| 4 | Bare number reply | Send just "6.5" to bot | Updates today's EOD hours |
| 5 | Weekend trigger | Run any trigger on Saturday | Function exits early |
| 6 | Config sheet missing | Set invalid CONFIG_SHEET_ID | Fatal error in logs |
| 7 | ClickUp API fail | Set invalid CLICKUP_API_TOKEN | Alert DM to manager, proceeds without tasks |
| 8 | Multiple tasks overdue | Have 3+ overdue tasks for one user | Sorted by days overdue (highest first) |
| 9 | Email mismatch | Add entry to email_mapping tab | Sage HR email resolved to Google email |
| 10 | Odoo + ClickUp user | Set task_source = "both" for a user | Both task sources merged in DMs |

---

## 9. BigQuery Data Validation

After running a full day cycle, verify data in each table:

```sql
-- Check-ins recorded today
SELECT COUNT(*) as today_checkins FROM checkin_bot.check_ins
WHERE checkin_date = CURRENT_DATE();

-- EOD reports recorded today
SELECT COUNT(*) as today_eods FROM checkin_bot.eod_reports
WHERE eod_date = CURRENT_DATE();

-- Missed check-ins today
SELECT * FROM checkin_bot.missed_checkins
WHERE missed_date = CURRENT_DATE();

-- Task actions today
SELECT * FROM checkin_bot.clickup_task_actions
WHERE DATE(timestamp) = CURRENT_DATE();

-- Escalations today
SELECT * FROM checkin_bot.escalations
WHERE DATE(created_at) = CURRENT_DATE();

-- System events today
SELECT * FROM checkin_bot.system_events
WHERE DATE(timestamp) = CURRENT_DATE()
ORDER BY timestamp DESC;

-- Sage HR sync status
SELECT * FROM checkin_bot.sage_hr_syncs
WHERE sync_date = CURRENT_DATE();

-- AI evaluation today
SELECT * FROM checkin_bot.ai_evaluations
WHERE evaluation_date = CURRENT_DATE();
```

---

## 10. Error Handling Validation

| Scenario | How to Test | Expected Behavior |
|----------|-------------|-------------------|
| Sage HR down | Set invalid API key temporarily | Falls back to team_members tab, DM to manager |
| ClickUp down | Set invalid API token temporarily | Logs error, proceeds without task data, DM to manager |
| OpenAI down | Set invalid API key temporarily | Skips evaluation, logs to system_events |
| Odoo down | Set invalid API key temporarily | Skips Odoo tasks, ClickUp still works, logs to console |
| BigQuery write fail | Set invalid project ID temporarily | `logErrorToSheet()` fallback to console |
| Single user DM fail | Remove a user's DM space from DM_SPACES | Skips that user, continues with others |
| ClickUp 429 rate limit | Make many rapid API calls | Waits 60s, retries automatically |

**Important:** After testing error scenarios, restore the correct credentials immediately.

---

## 11. Full Day Simulation

To run a complete day cycle manually (Mon-Thu):

```
Step 1:  Run triggerSageHRSync()           → Syncs employees
Step 2:  Run triggerClickUpSync()          → Syncs tasks, overdue snapshots
Step 3:  Run triggerMorningCheckIns()      → Sends check-in DMs
         → Respond to check-in DM
Step 4:  Run triggerCheckInFollowUp()      → Sends follow-ups to non-responders
Step 5:  Run triggerMorningSummary()        → Posts morning summary + escalations
Step 6:  Run triggerEodRequests()          → Sends EOD DMs with task cards
         → Click task buttons, submit EOD report
Step 7:  Run triggerEodFollowUp()          → Sends follow-ups to non-responders
Step 8:  Run triggerEodSummary()           → Posts EOD summary + escalations + capacity warnings
Step 9:  Run triggerClickUpSnapshot()      → Saves daily metrics to BigQuery
Step 10: Run triggerAiEvaluation()         → Generates and sends AI evaluation
```

For Friday simulation, use the Friday-specific trigger functions instead.

---

## 12. Acceptance Criteria

The bot is ready for production when ALL of the following pass:

- [ ] All 5 connection tests pass (`runAllTests()` + `testOdooConnection()`)
- [ ] Service account card test passes (`testSendCardMessage()`)
- [ ] 16 BigQuery tables created (`setupBigQueryTables()`)
- [ ] 18 triggers created (`createScheduledTriggers()` + verify with `listAllTriggers()`)
- [ ] Morning check-in DM received and response processed correctly
- [ ] EOD request DM received with interactive task cards
- [ ] Task action buttons update ClickUp/Odoo status correctly
- [ ] "Tomorrow" button moves due date to next calendar day and logs delay
- [ ] Escalation sends individual DMs (not group DM) to employee + recipients
- [ ] Morning summary posts to #team-updates with PTO and birthdays
- [ ] EOD summary posts with per-person completions and blockers
- [ ] AI evaluation generates and sends to configured recipients
- [ ] Holidays (full + half_pm) correctly gate trigger execution
- [ ] At least one user with task_source = "odoo" can see Odoo tasks
- [ ] BigQuery tables contain data after a full day simulation
- [ ] Error handling: each API failure degrades gracefully (no crashes)
