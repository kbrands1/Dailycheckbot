# K-Brands Daily Check-in Bot — Complete Overview

**Version:** 3.0 (v45 deployment — Odoo integration, hours tracking, gamification overhaul, PTO/birthday sync, per-person EOD completions, Monday kickoff wins/streaks, half-day holidays, special hours, email mapping, gpt-4o, configurable threshold)
**Last Updated:** February 5, 2026
**Platform:** Google Apps Script → Google Chat Bot
**Integrations:** ClickUp API, Odoo JSON-RPC API, Sage HR API, OpenAI API, BigQuery, Google Sheets

**Source Conversations:**
- Original bot design: https://claude.ai/chat/7f3b6c7f-55ed-4012-8144-c8b358160717
- ClickUp integration: https://claude.ai/chat/b63926fc-b2ad-4a43-879b-db036f096635
- Bot troubleshooting: https://claude.ai/chat/3119d704-a829-4761-8af0-0a36422f34e1
- Review & testing: https://claude.ai/chat/66af0c06-572d-4e33-bfb7-998f68b55d45

---

## 1. Purpose

Automated daily check-in and reporting system for the K-Brands team (~30 members). The bot handles morning attendance tracking, end-of-day reporting with ClickUp task integration, escalation for non-compliance, AI-powered performance evaluations, and weekly gamification.

### In Scope
- Morning check-in via DM + 1 follow-up reminder
- EOD report via DM + 1 follow-up reminder (with ClickUp/Odoo task cards + hours tracking)
- Daily summaries posted to shared channel (with PTO/birthdays in morning, per-person completions + blockers in EOD)
- Monday kickoff with last week's wins, active streaks, and weekly task load preview
- Friday gamification and leaderboards (14 badge types)
- AI evaluation of tasks (OpenAI gpt-4o, configurable) — sent to Khalid + Danyal (configurable)
- Automatic PTO/birthday sync from Sage HR
- ClickUp task sync, status updates, overdue tracking
- Odoo task integration (unified task fetcher supports ClickUp, Odoo, or both per user)
- Self-reported hours tracking in EOD with ClickUp time estimate comparison
- Configurable schedules including special periods (Ramadan, etc.)
- Half-day holidays (half_pm type — morning triggers run, EOD triggers skip)
- Email mapping (Sage HR email to Google email resolution)
- Capacity warnings (5+ "no time" delays trigger manager alert)

### Out of Scope (Deferred)
- Real-time activity monitoring via Audit Logs
- Inactivity pings (25+ min idle detection)

---

## 2. Stakeholders & Recipients

| Person | Role | Receives | Channel |
|--------|------|----------|---------|
| ~30 Team Members | Staff | Check-in DMs, EOD DMs, follow-ups, task cards | Private DM |
| All Team | Group | Morning summary, EOD summary, Monday kickoff, Friday gamification | #team-updates space |
| Khalid (khalid@k-brands.com) | Manager | Daily AI evaluation, weekly summary, escalation DMs, overdue alerts | Private DM |
| Danyal (danyal@k-brands.com) | Ops Leader | Daily AI evaluation, weekly summary, escalation DMs, overdue alerts | Private DM |

**Note:** AI evaluation recipients are configurable in the config sheet (currently Khalid + Danyal). This was confirmed when Khalid said "AI evaluations sent to Danyal too — so that is configurable."

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    CONFIG SHEET (Google Sheets)               │
│  (Khalid edits this — no code changes needed)                │
│  See Section 8 for tab structure                             │
└────────────────────────┬─────────────────────────────────────┘
                         │ Reads at runtime
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                GOOGLE APPS SCRIPT BOT                        │
│  Scheduled triggers fire throughout the day                  │
│  Event handlers process user responses                       │
├──────────────────────────────────────────────────────────────┤
│  DATA SOURCES:                                               │
│  ├── Sage HR API (employees, PTO, birthdays)                 │
│  ├── ClickUp API (tasks, statuses, due dates)                │
│  ├── Odoo JSON-RPC API (tasks, stages)                       │
│  ├── Google Sheets (config — 10 tabs)                        │
│  └── BigQuery (historical data — 16 tables)                  │
│                                                              │
│  EXTERNAL APIs:                                              │
│  ├── Google Chat API (send/receive DMs + channel posts)      │
│  ├── OpenAI API (AI evaluations + weekly summaries)          │
│  ├── Sage HR API (employee sync, PTO, birthdays)             │
│  ├── ClickUp API (task sync + status updates)                │
│  └── Odoo JSON-RPC API (task fetch + stage updates)          │
│                                                              │
│  STORAGE:                                                    │
│  ├── BigQuery (primary — all check-ins, metrics, snapshots)  │
│  └── Google Sheets (live view — last 7-14 days)              │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. File Structure

14 script files + 1 manifest:

```
/checkin-bot-deploy (Apps Script Project via clasp)
├── Code.js                 # Main entry points (onMessage, onAddToSpace, onCardClick) + all trigger functions
├── Config.js               # Load settings from Google Sheets (10 tabs), unified task fetcher, holiday/special hours logic
├── SageHR.js               # Sage HR API calls (employee sync, PTO, birthdays, leave-today)
├── Chat.js                 # Google Chat API integration (DMs + channel posts) with Service Account for cards
├── BigQuery.js             # Data read/write to BigQuery (16 tables, streak/hours queries)
├── OpenAI.js               # AI evaluation calls + weekly summary generation + hours analysis
├── Gamification.js         # Badge calculations (14 badges), leaderboards, streak/blocker helpers
├── Templates.js            # All message templates + AI prompt builder
├── Utils.js                # Trigger setup (18 triggers), connection tests, manual test helpers
├── Escalation.js           # Individual DM escalations for missed check-ins/EODs + capacity warnings
├── ClickUp.js              # ClickUp API integration (fetch tasks, update status, cache workspace)
├── ClickUpCards.js         # Task cards with action buttons + Odoo task action routing
├── ClickUpSync.js          # Daily task sync, snapshots, overdue tracking, per-person completions
├── OdooService.js          # Odoo 18 JSON-RPC integration (task fetch, normalize, stage updates)
└── appsscript.json         # Manifest with scopes and chat config
```

