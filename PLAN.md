# Reminders & Calendar — Plan

**Bundle ID:** `io.github.x-o-r-r-o.reminders-calendar` · **Keywords:** `rems`, `radd`, `ract`, `agenda`, `eadd`

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-28):

| Raycast extension | Downloads |
|---|---|
| Apple Reminders (raycast/apple-reminders) | ~120,000 |
| Quick Event (raycast/quick-event) | ~43,000 |
| Quick Calendar (raycast/calendar, a month grid viewer only) | ~25,000 |
| **Total** | **~188,000** |

**Alfred today:** the Gallery’s “Reminders Today” (chrisgrieser, keyword `rem`) lists today’s and overdue reminders and adds reminders due today/tomorrow/+2 days/next Monday with `hh:mm` and `!` priority only. It runs uncompiled `swift` scripts, which need the Xcode Command Line Tools and macOS 15 (issues: no permission prompt without the CLT, `SwiftBridging` errors on macOS 26). Older forum workflows script Reminders.app through AppleScript (“too slow”, launches the app). None parses dates in natural language, adds events, or joins meetings.

**Raycast today:**
- Apple Reminders: a compiled Swift/EventKit helper, chrono-node parsing, lists/priorities/tags (tags faked into notes), recurrence. Open issues: date-parsing regressions (“in x days at xx:xx”, time-only input landing in the past, DD/MM), stale Today list, `spawn … EAGAIN`, permission prompt never shown from the AI extension.
- Quick Event: Sherlock.js parsing, then Calendar.app AppleScript built by string interpolation (quotes in titles break it, emoji calendar names fail with -1719, off-by-one-hour time-zone bugs, time-zone words end up in the title, events only in the first calendar).
- Quick Calendar: a month grid, no EventKit.

## What makes this one better
- EventKit through the JXA Objective-C bridge: no compiled helper, no Xcode tools, no Reminders.app/Calendar.app launch, macOS 13+. Reading is cached and refreshed in the background, so keystrokes stay fast.
- One parser for reminders, events, snoozing and the agenda’s day filter, tested across time zones, DST changes, locales (date order, 12/24-hour clock, first weekday, local day and month names) and explicit zones (`3pm UTC`, `9am ET`, `+05:30`, `Europe/London`).
- Complete with undo (and undo for snooze, priority, move and add), snooze presets that keep the reminder’s time, delete with a confirmation.
- Agenda with Zoom/Meet/Teams/Webex/FaceTime detection by host name (not substring), ↩ joins; hidden calendars; a day view for any date.
- Quick events with ranges, durations, location, calendar, alerts, recurrence and an overlap warning; text never becomes code.

## Features (v1.0)
- [x] `rems`: overdue + today (sorted by due, priority), then Scheduled / Flagged / All / Completed views and lists with counts; `:view`, `#list`, search over title, notes and list; “Add as a reminder” row when searching
- [x] Reminder rows: ↩ complete, ⌘↩ open in Reminders (`x-apple-reminderkit://REMCDReminder/<id>`), ⌥↩ actions, ⌃↩ delete…, fn↩ open the link, ⌘C title, ⌘L title + due + notes; overdue/today/scheduled icons; `!!!`, ↻ and 🔗 marks
- [x] Undo row (10 minutes) for complete, uncomplete, due date, priority, move and add
- [x] Completed view (last 7 days): ↩ marks as not completed
- [x] Flagged view: flags read from Reminders.app by one AppleScript query in the background (EventKit has no flag), Automation row when refused; can be turned off
- [x] `ract`: presets (In 1 hour, This evening, Tomorrow, This weekend, Next week) keeping the reminder’s time, typed dates, remove the due date, `!` priority, `#` move, complete, open, `delete` with confirmation; target from Alfred variables or a state file
- [x] `radd`: natural language (dates, times, zones, repeats, priority, list, link, notes, quotes), live preview, ⌘↩ add + open, ⌥↩ add as typed, `#` list suggestions, examples; alarm at the due time (configurable); optional default time for date-only reminders
- [x] `agenda`: on now first, today’s all-day events, then upcoming (1–30 days); “in 25 min”; join-link detection; ↩ join (or open, configurable), ⌘↩ the other, ⌥↩ copy link/details; search; a date shows that day (outside the window read directly); `:calendars` to hide/show calendars
- [x] `eadd`: ranges, `for`, `until`, `all day`, `for 3 days`, location after `at`/`@`, `#Calendar`, `alert 10 min before`, repeats, overlap warning from the cached agenda; default calendar, length and alert in the configuration; works with add-only (write-only) access
- [x] Universal Actions “Add to Reminders” / “Add to Calendar” (first line parsed, the rest becomes notes); Hotkeys for `rems` and `agenda`
- [x] Access rows: not asked yet (↩ asks macOS; the dialog names Alfred), denied/restricted (↩ opens Privacy & Security › Reminders/Calendars), write-only calendars

