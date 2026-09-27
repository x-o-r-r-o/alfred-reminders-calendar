#!/usr/bin/osascript -l JavaScript
// Reminders & Calendar for Alfred: list, search, add, complete, snooze and delete reminders; show the
// agenda, join meetings and add events, all through EventKit (the JXA Objective-C bridge).
// Usage: osascript -l JavaScript rc.js <mode> [query]
//   rems <query>     Script Filter: reminder views, lists and search       (keyword `rems`)
//   radd <query>     Script Filter: add a reminder in natural language      (keyword `radd`)
//   ract <query>     Script Filter: change the due date, priority or list, delete (keyword `ract`, ⌥↩/⌃↩)
//   agenda <query>   Script Filter: today's and upcoming events             (keyword `agenda`)
//   eadd <query>     Script Filter: add an event in natural language        (keyword `eadd`)
//   act              action chosen by $rc_action; prints a message for the notification
//   target <query>   remembers the reminder for `ract`, prints the query to open it with
//   bg-rems / bg-done / bg-events / bg-flagged   background refreshers (started detached)
//   parse            tests only: parses the JSON array in $RC_TEST_PARSE and prints the results
//
// Reminders and events are read and written through EventKit. Nothing the user typed is put into
// script source: text reaches EventKit as object properties and AppleScript isn't used except to read
// which reminders are flagged (EventKit has no flag), which runs a fixed script.
//
// Tests set RC_TEST_STORE to a JSON file that stands in for EventKit (see FakeStore). With any RC_TEST_*
// variable set and RC_TEST_STORE missing, the script refuses to run, so a test can never reach real data.
ObjC.import("Foundation");
ObjC.import("AppKit");
ObjC.bindFunction("setsid", ["int", []]);
ObjC.bindFunction("kill", ["int", ["int", "int"]]);
ObjC.bindFunction("rename", ["int", ["char *", "char *"]]);

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}
const FM = $.NSFileManager.defaultManager;
const PID = $.NSProcessInfo.processInfo.processIdentifier;
const ENV_KEYS = ObjC.deepUnwrap(ENV.allKeys) || [];
const TEST = ENV_KEYS.some((k) => k.indexOf("RC_TEST_") === 0);
const TEST_STORE = env("RC_TEST_STORE", "");
const ALFRED = "com.runningwithcrayons.Alfred";

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const MAX_ROWS = 50;
const CACHE_VERSION = 1;
const REM_TTL = 30 * 1000; // reminders are re-read after this long
const EV_TTL = 60 * 1000; // events too
const FLAG_TTL = 120 * 1000; // flagged reminders (AppleScript) too
const SYNC_BUDGET = 150; // ms: refresh in the foreground when the last read took less than this
const LOCK_EXPIRY = 600; // s; longer than any refresher can run (AppleScript: 3 queries × 120 s)
const UNDO_TTL = 10 * 60 * 1000;
const TARGET_TTL = 30 * 60 * 1000;
const NOTES_MAX = 2000; // characters of a reminder's notes kept in the cache
const PAYLOAD_NOTES = 10000; // characters of notes a new reminder or event can get from the typed or selected text
const UNDEF = 9.2e18; // NSDateComponentUndefined (NSIntegerMax) arrives as a huge number or a string

function parseLocalISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(s || "").trim());
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
}

function testNow() {
  const v = env("RC_TEST_NOW", "");
  if (!v) return Date.now();
  if (/^\d+$/.test(v)) return Number(v);
  const t = parseLocalISO(v);
  return isNaN(t) ? Date.parse(v) : t;
}
const NOW = testNow();

// ---------- small helpers ----------

function flag(name, fallback) {
  const v = String(env(name, "")).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function choice(name, allowed, fallback) {
  const v = String(env(name, "")).trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function config() {
  const days = Number(choice("agenda_days", ["1", "3", "7", "14", "30"], "7"));
  const dur = Number(choice("event_duration", ["15", "30", "45", "60", "90", "120"], "60"));
  const alertEv = choice("event_alert", ["none", "0", "5", "10", "15", "30", "60"], "none");
  const t = /^\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*$/i.exec(String(env("reminder_time", "")));
  let defTime = null;
  if (t && +(t[2] || 0) < 60) {
    const ap = t[3] ? t[3][0].toLowerCase() : null;
    const h = ap ? (+t[1] % 12) + (ap === "p" ? 12 : 0) : +t[1];
    if ((ap ? +t[1] >= 1 && +t[1] <= 12 : +t[1] < 24)) defTime = { h, mi: +(t[2] || 0) };
  }
  return {
    kwRems: String(env("keyword_rems", "")).trim() || "rems",
    kwAgenda: String(env("keyword_agenda", "")).trim() || "agenda",
    kwEadd: String(env("keyword_eadd", "")).trim() || "eadd",
    list: String(env("default_list", "")).trim(),
    calendar: String(env("default_calendar", "")).trim(),
    days,
    duration: dur,
    alertEvent: alertEv === "none" ? null : Number(alertEv),
    alarm: flag("reminder_alarm", true),
    defTime,
    location: flag("parse_location", true),
    flagged: flag("flagged_view", true),
    joinFirst: choice("event_return", ["join", "open"], "join") === "join",
  };
}

// Case- and accent-insensitive form for matching
function fold(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// Display strings: no control characters or bidi overrides, one line
function clean(s, max = 200) {
  const t = String(s == null ? "" : s)
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029\ufffc]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function mkdirs(dir) {
  FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $({ NSFilePosixPermissions: 448 }), $());
  return dir;
}

function cacheDir() {
  return mkdirs(env("alfred_workflow_cache", `${$.NSTemporaryDirectory().js}alfred-reminders-calendar`));
}

function dataDir() {
  return mkdirs(env("alfred_workflow_data", `${$.NSTemporaryDirectory().js}alfred-reminders-calendar-data`));
}

function readFile(p) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, $());
  return s.isNil() ? null : s.js;
}

function readJSON(p, fallback) {
  const s = readFile(p);
  if (s === null) return fallback;
  try {
    const v = JSON.parse(s);
    return v === null || typeof v !== "object" ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

// Atomic write (temp file + rename), readable only by the user: caches hold reminder titles
function writeFile(p, text) {
  const tmp = `${p}.tmp-${PID}-${Math.random().toString(36).slice(2)}`;
  if (!$(text).writeToFileAtomicallyEncodingError(tmp, false, $.NSUTF8StringEncoding, $())) return false;
  FM.setAttributesOfItemAtPathError($({ NSFilePosixPermissions: 384 }), tmp, $());
  const ok = $.rename(tmp, p) === 0;
  if (!ok) FM.removeItemAtPathError(tmp, $());
  return ok;
}

function removeFile(p) {
  FM.removeItemAtPathError(p, $());
}

function mtime(p) {
  const a = FM.attributesOfItemAtPathError(p, $());
  return a.isNil() ? 0 : a.fileModificationDate.timeIntervalSince1970 * 1000;
}

// A lock is a directory (mkdir is atomic) holding the owner's pid; a dead or expired owner doesn't count
function lockHeld(name) {
  const dir = `${cacheDir()}/${name}.lock`;
  const t = mtime(dir);
  if (!t) return false;
  const info = readJSON(`${dir}/owner.json`, null);
  if (info && Number.isInteger(info.pid) && $.kill(info.pid, 0) === 0 && Date.now() / 1000 - info.started < LOCK_EXPIRY) return true;
  if (!info && Date.now() - t < 5000) return true; // being created
  return false;
}

function takeLock(name) {
  const dir = `${cacheDir()}/${name}.lock`;
  if (!FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, false, $(), $())) {
    if (lockHeld(name)) return false;
    FM.removeItemAtPathError(dir, $());
    if (!FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, false, $(), $())) return false;
  }
  writeFile(`${dir}/owner.json`, JSON.stringify({ pid: PID, started: Date.now() / 1000 }));
  return true;
}

function releaseLock(name) {
  const dir = `${cacheDir()}/${name}.lock`;
  const info = readJSON(`${dir}/owner.json`, null);
  if (!info || info.pid === PID) FM.removeItemAtPathError(dir, $());
}

function scriptPath() {
  const own = env("RC_SCRIPT", "");
  return own || `${FM.currentDirectoryPath.js}/rc.js`;
}

// Start a detached background process of this script; it leaves Alfred's process group itself
function spawn(mode) {
  if (TEST && env("RC_TEST_NO_BG", "") === "1") return 0;
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath("/usr/bin/osascript");
  task.arguments = ["-l", "JavaScript", scriptPath(), mode];
  const nul = $.NSFileHandle.fileHandleWithNullDevice;
  task.standardInput = nul;
  task.standardOutput = nul;
  task.standardError = nul;
  return task.launchAndReturnError($()) ? task.processIdentifier : 0;
}

function testLog(entry) {
  const p = env("RC_TEST_LOG", "");
  if (!TEST) return false;
  const line = String(entry).replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
  if (p) {
    const h = $.NSFileHandle.fileHandleForWritingAtPath(p);
    if (h.isNil()) writeFile(p, line + "\n");
    else {
      h.seekToEndOfFile;
      h.writeData($(line + "\n").dataUsingEncoding($.NSUTF8StringEncoding));
      h.closeFile;
    }
  }
  return true;
}

// Only link schemes a reminder, event or meeting uses; nothing that runs code
function safeURL(u) {
  const s = String(u || "").trim();
  if (!/^(https?|zoommtg|zoomus|msteams|webex|facetime|x-apple-reminderkit|ical|x-apple\.systempreferences):/i.test(s)) return null;
  if (/[\s"<>]/.test(s)) return null;
  return s;
}

function openURL(u) {
  const s = safeURL(u);
  if (!s) return false;
  if (testLog(`open:${s}`)) return true;
  const url = $.NSURL.URLWithString(s);
  if (url.isNil()) return false;
  return $.NSWorkspace.sharedWorkspace.openURL(url);
}

function copyText(text) {
  if (testLog(`copy:${text}`)) return;
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  pb.setStringForType($(text), $.NSPasteboardTypeString);
}

function alfredSearch(q) {
  if (testLog(`search:${q}`)) return;
  Application(ALFRED).search(q);
}

function privacyURL(kind) {
  return `x-apple.systempreferences:com.apple.preference.security?Privacy_${kind === "reminder" ? "Reminders" : "Calendars"}`;
}

// ---------- locale, dates and formatting ----------

let LOCALE_INFO = null;

// Date order, 12/24-hour clock, first weekday and the locale's own day and month names
function localeInfo() {
  if (LOCALE_INFO) return LOCALE_INFO;
  const id = env("RC_TEST_LOCALE", "");
  const loc = id ? $.NSLocale.localeWithLocaleIdentifier(id) : $.NSLocale.currentLocale;
  // day or month first: the day-month template (sv_SE writes y-MM-dd but d/M), unless the configuration says
  const order = $.NSDateFormatter.dateFormatFromTemplateOptionsLocale("Md", 0, loc).js || $.NSDateFormatter.dateFormatFromTemplateOptionsLocale("yMd", 0, loc).js || "M/d/y";
  const orderSetting = choice("date_order", ["auto", "dmy", "mdy"], "auto");
  const hour = $.NSDateFormatter.dateFormatFromTemplateOptionsLocale("j", 0, loc).js || "h a";
  const cal = $.NSCalendar.alloc.initWithCalendarIdentifier($.NSCalendarIdentifierGregorian);
  cal.locale = loc;
  const df = $.NSDateFormatter.alloc.init;
  df.locale = loc;
  const names = (arr) => (ObjC.deepUnwrap(arr) || []).map((s) => fold(s).replace(/\.$/, ""));
  const lang = String(loc.languageCode.js || "en").toLowerCase();
  LOCALE_INFO = {
    loc,
    lang,
    dmy: orderSetting === "auto" ? order.indexOf("d") >= 0 && order.indexOf("d") < order.indexOf("M") : orderSetting === "dmy",
    h24: !/[ahbB]/.test(hour.replace(/'[^']*'/g, "")),
    firstWeekday: Number(cal.firstWeekday) || 1, // 1 = Sunday
    weekdays: lang === "en" ? [] : [names(df.weekdaySymbols), names(df.standaloneWeekdaySymbols), names(df.shortWeekdaySymbols), names(df.shortStandaloneWeekdaySymbols)],
    months: lang === "en" ? [] : [names(df.monthSymbols), names(df.shortMonthSymbols), names(df.standaloneMonthSymbols)],
  };
  return LOCALE_INFO;
}

const FORMATTERS = Object.create(null);
function formatter(template) {
  if (!FORMATTERS[template]) {
    const f = $.NSDateFormatter.alloc.init;
    f.locale = localeInfo().loc;
    f.timeZone = $.NSTimeZone.localTimeZone;
    f.setLocalizedDateFormatFromTemplate(template);
    FORMATTERS[template] = f;
  }
  return FORMATTERS[template];
}

function fmt(ms, template) {
  return formatter(template).stringFromDate($.NSDate.dateWithTimeIntervalSince1970(ms / 1000)).js;
}

function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Calendar days (wall-clock time is kept across daylight-saving changes)
function addDays(ms, n) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds()).getTime();
}

function dayDiff(ms, base) {
  const a = new Date(startOfDay(ms));
  const b = new Date(startOfDay(base));
  return Math.round((Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) - Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())) / DAY);
}

function timeLabel(ms) {
  return fmt(ms, "jmm");
}

// "Today", "Tomorrow", "Yesterday", a weekday within a week, else a short date (with the year when it differs)
function dayLabel(ms) {
  const d = dayDiff(ms, NOW);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d === -1) return "Yesterday";
  if (d > 1 && d < 7) return fmt(ms, "EEEE");
  return new Date(ms).getFullYear() === new Date(NOW).getFullYear() ? fmt(ms, "EEEdMMM") : fmt(ms, "EEEdMMMy");
}

function whenLabel(ms, allDay) {
  return allDay ? dayLabel(ms) : `${dayLabel(ms)} ${timeLabel(ms)}`;
}

function durationLabel(ms) {
  const m = Math.round(ms / MIN);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

function relLabel(ms) {
  const m = Math.round((ms - NOW) / MIN);
  if (m <= 0) return "now";
  if (m < 60) return `in ${m} min`;
  return `in ${durationLabel(m * MIN)}`;
}

// ---------- natural-language parser ----------
// parse("pay rent fri 9am !high #Home", "reminder", ctx) → { title, start, allDay, priority, list, … }
// Words are consumed left to right; anything not recognised stays in the title. Text in "quotes" is
// never parsed. Dates are built from local wall-clock parts, so daylight-saving changes keep the time.

function dict(obj) {
  return Object.assign(Object.create(null), obj);
}

const WEEKDAYS = dict({ sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, weds: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 });
// Short forms that are also ordinary words: only dates after on/next/this/by/every, before a time, or at the end
// (not after "the", "a", "my"…: "sit in the sun"). Other languages' short forms count too ("do", "so", "ma", "man").
const AMBIGUOUS_DAYS = new Set(["sun", "sat", "wed", "mon"]);
const DETERMINERS = new Set(["the", "a", "an", "my", "your", "his", "her", "our", "their", "its", "this", "that", "of", "to", "in", "into", "with", "under", "for", "some", "no"]);
const MONTHS = dict({ january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11 });
const TODAY_WORDS = new Set(["today", "heute", "aujourd'hui", "aujourd’hui", "hoy", "oggi", "vandaag", "hoje", "idag"]);
const TOMORROW_WORDS = new Set(["tomorrow", "tmrw", "tmr", "tmw", "tomorow", "2morrow", "morgen", "demain", "mañana", "manana", "domani", "amanha", "amanhã", "imorgon"]);
const PARTS = dict({ morning: [9, 0], noon: [12, 0], midday: [12, 0], afternoon: [15, 0], evening: [18, 0], tonight: [20, 0], night: [21, 0] });
const NUMBER_WORDS = dict({ a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, "forty-five": 45, ninety: 90 });
const UNITS = dict({
  m: "min", min: "min", mins: "min", minute: "min", minutes: "min",
  h: "hour", hr: "hour", hrs: "hour", hour: "hour", hours: "hour",
  d: "day", day: "day", days: "day",
  w: "week", wk: "week", wks: "week", week: "week", weeks: "week",
  mo: "month", mos: "month", month: "month", months: "month",
  y: "year", yr: "year", yrs: "year", year: "year", years: "year",
});
const PREPS = new Set(["on", "at", "@", "by", "due", "from", "starting", "à", "um", "am", "le", "el", "il"]);
const AT_PREPS = new Set(["at", "@", "by", "à", "um"]);
const CONNECTORS = new Set(["on", "at", "@", "by", "due", "from", "to", "for", "in", "until", "till", "til", "starting", "-", "–", "—", ",", "&"]);
const TZ_NAMES = dict({ et: "America/New_York", ct: "America/Chicago", mt: "America/Denver", pt: "America/Los_Angeles" });
const REC_WORDS = dict({ daily: ["day", 1], weekly: ["week", 1], monthly: ["month", 1], yearly: ["year", 1], annually: ["year", 1], biweekly: ["week", 2], fortnightly: ["week", 2] });

function tokenize(text) {
  const words = [];
  const re = /([#@]?)"([^"]*)"|([#@]?)“([^”]*)”|(\S+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[5] === undefined) {
      const prefix = m[1] || m[3] || "";
      const inner = m[2] !== undefined ? m[2] : m[4];
      words.push({ raw: prefix + inner, key: null, lit: true, prefix, inner, orig: m[0], used: false });
    } else {
      const raw = m[5];
      let key = raw.toLowerCase().replace(/[,;]+$/, "");
      if (!/^\d{1,2}\.\d{1,2}\.(\d{2}|\d{4})?$/.test(key) && !/^[ap]\.m\.$/.test(key)) key = key.replace(/\.$/, "");
      words.push({ raw, key, lit: false, used: false });
    }
  }
  return words;
}

function numberOf(k) {
  if (k == null) return null;
  if (/^\d+(\.\d+)?$/.test(k)) return Number(k);
  return k in NUMBER_WORDS ? NUMBER_WORDS[k] : null;
}

function localDate(y, m, d, h, mi) {
  return new Date(y, m, d, h || 0, mi || 0).getTime();
}

function ymd(ms) {
  const d = new Date(ms);
  return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
}

function validDate(y, m, d) {
  if (m < 0 || m > 11 || d < 1 || y < 1900 || y > 2200) return false;
  return new Date(y, m + 1, 0).getDate() >= d;
}

function addMonths(date, n) {
  const last = new Date(date.y, date.m + n + 1, 0).getDate();
  const t = new Date(date.y, date.m + n, Math.min(date.d, last));
  return ymd(t.getTime());
}

// Seconds east of UTC for a zone ("utc", "+05:30", "EST", "Europe/London") at a given moment; null when unknown
function zoneOffset(tz, atMs) {
  if (typeof tz === "number") return tz;
  const z = $.NSTimeZone.timeZoneWithName(tz);
  if (z.isNil()) return null;
  return Number(z.secondsFromGMTForDate($.NSDate.dateWithTimeIntervalSince1970(atMs / 1000)));
}

function wallInZone(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m, d, h, mi);
  let off = zoneOffset(tz, guess);
  if (off === null) return null;
  let t = guess - off * 1000;
  const off2 = zoneOffset(tz, t);
  if (off2 !== off) t = guess - off2 * 1000;
  return t;
}