**Notes:**
- Files use `.js` extension (managed via clasp CLI), deployed as `.gs` in Apps Script
- OverdueReporting functions are merged into ClickUpSync.js
- OdooService.js added in v43 for Odoo task integration
- Service Account auth (Chat.js) enables card rendering in proactive messages

---

## 5. Daily Schedule

### Monday–Thursday

| Time (CT) | Action | Recipient | Type |
|-----------|--------|-----------|------|
| 6:00 AM | Sage HR sync (employees, PTO) | — | Scheduled |
| 6:15 AM | ClickUp task sync (due today/overdue) | — | Scheduled |
| 8:00 AM | Monday kickoff message *(Monday only, posts before individual DMs)* | #team-updates | Scheduled |
| 8:00 AM | Morning check-in DM (with ClickUp/Odoo tasks due today) | Each active person | Scheduled |
| 8:20 AM | Check-in follow-up reminder | Non-responders only | Scheduled |
| 8:35 AM | Morning summary → #team-updates | Channel | Scheduled |
| 8:35 AM | Escalation DM (if still missed) | Employee + Khalid + Danyal | Conditional |
| 4:30 PM | EOD request DM (with ClickUp task cards + action buttons) | Each active person | Scheduled |
| 4:50 PM | EOD follow-up reminder | Non-responders only | Scheduled |
| 5:00 PM | EOD summary → #team-updates | Channel | Scheduled |
| 5:00 PM | Escalation DM (if still missed) | Employee + Khalid + Danyal | Conditional |
| 5:00 PM | Capacity warnings (5+ "no time" delays) | Khalid + Danyal | Conditional |
| 5:15 PM | ClickUp daily snapshot (metrics to BigQuery) | — | Scheduled |
| 5:30 PM | AI evaluation (daily) | Khalid + Danyal (configurable) | Scheduled |

### Friday (Early End — 7:00 AM to 11:00 AM)

| Time (CT) | Action | Recipient | Type |
|-----------|--------|-----------|------|
| 6:00 AM | Sage HR sync + ClickUp sync | — | Scheduled |
| 7:00 AM | Morning check-in DM | Each active person | Scheduled |
| 7:20 AM | Check-in follow-up | Non-responders | Scheduled |
| 7:35 AM | Morning summary → #team-updates | Channel | Scheduled |
| 7:35 AM | Escalation DM (if missed) | Employee + Khalid + Danyal | Conditional |
| 10:15 AM | Weekly gamification → #team-updates | Channel | Scheduled |
| 10:30 AM | EOD request DM | Each active person | Scheduled |
| 10:50 AM | EOD follow-up | Non-responders | Scheduled |
| 11:00 AM | EOD summary → #team-updates | Channel | Scheduled |
| 11:30 AM | AI evaluation + weekly summary | Khalid + Danyal (configurable) | Scheduled |

**Key timing notes:**
- Monday kickoff posts at **8:00 AM** inside the `triggerMorningCheckIns` handler — it posts to the channel BEFORE individual DMs are sent, so it appears first in the channel.
- All trigger times are **fixed in Utils.js** (not dynamically derived from config). To change times, update the trigger setup code and re-run `createScheduledTriggers()`.
- Follow-up = hardcoded 20 min after check-in trigger.
- Summary/Escalation = hardcoded 35 min after check-in trigger.
- EOD triggers skip on `half_pm` holidays (afternoon off) via `isEodWorkday()` check.
- All times are Central Time (America/Chicago).
- During special periods (e.g., Ramadan), work hours adjust but trigger times remain fixed — the late threshold adjusts based on `getTodayWorkHours()` which reads from the `special_hours` config tab.

---

## 6. Message Types (15 Total)

| # | Message | Channel | When |
|---|---------|---------|------|
| 1 | Check-in request (with ClickUp/Odoo tasks) | DM | Morning |
| 2 | Check-in follow-up | DM | Morning + 20 min |
| 3 | Morning summary (with PTO, birthdays, overdue stats) | #team-updates | Morning + 35 min |
| 4 | Monday kickoff (last week wins, streaks, task load) | #team-updates | Monday 8:00 AM |
| 5 | EOD request (with ClickUp/Odoo task cards + action buttons) | DM | Before work end |
| 6 | EOD follow-up (includes hours reminder) | DM | EOD + 20 min |
| 7 | EOD summary (with per-person completions + blockers) | #team-updates | Work end |
| 8 | Friday gamification (badges, leaderboards) | #team-updates | Friday 10:15 AM |
| 9 | AI daily evaluation (with hours analysis) | DM to Khalid + Danyal | After work end |
| 10 | AI weekly summary (with hours trends, outliers) | DM to Khalid + Danyal | Friday 11:30 AM |
| 11 | Escalation (missed check-in) | Individual DMs | After follow-up window |
| 12 | Escalation (missed EOD) | Individual DMs | After follow-up window |
| 13 | Overdue task alert (chronic/threshold) | DM to escalation recipients | During sync/summary |
| 14 | Capacity warning (5+ "no time" delays) | DM to escalation recipients | After EOD summary |
| 15 | System alerts (sync failures) | DM to Khalid | As needed |

---

## 7. Message Flows

### 7.1 Morning Check-in