## Tech
- **Stack:** one JXA file (`src/rc.js`) with the ObjC bridge. `EKEventStore` created once per run; `requestFullAccessTo…WithCompletion` on macOS 14+, `requestAccessToEntityType` on 13; completion handlers are JS functions and the run loop is spun until they fire (same for `fetchRemindersMatchingPredicate`).
- **Permission:** TCC charges the request to the responsible app, Alfred. Alfred 5.8 has `NSRemindersUsageDescription` and `NSCalendarsUsageDescription` (not the macOS 14 “FullAccess” keys), which EventKit accepts as the fallback. The dialog only appears when the script runs from Alfred.
- **Bridge pitfalls found:** a JS `null` becomes `NSNull` (crash), so nil is passed as `$()`; NSInteger values arrive as strings; `NSDateComponentUndefined` is NSIntegerMax.
- **Dates:** local wall-clock construction (`new Date(y, m, d, h, mi)`) for every calendar date, so DST keeps the time; absolute durations (`in 2 hours`) add milliseconds. Explicit zones are resolved with `NSTimeZone` (abbreviations, names, offsets). Due dates are Gregorian `NSDateComponents` (with the time zone for timed reminders); all-day due dates have no hour.
- **Caches** (`$alfred_workflow_cache`, 0600, atomic `rename`): `rems.json`, `done.json`, `events.json` (window from today), `flagged.json`, `lists.json`, `cals.json`, `undo.json`, `target.json`. A stale cache is re-read in the foreground when the last read took < 150 ms, otherwise the stale rows show and a detached refresher (`setsid`, mkdir lock with a dead-owner check) updates it while the filter reruns. Actions patch the cache at once. Event notes are never cached (only the detected meeting link); reminder notes are kept (2,000 characters) for search and Large Type.
- **Settings:** hidden calendars in `$alfred_workflow_data/calendars.json`.
- **Speed:** 1,500 reminders: 150–250 ms per keystroke including osascript start-up (cached).
- No network, no dependencies, no compiled code.

## Tests
`tests/test_reminders_calendar.py` runs every Script Filter and action with `osascript` as Alfred does, against a JSON file standing in for EventKit (`RC_TEST_STORE`, the FakeStore). With any `RC_TEST_*` variable and no store the script refuses to run, so tests can’t reach real reminders or calendars; opening URLs, copying and Alfred searches are logged instead. The parser is tested in batches under different `TZ`, `RC_TEST_LOCALE` and `RC_TEST_NOW`. EventKit conversions are checked on unsaved in-memory objects only. Passes with `python3 tests/test_reminders_calendar.py` and with `env -i HOME="$HOME" USER="$USER" TMPDIR="$TMPDIR" PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/python3 tests/test_reminders_calendar.py`.

## Self-audit
- Build: JavaScript `null` passed to Objective-C becomes `NSNull` and crashed `EKRecurrenceRule` and the predicates: nil is now `$()` (found by the in-memory EventKit test); `\u2028` written literally into a regex broke the script.
- Pass 1: bare-number ranges (“pages 10-12”, “score 5 - 6”) became times; “game night” / “morning run” set a time; an unknown `#42` vanished from the title; after a failed background read every keystroke re-read in the foreground (up to 20 s); the lock expiry was shorter than the AppleScript flag query; the agenda’s empty search now offers to add the event.
- Pass 2: a huge Universal Action selection was repeated in every row’s variables (capped at 10,000 characters of notes); ⌥↩ “as typed” cleaned and cut the title; a read-only default list made adding fail; README wording.
- Pass 3: `ract` offered “Complete” for a completed reminder; the agenda’s day view didn’t rerun while refreshing.
- Checked each pass: `Object.create(null)` for every lookup of typed words, curly apostrophes, stable uids, `arg` on every valid row and modifier, nothing printed by silent actions, atomic 0600 cache writes, dead-owner locks, macOS 13 paths (`requestAccessToEntityType`, status 3 = authorized), no LANG and a bare PATH, paths with spaces, config values `1`/`0`/padded/empty/garbage, 80–90 ms per keystroke with the fake store (1,500 reminders: < 250 ms).