function parseZone(w) {
  if (!w || w.lit) return null;
  const k = w.key;
  if (k === "utc" || k === "gmt" || k === "z") return 0;
  let m = /^(?:utc|gmt)?([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(k);
  if (m && (m[0].length > 3 || /^(utc|gmt)/.test(k)) && +m[2] <= 14 && +(m[3] || 0) < 60) return (m[1] === "-" ? -1 : 1) * (+m[2] * 3600 + +(m[3] || 0) * 60);
  if (k in TZ_NAMES && w.raw === w.raw.toUpperCase()) return TZ_NAMES[k];
  if (/^[A-Z]{3,5}$/.test(w.raw)) {
    const z = $.NSTimeZone.timeZoneWithAbbreviation(w.raw);
    if (!z.isNil()) return z.name.js;
  }
  if (/^[A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(w.raw) && !$.NSTimeZone.timeZoneWithName(w.raw).isNil()) return w.raw;
  return null;
}

function Parser(text, kind, ctx) {
  this.kind = kind;
  this.ctx = ctx || {};
  this.now = this.ctx.now || NOW;
  this.li = localeInfo();
  this.words = tokenize(text);
  this.st = { date: null, time: null, end: null, dur: null, durDays: 0, abs: null, rec: null, part: null, tz: null, today: false, allDayWord: false, alert: null };
  this.today = ymd(this.now);
}

Parser.prototype.k = function (i) {
  const w = this.words[i];
  return w && !w.used && !w.lit ? w.key : null;
};

Parser.prototype.weekdayOf = function (k) {
  if (k == null) return null;
  if (k in WEEKDAYS) return WEEKDAYS[k];
  for (const list of this.li.weekdays) {
    const i = list.indexOf(k);
    if (i >= 0) return i;
  }
  return null;
};

// A short weekday form that is also a word: English "sun", "sat"…, or another language's abbreviation
Parser.prototype.ambiguousDay = function (k) {
  if (AMBIGUOUS_DAYS.has(k)) return true;
  if (k in WEEKDAYS) return false;
  const [full, standalone] = this.li.weekdays;
  return !(full || []).includes(k) && !(standalone || []).includes(k);
};

Parser.prototype.monthOf = function (k) {
  if (k == null) return null;
  if (k in MONTHS) return MONTHS[k];
  for (const list of this.li.months) {
    const i = list.indexOf(k);
    if (i >= 0) return i;
  }
  return null;
};

Parser.prototype.dayOffset = function (n) {
  return ymd(localDate(this.today.y, this.today.m, this.today.d + n));
};

// The weekday `wd` (0 = Sunday): "next" = 1–7 days ahead, "this" = 0–6, "nextweek" = in the following week
Parser.prototype.weekdayDate = function (wd, mode) {
  const todayWd = new Date(this.now).getDay();
  let ahead = (wd - todayWd + 7) % 7;
  if (mode === "next" && ahead === 0) ahead = 7;
  if (mode === "nextweek") {
    const fw = this.li.firstWeekday - 1; // 0 = Sunday
    const toWeekStart = (fw - todayWd + 7) % 7 || 7;
    ahead = toWeekStart + ((wd - fw + 7) % 7);
  }
  return this.dayOffset(ahead);
};

Parser.prototype.nextWeek = function () {
  const fw = this.li.firstWeekday - 1;
  const todayWd = new Date(this.now).getDay();
  let ahead = (fw - todayWd + 7) % 7 || 7;
  if (fw === 0) ahead += 1; // weeks starting on Sunday: next week's Monday
  return this.dayOffset(ahead);
};

// A number and unit ("3 days", "an hour", "1h30", "1.5 hours", "half an hour", "1 hour 30 minutes")
Parser.prototype.duration = function (i) {
  const acc = { n: 0, ms: 0, days: 0, months: 0, parts: 0 };
  const add = (amount, unit) => {
    if (unit === "min") acc.ms += amount * MIN;
    else if (unit === "hour") acc.ms += amount * HOUR;
    else if (unit === "day") acc.days += amount;
    else if (unit === "week") acc.days += amount * 7;
    else if (unit === "month") acc.months += amount;
    else if (unit === "year") acc.months += amount * 12;
  };
  for (;;) {
    let c = this.durationPart(i + acc.n, add);
    if (!c && acc.parts && this.k(i + acc.n) === "and") {
      c = this.durationPart(i + acc.n + 1, add);
      if (c) c++;
    }
    if (!c) break;
    acc.n += c;
    acc.parts++;
  }
  if (!acc.parts || (acc.ms === 0 && acc.days === 0 && acc.months === 0)) return null;
  // whole days only: "in 1.5 days" isn't a date
  if (acc.days !== Math.floor(acc.days) || acc.months !== Math.floor(acc.months)) return null;
  return acc;
};

// One "amount unit" pair; returns the number of words it takes (0 = none)
Parser.prototype.durationPart = function (i, add) {
  const k = this.k(i);
  let m;
  if (k == null) return 0;
  if ((m = /^(\d+)h(\d{1,2})(?:m|min)?$/.exec(k)) && +m[2] < 60) {
    add(+m[1], "hour");
    add(+m[2], "min");
    return 1;
  }
  if (k === "half" && (this.k(i + 1) === "an" || this.k(i + 1) === "a") && this.k(i + 2) in UNITS) {
    add(0.5, UNITS[this.k(i + 2)]);
    return 3;
  }
  if ((m = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(k)) && m[2] in UNITS) {
    add(Number(m[1]), UNITS[m[2]]);
    return 1;
  }
  const amount = numberOf(k);
  const unit = this.k(i + 1);
  if (amount !== null && amount > 0 && unit != null && unit in UNITS && unit.length > 1) {
    add(amount, UNITS[unit]);
    return 2;
  }
  return 0;
};

// A clock time: 5pm, 5:30 pm, 17:30, 17h30, noon, midnight; bare hours only after "at"
Parser.prototype.time = function (i, afterAt) {
  const k = this.k(i);
  if (k == null) return null;
  let m;
  if (k === "noon" || k === "midday") return { n: 1, h: 12, mi: 0 };
  if (k === "midnight") return { n: 1, h: 24, mi: 0 };
  if ((m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a|p|a\.m\.?|p\.m\.?)$/.exec(k))) {
    const h = +m[1];
    const mi = +(m[2] || 0);
    if (h < 1 || h > 12 || mi > 59) return null;
    return { n: 1, h: (h % 12) + (m[3][0] === "p" ? 12 : 0), mi };
  }
  if ((m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(k))) {
    const next = this.k(i + 1);
    if (next === "uhr" && +m[1] <= 23 && +(m[2] || 0) <= 59) return { n: 2, h: +m[1], mi: +(m[2] || 0) };
    if (next && /^(am|pm|a\.m\.?|p\.m\.?)$/.test(next)) {
      const h = +m[1];
      const mi = +(m[2] || 0);
      if (h < 1 || h > 12 || mi > 59) return null;
      return { n: 2, h: (h % 12) + (next[0] === "p" ? 12 : 0), mi };
    }
  }
  if ((m = /^(\d{1,2}):(\d{2})h?$/.exec(k))) {
    const h = +m[1];
    const mi = +m[2];
    if (h > 23 || mi > 59) return null;
    // 12-hour clocks: "5:30" is probably the afternoon
    if (!this.li.h24 && h >= 1 && h <= 7) return { n: 1, h: h + 12, mi };
    return { n: 1, h, mi };
  }
  if ((m = /^(\d{1,2})h(\d{2})?$/.exec(k)) && (afterAt || m[2] || this.li.h24)) {
    const h = +m[1];
    const mi = +(m[2] || 0);
    if (h > 23 || mi > 59) return null;
    return { n: 1, h, mi };
  }
  if (afterAt && (m = /^(\d{1,2})$/.exec(k))) {
    const h = +m[1];
    if (h > 23) return null;
    return { n: 1, h: h >= 1 && h <= 7 ? h + 12 : h, mi: 0 };
  }
  return null;
};

// A time, optionally followed by a zone ("3pm UTC", "15:00 CET", "9am ET", "10:00 Europe/London")
Parser.prototype.timeWithZone = function (i, afterAt) {
  const t = this.time(i, afterAt);
  if (!t) return null;
  const w = this.words[i + t.n];
  const tz = w && !w.used ? parseZone(w) : null;
  if (tz !== null) return Object.assign(t, { n: t.n + 1, tz });
  return t;
};

// "1-2pm", "1pm-2pm", "13:00–14:30", "1pm to 2pm", "1 - 2pm"
Parser.prototype.range = function (i, afterAt) {
  const k = this.k(i);
  if (k == null) return null;
  let m;
  // bare numbers ("pages 10-12", "score 5 - 6") are only times after "at" or "from"
  const explicit = (s) => afterAt || /[:ap]/.test(s);
  if ((m = /^(\d{1,2}(?:[:.]\d{2})?(?:am|pm|a|p)?)[-–—](\d{1,2}(?:[:.]\d{2})?(?:am|pm|a|p)?)$/.exec(k))) {
    return explicit(k) ? this.rangeOf(m[1], m[2], 1, i) : null;
  }
  const a = this.time(i, true);
  if (a) {
    const sep = this.k(i + a.n);
    if (sep === "-" || sep === "–" || sep === "—" || sep === "to" || sep === "until" || sep === "till") {
      const b = this.time(i + a.n + 1, true);
      if (b) {
        const ka = this.words.slice(i, i + a.n).map((w) => w.key).join("");
        const kb = this.words.slice(i + a.n + 1, i + a.n + 1 + b.n).map((w) => w.key).join("");
        return explicit(ka + kb) ? this.rangeOf(ka, kb, a.n + 1 + b.n, i) : null;
      }
    }
  }
  return null;
};

Parser.prototype.rangeOf = function (sa, sb, n, i) {
  const parse1 = (s) => {
    const m = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm|a|p)?$/.exec(s);
    if (!m) return null;
    return { h: +m[1], mi: +(m[2] || 0), ap: m[3] ? m[3][0] : null };
  };
  const a = parse1(sa);
  const b = parse1(sb);
  if (!a || !b || a.mi > 59 || b.mi > 59) return null;
  const to24 = (t, ap) => (ap ? (t.h % 12) + (ap === "p" ? 12 : 0) : t.h);
  if ((a.ap && (a.h < 1 || a.h > 12)) || (b.ap && (b.h < 1 || b.h > 12))) return null;
  let bh = to24(b, b.ap);
  let ah;
  if (a.ap) ah = to24(a, a.ap);
  else if (b.ap) {
    // "11-1pm" is 11am–1pm; "1-2pm" is 1pm–2pm
    ah = to24(a, b.ap);
    if (ah * 60 + a.mi > bh * 60 + b.mi) ah = to24(a, b.ap === "p" ? "a" : "p");
  } else {
    ah = a.h;
    if (!this.li.h24 && a.h >= 1 && a.h <= 7 && b.h <= 12) {
      ah += 12;
      if (b.h <= 12) bh = b.h + (b.h < 12 ? 12 : 0);
    }
    // "9-5", "11-1": the end is in the afternoon ("22-2" still ends the next morning)
    if (bh * 60 + b.mi <= ah * 60 + a.mi && ah < 12 && bh < 12) bh += 12;
  }
  if (ah > 23 || bh > 24) return null;
  return { n, h: ah, mi: a.mi, end: { h: bh, mi: b.mi } };
};

// Dates: ISO, month names, numbers in the locale's order, relative words, weekdays
Parser.prototype.date = function (i, prep) {
  const k = this.k(i);
  if (k == null) return null;
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:t(\d{1,2}):(\d{2})(?::(\d{2}))?(z|[+-]\d{2}:?\d{2})?)?$/.exec(k))) {
    const d = { y: +m[1], m: +m[2] - 1, d: +m[3] };
    if (!validDate(d.y, d.m, d.d)) return null;
    const r = { n: 1, date: d };
    if (m[4] !== undefined) {
      if (+m[4] > 23 || +m[5] > 59) return null;
      r.time = { h: +m[4], mi: +m[5] };
      if (m[7]) {
        const z = m[7] === "z" ? 0 : (m[7][0] === "-" ? -1 : 1) * (+m[7].slice(1, 3) * 3600 + +m[7].slice(-2) * 60);
        r.tz = z;
      }
    }
    return r;
  }
  if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(k))) {
    const a = +m[1];
    const b = +m[2];
    const d = this.li.dmy ? { d: a, m: b - 1 } : { d: b, m: a - 1 };
    return this.withYear(d, m[3], 1);
  }
  if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})?$/.exec(k))) return this.withYear({ d: +m[1], m: +m[2] - 1 }, m[3], 1);
  // month names: "oct 5", "october 5th, 2027", "5 oct", "5th of october", "the 5th of oct"
  let j = i;
  if (k === "the") j++;
  const mo = this.monthOf(this.k(j));
  if (mo !== null && j === i) {
    const dm = /^(\d{1,2})(st|nd|rd|th)?$/.exec(this.k(j + 1) || "");
    if (dm) {
      const y = /^\d{4}$/.test(this.k(j + 2) || "") ? this.k(j + 2) : null;
      return this.withYear({ d: +dm[1], m: mo }, y, y ? 3 : 2);
    }
  }
  const dm = /^(\d{1,2})(st|nd|rd|th)?$/.exec(this.k(j) || "");
  if (dm) {
    let jj = j + 1;
    if (this.k(jj) === "of") jj++;
    const mo2 = this.monthOf(this.k(jj));
    if (mo2 !== null) {
      const y = /^\d{4}$/.test(this.k(jj + 1) || "") ? this.k(jj + 1) : null;
      return this.withYear({ d: +dm[1], m: mo2 }, y, jj - i + (y ? 2 : 1));
    }
    if (k === "the" && dm[2]) {
      // "the 5th": this month, or next month when it has passed
      const day = +dm[1];
      if (day < 1 || day > 31) return null;
      let y = this.today.y;
      let mo = this.today.m + (day < this.today.d ? 1 : 0);
      while (!validDate(y + Math.floor(mo / 12), mo % 12, day)) mo++;
      return { n: 2, date: { y: y + Math.floor(mo / 12), m: mo % 12, d: day } };
    }
  }
  if (TODAY_WORDS.has(k)) return { n: 1, date: this.today, today: true };
  if (k === "tonight") return { n: 1, date: this.today, today: true, part: PARTS.tonight };
  if (TOMORROW_WORDS.has(k)) return { n: 1, date: this.dayOffset(1) };
  if (k === "overmorrow") return { n: 1, date: this.dayOffset(2) };
  if (k === "day" && this.k(i + 1) === "after" && TOMORROW_WORDS.has(this.k(i + 2))) return { n: 3, date: this.dayOffset(2) };
  if (k === "this" && this.k(i + 1) in PARTS && this.k(i + 1) !== "noon" && this.k(i + 1) !== "midday") return { n: 2, date: this.today, today: true, part: PARTS[this.k(i + 1)] };
  if (k === "next" || k === "this" || k === "coming") {
    const w = this.k(i + 1);
    if (w === "week" && k === "next") return { n: 2, date: this.nextWeek() };
    if (w === "month" && k === "next") return { n: 2, date: ymd(localDate(this.today.y, this.today.m + 1, 1)) };
    if (w === "year" && k === "next") return { n: 2, date: { y: this.today.y + 1, m: 0, d: 1 } };
    if (w === "weekend") {
      const sat = this.weekdayDate(6, "this");
      const sun = new Date(this.now).getDay() === 0;
      if (k === "next") return { n: 2, date: this.dayOffset(dayDiff(localDate(sat.y, sat.m, sat.d), this.now) + (sun ? 6 : 7)) };
      return { n: 2, date: sun ? this.today : sat };
    }
    const wd = this.weekdayOf(w);
    if (wd !== null) return { n: 2, date: this.weekdayDate(wd, k === "next" ? "nextweek" : k === "this" ? "this" : "next") };
  }
  if (k === "weekend") return { n: 1, date: new Date(this.now).getDay() === 0 ? this.today : this.weekdayDate(6, "this") };
  if (k === "end" && this.k(i + 1) === "of" && this.k(i + 2) === "month") return { n: 3, date: ymd(localDate(this.today.y, this.today.m + 1, 0)) };
  if (k === "end" && this.k(i + 1) === "of" && this.k(i + 2) === "week") return { n: 3, date: this.weekdayDate(5, "this") };
  const wd = this.weekdayOf(k);
  if (wd !== null) {
    // "fri next week" is the Friday of the following week, "fri this week" this week's
    const wk = this.k(i + 2) === "week" ? this.k(i + 1) : null;
    if (wk === "next" || wk === "this") return { n: 3, date: this.weekdayDate(wd, wk === "next" ? "nextweek" : "this") };
    if (!prep && this.ambiguousDay(k)) {
      const prev = this.words[i - 1];
      const last = this.words.slice(i + 1).every((w) => w.used) && !(prev && !prev.lit && DETERMINERS.has(prev.key));
      if (!last && !this.time(i + 1, false) && !this.range(i + 1, false)) return null;
    }
    return { n: 1, date: this.weekdayDate(wd, "next") };
  }
  return null;
};