**Bot DM → Employee:**
```
Good morning {name}! ☀️

📋 Tasks due today:
• [Task 1 from ClickUp] — Due today
• [Task 2 from ClickUp] — Overdue (2 days)

Reply with "here" + your #1 priority for today.
```

**Employee Response:**
```
here - Finish PPC audit for Brand X
```

**Bot Confirmation (on time):**
```
✅ Thanks for checking in! Have a productive day.
```

**Bot Confirmation (late):**
```
✅ Check-in received (late). Thanks for confirming!
```

### 7.2 EOD Report

**Bot DM → Employee:**
```
Hey {name}, time to wrap up! 🌙

📋 Your tasks for today:
┌──────────────────────────────────────┐
│ 🔴 OVERDUE                          │
│ Fix product images — Due Jan 28      │
│ [✅ Done] [🔄 In Progress] [➡️ Tmrw] │
├──────────────────────────────────────┤
│ 🟡 DUE TODAY                        │
│ PPC audit Brand X — Due today        │
│ [✅ Done] [🔄 In Progress] [➡️ Tmrw] │
└──────────────────────────────────────┘

Please also share:
• Other tasks completed today
• Any blockers
• Top priority for tomorrow
```

**Button Actions:**
- ✅ Done → Updates ClickUp status to "complete"
- 🔄 In Progress → Updates ClickUp status to "in progress"
- ➡️ Tomorrow → Moves ClickUp due date to next calendar day (tomorrow.getDate() + 1, set to 5 PM) + captures delay reason

### 7.3 Escalation (Missed Check-in or EOD)

```
Trigger: No response after follow-up reminder (+35 min from original)
Action: Send individual DMs to Employee + each escalation recipient (Khalid + Danyal)
Note: NOT a group DM — each person receives their own private DM via sendEscalationToRecipients()
```

**Missed Check-in Message (sent to each recipient individually):**
```
⚠️ Missed Check-in Alert

{name} has not checked in today.

Please follow up to confirm they are available.
```

**Missed EOD Message (sent to each recipient individually):**
```
⚠️ Missed EOD Report

{name} has not submitted their EOD report.

Please follow up to ensure their day's work is documented.
```

### 7.4 Morning Summary (→ #team-updates)

```
☀️ MORNING CHECK-IN — Monday, Feb 3

✅ CHECKED IN (25/28)
Ali (8:02) · Sara (8:05) · Omar (7:58) ...

⏰ LATE (2)
John (8:22) · Maria (8:19)

❌ MISSING (1)
Ahmed — escalated

🏖️ OUT TODAY (2)
Fatima (PTO) · Bilal (Sick)

🎂 BIRTHDAYS
Happy birthday Sara! 🎉
```

### 7.5 EOD Summary (→ #team-updates)

```
🌙 EOD REPORT — Monday, Feb 3

✅ SUBMITTED (26/28)
Completed tasks: 47 | Blockers reported: 3

📊 TOP COMPLETIONS
Ali: 5 tasks · Sara: 4 tasks · Omar: 4 tasks

🚧 BLOCKERS
• Ali: Waiting on supplier response
• John: Access needed for new tool

❌ MISSING EOD (2)
Ahmed — escalated · Maria — escalated
```

### 7.6 Monday Kickoff (→ #team-updates)

```
🌟 MONDAY KICKOFF - Feb 3, 2026

Good morning team! Here's what we're building on:

🏆 LAST WEEK'S WINS
• Sarah crushed it with 22 tasks - can anyone match it?
• Team logged 312 tasks total
• 94% check-in rate — let's hit 100% this week!

🔥 STREAKS ON THE LINE
• Fatima: 25 days on-time — 5 more for monthly record!
• Ali: 20 days strong — keep it going!
• Omar: 18 days — almost at Ironman badge (20)!

💪 Let's have a great week!
```

### 7.7 Friday Gamification (→ #team-updates)

```
🏆 WEEKLY TEAM AWARDS — Week of Jan 27-31

🎖️ THIS WEEK'S BADGES

🚀 PRODUCTIVITY STAR
   Sarah Ahmed — 22 tasks completed

🌅 EARLY BIRD
   Omar Hassan — Avg check-in 8:41 AM (19 min early)

🦾 IRONMAN
   Fatima Ali — 25 consecutive days on-time!
   Ali Khan — 20 consecutive days on-time!

Have a great weekend! 🎉
```

---

## 8. Configuration (Google Sheets — No Code Changes)

**⚠️ Implementation Note:** The actual code tab names differ from the original design names. Below shows the **actual tab names used in code** (in parentheses where different from design).

### Tab: settings (was: config_general)

| Key | Value | Used By | Description |
|-----|-------|---------|-------------|
| manager_email | khalid@k-brands.com | Multiple | Manager notifications, sync failure alerts, fallback recipient |
| ops_leader_email | danyal@k-brands.com | `getReportRecipients()` | Fallback for escalation recipients |
| ai_eval_recipients | khalid@k-brands.com, danyal@k-brands.com | `getReportRecipients('ai_evaluation')` | Comma-separated list |
| weekly_summary_recipients | khalid@k-brands.com, danyal@k-brands.com | `getReportRecipients('weekly_summary')` | Who gets Friday weekly summary |
| escalation_recipients | khalid@k-brands.com, danyal@k-brands.com | `getReportRecipients('escalation')` | Who gets escalation DMs + overdue alerts |
| team_updates_space_id | spaces/AAAA... | `getTeamUpdatesChannel()` | #team-updates channel space ID |
| late_threshold_min | 15 | `getLateThresholdMin()` | Minutes after work start to count as late |
| openai_model | gpt-4o | `getOpenAIModel()` | Model for AI evaluations (gpt-4o, gpt-4o-mini, etc.) |
| overdue_escalate_days | 5 | `checkChronicOverdueAlerts()` | Days overdue before escalation alert |
| team_overdue_threshold | 20 | `checkTeamOverdueThreshold()` | Team total overdue tasks for alert |
| escalate_chronic_overdue | TRUE | `checkChronicOverdueAlerts()` | Enable/disable chronic overdue alerts |

