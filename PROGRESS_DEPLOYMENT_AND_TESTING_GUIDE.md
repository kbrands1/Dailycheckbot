## Part 3: Functional Testing Guide

### 3.5 Split-Shift & Custom Schedule Tests

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