Parser.prototype.withYear = function (d, yearText, n) {
  let y;
  if (yearText) {
    y = +yearText;
    if (yearText.length === 2) y += 2000;
  } else {
    y = this.today.y;
    // no year: the next time that date comes round (Feb 29: the next leap year)
    if (d.m < this.today.m || (d.m === this.today.m && d.d < this.today.d)) y++;
    for (let k = 0; k < 8 && !validDate(y, d.m, d.d); k++) y++;
  }
  if (!validDate(y, d.m, d.d)) return null;
  return { n, date: { y, m: d.m, d: d.d } };
};

// "every day", "every 2 weeks", "every other month", "every monday and thursday", "every weekday", "daily"
Parser.prototype.recurrence = function (i) {
  const k = this.k(i);
  if (k == null) return null;
  if (k in REC_WORDS) return { n: 1, rec: { freq: REC_WORDS[k][0], interval: REC_WORDS[k][1], days: null } };
  if (k !== "every" && k !== "each") return null;
  let j = i + 1;
  let interval = 1;
  const w = this.k(j);
  if (w === "other") {
    interval = 2;
    j++;
  } else if (/^\d+$/.test(w || "") && +w > 0 && +w < 100) {
    interval = +w;
    j++;
  }
  const u = this.k(j);
  if (u === "weekday" || u === "weekdays") return { n: j - i + 1, rec: { freq: "week", interval: 1, days: [1, 2, 3, 4, 5] } };
  if (u === "weekend") return { n: j - i + 1, rec: { freq: "week", interval: 1, days: [0, 6] } };
  const weekdays = (start) => {
    const days = [];
    let n = start;
    if (this.k(n) === "on" && this.weekdayOf(this.k(n + 1)) !== null) n++;
    for (;;) {
      const d = this.weekdayOf(this.k(n));
      if (d === null) break;
      if (!days.includes(d)) days.push(d);
      n++;
      if (this.k(n) === "and" && this.weekdayOf(this.k(n + 1)) !== null) n++;
    }
    return { n: n - start, days: days.sort() };
  };
  if (u != null && u in UNITS && UNITS[u] !== "min" && UNITS[u] !== "hour" && u.length > 1) {
    // "every 2 weeks on tue and thu"
    const wd = UNITS[u] === "week" ? weekdays(j + 1) : { n: 0, days: [] };
    return { n: j - i + 1 + wd.n, rec: { freq: UNITS[u], interval, days: wd.days.length ? wd.days : null } };
  }
  if (interval === 1 && u in PARTS) return { n: j - i + 1, rec: { freq: "day", interval: 1, days: null }, part: PARTS[u] };
  const wd = weekdays(j);
  if (wd.days.length) return { n: j - i + wd.n, rec: { freq: "week", interval, days: wd.days } };
  return null;
};

// One match at word i: which slots it fills and how many words it takes
Parser.prototype.matchAt = function (i) {
  const k = this.k(i);
  if (k == null) return null;
  if (PREPS.has(k)) {
    const r = this.core(i + 1, k);
    return r ? Object.assign(r, { n: r.n + 1 }) : null;
  }
  return this.core(i, null);
};

Parser.prototype.core = function (i, prep) {
  const k = this.k(i);
  if (k == null) return null;
  const afterAt = AT_PREPS.has(prep);
  const rangeAt = afterAt || prep === "from";
  const isEvent = this.kind === "event";
  let r;
  if (!prep && (r = this.recurrence(i))) return r;
  if (!prep && k === "in") {
    // "in the morning"
    if (this.k(i + 1) === "the" && this.k(i + 2) in PARTS) return { n: 3, part: PARTS[this.k(i + 2)] };
    const d = this.duration(i + 1);
    if (!d) return null;
    // "in 2 hours" is a moment; "in 3 days" a date (the time can be given too); mixing both isn't supported
    if (d.days === 0 && d.months === 0) return { n: d.n + 1, abs: Math.round((this.now + d.ms) / MIN) * MIN };
    if (d.ms !== 0) return null;
    let date = this.dayOffset(d.days);
    if (d.months) date = addMonths(date, d.months);
    if (!validDate(date.y, date.m, date.d)) return null;
    return { n: d.n + 1, date };
  }
  if (!prep && k === "for" && isEvent) {
    const d = this.duration(i + 1);
    if (d && d.months === 0) return { n: d.n + 1, dur: d.ms, durDays: d.days };
    return null;
  }
  if (!prep && (k === "until" || k === "till" || k === "til") && isEvent) {
    const t = this.time(i + 1, true);
    if (t) return { n: t.n + 1, end: { h: t.h, mi: t.mi } };
    return null;
  }
  if (!prep && (k === "alert" || k === "remind")) {
    let j = i + 1;
    if (this.k(j) === "me") j++;
    const d = this.duration(j);
    if (d && d.months === 0 && this.k(j + d.n) === "before") return { n: j + d.n + 1 - i, alert: Math.round((d.ms + d.days * DAY) / MIN) };
    if (this.k(j) === "at" && this.k(j + 1) === "start") return { n: j + 2 - i, alert: 0 };
    return null;
  }
  if (!prep && isEvent && (k === "all-day" || k === "allday" || (k === "all" && this.k(i + 1) === "day"))) return { n: k === "all" ? 2 : 1, allDayWord: true };
  if ((r = this.date(i, prep))) return r;
  if ((r = this.range(i, rangeAt))) {
    const zw = this.words[i + r.n];
    const tz = zw && !zw.used ? parseZone(zw) : null;
    return { n: r.n + (tz !== null ? 1 : 0), time: { h: r.h, mi: r.mi }, end: isEvent ? r.end : null, tz };
  }
  if ((r = this.timeWithZone(i, afterAt))) return { n: r.n, time: { h: r.h, mi: r.mi }, tz: r.tz === undefined ? null : r.tz };
  if (!prep && k in PARTS && (k === "tonight" || this.st.date)) return { n: 1, part: PARTS[k], today: k === "tonight" };
  return null;
};

Parser.prototype.fits = function (r) {
  const st = this.st;
  if (r.date && st.date) return false;
  if (r.time && st.time) return false;
  if (r.abs != null && (st.abs != null || st.time || st.date)) return false;
  if ((r.date || r.time) && st.abs != null) return false;
  if (r.rec && st.rec) return false;
  if ((r.dur != null || r.durDays) && (st.dur != null || st.durDays || st.end)) return false;
  if (r.end && (st.end || st.dur != null)) return false;
  if (r.part && (st.part || st.time)) return false;
  if (r.alert != null && st.alert != null) return false;
  return true;
};

Parser.prototype.apply = function (r) {
  const st = this.st;
  if (r.date) st.date = r.date;
  if (r.time) st.time = r.time;
  if (r.tz !== undefined && r.tz !== null) st.tz = r.tz;
  if (r.end) st.end = r.end;
  if (r.dur != null) st.dur = r.dur;
  if (r.durDays) st.durDays = r.durDays;
  if (r.abs != null) st.abs = r.abs;
  if (r.rec) st.rec = r.rec;
  if (r.part) st.part = r.part;
  if (r.today) st.today = true;
  if (r.allDayWord) st.allDayWord = true;
  if (r.alert != null) st.alert = r.alert;
};

function matchName(token, items) {
  const norm = (s) => fold(s).replace(/[^\p{L}\p{N}]+/gu, "");
  const f = norm(token);
  if (!f) return null;
  const exact = items.filter((it) => fold(it.title) === fold(token));
  if (exact.length) return exact[0];
  const same = items.filter((it) => norm(it.title) === f);
  if (same.length) return same[0];
  const prefix = items.filter((it) => norm(it.title).indexOf(f) === 0);
  return prefix.length === 1 ? prefix[0] : null;
}