**Notes:**
- Timezone is hardcoded as `'America/Chicago'` throughout the code, not read from settings.
- `bigquery_project` and `bigquery_dataset` are NOT read from this tab — project comes from Script Property `BIGQUERY_PROJECT_ID`, dataset is hardcoded as `'checkin_bot'` in BigQuery.js.
- Trigger times are fixed in Utils.js, not configurable from this tab.
- Additional keys can be added to this tab; `loadSettingsTab()` loads all key-value pairs dynamically.

### Tab: work_hours (was: config_schedule)

Key-value pairs (NOT a day-by-day table):

| Key | Value | Description |
|-----|-------|-------------|
| default_start | 08:00 | Mon-Thu work start |
| default_end | 17:00 | Mon-Thu work end |
| friday_start | 07:00 | Friday work start |
| friday_end | 11:00 | Friday work end |
| default_hours_per_day | 8 | Expected hours Mon-Thu |
| friday_hours_per_day | 4 | Expected hours Friday |
| timezone | America/Chicago | All times |

**Note:** Trigger times are fixed in Utils.js (not derived from this tab). This tab controls the late threshold calculation and expected hours for AI evaluation. During special periods, `getTodayWorkHours()` overrides these values with the special_hours tab.

### Tab: holidays (was: config_days_off)

| Date | Description | Type |
|------|-------------|------|
| 2026-01-01 | New Year's Day | full |
| 2026-01-19 | MLK Day | full |
| 2026-02-16 | Presidents' Day | full |
| 2026-05-25 | Memorial Day | full |
| 2026-06-19 | Juneteenth | full |
| 2026-07-03 | Independence Day (observed — July 4 is Saturday) | full |
| 2026-09-07 | Labor Day | full |
| 2026-11-26 | Thanksgiving | full |
| 2026-11-27 | Day After Thanksgiving | full |
| 2026-12-24 | Christmas Eve | half_pm |
| 2026-12-25 | Christmas Day | full |
| 2026-12-31 | New Year's Eve | half_pm |
| ... | (add Eid, etc. as needed) | ... |

**Type values:** `full` = no triggers all day. `half_pm` = normal morning triggers, no EOD triggers (team off after noon).

**Note:** The ClickUp source (b63926fc) included the `type` column and half-day holidays. The original design source had a simpler comma-separated list. The MLK Day (Jan 19) and Presidents' Day (Feb 16) dates in the overview are verified correct for 2026; the ClickUp source had these as Jan 20 and Feb 17 which were off by one day.

### Tab: special_hours (was: config_special_hours) — Ramadan, Q4 crunch, etc.

| Period Name | Start Date | End Date | Mon-Thu Start | Mon-Thu End | Fri Start | Fri End |
|-------------|------------|----------|---------------|-------------|-----------|---------|
| Ramadan 2026 | 2026-02-18 | 2026-03-20 | 10:00 AM | 5:00 PM | 10:00 AM | 2:00 PM |

**⚠️ Note:** The original design conversation used Feb 28–Mar 29 (approximate 2025 dates). Corrected here to actual 2026 Ramadan dates (~Feb 18–Mar 20). Final dates depend on moon sighting — verify with local mosque and update before deployment.

When a special period is active, all derived times auto-adjust (check-in, follow-up, EOD, etc.).

### Tab: team_members (was: config_team)

| Email | Name | Department | Manager Email | Active | Custom Start | Custom End | Timezone | Task Source |
|-------|------|------------|---------------|--------|-------------|-----------|----------|-------------|
| ali@k-brands.com | Ali Khan | PPC | khalid@k-brands.com | TRUE | | | America/Chicago | clickup |
| sara@k-brands.com | Sara Ahmed | Operations | khalid@k-brands.com | TRUE | | | America/Chicago | both |

**Task Source values:** `clickup` = tasks from ClickUp only, `odoo` = tasks from Odoo only, `both` = unified view merging ClickUp + Odoo tasks.

**Note:** This tab is the fallback when Sage HR sync fails. When Sage HR is operational, `getCachedWorkingEmployees()` returns data from Sage HR (filtered by leave status) and caches it for 24 hours.

### Gamification Badges (Hardcoded in Gamification.js — no config tab)

**Note:** There is no `config_gamification` tab in the code. All badge definitions are hardcoded in the `BADGES` constant in `Gamification.js`. To enable/disable badges, modify the code directly. The 14 active badges are:

| Badge Key | Name | Criteria (as implemented) | Emoji |
|-----------|------|---------------------------|-------|
| EARLY_BIRD | Early Bird | 3-4 check-in days this week, 0 late | 🌅 |
| PUNCTUAL | Punctual Pro | 5/5 check-in days, 0 late (full week perfect) | ⏰ |
| IRONMAN | Ironman | 20+ day on-time streak AND 5 EODs this week | 🦾 |
| TASK_CRUSHER | Task Crusher | 100% task completion rate for the week | 🎯 |
| ZERO_OVERDUE | Zero Overdue | No overdue tasks all week (must have tasks due) | ⚡ |
| BACKLOG_BUSTER | Backlog Buster | Cleared 5+ overdue tasks in a single day (verified via overdue_snapshots join) | 📉 |
| NO_DELAYS | No Delays | Didn't move any tasks all week (must have tasks due) | 🔥 |
| PRODUCTIVITY_STAR | Productivity Star | Most tasks completed this week (Top 1) | 🚀 |
| ON_TIME_CHAMPION | On-Time Champion | 100% completion rate AND 0 overdue all week | 🏅 |
| CONSISTENCY_KING | Consistency King | 100% monthly check-in rate (workdays only) | 👑 |
| BLOCKER_BUSTER | Blocker Buster | 0 blockers reported for 2+ consecutive weeks | 💪 |
| STREAK_5 | 5-Day Streak | 5 consecutive on-time check-ins | 🔥 |
| STREAK_10 | 10-Day Streak | 10 consecutive on-time check-ins | 🔥🔥 |
| STREAK_20 | 20-Day Streak | 20 consecutive on-time check-ins | 🔥🔥🔥 |