## Known limitations
- EventKit has no flags, tags, sections, subtasks or attachments. Flags are read (not set) through Reminders.app; tags typed as `#word` pick a list instead.
- The reminder `URL` field EventKit writes may not show in Reminders.app on every macOS version; fn↩ also finds links in the notes.
- Completing a repeating reminder is left to EventKit (Reminders.app moves it to the next date).
- A weekday on its own is always the next one, never today (“today” exists for that).
- Words after “at” become the event’s location (“look at the report” too); turn it off in the configuration or use quotes.
- `ical://ekevent/…` (open in Calendar) is undocumented.

## Verify in real Alfred
- [ ] First `rems`: the access row appears; ↩ shows the macOS dialog naming Alfred (macOS 14+: full access; macOS 13: legacy); Allow reopens `rems` with real reminders. Same for `agenda` and Calendars. With “Don’t Allow”, ↩ opens Privacy & Security › Reminders/Calendars.
- [ ] The dialog appears even though Alfred lacks the macOS 14 “FullAccess” usage keys (if not: document `tccutil reset Reminders com.runningwithcrayons.Alfred`).
- [ ] `fetchRemindersMatchingPredicate` completes under Alfred (run-loop spin) and a large library refreshes in the background with `rerun`.
- [ ] ↩ completes; Reminders.app shows it completed; the undo row restores it; a repeating reminder moves to its next date.
- [ ] ⌘↩ opens the reminder (`x-apple-reminderkit://REMCDReminder/<calendarItemIdentifier>`) on macOS 13–27.
- [ ] ⌥↩/⌃↩ open `ract` with the reminder (variables through the External Trigger, or the state file); snooze keeps the time and moves the alarm; delete asks first.
- [ ] Reminders added with a time notify at that time; all-day ones show without a time; URL/notes show in Reminders.app.
- [ ] Flagged view: the Automation prompt names Alfred; ids from AppleScript (`x-apple-reminder://…`) match EventKit’s `calendarItemIdentifier`.
- [ ] `agenda`: join links open Zoom/Meet/Teams; ⌘↩ opens the event in Calendar (`ical://ekevent/<id>?method=show&options=more`, with the occurrence date for repeating events).
- [ ] `eadd`: the event lands in the default/configured/`#` calendar with the right time zone, alert and repeat; write-only access adds to the default calendar.
- [ ] Universal Actions with multi-line selections; Hotkeys.
- [ ] Workflow Configuration: every option takes effect.
- [ ] Screenshots for every `images/*.png` referenced in the README (demo lists and calendars only).

## Release checklist (Alfred forum + Gallery)
- [x] README: intro, `## Usage` with “via the `kw` keyword” sentences and image placeholders
- [ ] Clean screenshots in `images/` (placeholders are in place)
- [x] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> Action.`
- [x] Every keyword ≥ 3 characters, configurable, no clash with the family (`rem` avoided: Reminders Today uses it)
- [x] Settings in Workflow Configuration; `readme` generated from README.md
- [x] Main icon ≥ 256×256 px
- [x] No self-updater, no downloads, no compiled binaries, no hard-coded user paths, `prefs.plist` git-ignored
- [x] AI assistance disclosed
- [x] Version 1.0.0; `python3 tools/build.py --package` builds `dist/alfred-reminders-calendar-1.0.0.alfredworkflow`
- [ ] GitHub release (by the author)
- [ ] Forum post in “Share your Workflows” (by the author)

## Ideas for v1.1
1. Set flags (AppleScript) and `!!`-style flag syntax; show flags in every view.
2. Location reminders (arriving/leaving) with EKStructuredLocation.
3. Edit a reminder’s title and notes from `ract`; convert a reminder into an event.
4. Menu-bar-style “next meeting” Hotkey that joins the current meeting directly.
5. Delete and move events from `agenda`; accept/decline invitations (read-only in EventKit, so via Calendar).
6. Subtasks and tags when EventKit exposes them.