function parse(text, kind, ctx) {
  ctx = ctx || {};
  let src = String(text || "").replace(/\r\n?/g, "\n");
  let notes = "";
  const nl = src.indexOf("\n");
  if (nl >= 0) {
    notes = src.slice(nl + 1).trim();
    src = src.slice(0, nl);
  }
  const sm = /(^|\s)\/\/(\s|$)/.exec(src);
  if (sm) {
    const rest = src.slice(sm.index + sm[0].length).trim();
    notes = rest + (notes && rest ? "\n" : "") + notes;
    src = src.slice(0, sm.index);
  }
  const p = new Parser(src, kind, ctx);
  const words = p.words;
  const out = { kind, title: "", notes, url: null, priority: 0, list: null, listToken: null, location: null, rec: null, start: null, end: null, allDay: false, guessed: false, past: false, alert: null };
  const extraURLs = [];
  // links, list or calendar, priority
  for (const w of words) {
    if (w.lit) {
      if (w.prefix === "#" && out.listToken === null) {
        w.used = w.hashToken = true;
        out.listToken = w.inner;
      }
      continue;
    }
    if (/^(https?|zoommtg|msteams|webex|facetime):\/\/\S+$/i.test(w.raw.replace(/[),.;]+$/, "")) || /^www\.[^\s.]+\.\S+$/i.test(w.raw)) {
      w.used = true;
      let u = w.raw.replace(/[),.;]+$/, "");
      if (/^www\./i.test(u)) u = "https://" + u;
      if (!out.url) out.url = u;
      else extraURLs.push(u);
      continue;
    }
    if (/^#[^\s#]/.test(w.raw) && out.listToken === null) {
      w.used = w.hashToken = true;
      out.listToken = w.raw.slice(1).replace(/[,;.]+$/, "");
      continue;
    }
    if (kind === "reminder") {
      const pm = /^(?:(!{1,3})|!(high|hi|h|3|medium|med|m|2|low|lo|l|1|none|no|0))$/i.exec(w.raw);
      if (pm) {
        w.used = true;
        if (pm[1]) out.priority = [0, 9, 5, 1][pm[1].length];
        else {
          const v = pm[2].toLowerCase();
          out.priority = /^(high|hi|h|3)$/.test(v) ? 1 : /^(medium|med|m|2)$/.test(v) ? 5 : /^(low|lo|l|1)$/.test(v) ? 9 : 0;
        }
      }
    }
  }
  if (extraURLs.length) out.notes = extraURLs.join("\n") + (out.notes ? "\n" + out.notes : "");
  // dates and times
  for (let i = 0; i < words.length; ) {
    const r = p.matchAt(i);
    if (r && p.fits(r)) {
      for (let j = i; j < i + r.n; j++) words[j].used = words[j].when = true;
      p.apply(r);
      if (r.part && r.date && !r.time) p.st.part = r.part;
      i += r.n;
    } else i++;
  }
  // location for events: the words after the last "at" / "@", up to the next parsed word
  if (kind === "event" && ctx.location !== false) {
    for (let i = words.length - 1; i >= 0; i--) {
      const w = words[i];
      if (w.used) continue;
      if (w.lit && w.prefix === "@") {
        w.used = true;
        out.location = w.inner.trim();
        break;
      }
      if (w.lit) continue;
      let run = [];
      if (w.key === "at" || w.key === "@") run = [];
      else if (/^@\S/.test(w.raw)) run = [w.raw.slice(1)];
      else continue;
      let j = i + 1;
      while (j < words.length && !words[j].used) {
        run.push(words[j].lit ? words[j].inner : words[j].raw);
        j++;
      }
      if (!run.length) continue;
      for (let x = i; x < j; x++) words[x].used = true;
      out.location = run.join(" ").replace(/[,;]+$/, "").trim();
      break;
    }
  }
  // list or calendar; an unknown #word stays in the title ("fix bug #42")
  if (out.listToken !== null) {
    out.list = matchName(out.listToken, ctx.lists || []);
    if (!out.list) for (const w of words) if (w.hashToken) w.used = false;
  }
  // title: what's left, without the connecting words that led into a date ("pay rent on fri")
  for (let i = words.length - 2; i >= 0; i--) {
    const w = words[i];
    if (!w.used && !w.lit && CONNECTORS.has(w.key) && words[i + 1].used && words[i + 1].when) w.used = true;
  }
  const left = words.filter((w) => !w.used);
  // quotes keep words as typed; a title that is one quoted text loses its quotes
  const quote = (w) => (left.length === 1 && !w.prefix ? w.inner : w.orig);
  out.title = left
    .map((w) => (w.lit ? quote(w) : w.raw))
    .join(" ")
    .replace(/[,;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  resolveWhen(p, out, ctx);
  return out;
}

function resolveWhen(p, out, ctx) {
  const st = p.st;
  const now = p.now;
  const kind = p.kind;
  let time = st.time || (st.part ? { h: st.part[0], mi: st.part[1] } : null);
  let date = st.date;
  out.rec = st.rec;
  out.alert = st.alert;
  if (st.abs != null) {
    out.start = st.abs;
  } else {
    if (!date && st.rec) {
      if (st.rec.freq === "week" && st.rec.days) {
        const todayWd = new Date(now).getDay();
        const okToday = st.rec.days.includes(todayWd) && (!time || localDate(p.today.y, p.today.m, p.today.d, time.h, time.mi) > now);
        date = okToday ? p.today : null;
        for (let a = 1; !date && a <= 7; a++) if (st.rec.days.includes((todayWd + a) % 7)) date = p.dayOffset(a);
      } else if (!time) date = p.today;
    }
    if (date && time) out.start = st.tz !== null ? wallInZone(date.y, date.m, date.d, time.h, time.mi, st.tz) : localDate(date.y, date.m, date.d, time.h, time.mi);
    else if (date) {
      out.start = localDate(date.y, date.m, date.d);
      out.allDay = true;
    } else if (time) {
      const t = p.today;
      out.start = st.tz !== null ? wallInZone(t.y, t.m, t.d, time.h, time.mi, st.tz) : localDate(t.y, t.m, t.d, time.h, time.mi);
      if (out.start !== null && out.start <= now && !st.today) out.start = st.tz !== null ? out.start + DAY : addDays(out.start, 1);
    }
    if (out.start === null && (date || time)) out.zoneError = true;
  }
  if (st.allDayWord) {
    if (out.start === null) out.start = localDate(p.today.y, p.today.m, p.today.d);
    out.start = startOfDay(out.start);
    out.allDay = true;
  }
  if (kind === "reminder") {
    if (out.start !== null && out.allDay && ctx.defTime) {
      const d = new Date(out.start);
      out.start = localDate(d.getFullYear(), d.getMonth(), d.getDate(), ctx.defTime.h, ctx.defTime.mi);
      out.allDay = false;
    }
    if (out.rec && out.start === null) {
      out.start = localDate(p.today.y, p.today.m, p.today.d);
      out.allDay = true;
    }
  } else {
    if (out.start === null) {
      // no date or time: the next full hour
      out.start = Math.ceil((now + 1) / HOUR) * HOUR;
      out.guessed = true;
    }
    if (out.allDay) {
      const days = Math.max(1, st.durDays || Math.round((st.dur || 0) / DAY) || 1);
      out.end = localDate(new Date(out.start).getFullYear(), new Date(out.start).getMonth(), new Date(out.start).getDate() + days);
    } else if (st.end) {
      const s = new Date(out.start);
      let e;
      if (st.tz !== null && st.time) {
        // a zone was given: the end is that many minutes after the start (same day in that zone)
        e = out.start + (st.end.h * 60 + st.end.mi - (st.time.h * 60 + st.time.mi)) * MIN;
        if (e <= out.start) e += DAY;
      } else {
        e = localDate(s.getFullYear(), s.getMonth(), s.getDate(), st.end.h, st.end.mi);
        if (e <= out.start) e = addDays(e, 1);
      }
      out.end = e;
    } else {
      const ms = (st.dur || 0) + (st.durDays || 0) * DAY;
      out.end = out.start + (ms > 0 ? ms : (ctx.duration || 60) * MIN);
    }
  }
  if (out.start !== null) out.past = out.allDay ? startOfDay(out.start) < startOfDay(now) : out.start < now - MIN;
}

// ---------- data: EventKit, or a JSON file in tests ----------
// Every store has the same methods. Items are plain objects:
//   reminder { id, title, notes, url, list, listId, priority, completed, completedAt, created, due, allDay, recurring }
//   event    { id, cid, title, start, end, allDay, location, url, calendar, calendarId, recurring, join }
// Times are milliseconds; an all-day due date is local midnight of that day.

const STATUS = ["notDetermined", "restricted", "denied", "full", "writeOnly"];
const FREQ = dict({ day: 0, week: 1, month: 2, year: 3 });

function joinLink(texts) {
  const hosts = [
    [/^([\w-]+\.)*zoom(gov)?\.(us|com)$/, "Zoom", /^\/(j|my|w|s|wc)\//],
    [/^meet\.google\.com$/, "Google Meet", /^\/[a-z]{3,}-[a-z]{3,}-[a-z]{3,}/],
    [/^teams\.(microsoft|live)\.com$|^teams\.cloud\.microsoft$|^([\w-]+\.)?teams\.microsoft\.us$/, "Teams", /^\/(l\/meetup-join|meet)\//],
    [/^([\w-]+\.)*webex\.com$/, "Webex", /./],
    [/^facetime\.apple\.com$/, "FaceTime", /^\/join/],
    [/^([\w-]+\.)*whereby\.com$/, "Whereby", /^\/[\w-]+/],
    [/^meet\.goto\.com$|^([\w-]+\.)*gotomeeting\.com$/, "GoTo Meeting", /./],
    [/^([\w-]+\.)*chime\.aws$/, "Chime", /./],
    [/^app\.slack\.com$/, "Slack", /^\/huddle\//],
  ];
  for (const text of texts) {
    if (!text) continue;
    const re = /(?:https?:\/\/|zoommtg:\/\/|msteams:\/?\/?)[^\s<>"'()\[\]]+/gi;
    let m;
    while ((m = re.exec(String(text)))) {
      const u = m[0].replace(/[.,;:!?]+$/, "");
      if (/^zoommtg:/i.test(u)) return { url: u, service: "Zoom" };
      if (/^msteams:/i.test(u)) return { url: u, service: "Teams" };
      const hm = /^https?:\/\/([^/?#:]+)(?::\d+)?([^?#]*)/i.exec(u);
      if (!hm) continue;
      const host = hm[1].toLowerCase();
      for (const [h, name, path] of hosts) if (h.test(host) && path.test(hm[2] || "/")) return { url: u.replace(/^http:/i, "https:"), service: name };
    }
  }
  return null;
}

// How a reminder's absolute alarms follow a new due date. `existing` holds each alarm's time (null for a
// relative one, which is left alone). The alarm at the old due time is dropped (and one is added at the new
// time when `alarm`); earlier ones ("10 min before") keep their distance to the due time; `early` minutes
// adds one before the new due time. Only timed due dates get alarms. → { remove: [indexes], add: [ms] }
function alarmPlan(existing, oldDue, due, allDay, alarm, early) {
  const timed = due !== null && due !== undefined && !allDay;
  const remove = [];
  const add = [];
  if (oldDue !== null && oldDue !== undefined) {
    existing.forEach((at, i) => {
      if (at === null || at === undefined) return;
      if (Math.abs(at - oldDue) < MIN) remove.push(i);
      else if (at < oldDue && oldDue - at <= 7 * DAY) {
        remove.push(i);
        if (timed) add.push(at + (due - oldDue));
      }
    });
  }
  if (timed && alarm) add.push(due);
  if (timed && typeof early === "number" && early >= 0) add.push(due - early * MIN);
  return { remove, add: add.filter((t, i) => add.indexOf(t) === i).sort((a, b) => a - b) };
}

function hasAlarmAt(times, due) {
  return due !== null && due !== undefined && times.some((t) => t !== null && t !== undefined && Math.abs(t - due) < MIN);
}

function FakeStore(path) {
  this.path = path;
  this.db = readJSON(path, null);
  if (!this.db) throw new Error("the test store can’t be read");
  const delay = num(this.db.delay);
  if (delay) $.NSThread.sleepForTimeInterval(delay / 1000);
}

FakeStore.prototype.fail = function (op) {
  const f = this.db.fail && this.db.fail[op];
  if (f) throw new Error(f);
};
FakeStore.prototype.save = function () {
  this.db.ops = (this.db.ops || 0) + 1;
  writeFile(this.path, JSON.stringify(this.db, null, 1));
};
FakeStore.prototype.time = function (v) {
  if (v === null || v === undefined || v === "") return null;
  return typeof v === "number" ? v : parseLocalISO(v);
};
FakeStore.prototype.status = function (kind) {
  return (this.db.access && this.db.access[kind]) || "full";
};
FakeStore.prototype.request = function (kind) {
  this.fail("request");
  this.db.access = this.db.access || {};
  const after = (this.db.afterRequest && this.db.afterRequest[kind]) || "full";
  if (this.status(kind) === "notDetermined") this.db.access[kind] = after;
  this.db.requested = (this.db.requested || []).concat([kind]);
  this.save();
  return this.status(kind);
};
FakeStore.prototype.lists = function () {
  this.fail("lists");
  return (this.db.lists || []).map((l) => ({ id: l.id, title: l.title, source: l.source || "iCloud", writable: l.writable !== false }));
};
FakeStore.prototype.defaultList = function () {
  const d = (this.db.lists || []).filter((l) => l.default)[0] || (this.db.lists || [])[0];
  return d ? d.id : null;
};
FakeStore.prototype.calendars = function () {
  this.fail("calendars");
  return (this.db.calendars || []).map((c) => ({ id: c.id, title: c.title, source: c.source || "iCloud", writable: c.writable !== false }));
};
FakeStore.prototype.defaultCalendar = function () {
  const d = (this.db.calendars || []).filter((c) => c.default)[0] || (this.db.calendars || []).filter((c) => c.writable !== false)[0];
  return d ? d.id : null;
};
FakeStore.prototype.listTitle = function (id) {
  const l = (this.db.lists || []).filter((x) => x.id === id)[0];
  return l ? l.title : "";
};
FakeStore.prototype.toReminder = function (r) {
  return {
    id: r.id,
    title: r.title || "",
    notes: String(r.notes || "").slice(0, NOTES_MAX),
    url: r.url || null,
    list: this.listTitle(r.listId),
    listId: r.listId,
    priority: num(r.priority),
    completed: !!r.completed,
    completedAt: this.time(r.completedAt),
    created: this.time(r.created) || 0,
    due: this.time(r.due),
    allDay: !!r.allDay,
    recurring: !!r.rec,
    alarms: (r.alarms || []).length,
    dueAlarm: !r.allDay && hasAlarmAt(r.alarms || [], this.time(r.due)),
  };
};
FakeStore.prototype.reminders = function (opts) {
  this.fail("reminders");
  const since = opts && opts.completedSince;
  return (this.db.reminders || [])
    .filter((r) => (since ? r.completed && (this.time(r.completedAt) || 0) >= since : !r.completed))
    .map((r) => this.toReminder(r));
};
FakeStore.prototype.getReminder = function (id) {
  const r = (this.db.reminders || []).filter((x) => x.id === id)[0];
  return r ? this.toReminder(r) : null;
};
FakeStore.prototype.flagged = function () {
  this.fail("flagged");
  return (this.db.reminders || []).filter((r) => r.flagged && !r.completed).map((r) => ({ id: r.id, title: r.title, due: this.time(r.due) }));
};
FakeStore.prototype.find = function (id) {
  const r = (this.db.reminders || []).filter((x) => x.id === id)[0];
  if (!r) throw new Error("the reminder no longer exists");
  return r;
};
FakeStore.prototype.addReminder = function (f) {
  this.fail("addReminder");
  const listId = f.listId || this.defaultList();
  if (!listId) throw new Error("there’s no list to add it to");
  const id = `new-${(this.db.reminders || []).length + 1}-${(this.db.ops || 0) + 1}`;
  const r = { id, title: f.title, notes: f.notes || "", url: f.url || null, listId, priority: f.priority || 0, completed: false, created: NOW, due: f.due, allDay: !!f.allDay, rec: f.rec || null, alarms: alarmPlan([], null, f.due, f.allDay, f.alarm, f.alert).add };
  this.db.reminders = (this.db.reminders || []).concat([r]);
  this.save();
  return { id };
};
FakeStore.prototype.updateReminder = function (id, ch) {
  this.fail("updateReminder");
  const r = this.find(id);
  if ("completed" in ch) {
    r.completed = ch.completed;
    r.completedAt = ch.completed ? NOW : null;
    // like Reminders, a repeating reminder moves to its next date instead ("advance" in the store simulates it)
    if (ch.completed && r.rec && this.db.advance && r.due != null) {
      r.completed = false;
      r.completedAt = null;
      r.due = this.time(r.due) + this.db.advance;
    }
  }
  if ("due" in ch) {
    const old = this.time(r.due);
    const alarms = r.alarms || [];
    const plan = alarmPlan(alarms, r.allDay ? null : old, ch.due, !!ch.allDay, ch.alarm, null);
    r.alarms = alarms.filter((a, i) => !plan.remove.includes(i)).concat(plan.add);
    r.due = ch.due;
    r.allDay = !!ch.allDay;
  }
  if ("priority" in ch) r.priority = ch.priority;
  if ("listId" in ch) r.listId = ch.listId;
  this.save();
  return this.toReminder(r);
};
FakeStore.prototype.removeReminder = function (id) {
  this.fail("removeReminder");
  this.find(id);
  this.db.reminders = this.db.reminders.filter((x) => x.id !== id);
  this.save();
};
FakeStore.prototype.calendarTitle = function (id) {
  const c = (this.db.calendars || []).filter((x) => x.id === id)[0];
  return c ? c.title : "";
};
FakeStore.prototype.events = function (from, to) {
  this.fail("events");
  return (this.db.events || [])
    .map((e) => {
      const start = this.time(e.start);
      const end = this.time(e.end) || start;
      return {
        id: e.id,
        cid: e.cid || e.id,
        title: e.title || "",
        start,
        end,
        allDay: !!e.allDay,
        location: e.location || "",
        url: e.url || null,
        calendar: this.calendarTitle(e.calendarId),
        calendarId: e.calendarId,
        recurring: !!e.recurring,
        join: joinLink([e.url, e.location, e.notes]),
      };
    })
    .filter((e) => e.start < to && e.end > from)
    .sort((a, b) => a.start - b.start);
};
FakeStore.prototype.addEvent = function (f) {
  this.fail("addEvent");
  const calendarId = f.calendarId || this.defaultCalendar();
  if (!calendarId) throw new Error("there’s no calendar to add it to");
  const id = `ev-${(this.db.events || []).length + 1}-${(this.db.ops || 0) + 1}`;
  const e = { id, cid: id, title: f.title, start: f.start, end: f.end, allDay: !!f.allDay, location: f.location || "", notes: f.notes || "", url: f.url || null, calendarId, rec: f.rec || null, alert: f.alert };
  this.db.events = (this.db.events || []).concat([e]);
  this.save();
  return { id, cid: id };
};
FakeStore.prototype.removeEvent = function (id) {
  this.fail("removeEvent");
  const e = (this.db.events || []).filter((x) => x.id === id)[0];
  if (!e) throw new Error("the event no longer exists");
  // EventKit removes one occurrence of a repeating event unless asked for the whole series
  this.db.removedSpan = e.rec || e.recurring ? "future" : "this";
  this.db.events = this.db.events.filter((x) => x.id !== id);
  this.save();
};

// ----- EventKit through the Objective-C bridge -----

function spin(done, timeoutMs) {
  const end = Date.now() + timeoutMs;
  const loop = $.NSRunLoop.currentRunLoop;
  while (!done() && Date.now() < end) {
    loop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.01));
    if (!done()) $.NSThread.sleepForTimeInterval(0.002);
  }
  return done();
}

function nsDate(ms) {
  return $.NSDate.dateWithTimeIntervalSince1970(ms / 1000);
}

function msOf(d) {
  return d && !d.isNil() ? Math.round(d.timeIntervalSince1970 * 1000) : null;
}

function str(v) {
  return v && !v.isNil() ? v.js : "";
}

function gregorian() {
  const c = $.NSCalendar.alloc.initWithCalendarIdentifier($.NSCalendarIdentifierGregorian);
  c.timeZone = $.NSTimeZone.localTimeZone;
  return c;
}

function undefinedComponent(v) {
  return v === undefined || v === null || Number(v) > UNDEF || String(v) === "9223372036854775807";
}

// dueDateComponents → { due, allDay }
function dueOf(dc) {
  if (!dc || dc.isNil()) return { due: null, allDay: false };
  const y = Number(dc.year);
  const m = Number(dc.month);
  const d = Number(dc.day);
  if (undefinedComponent(dc.year) || undefinedComponent(dc.month) || undefinedComponent(dc.day)) return { due: null, allDay: false };
  if (undefinedComponent(dc.hour)) return { due: localDate(y, m - 1, d), allDay: true };
  const cal = gregorian();
  if (!dc.timeZone.isNil()) cal.timeZone = dc.timeZone;
  const date = cal.dateFromComponents(dc);
  return date.isNil() ? { due: localDate(y, m - 1, d, Number(dc.hour), undefinedComponent(dc.minute) ? 0 : Number(dc.minute)) } : { due: msOf(date), allDay: false };
}

// ms → dueDateComponents (a date, or a date and time in the local zone)
function componentsOf(ms, allDay) {
  const units = allDay ? 4 | 8 | 16 : 4 | 8 | 16 | 32 | 64 | 2097152; // year month day (hour minute timeZone)
  const dc = gregorian().componentsFromDate(units, nsDate(ms));
  if (!allDay) dc.timeZone = $.NSTimeZone.localTimeZone;
  return dc;
}

function recurrenceRule(rec) {
  if (!rec || !(rec.freq in FREQ)) return null;
  const interval = Math.max(1, Math.min(99, num(rec.interval) || 1));
  if (rec.days && rec.days.length && rec.freq === "week") {
    const days = rec.days.map((d) => $.EKRecurrenceDayOfWeek.dayOfWeek(d + 1)); // EventKit: 1 = Sunday
    return $.EKRecurrenceRule.alloc.initRecurrenceWithFrequencyIntervalDaysOfTheWeekDaysOfTheMonthMonthsOfTheYearWeeksOfTheYearDaysOfTheYearSetPositionsEnd(FREQ.week, interval, $(days), $(), $(), $(), $(), $(), $());
  }
  return $.EKRecurrenceRule.alloc.initRecurrenceWithFrequencyIntervalEnd(FREQ[rec.freq], interval, $());
}

function reminderJS(r) {
  const cal = r.calendar;
  const due = dueOf(r.dueDateComponents);
  return {
    id: str(r.calendarItemIdentifier),
    title: str(r.title),
    notes: str(r.notes).slice(0, NOTES_MAX),
    url: r.URL.isNil() ? null : str(r.URL.absoluteString),
    list: cal.isNil() ? "" : str(cal.title),
    listId: cal.isNil() ? "" : str(cal.calendarIdentifier),
    priority: num(r.priority),
    completed: !!r.completed,
    completedAt: msOf(r.completionDate),
    created: msOf(r.creationDate) || 0,
    due: due.due,
    allDay: !!due.allDay,
    recurring: !!r.hasRecurrenceRules,
    alarms: r.alarms.isNil() ? 0 : Number(r.alarms.count),
    dueAlarm: !due.allDay && hasAlarmAt(alarmTimes(r), due.due),
  };
}

function alarmTimes(r) {
  const arr = r.alarms;
  const out = [];
  if (!arr.isNil()) for (let i = 0; i < Number(arr.count); i++) out.push(msOf(arr.objectAtIndex(i).absoluteDate));
  return out;
}

function eventJS(e) {
  const cal = e.calendar;
  const url = e.URL.isNil() ? null : str(e.URL.absoluteString);
  const location = str(e.location);
  const notes = e.notes.isNil() ? "" : str(e.notes);
  return {
    id: str(e.eventIdentifier),
    cid: str(e.calendarItemIdentifier),
    title: str(e.title),
    start: msOf(e.startDate),
    end: msOf(e.endDate),
    allDay: !!e.allDay,
    location,
    url,
    calendar: cal.isNil() ? "" : str(cal.title),
    calendarId: cal.isNil() ? "" : str(cal.calendarIdentifier),
    recurring: !!e.hasRecurrenceRules,
    join: joinLink([url, location, notes]), // the notes themselves aren't kept
  };
}

function EKStore() {
  if (TEST) throw new Error("EventKit is never used in tests");
  ObjC.import("EventKit");
  let s = null;
  // created on first use: the access check on every keystroke is a class method and needs none
  Object.defineProperty(this, "store", { get: () => s || (s = $.EKEventStore.alloc.init) });
}

EKStore.prototype.type = function (kind) {
  return kind === "reminder" ? 1 : 0; // EKEntityTypeReminder, EKEntityTypeEvent
};
EKStore.prototype.status = function (kind) {
  return STATUS[Number($.EKEventStore.authorizationStatusForEntityType(this.type(kind)))] || "denied";
};
// Asks macOS for access. The dialog names Alfred (the app that started this script); waits for the answer
EKStore.prototype.request = function (kind) {
  const s = this.store;
  let done = false;
  const cb = () => {
    done = true;
  };
  if (kind === "reminder" && s.respondsToSelector("requestFullAccessToRemindersWithCompletion:")) s.requestFullAccessToRemindersWithCompletion(cb);
  else if (kind === "event" && s.respondsToSelector("requestFullAccessToEventsWithCompletion:")) s.requestFullAccessToEventsWithCompletion(cb);
  else s.requestAccessToEntityTypeCompletion(this.type(kind), cb);
  spin(() => done, 120000);
  return this.status(kind);
};
EKStore.prototype.calendarsOf = function (kind) {
  const arr = this.store.calendarsForEntityType(this.type(kind));
  const out = [];
  if (arr.isNil()) return out;
  for (let i = 0; i < Number(arr.count); i++) {
    const c = arr.objectAtIndex(i);
    out.push({ id: str(c.calendarIdentifier), title: str(c.title), source: c.source.isNil() ? "" : str(c.source.title), writable: !!c.allowsContentModifications });
  }
  return out;
};
EKStore.prototype.lists = function () {
  return this.calendarsOf("reminder");
};
EKStore.prototype.calendars = function () {
  return this.calendarsOf("event");
};
EKStore.prototype.defaultList = function () {
  const c = this.store.defaultCalendarForNewReminders;
  return c.isNil() ? null : str(c.calendarIdentifier);
};
EKStore.prototype.defaultCalendar = function () {
  const c = this.store.defaultCalendarForNewEvents;
  return c.isNil() ? null : str(c.calendarIdentifier);
};
EKStore.prototype.calendar = function (id) {
  const c = this.store.calendarWithIdentifier(id);
  return c.isNil() ? null : c;
};
EKStore.prototype.reminders = function (opts) {
  const s = this.store;
  const since = opts && opts.completedSince;
  const pred = since
    ? s.predicateForCompletedRemindersWithCompletionDateStartingEndingCalendars(nsDate(since), nsDate(NOW + DAY), $())
    : s.predicateForIncompleteRemindersWithDueDateStartingEndingCalendars($(), $(), $());
  let result = null;
  let done = false;
  s.fetchRemindersMatchingPredicateCompletion(pred, (arr) => {
    result = arr;
    done = true;
  });
  if (!spin(() => done, BACKGROUND ? 60000 : 10000)) throw new Error("Reminders took too long to answer");
  const out = [];
  if (!result || result.isNil()) return out;
  for (let i = 0; i < Number(result.count); i++) out.push(reminderJS(result.objectAtIndex(i)));
  return out;
};
EKStore.prototype.item = function (id) {
  const r = this.store.calendarItemWithIdentifier(id);
  if (r.isNil() || !r.isKindOfClass($.EKReminder)) throw new Error("the reminder no longer exists");
  return r;
};
EKStore.prototype.getReminder = function (id) {
  try {
    return reminderJS(this.item(id));
  } catch (e) {
    return null;
  }
};
EKStore.prototype.saveReminder = function (r) {
  const err = $();
  if (!this.store.saveReminderCommitError(r, true, err)) throw new Error(err.isNil() || !err.localizedDescription ? "Reminders refused the change" : err.localizedDescription.js);
};
// Alarms follow the due date (see alarmPlan); Reminders itself uses absolute alarms
function setAlarm(r, oldDue, due, allDay, alarm, early) {
  const arr = r.alarms;
  const plan = alarmPlan(alarmTimes(r), oldDue, due, allDay, alarm, early);
  for (const i of plan.remove.sort((a, b) => b - a)) r.removeAlarm(arr.objectAtIndex(i));
  for (const at of plan.add) r.addAlarm($.EKAlarm.alarmWithAbsoluteDate(nsDate(at)));
}
EKStore.prototype.addReminder = function (f) {
  const r = $.EKReminder.reminderWithEventStore(this.store);
  r.title = f.title;
  const cal = (f.listId && this.calendar(f.listId)) || this.store.defaultCalendarForNewReminders;
  if (!cal || cal.isNil()) throw new Error("there’s no list to add it to");
  r.calendar = cal;
  if (f.notes) r.notes = f.notes;
  if (f.url) {
    const u = $.NSURL.URLWithString(f.url);
    if (!u.isNil()) r.URL = u;
  }
  if (f.priority) r.priority = f.priority;
  if (f.due != null) {
    r.dueDateComponents = componentsOf(f.due, f.allDay);
    setAlarm(r, null, f.due, f.allDay, f.alarm, f.alert);
    const rule = recurrenceRule(f.rec);
    if (rule) r.addRecurrenceRule(rule);
  }
  this.saveReminder(r);
  return { id: str(r.calendarItemIdentifier) };
};
EKStore.prototype.updateReminder = function (id, ch) {
  const r = this.item(id);
  if ("completed" in ch) r.completed = !!ch.completed;
  if ("due" in ch) {
    const old = dueOf(r.dueDateComponents);
    if (ch.due === null) {
      r.dueDateComponents = $(); // nil (a JavaScript null would become NSNull)
      r.startDateComponents = $();
      setAlarm(r, old.allDay ? null : old.due, null, true, false, null);
    } else {
      r.dueDateComponents = componentsOf(ch.due, ch.allDay);
      r.startDateComponents = $(); // a start after the new due date would confuse Reminders
      setAlarm(r, old.allDay ? null : old.due, ch.due, ch.allDay, ch.alarm, null);
    }
  }
  if ("priority" in ch) r.priority = ch.priority;
  if ("listId" in ch) {
    const cal = this.calendar(ch.listId);
    if (!cal) throw new Error("that list no longer exists");
    r.calendar = cal;
  }
  this.saveReminder(r);
  return reminderJS(r);
};
EKStore.prototype.removeReminder = function (id) {
  const r = this.item(id);
  const err = $();
  if (!this.store.removeReminderCommitError(r, true, err)) throw new Error(err.isNil() || !err.localizedDescription ? "Reminders refused to delete it" : err.localizedDescription.js);
};
// Which reminders are flagged: EventKit doesn't know, so ask the Reminders app (one query for all)
EKStore.prototype.flagged = function () {
  const app = Application("Reminders");
  const refs = app.reminders.whose({ _and: [{ flagged: true }, { completed: false }] });
  const ids = refs.id();
  const names = refs.name();
  let dues = [];
  try {
    dues = refs.dueDate();
  } catch (e) {
    dues = [];
  }
  return ids.map((id, i) => ({ id: String(id).replace(/^x-apple-reminder:\/\//, ""), title: String(names[i] || ""), due: dues[i] instanceof Date ? dues[i].getTime() : null }));
};
EKStore.prototype.events = function (from, to) {
  const s = this.store;
  const pred = s.predicateForEventsWithStartDateEndDateCalendars(nsDate(from), nsDate(to), $());
  const arr = s.eventsMatchingPredicate(pred);
  const out = [];
  if (arr.isNil()) return out;
  for (let i = 0; i < Number(arr.count); i++) out.push(eventJS(arr.objectAtIndex(i)));
  return out.sort((a, b) => a.start - b.start);
};
EKStore.prototype.addEvent = function (f) {
  const s = this.store;
  const e = $.EKEvent.eventWithEventStore(s);
  e.title = f.title;
  const cal = (f.calendarId && this.calendar(f.calendarId)) || s.defaultCalendarForNewEvents;
  if (!cal || cal.isNil()) throw new Error("there’s no calendar to add it to");
  e.calendar = cal;
  e.allDay = !!f.allDay;
  e.startDate = nsDate(f.start);
  e.endDate = nsDate(f.allDay ? f.end - 1000 : f.end); // EventKit's all-day end is inside the last day
  if (f.location) e.location = f.location;
  if (f.notes) e.notes = f.notes;
  if (f.url) {
    const u = $.NSURL.URLWithString(f.url);
    if (!u.isNil()) e.URL = u;
  }
  if (f.alert != null) e.addAlarm($.EKAlarm.alarmWithRelativeOffset(-60 * f.alert));
  const rule = recurrenceRule(f.rec);
  if (rule) e.addRecurrenceRule(rule);
  const err = $();
  if (!s.saveEventSpanCommitError(e, 0, true, err)) throw new Error(err.isNil() || !err.localizedDescription ? "Calendar refused the event" : err.localizedDescription.js);
  return { id: str(e.eventIdentifier), cid: str(e.calendarItemIdentifier) };
};
EKStore.prototype.removeEvent = function (id) {
  const e = this.store.eventWithIdentifier(id);
  if (e.isNil()) throw new Error("the event no longer exists");
  const err = $();
  // EKSpanThisEvent (0) would only remove the first occurrence of a repeating event; EKSpanFutureEvents (1) removes the series
  if (!this.store.removeEventSpanCommitError(e, e.hasRecurrenceRules ? 1 : 0, true, err)) throw new Error(err.isNil() || !err.localizedDescription ? "Calendar refused to delete it" : err.localizedDescription.js);
};

let STORE = null;
function store() {
  if (STORE) return STORE;
  if (TEST_STORE) STORE = new FakeStore(TEST_STORE);
  else if (TEST) throw new Error("test mode without RC_TEST_STORE");
  else STORE = new EKStore();
  return STORE;
}

// ---------- caches ----------
// Script Filters read JSON caches. A stale cache is refreshed in the foreground when the last read was
// quick, otherwise in a detached background process while the stale rows show (and the filter reruns).

function cachePath(name) {
  return `${cacheDir()}/${name}.json`;
}

function readCache(name) {
  const c = readJSON(cachePath(name), null);
  return c && c.v === CACHE_VERSION ? c : null;
}

function writeCache(name, c) {
  c.v = CACHE_VERSION;
  writeFile(cachePath(name), JSON.stringify(c));
  return c;
}

function stale(c, ttl) {
  return !c || c.dirty || NOW - c.at > ttl || NOW < c.at - 5000;
}

// true while a refresher runs (or was just started)
function background(mode, lock) {
  if (lockHeld(lock)) return true;
  return spawn(mode) > 0;
}

// Runs a fetch in the background process under its lock
let BACKGROUND = false;
function refreshIn(lock, fn) {
  BACKGROUND = true;
  $.setsid(); // leave Alfred's process group: the next keystroke must not end the refresh
  if (!takeLock(lock)) return;
  try {
    fn();
  } catch (e) {
    const name = lock;
    const c = readCache(name);
    if (c) {
      c.error = String(e.message || e).slice(0, 300);
      c.at = NOW;
      delete c.dirty;
      writeCache(name, c);
    } else writeCache(name, { at: NOW, items: [], error: String(e.message || e).slice(0, 300) });
  } finally {
    releaseLock(lock);
  }
}

function fetchReminders() {
  const t0 = Date.now();
  const s = store();
  const items = s.reminders({});
  const lists = s.lists();
  const c = { at: NOW, took: Date.now() - t0, items, lists, defaultList: s.defaultList() };
  writeCache("lists", { at: NOW, lists, defaultList: c.defaultList });
  return writeCache("rems", c);
}

function fetchDone() {
  const t0 = Date.now();
  const items = store().reminders({ completedSince: startOfDay(addDays(NOW, -7)) });
  return writeCache("done", { at: NOW, took: Date.now() - t0, items });
}

function eventWindow(cfg) {
  const from = startOfDay(NOW);
  return { from, to: localDate(new Date(from).getFullYear(), new Date(from).getMonth(), new Date(from).getDate() + cfg.days) };
}

function fetchEvents(cfg) {
  const t0 = Date.now();
  const s = store();
  const w = eventWindow(cfg);
  const items = s.events(w.from, w.to);
  const calendars = s.calendars();
  return writeCache("events", { at: NOW, took: Date.now() - t0, from: w.from, to: w.to, items, calendars, defaultCalendar: s.defaultCalendar() });
}

function fetchFlagged() {
  return writeCache("flagged", { at: NOW, items: store().flagged() });
}

// { c, refreshing, error }
function cached(name, ttl, fetch, bgMode, extraStale) {
  const c = readCache(name);
  if (!stale(c, ttl) && !(extraStale && extraStale(c))) return { c };
  if (!c || (num(c.took) < SYNC_BUDGET && !lockHeld(name))) {
    try {
      return { c: fetch() };
    } catch (e) {
      if (c && !c.error) return { c, error: String(e.message || e) };
      throw e;
    }
  }
  return { c, refreshing: background(bgMode, name) };
}

function reminderData() {
  return cached("rems", REM_TTL, fetchReminders, "bg-rems");
}

function doneData() {
  return cached("done", REM_TTL, fetchDone, "bg-done");
}

function eventData(cfg) {
  const w = eventWindow(cfg);
  return cached("events", EV_TTL, () => fetchEvents(cfg), "bg-events", (c) => c.from !== w.from || c.to !== w.to);
}

// Flagged reminders come from AppleScript, which can take seconds: always in the background
function flaggedData() {
  const c = readCache("flagged");
  if (!stale(c, FLAG_TTL)) return { c };
  return { c, refreshing: background("bg-flagged", "flagged") };
}

// Lists and calendars for the add filters: from a small cache, refreshed in the foreground (fast)
function listData() {
  let c = readCache("lists");
  if (stale(c, 5 * MIN)) {
    const s = store();
    c = writeCache("lists", { at: NOW, lists: s.lists(), defaultList: s.defaultList() });
  }
  return c;
}

function calendarData() {
  let c = readCache("cals");
  if (stale(c, 5 * MIN)) {
    const s = store();
    c = writeCache("cals", { at: NOW, calendars: s.calendars(), defaultCalendar: s.defaultCalendar() });
  }
  return c;
}

// After a change: patch the cached rows so the next view is right at once, and re-read soon
function patchCache(name, fn) {
  const c = readCache(name);
  if (!c || !Array.isArray(c.items)) return;
  c.items = fn(c.items) || c.items;
  c.dirty = true;
  writeCache(name, c);
}

function hiddenCalendars() {
  const h = readJSON(`${dataDir()}/calendars.json`, {});
  return new Set(Array.isArray(h.hidden) ? h.hidden.filter((x) => typeof x === "string") : []);
}

function readState(name, ttl) {
  const s = readJSON(`${cacheDir()}/${name}.json`, null);
  if (!s || typeof s.at !== "number" || Date.now() - s.at > ttl || s.at > Date.now() + 5000) return null;
  return s;
}

function writeState(name, obj) {
  obj.at = Date.now();
  writeFile(`${cacheDir()}/${name}.json`, JSON.stringify(obj));
}

// ---------- Alfred output ----------

function icon(name) {
  return { path: `icons/${name}.png` };
}

function info(title, subtitle, iconName, extra) {
  return Object.assign({ title, subtitle: subtitle || "", valid: false, icon: icon(iconName || "info") }, extra || {});
}

function output(items, extra) {
  items.forEach((it, i) => {
    if (it && !it.uid) it.uid = `${i}|${String(it.title || "").replace(/[0-9]+/g, "#")}`;
  });
  return JSON.stringify(Object.assign({ skipknowledge: true, items }, extra || {}));
}

// Every modifier of a row that isn't an action: nothing happens and the subtitle says so
function noMods(sub) {
  const m = { valid: false, subtitle: sub || "" };
  return { cmd: m, alt: m, ctrl: m, fn: m, shift: m };
}

function vars(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined && obj[k] !== null) out[k] = String(obj[k]);
  return out;
}

// Rows for missing access; null when access is fine
function accessRows(kind, cfg, forWrite) {
  let status;
  try {
    status = store().status(kind);
  } catch (e) {
    return [info(`Couldn’t use ${kind === "reminder" ? "Reminders" : "Calendar"}`, clean(e.message || e, 200), "error")];
  }
  const what = kind === "reminder" ? "reminders" : "calendars";
  const app = kind === "reminder" ? "Reminders" : "Calendars";
  if (status === "full") return null;
  if (status === "writeOnly" && kind === "event" && forWrite) return null;
  if (status === "notDetermined")
    return [
      {
        title: `Allow Alfred to use your ${what}`,
        subtitle: "↩ Ask macOS for access (a dialog about Alfred appears)",
        arg: "request",
        icon: icon("privacy"),
        variables: vars({ rc_action: "request", rc_kind: kind }),
        mods: noMods(""),
      },
    ];
  const why =
    status === "writeOnly"
      ? `Alfred can add events but not read them. ↩ Open Privacy & Security › ${app} and choose Full Access`
      : status === "restricted"
        ? `Access is restricted on this Mac (for example by a profile). ↩ Open Privacy & Security › ${app}`
        : `↩ Open Privacy & Security › ${app} and turn on Alfred`;
  return [
    {
      title: status === "writeOnly" ? `Alfred can only add events` : `Alfred isn’t allowed to use your ${what}`,
      subtitle: why,
      arg: "privacy",
      icon: icon("privacy"),
      variables: vars({ rc_action: "privacy", rc_kind: kind }),
      mods: noMods(""),
    },
  ];
}

function errorRow(what, e) {
  return info(`Couldn’t ${what}`, clean(e && e.message ? e.message : e, 200), "error");
}

// ---------- reminders view (`rems`) ----------

const VIEWS = dict({
  today: ["Today", "Due today and overdue", "today"],
  overdue: ["Overdue", "Past their due date", "overdue"],
  scheduled: ["Scheduled", "Every reminder with a due date", "scheduled"],
  flagged: ["Flagged", "Flagged in Reminders", "flag"],
  all: ["All", "Every open reminder", "all"],
  done: ["Completed", "Completed in the last 7 days; ↩ marks one as not completed", "done"],
});

function isOverdue(r) {
  return r.due != null && (r.allDay ? startOfDay(r.due) < startOfDay(NOW) : r.due < NOW);
}

function isToday(r) {
  return r.due != null && dayDiff(r.due, NOW) === 0;
}

function priorityRank(p) {
  return p >= 1 && p <= 4 ? 0 : p === 5 ? 1 : p >= 6 ? 2 : 3;
}

function priorityMark(p) {
  return ["!!!", "!!", "!", ""][priorityRank(p)];
}

function priorityName(p) {
  return ["High", "Medium", "Low", "None"][priorityRank(p)];
}

function byDue(a, b) {
  const ad = a.due == null ? Infinity : a.allDay ? startOfDay(a.due) : a.due;
  const bd = b.due == null ? Infinity : b.allDay ? startOfDay(b.due) : b.due;
  if (ad !== bd) return ad < bd ? -1 : 1;
  const p = priorityRank(a.priority) - priorityRank(b.priority);
  if (p) return p;
  return (a.created || 0) - (b.created || 0);
}

function dueText(r) {
  if (r.due == null) return "";
  const w = whenLabel(r.due, r.allDay);
  return isOverdue(r) ? `Overdue · ${w}` : w;
}

function reminderIcon(r) {
  if (r.completed) return "done";
  if (isOverdue(r)) return "overdue";
  if (isToday(r)) return "today";
  if (r.due != null) return "scheduled";
  return "reminder";
}

function largeText(r) {
  const lines = [r.title || "Untitled"];
  if (r.due != null) lines.push(dueText(r));
  if (r.notes) lines.push("", r.notes.slice(0, 1000));
  if (r.url) lines.push("", r.url);
  return lines.join("\n");
}

function linkOf(r) {
  if (r.url && safeURL(r.url) && /^https?:/i.test(r.url)) return r.url;
  const m = /https?:\/\/[^\s<>"']+/.exec(r.notes || "");
  return m ? m[0].replace(/[.,;:!?)]+$/, "") : null;
}

function reminderRow(r, opts) {
  const parts = [];
  const due = dueText(r);
  if (r.completed) parts.push(`Completed ${r.completedAt ? whenLabel(r.completedAt, false) : ""}`.trim());
  else if (due) parts.push(due);
  if (!opts.inList && r.list) parts.push(r.list);
  const mark = priorityMark(r.priority);
  if (mark) parts.push(mark);
  if (r.recurring) parts.push("↻");
  const link = linkOf(r);
  if (link) parts.push("🔗");
  const title = clean(r.title, 200) || "Untitled";
  const base = { rc_id: r.id, rc_title: clean(r.title, 80) || "Untitled" };
  const row = {
    uid: `r|${r.id}`,
    title,
    subtitle: parts.join(" · "),
    arg: r.id,
    icon: icon(reminderIcon(r)),
    variables: vars(Object.assign({ rc_action: r.completed ? "uncomplete" : "complete" }, base)),
    text: { copy: r.title || "", largetype: largeText(r) },
    mods: {
      cmd: { subtitle: "Open in Reminders", arg: r.id, variables: vars(Object.assign({ rc_action: "open" }, base)) },
      alt: r.completed ? { valid: false, subtitle: "Mark it as not completed first" } : { subtitle: "Change the due date, priority or list…", arg: "due", variables: vars(Object.assign({ rc_action: "menu" }, base)) },
      ctrl: { subtitle: "Delete…", arg: "delete", variables: vars(Object.assign({ rc_action: "menu" }, base)) },
      fn: link ? { subtitle: `Open ${clean(link, 80)}`, arg: link, variables: vars({ rc_action: "openurl", rc_url: link }) } : { valid: false, subtitle: "No link in this reminder" },
    },
  };
  if (r.completed) row.subtitle = (row.subtitle ? row.subtitle + " · " : "") + "↩ Mark as not completed";
  if (link) row.quicklookurl = link;
  return row;
}

function viewRow(key, count, extra) {
  const v = VIEWS[key];
  return Object.assign(
    {
      uid: `view|${key}`,
      title: count === null || count === undefined ? v[0] : `${v[0]} · ${count}`,
      subtitle: v[1],
      valid: false,
      autocomplete: `:${key} `,
      icon: icon(v[2]),
      mods: noMods(""),
    },
    extra || {}
  );
}

function listRow(l, count) {
  const q = /\s/.test(l.title) ? `#"${l.title.replace(/"/g, "")}" ` : `#${l.title} `;
  return {
    uid: `list|${l.id}`,
    title: `${clean(l.title, 80)} · ${count}`,
    subtitle: `${l.source ? l.source + " · " : ""}Show this list`,
    valid: false,
    autocomplete: q,
    icon: icon("list"),
    mods: noMods(""),
  };
}

function undoRow() {
  const u = readState("undo", UNDO_TTL);
  if (!u || !u.kind || !u.title) return null;
  const what = dict({ complete: `completed “${u.title}”`, uncomplete: `marked “${u.title}” as not completed`, due: `changed the due date of “${u.title}”`, priority: `changed the priority of “${u.title}”`, move: `moved “${u.title}”`, add: `added “${u.title}”`, "event-add": `added the event “${u.title}”` })[u.kind];
  if (!what) return null;
  return {
    uid: "undo",
    title: `Undo: ${what}`,
    subtitle: `↩ Undo (${relAgo(u.at)})`,
    arg: "undo",
    icon: icon("undo"),
    variables: vars({ rc_action: "undo" }),
    mods: noMods(""),
  };
}

function relAgo(at) {
  const m = Math.round((Date.now() - at) / MIN);
  return m < 1 ? "just now" : `${m} min ago`;
}

// ":today #Home milk" → { view, listToken, text, partial }
function parseViewQuery(q) {
  const out = { view: null, listToken: null, text: "", partial: null };
  const words = tokenize(q);
  const rest = [];
  words.forEach((w, i) => {
    const last = i === words.length - 1 && !/\s$/.test(q);
    if (w.lit && w.prefix === "#") out.listToken = w.inner;
    else if (!w.lit && /^:[a-z]*$/i.test(w.raw)) {
      const k = w.raw.slice(1).toLowerCase();
      const hit = Object.keys(VIEWS).filter((v) => v.indexOf(k) === 0);
      if (k in VIEWS) out.view = k;
      else if (last) out.partial = { kind: "view", text: k, hits: hit };
      else if (hit.length === 1) out.view = hit[0];
      else rest.push(w.raw);
    } else if (!w.lit && /^#/.test(w.raw)) {
      if (last) out.partial = { kind: "list", text: w.raw.slice(1) };
      out.listToken = w.raw.slice(1);
    } else rest.push(w.lit ? w.inner : w.raw);
  });
  out.text = rest.join(" ").trim();
  return out;
}

function searchScore(r, words) {
  const t = fold(r.title);
  const hay = `${t} ${fold(r.list)} ${fold(r.notes)}`;
  let score = 0;
  for (const w of words) {
    if (!w) continue;
    if (t.indexOf(w) === 0) score += 4;
    else if (new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t)) score += 3;
    else if (t.indexOf(w) >= 0) score += 2;
    else if (hay.indexOf(w) >= 0) score += 1;
    else return 0;
  }
  return score;
}

function remsFilter(query) {
  const cfg = config();
  const denied = accessRows("reminder", cfg);
  if (denied) return output(denied);
  const q = parseViewQuery(query);
  let data;
  try {
    data = q.view === "done" ? doneData() : reminderData();
  } catch (e) {
    return output([errorRow("read your reminders", e)]);
  }
  const c = data.c;
  let items = (c.items || []).slice();
  let lists = c.lists || (readCache("rems") || {}).lists || [];
  if (q.view === "done") lists = (readCache("lists") || {}).lists || lists;
  const rows = [];
  const top = [];
  const undo = undoRow();
  if (undo && !query.trim()) top.push(undo);
  if (data.error) top.push(info("Couldn’t refresh your reminders", `Showing what was read ${relAgo(c.at)}: ${clean(data.error, 120)}`, "error"));
  if (c.error) top.push(errorRow("read your reminders", c.error));
  // partial ":" or "#": suggestions
  if (q.partial && q.partial.kind === "view") {
    for (const k of Object.keys(VIEWS)) if (k.indexOf(q.partial.text) === 0) rows.push(viewRow(k, null));
    if (rows.length) return output(top.concat(rows));
  }
  let list = null;
  if (q.listToken !== null) {
    list = matchName(q.listToken, lists);
    if (!list || (q.partial && q.partial.kind === "list")) {
      const f = fold(q.listToken).replace(/\s+/g, "");
      const hits = lists.filter((l) => fold(l.title).replace(/\s+/g, "").indexOf(f) >= 0);
      if (!list || (hits.length > 1 && q.partial)) {
        for (const l of hits) rows.push(listRow(l, items.filter((r) => r.listId === l.id).length));
        if (!rows.length) rows.push(info(`No list named “${clean(q.listToken, 60)}”`, "Type # to see your lists", "error"));
        return output(top.concat(rows));
      }
    }
  }
  if (list) items = items.filter((r) => r.listId === list.id);
  const words = fold(q.text).split(/\s+/).filter(Boolean);
  let flagged = null;
  if (q.view === "flagged") {
    if (!cfg.flagged) return output(top.concat([info("The Flagged view is turned off", "Turn it on in the Workflow’s Configuration", "info")]));
    flagged = flaggedData();
    const fc = flagged.c;
    if (!fc) return output(top.concat([info("Reading flagged reminders from Reminders…", "EventKit doesn’t know about flags, so they’re read from the Reminders app", "wait")]), flagged.refreshing ? { rerun: 0.5 } : {});
    if (fc && fc.error) {
      if (/-1743|not allowed|not authori[sz]ed/i.test(fc.error))
        top.push({ title: "Alfred isn’t allowed to control Reminders", subtitle: "Needed to read flags. ↩ Open Privacy & Security › Automation", arg: "automation", icon: icon("privacy"), variables: vars({ rc_action: "automation" }), mods: noMods("") });
      else top.push(errorRow("read flagged reminders", fc.error));
    }
    const byId = new Map(items.map((r) => [r.id, r]));
    const fl = [];
    for (const f of (fc && fc.items) || []) {
      const r = byId.get(f.id);
      if (r) fl.push(r);
      else if (!list) fl.push({ id: f.id, title: f.title, notes: "", url: null, list: "", listId: "", priority: 0, completed: false, created: 0, due: f.due, allDay: false, recurring: false });
    }
    items = fl;
  }
  if (q.view === "today") items = items.filter((r) => isOverdue(r) || isToday(r));
  else if (q.view === "overdue") items = items.filter(isOverdue);
  else if (q.view === "scheduled") items = items.filter((r) => r.due != null);
  let scored = null;
  if (words.length) {
    scored = items.map((r) => [searchScore(r, words), r]).filter((x) => x[0] > 0);
    scored.sort((a, b) => b[0] - a[0] || byDue(a[1], b[1]));
    items = scored.map((x) => x[1]);
  } else if (q.view === "done") items.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  else items.sort(byDue);
  const opts = { inList: !!list };
  if (!q.view && !list && !words.length) {
    // overview: what's due now, then the views and lists
    const all = c.items || [];
    const due = all.filter((r) => isOverdue(r) || isToday(r)).sort(byDue);
    for (const r of due.slice(0, MAX_ROWS)) rows.push(reminderRow(r, opts));
    if (!due.length) rows.push(info("Nothing due today", `${plural(all.length, "open reminder")} · type to search`, "done"));
    rows.push(viewRow("scheduled", all.filter((r) => r.due != null).length));
    if (cfg.flagged) rows.push(viewRow("flagged", null));
    rows.push(viewRow("all", all.length));
    rows.push(viewRow("done", null));
    for (const l of lists) rows.push(listRow(l, all.filter((r) => r.listId === l.id).length));
  } else {
    for (const r of items.slice(0, MAX_ROWS)) rows.push(reminderRow(r, opts));
    if (!items.length) {
      const where = list ? ` in ${clean(list.title, 60)}` : "";
      const label = q.view ? VIEWS[q.view][0].toLowerCase() + " reminders" : "reminders";
      rows.push(info(words.length ? `No ${label}${where} match “${clean(q.text, 60)}”` : `No ${label}${where}`, q.view === "done" ? "Nothing was completed in the last 7 days" : "", q.view === "done" ? "done" : "info"));
    }
    if (words.length && q.view !== "done") rows.push(addRow(q.text + (list ? ` #"${list.title.replace(/"/g, "")}"` : ""), cfg, lists, c.defaultList, "Add as a reminder"));
  }
  const extra = data.refreshing || (flagged && flagged.refreshing) ? { rerun: 0.5 } : {};
  return output(top.concat(rows), extra);
}

// ---------- adding reminders (`radd`) ----------

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function recLabel(rec) {
  if (!rec) return "";
  const unit = rec.freq;
  if (rec.days && rec.days.length) {
    const d = rec.days.join(",");
    if (d === "1,2,3,4,5" && rec.interval === 1) return "every weekday";
    const names = rec.days.map((x) => DAY_ABBR[x]).join(", ");
    return rec.interval === 1 ? `every ${names}` : `every ${rec.interval} weeks on ${names}`;
  }
  return rec.interval === 1 ? `every ${unit}` : rec.interval === 2 ? `every other ${unit}` : `every ${rec.interval} ${unit}s`;
}

function hostOf(u) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(u || "");
  return m ? m[1] : u;
}

function defaultList(cfg, lists, defId) {
  lists = lists.filter((l) => l.writable !== false);
  if (cfg.list) {
    const l = matchName(cfg.list, lists);
    if (l) return { list: l, configured: true };
  }
  const d = lists.filter((l) => l.id === defId)[0] || lists.filter((l) => l.writable !== false)[0] || null;
  return { list: d, configured: false, missing: cfg.list ? cfg.list : null };
}

function addRow(text, cfg, lists, defId, label) {
  const p = parse(text, "reminder", { lists: lists.filter((l) => l.writable !== false), defTime: cfg.defTime });
  const def = defaultList(cfg, lists, defId);
  const list = p.list || def.list;
  const parts = [];
  parts.push(p.start != null ? whenLabel(p.start, p.allDay) : "No due date");
  if (p.listToken !== null && !p.list) parts.push(`No list “${clean(p.listToken, 40)}”: ${list ? clean(list.title, 40) : "default list"}`);
  else if (list) parts.push(clean(list.title, 40));
  if (p.priority) parts.push(`${priorityName(p.priority)} priority`);
  if (p.rec) parts.push(`↻ ${recLabel(p.rec)}`);
  if (p.url) parts.push(`🔗 ${clean(hostOf(p.url), 40)}`);
  if (p.alert != null) parts.push(p.start != null && !p.allDay ? `⏰ ${p.alert === 0 ? "at the due time" : durationLabel(p.alert * MIN) + " before"}` : "⏰ needs a time");
  if (p.notes) parts.push("📝 notes");
  if (p.past) parts.push("⚠ in the past");
  const title = p.title;
  const payload = {
    title,
    due: p.start,
    allDay: p.allDay,
    priority: p.priority,
    listId: list ? list.id : null,
    listTitle: list ? list.title : "",
    url: p.url,
    notes: p.notes.slice(0, PAYLOAD_NOTES), // a huge selection would be repeated in every row's variables
    rec: p.rec,
    alarm: cfg.alarm,
    alert: p.alert,
  };
  // ⌥↩: the first line exactly as typed (only trimmed), the rest as notes
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const raw = lines[0].trim().slice(0, 1000);
  const rawPayload = { title: raw, due: null, allDay: false, priority: 0, listId: def.list ? def.list.id : null, listTitle: def.list ? def.list.title : "", url: null, notes: lines.slice(1).join("\n").trim().slice(0, PAYLOAD_NOTES), rec: null, alarm: false };
  if (!title) return info("Type what to be reminded of", `${parts.join(" · ")}`, "add", { uid: "add" });
  if (!list) return info(`Couldn’t add “${clean(title, 60)}”`, "There’s no reminder list to add it to: create one in Reminders", "error", { uid: "add" });
  return {
    uid: "add",
    title: label ? `${label}: ${clean(title, 150)}` : clean(title, 200),
    subtitle: parts.join(" · "),
    arg: "add",
    icon: icon("add"),
    variables: vars({ rc_action: "add", rc_payload: JSON.stringify(payload), rc_title: clean(title, 80) }),
    text: { copy: title, largetype: title },
    mods: {
      cmd: { subtitle: "Add it and open Reminders", arg: "add", variables: vars({ rc_action: "add", rc_open: "1", rc_payload: JSON.stringify(payload), rc_title: clean(title, 80) }) },
      alt: raw ? { subtitle: `Add “${clean(raw, 60)}” exactly as typed, without a date`, arg: "add", variables: vars({ rc_action: "add", rc_payload: JSON.stringify(rawPayload), rc_title: clean(raw, 80) }) } : { valid: false, subtitle: "" },
      ctrl: { valid: false, subtitle: "" },
      fn: { valid: false, subtitle: "" },
    },
  };
}

// A "#Li" being typed: the lists it could be, with ⇥ completing the name
function listSuggestions(query, lists, what) {
  const m = /(^|\s)#([^\s"“]*)$/.exec(query);
  if (!m) return [];
  const f = fold(m[2]);
  const hits = lists.filter((l) => l.writable !== false && fold(l.title).replace(/\s+/g, "").indexOf(f.replace(/\s+/g, "")) >= 0);
  if (hits.length === 1 && fold(hits[0].title) === f) return [];
  const head = query.slice(0, m.index + m[1].length);
  return hits.slice(0, 12).map((l) => ({
    uid: `sug|${l.id}`,
    title: clean(l.title, 80),
    subtitle: `⇥ ${what}${l.source ? " · " + l.source : ""}`,
    valid: false,
    autocomplete: head + (/\s/.test(l.title) ? `#"${l.title.replace(/"/g, "")}" ` : `#${l.title} `),
    icon: icon(what === "Calendar" ? "calendar" : "list"),
    mods: noMods(""),
  }));
}

function raddFilter(query) {
  const cfg = config();
  const denied = accessRows("reminder", cfg);
  if (denied) return output(denied);
  let lc;
  try {
    lc = listData();
  } catch (e) {
    return output([errorRow("read your reminder lists", e)]);
  }
  const lists = lc.lists || [];
  const rows = [];
  const def = defaultList(cfg, lists, lc.defaultList);
  if (!query.trim()) {
    const where = def.list ? `Adds to ${clean(def.list.title, 40)}${def.configured ? "" : " (Reminders’ default list)"}` : "No reminder list yet: create one in Reminders";
    rows.push(info("Type a reminder", where, "add"));
    if (def.missing) rows.push(info(`No list named “${clean(def.missing, 40)}”`, "Check “List for new reminders” in the Workflow’s Configuration", "error"));
    const examples = ["pay rent fri 9am !high", "call the bank tomorrow 10:30", "water plants every sat", "renew passport in 2 weeks", "read https://example.com tonight"];
    for (const ex of examples) rows.push({ title: ex, subtitle: "⇥ Try this example", valid: false, autocomplete: ex, icon: icon("idea"), mods: noMods("") });
    rows.push(info("Dates: today, tomorrow, fri, next week, in 3 days, oct 5, 2026-10-05; times: 5pm, 17:30, noon", "Priority !, !!, !!! or !high · list #Name · notes after // · \"quotes\" keep words as typed", "info"));
    return output(rows);
  }
  const sug = listSuggestions(query, lists, "List");
  rows.push(addRow(query, cfg, lists, lc.defaultList, ""));
  return output(rows.concat(sug));
}

// ---------- reminder actions (`ract`, ⌥↩ and ⌃↩ on a reminder) ----------

function target() {
  const id = env("rc_id", "");
  if (id) return { id, title: env("rc_title", "") };
  const s = readState("target", TARGET_TTL);
  return s && typeof s.id === "string" ? s : null;
}

function findReminder(id) {
  const c = readCache("rems");
  const hit = c && Array.isArray(c.items) ? c.items.filter((r) => r.id === id)[0] : null;
  return hit || store().getReminder(id);
}

// A date typed for a timed reminder keeps its time: "fri" moves 09:00 today to 09:00 Friday
function dueFrom(p, r) {
  if (p.start == null) return null;
  if (p.allDay && r.due != null && !r.allDay) {
    const t = new Date(r.due);
    const d = new Date(p.start);
    return { due: localDate(d.getFullYear(), d.getMonth(), d.getDate(), t.getHours(), t.getMinutes()), allDay: false };
  }
  return { due: p.start, allDay: p.allDay };
}

function ractRow(r, title, subtitle, iconName, action, extra) {
  return {
    title,
    subtitle,
    arg: action,
    icon: icon(iconName),
    variables: vars(Object.assign({ rc_action: action, rc_id: r.id, rc_title: clean(r.title, 80) || "Untitled" }, extra || {})),
    mods: noMods(""),
  };
}

// The eadd text for a reminder: its title in quotes (never parsed) and its due date as ISO, which reads the
// same in every region ("Pay rent" 2026-10-02T09:00)
function eventTextFor(r) {
  const title = `"${String(r.title || "").replace(/["“”\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}"`;
  if (r.due == null) return title + " ";
  const d = new Date(r.due);
  const p2 = (n) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return `${title} ${r.allDay ? day : `${day}T${p2(d.getHours())}:${p2(d.getMinutes())}`}`;
}

function dueRow(r, label, due, cfg) {
  const when = whenLabel(due.due, due.allDay);
  return ractRow(r, label ? `${label} · ${when}` : `Due ${when}`, `↩ Set the due date${due.due < NOW - MIN && !due.allDay ? " (in the past)" : ""}`, "snooze", "due", { rc_due: due.due, rc_allday: due.allDay ? "1" : "0", rc_alarm: cfg.alarm ? "1" : "0" });
}

function ractFilter(query) {
  const cfg = config();
  const denied = accessRows("reminder", cfg);
  if (denied) return output(denied);
  const t = target();
  if (!t) return output([info("Choose a reminder first", `Press ⌥↩ or ⌃↩ on a reminder in ${cfg.kwRems}`, "info", { valid: true, arg: "search", variables: vars({ rc_action: "search", rc_query: `${cfg.kwRems} ` }), subtitle: `↩ Open ${cfg.kwRems}, then press ⌥↩ or ⌃↩ on a reminder` })]);
  let r;
  try {
    r = findReminder(t.id);
  } catch (e) {
    return output([errorRow("read the reminder", e)]);
  }
  if (!r) return output([info(`“${clean(t.title, 60) || "The reminder"}” no longer exists`, "It may have been completed or deleted in Reminders", "error")]);
  const title = clean(r.title, 80) || "Untitled";
  const head = info(title, [dueText(r) || "No due date", r.list, priorityMark(r.priority)].filter(Boolean).join(" · "), reminderIcon(r), { uid: "head" });
  const q = query.trim();
  const rows = [head];
  if (q && "delete".indexOf(q.toLowerCase()) === 0 && q.length >= 3) {
    rows.push(ractRow(r, `Delete “${title}”?`, "↩ Delete it from Reminders. This can’t be undone", "trash", "delete"));
    rows.push(info("Keep it", "⇥ Back to the actions", "undo", { autocomplete: "" }));
    return output(rows);
  }
  let lists = [];
  try {
    lists = (listData().lists || []).filter((l) => l.writable !== false);
  } catch (e) {
    lists = [];
  }
  if (!q) {
    const presets = [["In 1 hour", "in 1 hour"], ["This evening", "today 6pm"], ["Tomorrow", "tomorrow"], ["This weekend", "this weekend"], ["Next week", "next week"]];
    const nowD = new Date(NOW);
    for (const [label, text] of presets) {
      if (text === "today 6pm" && nowD.getHours() >= 17) continue;
      if (text === "this weekend" && (nowD.getDay() === 6 || nowD.getDay() === 0)) continue;
      const due = dueFrom(parse(text, "reminder", { defTime: text === "tomorrow" || text === "next week" || text === "this weekend" ? cfg.defTime : null }), r);
      if (due) rows.push(dueRow(r, label, due, cfg));
    }
    if (r.due != null) rows.push(ractRow(r, "Remove the due date", "↩ No due date", "snooze", "due", { rc_due: "", rc_allday: "1" }));
    rows.push(info("Another date…", "Type it: fri 9am, in 3 days, oct 5, next mon…", "scheduled"));
    rows.push(info("Priority…", `Now ${priorityName(r.priority).toLowerCase()} · ⇥ Choose`, "priority", { autocomplete: "!" }));
    rows.push(info("Move to another list…", `Now in ${clean(r.list, 40) || "a list"} · ⇥ Choose`, "list", { autocomplete: "#" }));
    if (r.completed) rows.push(ractRow(r, "Mark as not completed", "↩ Back to the open reminders", "undo", "uncomplete"));
    else rows.push(ractRow(r, "Complete", "↩ Mark as completed (undo from the reminders list)", "done", "complete"));
    rows.push(ractRow(r, "Open in Reminders", "", "open", "open"));
    rows.push(ractRow(r, "Block time in Calendar…", `↩ Continue in ${cfg.kwEadd} with its title${r.due != null ? " and due date" : ""}`, "addevent", "search", { rc_query: `${cfg.kwEadd} ${eventTextFor(r)}` }));
    rows.push(info("Delete…", "⇥ Asks before deleting", "trash", { autocomplete: "delete" }));
    return output(rows);
  }
  if (q === "!" || (/^!\w+$/.test(q) && !/^!(high|hi|h|medium|med|m|low|lo|l|none|no|[0-3])$/i.test(q))) {
    const f = q.slice(1).toLowerCase();
    for (const [name, v] of [["High", 1], ["Medium", 5], ["Low", 9], ["None", 0]]) {
      if (name.toLowerCase().indexOf(f) !== 0) continue;
      rows.push(ractRow(r, `Priority: ${name}`, priorityRank(r.priority) === priorityRank(v) ? "The current priority" : "↩ Set the priority", "priority", "priority", { rc_priority: v }));
    }
    if (rows.length === 1) rows.push(info("Type !high, !medium, !low or !none", "", "priority"));
    return output(rows);
  }
  if (q === "#") {
    for (const l of lists) if (l.id !== r.listId) rows.push(ractRow(r, `Move to ${clean(l.title, 60)}`, "↩ Move the reminder to this list", "list", "move", { rc_list: l.id, rc_list_title: clean(l.title, 60) }));
    if (rows.length === 1) rows.push(info("There’s no other list", "Create one in Reminders", "list"));
    return output(rows);
  }
  const p = parse(q, "reminder", { lists });
  if (p.listToken !== null) {
    if (p.list && p.list.id !== r.listId) rows.push(ractRow(r, `Move to ${clean(p.list.title, 60)}`, "↩ Move the reminder to this list", "list", "move", { rc_list: p.list.id, rc_list_title: clean(p.list.title, 60) }));
    else if (p.list) rows.push(info(`Already in ${clean(p.list.title, 60)}`, "", "list"));
    const f = fold(p.listToken).replace(/\s+/g, "");
    if (!p.list || /#\S*$/.test(query)) {
      for (const l of lists) {
        if (l.id === r.listId || (p.list && l.id === p.list.id) || fold(l.title).replace(/\s+/g, "").indexOf(f) < 0) continue;
        rows.push(ractRow(r, `Move to ${clean(l.title, 60)}`, "↩ Move the reminder to this list", "list", "move", { rc_list: l.id, rc_list_title: clean(l.title, 60) }));
      }
    }
    if (rows.length === 1) rows.push(info(`No list named “${clean(p.listToken, 40)}”`, "Type # to see your lists", "error"));
  }
  if (/(^|\s)(!{1,3}|![a-z0-3]+)(\s|$)/i.test(q)) rows.push(ractRow(r, `Priority: ${priorityName(p.priority)}`, "↩ Set the priority", "priority", "priority", { rc_priority: p.priority }));
  const due = dueFrom(p, r);
  if (due) rows.splice(1, 0, dueRow(r, "", due, cfg));
  if (rows.length === 1) rows.push(info("Type a new due date", "Like tomorrow 9am, fri, in 2 hours, next week or oct 5; or !high, #List", "info"));
  return output(rows);
}

// ---------- agenda (`agenda`) ----------

function eventWhen(e) {
  if (e.allDay) {
    const lastDay = e.end - 1000;
    if (dayDiff(lastDay, e.start) >= 1) return `${dayLabel(Math.max(e.start, startOfDay(NOW)))} – ${dayLabel(lastDay)} · All day`;
    return `${dayLabel(e.start)} · All day`;
  }
  if (e.start <= NOW && e.end > NOW) return `Now · until ${dayDiff(e.end, NOW) === 0 ? timeLabel(e.end) : whenLabel(e.end, false)}`;
  const endPart = dayDiff(e.end, e.start) === 0 ? timeLabel(e.end) : whenLabel(e.end, false);
  const soon = e.start > NOW && e.start - NOW <= 3 * HOUR ? ` (${relLabel(e.start)})` : "";
  return `${whenLabel(e.start, false)}–${endPart}${soon}`;
}

function eventDetails(e) {
  const lines = [e.title || "Untitled", eventWhen(e)];
  if (e.location) lines.push(e.location);
  if (e.join) lines.push(e.join.url);
  return lines.join("\n");
}

function calendarURL(e) {
  if (!/^[\w:.-]+$/.test(e.cid || "")) return null;
  if (e.recurring) {
    const d = new Date(e.start);
    const p2 = (n) => String(n).padStart(2, "0");
    const stamp = e.allDay ? `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` : `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
    return `ical://ekevent/${stamp}/${e.cid}?method=show&options=more`;
  }
  return `ical://ekevent/${e.cid}?method=show&options=more`;
}

function eventRow(e, cfg) {
  const parts = [eventWhen(e)];
  if (e.location && !(e.join && e.location.indexOf(e.join.url) >= 0)) parts.push(clean(e.location, 60));
  if (e.calendar) parts.push(clean(e.calendar, 40));
  const openUrl = calendarURL(e);
  const base = { rc_title: clean(e.title, 80) || "Untitled", rc_cal_url: openUrl || "" };
  const join = e.join ? { rc_action: "join", rc_url: e.join.url, rc_service: e.join.service } : null;
  const open = { rc_action: "eopen" };
  const primary = join && cfg.joinFirst ? join : open;
  const secondary = primary === join ? open : join;
  const label = (v) => (v === join ? `Join the ${e.join.service} meeting` : "Open in Calendar");
  if (e.join) parts.unshift(e.join.service);
  const now = !e.allDay && e.start <= NOW && e.end > NOW;
  return {
    uid: `e|${e.id}|${e.start}`,
    title: clean(e.title, 200) || "Untitled",
    subtitle: parts.join(" · "),
    arg: e.cid || e.id || "event",
    icon: icon(e.join ? "join" : now ? "now" : e.allDay ? "allday" : "event"),
    variables: vars(Object.assign({}, base, primary)),
    text: { copy: eventDetails(e), largetype: eventDetails(e) },
    mods: {
      cmd: secondary ? { subtitle: label(secondary), arg: "event", variables: vars(Object.assign({}, base, secondary)) } : { subtitle: "Open in Calendar", arg: "event", variables: vars(Object.assign({}, base, open)) },
      alt: { subtitle: e.join ? "Copy the meeting link" : "Copy the event’s details", arg: "event", variables: vars({ rc_action: "copy", rc_text: e.join ? e.join.url : eventDetails(e), rc_title: base.rc_title }) },
      ctrl: { valid: false, subtitle: "" },
      fn: { valid: false, subtitle: "" },
    },
  };
}

function eventUndoRow() {
  const u = readState("undo", UNDO_TTL);
  if (!u || u.kind !== "event-add") return null;
  return { uid: "undo", title: `Undo: add “${clean(u.title, 60)}”`, subtitle: `↩ Delete the event you added (${relAgo(u.at)})`, arg: "undo", icon: icon("undo"), variables: vars({ rc_action: "undo" }), mods: noMods("") };
}

function calendarsView(c) {
  const hidden = hiddenCalendars();
  const rows = [];
  for (const cal of c.calendars || []) {
    const shown = !hidden.has(cal.id);
    rows.push({
      uid: `cal|${cal.id}`,
      title: `${shown ? "✓ " : "    "}${clean(cal.title, 80)}`,
      subtitle: `${cal.source ? cal.source + " · " : ""}↩ ${shown ? "Hide" : "Show"} its events in the agenda`,
      arg: cal.id,
      icon: icon(shown ? "calendar" : "hidden"),
      variables: vars({ rc_action: "togglecal", rc_cal: cal.id, rc_title: clean(cal.title, 60) }),
      mods: noMods(""),
    });
  }
  if (!rows.length) rows.push(info("No calendars", "Add one in Calendar", "info"));
  return rows;
}

function agendaFilter(query) {
  const cfg = config();
  const denied = accessRows("event", cfg);
  if (denied) return output(denied);
  let data;
  try {
    data = eventData(cfg);
  } catch (e) {
    return output([errorRow("read your calendars", e)]);
  }
  const c = data.c;
  const q = query.trim();
  const top = [];
  if (data.error) top.push(info("Couldn’t refresh your calendars", `Showing what was read ${relAgo(c.at)}: ${clean(data.error, 120)}`, "error"));
  if (c.error) top.push(errorRow("read your calendars", c.error));
  if (/^:c(a(l(e(n(d(a(rs?)?)?)?)?)?)?)?$/i.test(q)) return output(top.concat(calendarsView(c)));
  if (/^:\w*$/.test(q)) return output(top.concat([info("Choose calendars", "⇥ Show or hide calendars in the agenda", "calendar", { autocomplete: ":calendars" })]));
  const hidden = hiddenCalendars();
  let items = (c.items || []).filter((e) => !hidden.has(e.calendarId));
  let dayFilter = null;
  if (q) {
    // a date on its own ("tomorrow", "fri", "oct 5") shows that day
    const p = parse(q, "reminder", {});
    if (!p.title && p.start != null && !p.rec) {
      dayFilter = startOfDay(p.start);
      const dayEnd = localDate(new Date(dayFilter).getFullYear(), new Date(dayFilter).getMonth(), new Date(dayFilter).getDate() + 1);
      if (dayFilter < c.from || dayEnd > c.to) {
        try {
          items = store().events(dayFilter, dayEnd).filter((e) => !hidden.has(e.calendarId));
        } catch (e) {
          return output(top.concat([errorRow("read your calendars", e)]));
        }
      } else items = items.filter((e) => e.start < dayEnd && e.end > dayFilter);
      items.sort((a, b) => (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0) || a.start - b.start);
      const rows = items.slice(0, MAX_ROWS).map((e) => eventRow(e, cfg));
      if (!rows.length) rows.push(info(`No events ${dayDiff(dayFilter, NOW) === 0 ? "today" : "on " + dayLabel(dayFilter)}`, "", "event"));
      return output(top.concat(rows), data.refreshing ? { rerun: 0.5 } : {});
    }
    const words = fold(q).split(/\s+/).filter(Boolean);
    items = items.filter((e) => {
      const hay = fold(`${e.title} ${e.location} ${e.calendar} ${e.join ? e.join.service : ""}`);
      return words.every((w) => hay.indexOf(w) >= 0);
    });
    const rows = items.slice(0, MAX_ROWS).map((e) => eventRow(e, cfg));
    if (!rows.length) {
      rows.push(info(`No events match “${clean(q, 60)}”`, `Searched the next ${plural(cfg.days, "day")}`, "event"));
      rows.push({ title: `Add “${clean(q, 60)}” as an event`, subtitle: `↩ Continue in ${cfg.kwEadd}`, arg: "search", icon: icon("addevent"), variables: vars({ rc_action: "search", rc_query: `${cfg.kwEadd} ${q}` }), mods: noMods("") });
    }
    return output(top.concat(rows), data.refreshing ? { rerun: 0.5 } : {});
  }
  // upcoming: what's on now, then the rest in order; today's all-day events first
  items = items.filter((e) => e.end > NOW);
  const today = startOfDay(NOW);
  const key = (e) => {
    const onNow = !e.allDay && e.start <= NOW ? 0 : 1;
    const day = e.allDay ? Math.max(startOfDay(e.start), today) : startOfDay(e.start);
    return [onNow, day, e.allDay ? 0 : 1, e.start];
  };
  items.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
  const rows = [];
  const undo = eventUndoRow();
  if (undo) rows.push(undo);
  for (const e of items.slice(0, MAX_ROWS)) rows.push(eventRow(e, cfg));
  if (!items.length) rows.push(info(`No events in the next ${plural(cfg.days, "day")}`, hidden.size ? `${plural(hidden.size, "calendar")} hidden · type :calendars to choose` : "", "event"));
  else if (hidden.size) rows.push(info(`${plural(hidden.size, "calendar")} hidden`, "⇥ Choose calendars", "hidden", { autocomplete: ":calendars" }));
  return output(top.concat(rows), data.refreshing ? { rerun: 0.5 } : {});
}

// ---------- adding events (`eadd`) ----------

function eaddFilter(query) {
  const cfg = config();
  const denied = accessRows("event", cfg, true);
  if (denied) return output(denied);
  const writeOnly = store().status("event") === "writeOnly";
  let cals = [];
  let defId = null;
  if (!writeOnly) {
    try {
      const cc = calendarData();
      cals = (cc.calendars || []).filter((c) => c.writable !== false);
      defId = cc.defaultCalendar;
    } catch (e) {
      return output([errorRow("read your calendars", e)]);
    }
  }
  let def = null;
  let defMissing = null;
  if (cfg.calendar && cals.length) {
    def = matchName(cfg.calendar, cals);
    if (!def) defMissing = cfg.calendar;
  }
  if (!def) def = cals.filter((c) => c.id === defId)[0] || cals[0] || null;
  if (!query.trim()) {
    const rows = [info("Type an event", def ? `Adds to ${clean(def.title, 40)}` : "Adds to Calendar’s default calendar", "event")];
    if (defMissing) rows.push(info(`No calendar named “${clean(defMissing, 40)}”`, "Check “Calendar for new events” in the Workflow’s Configuration", "error"));
    for (const ex of ["lunch with Sam tomorrow 1pm for 1h at Cafe", "standup mon 9:30-9:45", "dentist oct 5 3pm", "offsite nov 2 for 3 days", "call 4pm ET https://zoom.us/j/123"]) rows.push({ title: ex, subtitle: "⇥ Try this example", valid: false, autocomplete: ex, icon: icon("idea"), mods: noMods("") });
    rows.push(info("Dates and times like reminders; 1-2pm, for 90 min, until 5pm, all day", "Location: at Place or @Place · calendar #Name · notes after // · alert 10 min before", "info"));
    return output(rows);
  }
  const p = parse(query, "event", { lists: cals, duration: cfg.duration, location: cfg.location });
  const cal = p.list || def;
  const parts = [];
  if (p.allDay) {
    const days = Math.round((p.end - p.start) / DAY);
    parts.push(days > 1 ? `${whenLabel(p.start, true)} – ${whenLabel(p.end - DAY, true)} · All day` : `${whenLabel(p.start, true)} · All day`);
  } else parts.push(`${whenLabel(p.start, false)}–${dayDiff(p.end, p.start) === 0 ? timeLabel(p.end) : whenLabel(p.end, false)}${p.guessed ? " (no time given)" : ""}`);
  if (p.location) parts.push(`📍 ${clean(p.location, 50)}`);
  if (p.listToken !== null && !p.list) parts.push(writeOnly ? "Calendars can’t be chosen with add-only access" : `No calendar “${clean(p.listToken, 40)}”: ${cal ? clean(cal.title, 40) : "default"}`);
  else if (cal) parts.push(clean(cal.title, 40));
  if (p.rec) parts.push(`↻ ${recLabel(p.rec)}`);
  const alert = p.alert != null ? p.alert : cfg.alertEvent;
  if (alert != null) parts.push(`⏰ ${alert === 0 ? "at start" : durationLabel(alert * MIN) + " before"}`);
  const join = joinLink([p.url, p.location, p.notes]);
  if (join) parts.push(join.service);
  else if (p.url) parts.push(`🔗 ${clean(hostOf(p.url), 40)}`);
  if (p.past) parts.push("⚠ in the past");
  if (p.zoneError) return output([info("Couldn’t work out that time zone", "Use UTC, +05:30, an abbreviation like EST or a name like Europe/London", "error")]);
  // overlaps with what's already in the (cached) agenda
  const ev = readCache("events");
  if (ev && !p.allDay && Array.isArray(ev.items)) {
    const hidden = hiddenCalendars();
    const clash = ev.items.filter((e) => !e.allDay && !hidden.has(e.calendarId) && e.start < p.end && e.end > p.start)[0];
    if (clash) parts.push(`Overlaps “${clean(clash.title, 40)}”`);
  }
  if (!p.title) return output([info("Type the event’s title", parts.join(" · "), "event", { uid: "add" })]);
  const payload = { title: p.title, start: p.start, end: p.end, allDay: p.allDay, location: p.location || "", notes: p.notes.slice(0, PAYLOAD_NOTES), url: p.url, calendarId: cal && !writeOnly ? cal.id : null, calendarTitle: cal ? cal.title : "", rec: p.rec, alert };
  const row = {
    uid: "add",
    title: clean(p.title, 200),
    subtitle: parts.join(" · "),
    arg: "add",
    icon: icon("addevent"),
    variables: vars({ rc_action: "eadd", rc_payload: JSON.stringify(payload), rc_title: clean(p.title, 80) }),
    text: { copy: p.title, largetype: p.title },
    mods: {
      cmd: { subtitle: "Add it and open Calendar", arg: "add", variables: vars({ rc_action: "eadd", rc_open: "1", rc_payload: JSON.stringify(payload), rc_title: clean(p.title, 80) }) },
      alt: { valid: false, subtitle: "" },
      ctrl: { valid: false, subtitle: "" },
      fn: { valid: false, subtitle: "" },
    },
  };
  return output([row].concat(writeOnly ? [] : listSuggestions(query, cals, "Calendar")));
}

// ---------- actions ----------

function payloadOf(name) {
  let p;
  try {
    p = JSON.parse(env(name, "{}"));
  } catch (e) {
    return null;
  }
  if (!p || typeof p !== "object" || typeof p.title !== "string" || !p.title.trim()) return null;
  const time = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  return {
    title: p.title.slice(0, 1000),
    due: time(p.due),
    start: time(p.start),
    end: time(p.end),
    allDay: p.allDay === true,
    priority: [0, 1, 5, 9].includes(p.priority) ? p.priority : 0,
    listId: typeof p.listId === "string" ? p.listId : null,
    listTitle: typeof p.listTitle === "string" ? p.listTitle : "",
    calendarId: typeof p.calendarId === "string" ? p.calendarId : null,
    calendarTitle: typeof p.calendarTitle === "string" ? p.calendarTitle : "",
    url: typeof p.url === "string" && /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(p.url) ? p.url : null,
    notes: typeof p.notes === "string" ? p.notes.slice(0, PAYLOAD_NOTES) : "",
    location: typeof p.location === "string" ? p.location.slice(0, 500) : "",
    rec: p.rec && typeof p.rec === "object" && p.rec.freq in FREQ ? { freq: p.rec.freq, interval: num(p.rec.interval) || 1, days: Array.isArray(p.rec.days) ? p.rec.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : null } : null,
    alarm: p.alarm === true,
    alert: typeof p.alert === "number" && p.alert >= 0 && p.alert < 100000 ? p.alert : null,
  };
}

function reminderURL(id) {
  return /^[\w-]+$/.test(id || "") ? `x-apple-reminderkit://REMCDReminder/${id}` : null;
}

function patchReminder(id, fn) {
  patchCache("rems", (items) => items.map((r) => (r.id === id ? Object.assign({}, r, fn(r)) : r)));
}

function act() {
  const a = env("rc_action", "");
  const cfg = config();
  const id = env("rc_id", "");
  const title = clean(env("rc_title", ""), 60) || "the reminder";
  const kind = env("rc_kind", "") === "event" ? "event" : "reminder";
  switch (a) {
    case "request": {
      const what = kind === "reminder" ? "reminders" : "calendars";
      const st = store().request(kind);
      if (st === "full" || (kind === "event" && st === "writeOnly")) {
        alfredSearch(`${kind === "reminder" ? cfg.kwRems : cfg.kwAgenda} `);
        return undefined;
      }
      openURL(privacyURL(kind));
      if (st === "notDetermined") return `Couldn’t ask for access to your ${what}: turn on Alfred in Privacy & Security`;
      return `Alfred isn’t allowed to use your ${what}: turn it on in Privacy & Security`;
    }
    case "privacy":
      openURL(privacyURL(kind));
      return undefined;
    case "automation":
      openURL("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation");
      return undefined;
    case "search":
      alfredSearch(env("rc_query", `${cfg.kwRems} `));
      return undefined;
    case "open": {
      if (!openURL(reminderURL(id))) return `Couldn’t open “${title}” in Reminders`;
      return undefined;
    }
    case "openurl":
      if (!openURL(env("rc_url", ""))) return "Couldn’t open the link";
      return undefined;
    case "complete":
    case "uncomplete": {
      const done = a === "complete";
      // a repeating reminder moves to its next date when completed: undo puts the date back
      const before = done ? findReminder(id) : null;
      store().updateReminder(id, { completed: done });
      const prev = before && before.recurring ? { due: before.due, allDay: before.allDay, alarm: before.dueAlarm !== undefined ? !!before.dueAlarm : before.alarms > 0 } : undefined;
      writeState("undo", { kind: a, id, title, prev });
      if (done) {
        let moved = null;
        patchCache("rems", (items) => items.filter((r) => (r.id === id ? ((moved = r), false) : true)));
        if (moved) patchCache("done", (items) => [Object.assign({}, moved, { completed: true, completedAt: NOW })].concat(items));
      } else {
        patchCache("done", (items) => items.filter((r) => r.id !== id));
        patchCache("rems", (items) => items);
      }
      return done ? `Completed “${title}”` : `“${title}” is no longer completed`;
    }
    case "due": {
      const s = store();
      const before = findReminder(id);
      const raw = env("rc_due", "");
      const due = raw === "" ? null : Number(raw);
      if (due !== null && !isFinite(due)) return "Couldn’t read the new due date";
      const allDay = env("rc_allday", "0") === "1";
      s.updateReminder(id, { due, allDay, alarm: env("rc_alarm", "0") === "1" });
      if (before) writeState("undo", { kind: "due", id, title, prev: { due: before.due, allDay: before.allDay, alarm: before.dueAlarm !== undefined ? !!before.dueAlarm : before.alarms > 0 } });
      patchReminder(id, () => ({ due, allDay }));
      return due === null ? `Removed the due date of “${title}”` : `“${title}” is due ${whenLabel(due, allDay)}`;
    }
    case "priority": {
      const before = findReminder(id);
      const p = Number(env("rc_priority", "0"));
      if (![0, 1, 5, 9].includes(p)) return "Couldn’t read the priority";
      store().updateReminder(id, { priority: p });
      if (before) writeState("undo", { kind: "priority", id, title, prev: { priority: before.priority } });
      patchReminder(id, () => ({ priority: p }));
      return `“${title}” has ${priorityName(p).toLowerCase()} priority`;
    }
    case "move": {
      const before = findReminder(id);
      const listId = env("rc_list", "");
      const listTitle = clean(env("rc_list_title", ""), 60);
      store().updateReminder(id, { listId });
      if (before) writeState("undo", { kind: "move", id, title, prev: { listId: before.listId, list: before.list } });
      patchReminder(id, () => ({ listId, list: listTitle }));
      return `Moved “${title}” to ${listTitle || "the list"}`;
    }
    case "delete": {
      store().removeReminder(id);
      patchCache("rems", (items) => items.filter((r) => r.id !== id));
      const u = readState("undo", UNDO_TTL);
      if (u && u.id === id) removeFile(`${cacheDir()}/undo.json`);
      return `Deleted “${title}”`;
    }
    case "add": {
      const f = payloadOf("rc_payload");
      if (!f) return "Couldn’t add the reminder: nothing to add";
      const res = store().addReminder(f);
      writeState("undo", { kind: "add", id: res.id, title: clean(f.title, 60) });
      patchCache("rems", (items) => items.concat([{ id: res.id, title: f.title, notes: f.notes, url: f.url, list: f.listTitle, listId: f.listId, priority: f.priority, completed: false, completedAt: null, created: NOW, due: f.due, allDay: f.allDay, recurring: !!f.rec, alarms: 0, dueAlarm: false }]));
      if (env("rc_open", "") === "1") {
        openURL(reminderURL(res.id));
        return undefined;
      }
      const bits = [f.due !== null ? whenLabel(f.due, f.allDay) : "", f.listTitle ? clean(f.listTitle, 40) : ""].filter(Boolean);
      return `Added “${clean(f.title, 60)}”${bits.length ? " · " + bits.join(" · ") : ""}`;
    }
    case "eadd": {
      const f = payloadOf("rc_payload");
      if (!f || f.start === null || f.end === null) return "Couldn’t add the event: nothing to add";
      const st = store();
      const res = st.addEvent(f);
      // with add-only access the event can't be found again, so there's nothing to undo
      if (st.status("event") !== "writeOnly") writeState("undo", { kind: "event-add", id: res.id, title: clean(f.title, 60) });
      patchCache("events", (items) => items);
      if (env("rc_open", "") === "1") {
        openURL(calendarURL({ cid: res.cid, start: f.start, allDay: f.allDay, recurring: false }));
        return undefined;
      }
      const when = f.allDay ? `${whenLabel(f.start, true)}` : whenLabel(f.start, false);
      return `Added “${clean(f.title, 60)}” · ${when}${f.calendarTitle ? " · " + clean(f.calendarTitle, 40) : ""}`;
    }
    case "undo": {
      const u = readState("undo", UNDO_TTL);
      if (!u) return "Nothing to undo";
      const s = store();
      const t = clean(u.title, 60);
      let msg;
      try {
        if (u.kind === "complete" || u.kind === "uncomplete") {
          s.updateReminder(u.id, { completed: u.kind !== "complete" });
          if (u.kind === "complete" && u.prev && u.prev.due != null) {
            const now = s.getReminder(u.id);
            if (now && now.due !== u.prev.due) s.updateReminder(u.id, { due: u.prev.due, allDay: !!u.prev.allDay, alarm: !!u.prev.alarm });
          }
          patchCache("rems", (items) => items);
          patchCache("done", (items) => items.filter((r) => r.id !== u.id));
          msg = u.kind === "complete" ? `“${t}” is no longer completed` : `Completed “${t}” again`;
        } else if (u.kind === "due" && u.prev) {
          s.updateReminder(u.id, { due: u.prev.due, allDay: !!u.prev.allDay, alarm: !!u.prev.alarm });
          patchReminder(u.id, () => ({ due: u.prev.due, allDay: !!u.prev.allDay }));
          msg = `Restored the due date of “${t}”`;
        } else if (u.kind === "priority" && u.prev) {
          s.updateReminder(u.id, { priority: u.prev.priority });
          patchReminder(u.id, () => ({ priority: u.prev.priority }));
          msg = `Restored the priority of “${t}”`;
        } else if (u.kind === "move" && u.prev) {
          s.updateReminder(u.id, { listId: u.prev.listId });
          patchReminder(u.id, () => ({ listId: u.prev.listId, list: u.prev.list }));
          msg = `Moved “${t}” back`;
        } else if (u.kind === "add") {
          s.removeReminder(u.id);
          patchCache("rems", (items) => items.filter((r) => r.id !== u.id));
          msg = `Removed “${t}”`;
        } else if (u.kind === "event-add") {
          s.removeEvent(u.id);
          patchCache("events", (items) => items.filter((e) => e.id !== u.id));
          msg = `Removed the event “${t}”`;
        } else return "Nothing to undo";
      } catch (e) {
        // the item is gone: there's nothing left to undo, so the row goes too
        if (/no longer exists/.test(String(e.message || e))) removeFile(`${cacheDir()}/undo.json`);
        throw e;
      }
      removeFile(`${cacheDir()}/undo.json`);
      return msg;
    }
    case "join":
      if (!openURL(env("rc_url", ""))) return "Couldn’t open the meeting link";
      return undefined;
    case "eopen":
      if (!openURL(env("rc_cal_url", ""))) return "Couldn’t open the event in Calendar";
      return undefined;
    case "copy":
      copyText(env("rc_text", ""));
      return `Copied ${/^[a-z]+:\/\//i.test(env("rc_text", "")) ? "the meeting link" : `“${title}”`}`;
    case "togglecal": {
      const cal = env("rc_cal", "");
      const h = hiddenCalendars();
      if (h.has(cal)) h.delete(cal);
      else h.add(cal);
      writeFile(`${dataDir()}/calendars.json`, JSON.stringify({ hidden: Array.from(h) }));
      alfredSearch(`${cfg.kwAgenda} :calendars`);
      return undefined;
    }
    default:
      return `Unknown action: ${clean(a, 40)}`;
  }
}

// ⌥↩ / ⌃↩ on a reminder: remember it for `ract` (in case Alfred drops the variables) and print its query
function targetOut(arg) {
  const id = env("rc_id", "");
  if (id) writeState("target", { id, title: env("rc_title", "") });
  const q = arg === "delete" ? "delete" : "";
  if (q) $.NSFileHandle.fileHandleWithStandardOutput.writeData($(q).dataUsingEncoding($.NSUTF8StringEncoding));
}

// ---------- tests only ----------

function parseBatch() {
  const cases = JSON.parse(env("RC_TEST_PARSE", "[]"));
  return JSON.stringify(
    cases.map((c) => {
      if (c.kind === "join") return joinLink(c.texts || []);
      if (c.kind === "label") return { when: whenLabel(c.ms, !!c.allDay), time: timeLabel(c.ms), h24: localeInfo().h24, dmy: localeInfo().dmy, firstWeekday: localeInfo().firstWeekday };
      const r = parse(c.text, c.kind || "reminder", { lists: c.lists || [], defTime: c.defTime || null, duration: c.duration || 60, location: c.location !== false });
      const iso = (ms) => {
        if (ms === null || ms === undefined) return null;
        const d = new Date(ms);
        const p2 = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
      };
      return Object.assign({}, r, { list: r.list ? r.list.title : null, startLocal: iso(r.start), endLocal: iso(r.end), when: r.start !== null ? whenLabel(r.start, r.allDay) : null });
    })
  );
}

// Builds EventKit objects in memory (never saved, nothing is read) to check the conversions
function selftest() {
  ObjC.import("EventKit");
  const s = $.EKEventStore.alloc.init;
  const out = {};
  const r = $.EKReminder.reminderWithEventStore(s);
  r.title = "Pay rent “now”";
  r.priority = 1;
  const due = localDate(2026, 9, 2, 9, 30);
  r.dueDateComponents = componentsOf(due, false);
  r.URL = $.NSURL.URLWithString("https://example.com/a?b=c");
  r.addAlarm($.EKAlarm.alarmWithAbsoluteDate(nsDate(due)));
  const rule = recurrenceRule({ freq: "week", interval: 2, days: [1, 4] });
  r.addRecurrenceRule(rule);
  out.timed = reminderJS(r);
  // snoozing moves the alarm that belonged to the old due time
  const r4 = $.EKReminder.reminderWithEventStore(s);
  r4.dueDateComponents = componentsOf(due, false);
  setAlarm(r4, null, due, false, true);
  r4.addAlarm($.EKAlarm.alarmWithRelativeOffset(-600));
  const later = due + DAY;
  r4.dueDateComponents = componentsOf(later, false);
  setAlarm(r4, due, later, false, true);
  out.snoozed = { due: reminderJS(r4).due, alarms: ObjC.deepUnwrap(r4.alarms).length, absolute: [0, 1].map((i) => msOf(r4.alarms.objectAtIndex(i).absoluteDate)).filter((x) => x !== null) };
  out.snoozedExpected = later;
  // an early alarm ("10 min before") keeps its distance when the due date moves
  const r5 = $.EKReminder.reminderWithEventStore(s);
  r5.dueDateComponents = componentsOf(due, false);
  setAlarm(r5, null, due, false, true, 10);
  const added = alarmTimes(r5);
  r5.dueDateComponents = componentsOf(later, false);
  setAlarm(r5, due, later, false, true, null);
  out.early = { added, moved: alarmTimes(r5).sort((a, b) => a - b), dueAlarm: reminderJS(r5).dueAlarm };
  out.timedExpected = due;
  const r2 = $.EKReminder.reminderWithEventStore(s);
  r2.title = "All day";
  r2.dueDateComponents = componentsOf(localDate(2026, 11, 31), true);
  out.allDay = reminderJS(r2);
  out.allDayExpected = localDate(2026, 11, 31);
  const r3 = $.EKReminder.reminderWithEventStore(s);
  out.none = reminderJS(r3);
  out.rule = { freq: Number(rule.frequency), interval: Number(rule.interval), days: ObjC.deepUnwrap(rule.daysOfTheWeek.valueForKey("dayOfTheWeek")) };
  const e = $.EKEvent.eventWithEventStore(s);
  e.title = "Lunch";
  e.startDate = nsDate(localDate(2026, 8, 29, 13, 0));
  e.endDate = nsDate(localDate(2026, 8, 29, 14, 0));
  e.location = "Cafe https://meet.google.com/abc-defg-hij";
  out.event = eventJS(e);
  return JSON.stringify(out);
}

// ---------- main ----------

const FILTERS = dict({ rems: remsFilter, radd: raddFilter, ract: ractFilter, agenda: agendaFilter, eadd: eaddFilter });

function run(argv) {
  const mode = argv[0] || "rems";
  const arg = argv.length > 1 ? String(argv[1]) : "";
  if (mode in FILTERS) {
    try {
      return FILTERS[mode](arg);
    } catch (e) {
      return output([errorRow(mode === "agenda" || mode === "eadd" ? "read your calendars" : "read your reminders", e)]);
    }
  }
  try {
    switch (mode) {
      case "act":
        return act();
      case "target":
        targetOut(arg);
        return undefined;
      case "bg-rems":
        refreshIn("rems", fetchReminders);
        return undefined;
      case "bg-done":
        refreshIn("done", fetchDone);
        return undefined;
      case "bg-events":
        refreshIn("events", () => fetchEvents(config()));
        return undefined;
      case "bg-flagged":
        refreshIn("flagged", fetchFlagged);
        return undefined;
      case "parse":
        if (!TEST) return undefined;
        return parseBatch();
      case "selftest":
        if (!TEST || env("RC_TEST_SELFTEST", "") !== "1") return undefined;
        return selftest();
      default:
        return `Unknown mode: ${clean(mode, 40)}`;
    }
  } catch (e) {
    const what = dict({ complete: "complete it", uncomplete: "mark it as not completed", due: "change the due date", priority: "change the priority", move: "move it", delete: "delete it", add: "add the reminder", eadd: "add the event", undo: "undo", request: "ask for access" })[env("rc_action", "")];
    return `Couldn’t ${what || "do that"}: ${clean(e.message || e, 150)}`;
  }
}