### Tab: email_mapping (was: config_email_mapping) — For Mismatches

| Sage HR Email | Google Email | Notes |
|---------------|--------------|-------|
| sara.ahmed@k-brands.com | sarah.a@k-brands.com | Name variation |
| john@contractor.com | john.ext@k-brands.com | External contractor |

**Purpose:** Handles cases where Sage HR email ≠ Google Workspace email. Bot tries email match first, falls back to this mapping.

### Tab: clickup_config (was: config_clickup)

| Key | Value | Description |
|-----|-------|-------------|
| enabled | TRUE | Enable/disable ClickUp integration entirely |
| include_in_morning | TRUE | Show tasks due today in morning check-in DM |
| include_in_eod | TRUE | Show interactive task cards in EOD DM |
| auto_update | TRUE | Allow status updates from Chat button clicks |
| add_comments | TRUE | Add ClickUp comment when completing via bot |
| show_weekly_monday | TRUE | Show weekly task preview in Monday kickoff |
| overdue_warning | TRUE | Highlight overdue tasks with color coding |
| use_clickup_time_estimates | FALSE | Include ClickUp time estimates in AI evaluation |

### Tab: clickup_user_map (was: config_clickup_users) — Optional

| Google Email | ClickUp User ID | ClickUp Username |
|-------------|-----------------|------------------|
| ali@k-brands.com | 12345678 | ali |
| sara@k-brands.com | 12345679 | sara |

**Note:** This is separate from email_mapping. That tab maps Sage HR → Google; this maps Google → ClickUp. Only needed if Google Workspace emails don't match ClickUp usernames/emails.

### Tab: odoo_config (Odoo integration settings)

| Key | Value | Description |
|-----|-------|-------------|
| enabled | TRUE/FALSE | Enable/disable Odoo integration |
| include_in_morning | TRUE | Show Odoo tasks in morning check-in DM |
| include_in_eod | TRUE | Show Odoo tasks in EOD request |

### Tab: odoo_user_map (Google email → Odoo user mapping)

| Google Email | Odoo User ID | Odoo Username |
|-------------|-------------|---------------|
| sara@k-brands.com | 42 | sara |

**Note:** Only needed if Google email ≠ Odoo login email. The bot can also look up Odoo users by email directly via `res.users` search.

---

## 9. BigQuery Schema

**Dataset:** `checkin_bot`
**Project:** `k-brands-ops` (from Script Property `BIGQUERY_PROJECT_ID`)

### Tables (16) — as defined in `setupBigQueryTables()` in BigQuery.js

| # | Table Name | Purpose | Key Columns |
|---|-----------|---------|-------------|
| 1 | `check_ins` | Morning check-in responses | checkin_id, user_email, checkin_date, checkin_timestamp, response_text, is_late (BOOLEAN), created_at |
| 2 | `eod_reports` | EOD report responses | eod_id, user_email, eod_date, eod_timestamp, tasks_completed, blockers, tomorrow_priority, raw_response, hours_worked (FLOAT), created_at |
| 3 | `missed_checkins` | Missed check-in/EOD events | missed_id, user_email, missed_date, missed_type (CHECKIN/EOD), created_at |
| 4 | `clickup_task_actions` | Button click actions (done/progress/tomorrow) | action_id, timestamp, user_email, task_id, task_name, list_id, list_name, action_type (COMPLETE/IN_PROGRESS/TOMORROW), old_status, new_status, old_due_date, new_due_date, status, source (clickup/odoo) |
| 5 | `task_delays` | Delay reasons from "Tomorrow" button | delay_id, timestamp, user_email, task_id, task_name, original_due_date, new_due_date, delay_reason, delay_count (INTEGER), source (clickup/odoo) |
| 6 | `overdue_snapshots` | Daily overdue task snapshots | snapshot_date, user_email, task_id, task_name, list_name, original_due_date, days_overdue, is_chronic (BOOLEAN), delay_count |
| 7 | `clickup_daily_snapshot` | Per-user daily task metrics | snapshot_date, user_email, tasks_due_today, tasks_overdue, tasks_due_this_week, tasks_completed_today, tasks_moved_tomorrow, completion_rate (FLOAT) |
| 8 | `escalations` | Escalation events (missed check-in/EOD/overdue) | escalation_id, escalation_type (MISSED_CHECKIN/MISSED_EOD/OVERDUE_TASK), user_email, task_id, task_name, days_overdue, recipients (JSON string), created_at |
| 9 | `ai_evaluations` | Daily AI evaluation outputs | evaluation_id, evaluation_date, evaluation_text, team_size, created_at |
| 10 | `badges_awarded` | Badge award history | badge_id, user_email, badge_key, badge_emoji, badge_name, awarded_at |
| 11 | `system_events` | System event audit log | event_id, timestamp, event_type, status, details (JSON string) |
| 12 | `sage_hr_syncs` | Daily Sage HR sync metadata | sync_date, total_employees, active_employees, on_leave_today, working_today |
| 13 | `employees` | Master employee roster | employee_id, email, name, department, position, manager_email, status, start_date, task_source, updated_at |
| 14 | `time_off` | PTO/leave records | time_off_id, user_email, leave_date, leave_type, status, created_at |
| 15 | `gamification_streaks` | Running streak counters | streak_id, user_email, streak_type, current_streak, best_streak, last_updated |
| 16 | `bot_errors` | Error logging | error_id, timestamp, function_name, error_message, error_stack, context |

**Notes:**
- `setupBigQueryTables()` also runs ALTER TABLE migrations to add `hours_worked` to `eod_reports` and `source` to `clickup_task_actions`/`task_delays` for existing deployments.
- BigQuery returns BOOLEAN fields as string `'true'`/`'false'` (not native boolean). Code handles this with `c.is_late === true || c.is_late === 'true'`.
- `sanitizeForBQ()` escapes backslashes, single quotes, and removes semicolons for safe query interpolation.

### Views — None Implemented

No BigQuery views are created by the code. All analytics are done via inline queries in BigQuery.js functions (`getWeeklyTeamStats`, `getActiveStreaks`, `getTeamOverdueSummary`, etc.). Views can be added manually for dashboard use if desired.

**History:** Original design proposed 6 tables + 3 views. ClickUp integration expanded to 14 tables. v45 added `badges_awarded`, `gamification_streaks`, `bot_errors` (16 total). Views were planned but not implemented — all data access is via parameterized queries.

---

## 10. Task Integration (ClickUp + Odoo)

### 10.1 Unified Task Fetcher

The bot supports **ClickUp**, **Odoo**, or **both** per user via the `task_source` column in the `team_members` config tab. The unified fetcher `getTasksForUser(email, period)` in Config.js:

1. Checks the user's `task_source` setting (`clickup`, `odoo`, or `both`)
2. Fetches from the appropriate source(s)
3. Normalizes Odoo tasks to ClickUp-compatible format via `normalizeOdooTasks()`
4. Merges and sorts: overdue first, then by due date

### 10.2 ClickUp Integration

**Daily Sync (6:15 AM):**
- Pull all tasks assigned to team members due today or overdue
- Snapshot overdue task states to BigQuery (for delay tracking)
- Cache workspace structure for 1 hour
- Check chronic overdue + team threshold alerts

**Interactive Task Cards (EOD):**
- Cards with color-coded urgency: 🔴 Overdue, 🟡 Due Today, 🟢 Upcoming
- Action buttons update ClickUp directly via API
- "Tomorrow" button prompts for delay reason before moving due date
- All actions logged to `clickup_task_actions` table with `source: 'clickup'`

**Auto Status Updates:**

| Button Clicked | ClickUp Action |
|----------------|----------------|
| ✅ Done | Status → "complete" |
| 🔄 In Progress | Status → "in progress" |
| ➡️ Tomorrow | Due date → next calendar day (5 PM), log delay reason |

**API Details:**
- **Auth:** API Token stored in Script Properties (`CLICKUP_API_TOKEN`)
- ⚠️ **Security:** Never expose API tokens in documentation or version control. Rotate before production.
- **Rate Limit:** 100 requests/minute per token
- **Caching:** Workspace structure cached for 1 hour via CacheService
- **Lists:** Configured in ClickUp workspace (auto-discovered)

### 10.3 Odoo Integration

**Connection:**
- Uses JSON-RPC API (Odoo 18) via `OdooService.js`
- Auth via `ODOO_API_KEY` (Script Property) + `ODOO_DB` (odoo_config tab or Script Property)
- Authenticates and caches session UID

**Task Operations:**
- Fetch tasks by user email (looks up Odoo user via `res.users` or `odoo_user_map`)
- Normalize to standard shape: `{ id, name, status, dueDate, isOverdue, daysOverdue, source: 'odoo' }`
- Update stages via `write` method on `project.task` model
- Action buttons route through `ClickUpCards.js` with source-aware handling

**Limitations:**
- No workspace caching (simpler API structure)
- Stage names may vary by Odoo configuration
- Time estimates from Odoo not yet integrated into AI eval (ClickUp only)

### 10.4 Overdue/Delay Tracking
- Track how many times a task has been delayed (both ClickUp and Odoo)
- After **3 delays** on same task → alert to escalation recipients (Khalid + Danyal)
- Any task overdue **5+ days** (configurable via `overdue_escalate_days`) → "chronic overdue" alert to escalation recipients (Khalid + Danyal), grouped by assignee
- **5+ "no time" delays** in a week → capacity warning to escalation recipients
- **Team total overdue** exceeds threshold (default 20) → team threshold alert
- All tracked in BigQuery for reporting

---

## 11. Escalation Logic

```
MISSED CHECK-IN FLOW:
8:00 AM  →  Check-in DM sent
8:20 AM  →  Follow-up DM (non-responders only)
8:35 AM  →  Still no response?
             YES → Individual DMs to: Employee + each escalation recipient
             NO  → Continue normally
             Also: Log to missed_checkins table + escalations table

MISSED EOD FLOW:
4:30 PM  →  EOD DM sent
4:50 PM  →  Follow-up DM (non-responders only)
5:00 PM  →  Still no response?
             YES → Individual DMs to: Employee + each escalation recipient
             NO  → Continue normally
             Also: Log to missed_checkins table + escalations table

TASK OVERDUE ESCALATION (checked during morning sync + daily ClickUp sync):
Any task overdue 5+ days     → "Chronic overdue" alert to each escalation recipient (grouped by assignee)
Same task delayed 3+ times   → Alert DM to each escalation recipient
Team total overdue >= 20     → Team threshold alert to manager only

CAPACITY WARNING (checked after EOD summary):
User has 5+ "no time" delays this week → Capacity warning DM to escalation recipients
```

**Note:** Escalations use `sendEscalationToRecipients()` which sends **individual DMs** to each recipient (not group DMs). This was a deliberate design choice (BUG #5 fix) since Google Chat group DM creation requires additional API setup.

---

## 12. Edge Cases Handled

| # | Scenario | Behavior |
|---|----------|----------|
| 1 | Employee on PTO (Sage HR) | Excluded from `getCachedWorkingEmployees()`, shown as "🏖️ Out" in morning summary |
| 2 | Employee in Sage HR but no DM space | Cannot DM — user must message bot first to establish DM space |
| 3 | Employee in Google but not Sage HR | Fallback to `team_members` config tab via `getActiveTeamMembers()` |
| 4 | Employee terminated in Sage HR | Excluded from active roster on next daily sync |
| 5 | Full holiday (type=full) | `isWorkday()` returns false → all triggers skip |
| 6 | Half-day holiday (type=half_pm) | Morning triggers run normally; EOD triggers skip via `isEodWorkday()` |
| 7 | Special period active (Ramadan) | `getTodayWorkHours()` returns special hours; late threshold adjusts accordingly; trigger times remain fixed |
| 8 | Bot receives response outside window | User state is `IDLE` → logged as default message, not duplicate check-in |
| 9 | Late check-in after follow-up | State-based routing accepts it; marked as "late" not "missing" |
| 10 | "here" without active state | Fallback handler catches "here"/"present" even when user state is IDLE |
| 11 | Multiple tasks overdue | Sorted by urgency: overdue first (highest days first), then by due date |
| 12 | Weekend / inactive day | `isWorkday()` returns false for Sat/Sun → triggers exit early |
| 13 | Email mismatch (Sage vs Google) | `email_mapping` tab resolves aliases; `resolveEmail()` function available |
| 14 | Streak broken by PTO/holiday | Streak uses gap > 3 days threshold (weekends/PTO don't break streaks) |
| 15 | Bare number reply (e.g., "6.5") | Updates today's EOD hours via `updateTodayEodHours()` if no active state |
| 16 | Hours not reported in EOD | Bot prompts: "Reply with just a number to log your hours" |
| 17 | Odoo + ClickUp user (task_source=both) | Unified fetcher merges both sources, de-sorted by urgency |
| 18 | ClickUp API fails during sync | Alert DM to manager; morning/EOD proceed with cached/no task data |
| 19 | Sage HR API fails during sync | Fallback to `getActiveTeamMembers()` from config sheet |
| 20 | BigQuery insert fails | `logErrorToSheet()` fallback logs to console (no retry) |

---

## 13. Gamification

### All 14 Badges (hardcoded in `BADGES` constant, Gamification.js)

See Section 8 (Gamification Badges table) for the complete badge reference with exact criteria.

**Badge Categories:**

| Category | Badges | How Earned |
|----------|--------|------------|
| Attendance | Early Bird, Punctual Pro, Ironman | On-time check-in consistency |
| Task Performance | Task Crusher, Zero Overdue, Backlog Buster, No Delays, Productivity Star, On-Time Champion | ClickUp/Odoo task metrics |
| Consistency | Consistency King, Blocker Buster | Monthly check-in rate, blocker-free weeks |
| Streak Milestones | 5-Day, 10-Day, 20-Day Streak | Consecutive on-time check-ins |

**Award Process (in `postWeeklyGamification()`):**
1. `calculateWeeklyBadges()` evaluates all users against all 14 badge criteria
2. Badges are posted to #team-updates as part of the weekly leaderboard
3. Each badge is awarded individually via `awardBadge()`:
   - Logged to `badges_awarded` table in BigQuery
   - DM notification sent to the user: "🎉 Badge Earned! {emoji} {name} — {description}"

### Leaderboards (posted weekly)

| Leaderboard | Source Function | Ranking |
|-------------|----------------|---------|
| Attendance Champions | `buildAttendanceLeaderboard()` | Top 5 by on-time rate, then check-in count |
| Task Completion | `buildTaskCompletionLeaderboard()` | Top 5 by completion rate, then total completed |
| Zero Overdue | `getZeroOverdueList()` | All users with 0 current overdue tasks |

### Negative Indicators (sent privately to escalation recipients)

| Indicator | Trigger | Source |
|-----------|---------|--------|
| 🔴 Overdue Alert | Task overdue 5+ days | `checkChronicOverdueAlerts()` |
| 🟠 Delay Pattern | Same task moved 3+ times | `getRepeatDelayedTasks()` |
| ⚠️ Capacity Warning | "No time" delay reason 5+ times/week | `checkCapacityWarnings()` |
| ⚠️ Team Threshold | Total team overdue ≥ 20 tasks | `checkTeamOverdueThreshold()` |

### Weekly Rhythm

| Day | What Happens |
|-----|-------------|
| Friday 10:15 AM | `postWeeklyGamification()` → badges + leaderboards to #team-updates |
| Friday 11:30 AM | `generateWeeklySummary()` → stats + hours analysis to Khalid + Danyal |
| Monday 8:00 AM | `postMondayKickoff()` → last week's wins, active streaks, weekly task load to #team-updates |

---

## 14. Security

| Item | Implementation |
|------|----------------|
| ClickUp API token | Script Properties only (not in Sheet, not in code) |
| Odoo API key | Script Properties only |
| Sage HR API key | Script Properties only |
| OpenAI API key | Script Properties only |
| Service Account key | Script Properties only (JSON key stored as string) |
| Config Sheet ID | Script Properties only |
| BigQuery Project ID | Script Properties only |
| AI evaluations | Only sent to configured recipients (ai_eval_recipients in settings tab) |
| Birthday data | Visible to all in morning summaries (confirmed OK by Khalid) |
| Individual check-in data | DMs are private; summaries show only name + time |
| DM space IDs | Stored in Script Properties (`DM_SPACES` JSON object) |

**Script Properties to set (via Apps Script → Project Settings → Script Properties):**

| Property | Description | Required |
|----------|-------------|----------|
| `CONFIG_SHEET_ID` | Google Sheet ID for config tabs | Yes |
| `BIGQUERY_PROJECT_ID` | GCP project ID for BigQuery | Yes |
| `SAGE_HR_API_KEY` | Sage HR API token | Yes |
| `OPENAI_API_KEY` | OpenAI API key | Yes |
| `CLICKUP_API_TOKEN` | ClickUp personal API token | Yes (if ClickUp enabled) |
| `ODOO_API_KEY` | Odoo API key/password | Yes (if Odoo enabled) |
| `ODOO_DB` | Odoo database name (find via database selector or admin) | Yes (if Odoo enabled) |
| `SERVICE_ACCOUNT_KEY` | Full JSON contents of GCP service account key file | Yes (for card rendering) |
| `DM_SPACES` | Auto-populated — JSON map of email→space IDs | Auto (don't set manually) |

**⚠️ Security Notes:**
- Never expose API tokens in documentation, code, or version control
- Service account key should be stored via `setupServiceAccountKey()` function, then deleted from code
- Rotate all tokens before production deployment
- `sanitizeForBQ()` protects against SQL injection in BigQuery queries

---

## 15. Error Handling

| Error | Detection | Action | Alert |
|-------|-----------|--------|-------|
| Sage HR API down | `sageHRRequest()` returns null | Fallback to `getActiveTeamMembers()` (config sheet) | DM to manager via `dailySageHRSync()` |
| ClickUp API fails | `getWorkspaceStructure()` returns null | Log, proceed without task data | DM to manager via `dailyClickUpSync()` |
| OpenAI API fails | `callOpenAI()` returns null | Skip evaluation entirely (no retry) | Logged to `system_events` |
| Odoo API fails | `odooJsonRpc()` throws | Skip Odoo tasks, ClickUp tasks still work | Logged to console |
| Employee DM fails | No DM space stored | Skip that user, continue others | Logged to console |
| BigQuery insert fails | `insertIntoBigQuery()` catches error | `logErrorToSheet()` fallback (console only) | None |
| BigQuery query fails | `runBigQueryQuery()` catches error | Returns empty array `[]` | None |
| Individual user error | try/catch in per-user loops | Skip user, continue with others (BUG #11 fix) | Logged to console |
| Config sheet not found | `getConfig()` throws | Fatal — all triggers fail | Stack trace in Apps Script logs |

**Notes:**
- **ClickUp API** has 429 rate-limit retry: `clickUpRequest()` detects HTTP 429, sleeps 60 seconds, then recursively retries the same call. This is the ONLY retry logic in the codebase.
- All other API calls (OpenAI, Sage HR, Odoo, BigQuery) are **single-attempt** with error logging — no retry.
- Per-user loops (morning check-ins, EOD requests) have individual try/catch blocks so one user's error doesn't block others.
- `logBotError()` function exists but is not called from any code path (dead code — available for manual use).
- Errors are primarily visible in the Apps Script Execution Log (not sent as DMs except for sync failures).

---

## 16. Estimated Costs

| Service | Monthly Estimate | Notes |
|---------|-----------------|-------|
| Google Workspace | Already included | — |
| BigQuery | < $1/month | ~22K rows/year is negligible |
| OpenAI API (gpt-4o) | ~$30-60/month | 30 evals/day × ~$0.03-0.06 each |
| Sage HR | Already included | — |
| ClickUp | Already included | — |
| Odoo | Already included | — |
| **Total** | **~$35-65/month** | Mostly OpenAI; actual depends on prompt length and team size |

**Note:** Default model is `gpt-4o` (configurable via `openai_model` setting). Can be switched to `gpt-4o-mini` for ~$5-15/month OpenAI costs if budget is a concern. The AI evaluation prompt includes full task lists, hours analysis, and ClickUp time estimates which increase token count.

---

## 17. Known Issues / Deployment Notes

### Google Chat Bot Deployment
- Bot must be deployed as a **Chat App** (not web app)
- After ANY code change: Deploy → Manage deployments → Edit → **New version** → Deploy
- Bot discovery can take 5-10 minutes after deployment
- "Not responding" errors usually mean: uncaught exception in onMessage, wrong deployment type, or stale deployment version

### Common Troubleshooting

| Issue | Fix |
|-------|-----|
| Bot not discoverable | Check Chat API config in GCP Console, wait 5-10 min |
| "Not responding" | Check Apps Script execution logs, redeploy new version |
| "Chatbot is not allowed" | Check visibility settings, verify domain access |
| Cards not rendering | Verify Card v2 format, check JSON structure |
| Triggers not firing | Run `createScheduledTriggers()` manually, check quotas |
| ClickUp 401 error | Regenerate API token, check Script Properties |
| BigQuery permission error | Verify GCP project ID and dataset permissions |
| `sendMessageToSpace` not working | Ensure Chat advanced service is enabled, check OAuth scopes |

### Required OAuth Scopes (6 — from appsscript.json)
- `https://www.googleapis.com/auth/spreadsheets` — Read/write config sheet
- `https://www.googleapis.com/auth/drive` — File access for config sheet lookup
- `https://www.googleapis.com/auth/script.external_request` — External API calls (ClickUp, Odoo, Sage HR, OpenAI)
- `https://www.googleapis.com/auth/bigquery` — BigQuery read/write
- `https://www.googleapis.com/auth/chat.messages.create` — Send messages to Google Chat spaces
- `https://www.googleapis.com/auth/chat.spaces.readonly` — Read Chat space info for DM routing

### Advanced Services (in appsscript.json)
- BigQuery API v2 (enabled as `BigQuery` advanced service)

