#!/usr/bin/env python3
"""End-to-end tests: run the Script Filters and actions the way Alfred does and check the output.

EventKit is replaced by a JSON file (RC_TEST_STORE) that the script reads and writes through FakeStore,
so the tests never read or change real reminders or calendars: every run sets RC_TEST_STORE (asserted
in run()), and with RC_TEST_* set but no store the script refuses to run (tested). Opening URLs,
copying and Alfred searches are logged to RC_TEST_LOG instead of happening.

Python 3.9 compatible (macOS's /usr/bin/python3).
"""
import json, os, plistlib, shutil, subprocess, sys, tempfile, time, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
SCRIPT = os.path.join(SRC, "rc.js")
TMP = tempfile.mkdtemp(prefix="rc test ")  # a space in every path, like Alfred's folders
NOW = "2026-09-28T10:00"  # a Monday
BASE_TZ = "America/New_York"


def local_ms(text, tz=BASE_TZ):
    """Milliseconds for a local wall-clock time in a zone (zoneinfo ships with Python 3.9)."""
    from datetime import datetime
    from zoneinfo import ZoneInfo
    d = datetime.strptime(text, "%Y-%m-%d %H:%M").replace(tzinfo=ZoneInfo(tz))
    return int(d.timestamp() * 1000)


def base_store():
    return {
        "access": {"reminder": "full", "event": "full"},
        "lists": [
            {"id": "L-home", "title": "Home", "default": True},
            {"id": "L-work", "title": "Work"},
            {"id": "L-shop", "title": "Shopping List"},
            {"id": "L-ro", "title": "Shared (read-only)", "writable": False},
        ],
        "calendars": [
            {"id": "C-work", "title": "Work", "default": True},
            {"id": "C-home", "title": "Personal"},
            {"id": "C-bday", "title": "Birthdays", "writable": False},
        ],
        "reminders": [
            {"id": "R1", "title": "Pay rent", "listId": "L-home", "priority": 1, "due": "2026-09-27 09:00", "created": "2026-09-01 08:00", "notes": "IBAN in the folder", "flagged": True},
            {"id": "R2", "title": "Call the bank", "listId": "L-work", "due": "2026-09-28 15:00", "created": "2026-09-02 08:00"},
            {"id": "R3", "title": "Buy milk", "listId": "L-shop", "due": "2026-09-28", "allDay": True, "created": "2026-09-03 08:00", "url": "https://shop.example.com/milk"},
            {"id": "R4", "title": "Renew passport", "listId": "L-home", "due": "2026-10-12", "allDay": True, "priority": 5, "created": "2026-09-04 08:00", "rec": {"freq": "year", "interval": 10}},
            {"id": "R5", "title": "Read “Dune”", "listId": "L-home", "created": "2026-09-05 08:00", "notes": "see https://books.example.org/dune."},
            {"id": "R6", "title": "Water plants", "listId": "L-home", "due": "2026-09-26", "allDay": True, "created": "2026-09-06 08:00"},
            {"id": "R7", "title": "Old task", "listId": "L-work", "completed": True, "completedAt": "2026-09-27 18:00", "created": "2026-09-01 08:00"},
            {"id": "R8", "title": "Ancient task", "listId": "L-work", "completed": True, "completedAt": "2026-08-01 18:00", "created": "2026-07-01 08:00"},
        ],
        "events": [
            {"id": "E1", "title": "Standup", "calendarId": "C-work", "start": "2026-09-28 09:45", "end": "2026-09-28 10:15", "notes": "Join: https://acme.zoom.us/j/123456789?pwd=abc"},
            {"id": "E2", "title": "Lunch with Sam", "calendarId": "C-home", "start": "2026-09-28 13:00", "end": "2026-09-28 14:00", "location": "Cafe Blue"},
            {"id": "E3", "title": "Offsite", "calendarId": "C-work", "start": "2026-09-30", "end": "2026-10-02", "allDay": True},
            {"id": "E4", "title": "Design review", "calendarId": "C-work", "start": "2026-09-29 11:00", "end": "2026-09-29 12:00", "url": "https://meet.google.com/abc-defg-hij", "recurring": True},
            {"id": "E5", "title": "Early call", "calendarId": "C-work", "start": "2026-09-28 07:00", "end": "2026-09-28 08:00"},
            {"id": "E6", "title": "Mum’s birthday", "calendarId": "C-bday", "start": "2026-09-28", "end": "2026-09-29", "allDay": True},
            {"id": "E7", "title": "Far away", "calendarId": "C-work", "start": "2026-11-20 10:00", "end": "2026-11-20 11:00"},
            {"id": "E8", "title": "Phishy", "calendarId": "C-work", "start": "2026-09-29 15:00", "end": "2026-09-29 16:00", "notes": "https://evil.example/?next=meet.google.com/abc-defg-hij"},
        ],
    }


class Env:
    """A fresh store, cache and data folder for one test."""

    def __init__(self, store=None, **env):
        self.dir = tempfile.mkdtemp(prefix="case ", dir=TMP)
        self.store_path = os.path.join(self.dir, "store.json")
        self.log = os.path.join(self.dir, "log.txt")
        self.cache = os.path.join(self.dir, "Workflow Cache")
        self.data = os.path.join(self.dir, "Workflow Data")
        self.write(store if store is not None else base_store())
        self.env = {"TZ": BASE_TZ, "RC_TEST_NOW": NOW, "RC_TEST_LOCALE": "en_US", "RC_TEST_NO_BG": "1"}
        self.env.update(env)

    def write(self, store):
        with open(self.store_path, "w") as f:
            json.dump(store, f)

    def read(self):
        with open(self.store_path) as f:
            return json.load(f)

    def logged(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as f:
            return [l.replace("\\n", "\n") for l in f.read().split("\n") if l]

    def run(self, mode, query=None, extra=None, raw=False):
        env = {
            "HOME": os.environ.get("HOME", "/tmp"),
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "alfred_workflow_cache": self.cache,
            "alfred_workflow_data": self.data,
            "alfred_workflow_bundleid": "io.github.x-o-r-r-o.reminders-calendar",
            "RC_TEST_STORE": self.store_path,
            "RC_TEST_LOG": self.log,
            "RC_SCRIPT": SCRIPT,
        }
        env.update(self.env)
        env.update(extra or {})
        assert env.get("RC_TEST_STORE"), "every run must use the fake store"
        args = ["/usr/bin/osascript", "-l", "JavaScript", SCRIPT, mode] + ([query] if query is not None else [])
        t0 = time.time()
        out = subprocess.run(args, cwd=SRC, env=env, capture_output=True, text=True, timeout=60)
        self.last_ms = (time.time() - t0) * 1000
        if raw:
            return out
        if out.returncode != 0:
            raise AssertionError(out.stderr)
        return out.stdout

    def items(self, mode, query="", extra=None):
        out = self.run(mode, query, extra)
        data = json.loads(out)
        check_items(data)
        return data

    def act(self, variables, arg="go"):
        return self.run("act", arg, variables).strip()


def check_items(data):
    """What Alfred needs: valid JSON, icons that exist, arg on every valid row and modifier."""
    assert isinstance(data.get("items"), list)
    for it in data["items"]:
        assert it.get("title") is not None, it
        assert "uid" in it, it
        if "icon" in it:
            assert os.path.exists(os.path.join(SRC, it["icon"]["path"])), it["icon"]
        if it.get("valid", True):
            assert it.get("arg") not in (None, ""), it
        for mod, m in (it.get("mods") or {}).items():
            assert "subtitle" in m, (mod, it)
            if m.get("valid", True):
                assert m.get("arg") not in (None, ""), (mod, it)
        for k, v in (it.get("variables") or {}).items():
            assert isinstance(v, str), (k, v)


def titles(data):
    return [i["title"] for i in data["items"]]


def row(data, text):
    for i in data["items"]:
        if text in i["title"]:
            return i
    raise AssertionError("no row with %r in %r" % (text, titles(data)))


def parse_cases(cases, env=None):
    """Runs the parser on many texts in one osascript call."""
    e = Env()
    e.env.update(env or {})
    out = e.run("parse", extra={"RC_TEST_PARSE": json.dumps(cases)})
    return json.loads(out)


LISTS = [{"id": "L-home", "title": "Home"}, {"id": "L-work", "title": "Work"}, {"id": "L-shop", "title": "Shopping List"}, {"id": "L-emoji", "title": "🏡 House"}]


class ParserTests(unittest.TestCase):
    """en_US, New York, Monday 2026-09-28 10:00."""

    def check(self, cases, env=None, kind="reminder"):
        inputs = [{"text": c[0], "kind": kind, "lists": LISTS} for c in cases]
        results = parse_cases(inputs, env)
        for c, r in zip(cases, results):
            text, expect = c[0], c[1]
            for k, v in expect.items():
                self.assertEqual(r.get(k), v, "%r → %s: %r (got %r)" % (text, k, v, {x: r.get(x) for x in ("title", "startLocal", "endLocal", "allDay", "priority", "list", "location", "rec", "notes", "url")}))

    def test_spec_example(self):
        self.check([("pay rent fri 9am !high #Home", {"title": "pay rent", "startLocal": "2026-10-02 09:00", "allDay": False, "priority": 1, "list": "Home"})])

    def test_relative_days(self):
        self.check([
            ("call mum today", {"title": "call mum", "startLocal": "2026-09-28 00:00", "allDay": True}),
            ("call mum tomorrow", {"startLocal": "2026-09-29 00:00", "allDay": True}),
            ("call mum tmrw", {"startLocal": "2026-09-29 00:00"}),
            ("x day after tomorrow", {"title": "x", "startLocal": "2026-09-30 00:00"}),
            ("x tonight", {"startLocal": "2026-09-28 20:00", "allDay": False}),
            ("x tomorrow morning", {"startLocal": "2026-09-29 09:00"}),
            ("x tomorrow evening", {"startLocal": "2026-09-29 18:00"}),
            ("x this afternoon", {"startLocal": "2026-09-28 15:00"}),
            ("x in 3 days", {"startLocal": "2026-10-01 00:00", "allDay": True}),
            ("x in 3 days at 5pm", {"startLocal": "2026-10-01 17:00"}),
            ("x in a week", {"startLocal": "2026-10-05 00:00"}),
            ("x in 2 weeks", {"startLocal": "2026-10-12 00:00"}),
            ("x in 1 month", {"startLocal": "2026-10-28 00:00"}),
            ("x in 1 year", {"startLocal": "2027-09-28 00:00"}),
            ("x in 2 hours", {"startLocal": "2026-09-28 12:00", "allDay": False}),
            ("x in 30 min", {"startLocal": "2026-09-28 10:30"}),
            ("x in 90m", {"startLocal": "2026-09-28 11:30"}),
            ("x in 1h30", {"startLocal": "2026-09-28 11:30"}),
            ("x in an hour", {"startLocal": "2026-09-28 11:00"}),
            ("x in half an hour", {"startLocal": "2026-09-28 10:30"}),
            ("x in 1 hour 15 minutes", {"startLocal": "2026-09-28 11:15"}),
            ("x in 1.5 hours", {"startLocal": "2026-09-28 11:30"}),
            ("x next week", {"startLocal": "2026-10-05 00:00"}),
            ("x next month", {"startLocal": "2026-10-01 00:00"}),
            ("x next year", {"startLocal": "2027-01-01 00:00"}),
            ("x this weekend", {"startLocal": "2026-10-03 00:00"}),
            ("x next weekend", {"startLocal": "2026-10-10 00:00"}),
            ("x end of month", {"startLocal": "2026-09-30 00:00"}),
            ("x the 5th", {"startLocal": "2026-10-05 00:00"}),
            ("x on the 30th", {"startLocal": "2026-09-30 00:00"}),
        ])

    def test_weekdays(self):
        # Monday: a weekday on its own is the next one (never today); "next" is the one in the following week
        self.check([
            ("x fri", {"startLocal": "2026-10-02 00:00"}),
            ("x friday", {"startLocal": "2026-10-02 00:00"}),
            ("x on friday", {"title": "x", "startLocal": "2026-10-02 00:00"}),
            ("x mon", {"startLocal": "2026-10-05 00:00"}),
            ("x this mon", {"startLocal": "2026-09-28 00:00"}),
            ("x next fri", {"startLocal": "2026-10-09 00:00"}),
            ("x next monday", {"startLocal": "2026-10-05 00:00"}),
            ("x by thursday 5pm", {"title": "x", "startLocal": "2026-10-01 17:00"}),
            ("x due tue", {"title": "x", "startLocal": "2026-09-29 00:00"}),
            ("meeting sat", {"title": "meeting", "startLocal": "2026-10-03 00:00"}),
            ("x sun 10am", {"startLocal": "2026-10-04 10:00"}),
        ])

    def test_words_that_look_like_dates_stay(self):
        self.check([
            ("call tom", {"title": "call tom", "start": None}),
            ("buy sun cream", {"title": "buy sun cream", "start": None}),
            ("sat exam prep", {"title": "sat exam prep", "start": None}),
            ("may the force", {"title": "may the force", "start": None}),
            ("review march madness", {"title": "review march madness", "start": None}),
            ("in the garden", {"title": "in the garden", "start": None}),
            ("call 911", {"title": "call 911", "start": None}),
            ("buy 2 eggs", {"title": "buy 2 eggs", "start": None}),
            ("chapter 5 notes", {"title": "chapter 5 notes", "start": None}),
            ("fix bug #42 in parser", {"start": None}),
            ("send the 2026 report", {"title": "send the 2026 report", "start": None}),
            # audit 1: bare number ranges, parts of the day, unknown #words, mixed "in"
            ("read pages 10-12", {"title": "read pages 10-12", "start": None}),
            ("score 5 - 6", {"title": "score 5 - 6", "start": None}),
            ("plan game night", {"title": "plan game night", "start": None}),
            ("morning run", {"title": "morning run", "start": None}),
            ("fix bug #42 in parser", {"title": "fix bug #42 in parser", "listToken": "42", "list": None}),
            ("x in 1 day 2 hours", {"start": None}),
        ])

    def test_parts_of_the_day_need_a_date(self):
        self.check([
            ("call mom tomorrow in the morning", {"title": "call mom", "startLocal": "2026-09-29 09:00"}),
            ("x fri evening", {"title": "x", "startLocal": "2026-10-02 18:00"}),
            ("x in the afternoon", {"title": "x", "startLocal": "2026-09-28 15:00"}),
        ])

    def test_times_12h(self):
        self.check([
            ("x 5pm", {"startLocal": "2026-09-28 17:00"}),
            ("x 5 pm", {"title": "x", "startLocal": "2026-09-28 17:00"}),
            ("x 5:30pm", {"startLocal": "2026-09-28 17:30"}),
            ("x 5.30pm", {"startLocal": "2026-09-28 17:30"}),
            ("x 5p", {"startLocal": "2026-09-28 17:00"}),
            ("x 11am", {"startLocal": "2026-09-28 11:00"}),
            ("x 12pm", {"startLocal": "2026-09-28 12:00"}),
            ("x 12am", {"startLocal": "2026-09-29 00:00"}),
            ("x 9am", {"startLocal": "2026-09-29 09:00"}),  # passed today: tomorrow
            ("x today 9am", {"startLocal": "2026-09-28 09:00", "past": True}),  # "today" is kept
            ("x 17:30", {"startLocal": "2026-09-28 17:30"}),
            ("x 5:30", {"startLocal": "2026-09-28 17:30"}),  # 12-hour clock: afternoon
            ("x 9:30", {"startLocal": "2026-09-29 09:30"}),
            ("x at 5", {"title": "x", "startLocal": "2026-09-28 17:00"}),
            ("x at 8", {"startLocal": "2026-09-29 08:00"}),
            ("x at 11", {"startLocal": "2026-09-28 11:00"}),
            ("x at 17h", {"startLocal": "2026-09-28 17:00"}),
            ("x 17h30", {"startLocal": "2026-09-28 17:30"}),
            ("x noon", {"startLocal": "2026-09-28 12:00"}),
            ("x midnight", {"startLocal": "2026-09-29 00:00"}),
            ("x tomorrow noon", {"startLocal": "2026-09-29 12:00"}),
            ("x 13pm", {"title": "x 13pm", "start": None}),
            ("x 25:00", {"title": "x 25:00", "start": None}),
            ("x 10:75", {"title": "x 10:75", "start": None}),
        ])

    def test_times_24h_locale(self):
        env = {"RC_TEST_LOCALE": "en_GB"}
        self.check([
            ("x 5:30", {"startLocal": "2026-09-29 05:30"}),
            ("x 17:30", {"startLocal": "2026-09-28 17:30"}),
            ("x 5pm", {"startLocal": "2026-09-28 17:00"}),
            ("x at 5", {"startLocal": "2026-09-28 17:00"}),
        ], env)

    def test_dates(self):
        self.check([
            ("x 2026-10-05", {"startLocal": "2026-10-05 00:00", "allDay": True}),
            ("x 2026/10/05", {"startLocal": "2026-10-05 00:00"}),
            ("x 2026-10-05T14:30", {"startLocal": "2026-10-05 14:30", "allDay": False}),
            ("x 2026-10-05 2pm", {"startLocal": "2026-10-05 14:00"}),
            ("x oct 5", {"startLocal": "2026-10-05 00:00"}),
            ("x October 5th", {"startLocal": "2026-10-05 00:00"}),
            ("x oct 5 2027", {"startLocal": "2027-10-05 00:00"}),
            ("x 5 oct", {"startLocal": "2026-10-05 00:00"}),
            ("x 5th of october at 3pm", {"title": "x", "startLocal": "2026-10-05 15:00"}),
            ("x may 1", {"startLocal": "2027-05-01 00:00"}),  # passed this year: next year
            ("x 5/10", {"startLocal": "2027-05-10 00:00"}),  # en_US: May 10
            ("x 10/5/2026", {"startLocal": "2026-10-05 00:00"}),
            ("x 5.10.", {"startLocal": "2026-10-05 00:00"}),
            ("x 5.10.2026", {"startLocal": "2026-10-05 00:00"}),
            ("x 2026-02-30", {"title": "x 2026-02-30", "start": None}),
            ("x feb 29", {"startLocal": "2028-02-29 00:00"}),
            ("x 31/31", {"start": None}),
            ("x 2020-01-01", {"startLocal": "2020-01-01 00:00", "past": True}),
        ])

    def test_numeric_dates_follow_the_locale(self):
        self.check([("x 5/10", {"startLocal": "2026-10-05 00:00"}), ("x 13/10/2026", {"startLocal": "2026-10-13 00:00"})], {"RC_TEST_LOCALE": "en_GB"})
        self.check([("x 5/10", {"startLocal": "2027-05-10 00:00"}), ("x 13/10/2026", {"start": None})], {"RC_TEST_LOCALE": "en_US"})

    def test_other_languages(self):
        self.check([
            ("x freitag 9:00", {"title": "x", "startLocal": "2026-10-02 09:00"}),
            ("x morgen", {"startLocal": "2026-09-29 00:00"}),
            ("x 5 okt", {"startLocal": "2026-10-05 00:00"}),
            ("x heute 18:00", {"startLocal": "2026-09-28 18:00"}),
        ], {"RC_TEST_LOCALE": "de_DE"})
        self.check([("x vendredi", {"startLocal": "2026-10-02 00:00"}), ("x demain 9h", {"title": "x", "startLocal": "2026-09-29 09:00"}), ("x à 14h30", {"title": "x", "startLocal": "2026-09-28 14:30"})], {"RC_TEST_LOCALE": "fr_FR"})
        # "9h" alone is only a time on a 24-hour clock
        self.check([("x 9h", {"title": "x 9h", "start": None})], {"RC_TEST_LOCALE": "en_US"})

    def test_next_week_follows_the_first_weekday(self):
        # Sunday 2026-10-04: in the US the week starts on Sunday, so "next week" is the week after
        self.check([("x next week", {"startLocal": "2026-10-12 00:00"}), ("x next fri", {"startLocal": "2026-10-16 00:00"})], {"RC_TEST_NOW": "2026-10-04T10:00", "RC_TEST_LOCALE": "en_US"})
        self.check([("x next week", {"startLocal": "2026-10-05 00:00"}), ("x next fri", {"startLocal": "2026-10-09 00:00"})], {"RC_TEST_NOW": "2026-10-04T10:00", "RC_TEST_LOCALE": "en_GB"})

    def test_recurrence(self):
        self.check([
            ("gym every day 7am", {"title": "gym", "rec": {"freq": "day", "interval": 1, "days": None}, "startLocal": "2026-09-29 07:00"}),
            ("x daily", {"rec": {"freq": "day", "interval": 1, "days": None}, "startLocal": "2026-09-28 00:00"}),
            ("x weekly", {"rec": {"freq": "week", "interval": 1, "days": None}}),
            ("x every 2 weeks", {"rec": {"freq": "week", "interval": 2, "days": None}}),
            ("x every other month", {"rec": {"freq": "month", "interval": 2, "days": None}}),
            ("x every weekday 8am", {"rec": {"freq": "week", "interval": 1, "days": [1, 2, 3, 4, 5]}, "startLocal": "2026-09-29 08:00"}),
            ("x every mon and thu", {"rec": {"freq": "week", "interval": 1, "days": [1, 4]}, "startLocal": "2026-09-28 00:00"}),
            ("x every mon, wed and fri 7am", {"rec": {"freq": "week", "interval": 1, "days": [1, 3, 5]}, "startLocal": "2026-09-30 07:00"}),
            ("x every week on tue", {"rec": {"freq": "week", "interval": 1, "days": [2]}, "startLocal": "2026-09-29 00:00"}),
            ("x every year", {"rec": {"freq": "year", "interval": 1, "days": None}}),
            ("x yearly oct 5", {"rec": {"freq": "year", "interval": 1, "days": None}, "startLocal": "2026-10-05 00:00"}),
            ("x every morning", {"rec": {"freq": "day", "interval": 1, "days": None}, "startLocal": "2026-09-29 09:00"}),
            ("everything is fine", {"title": "everything is fine", "rec": None}),
        ])

    def test_priority_list_link_notes(self):
        self.check([
            ("x !", {"priority": 9, "title": "x"}),
            ("x !!", {"priority": 5}),
            ("x !!!", {"priority": 1}),
            ("x !low", {"priority": 9}),
            ("x !med", {"priority": 5}),
            ("x !HIGH", {"priority": 1}),
            ("wow!", {"priority": 0, "title": "wow!"}),
            ("x #home", {"list": "Home", "title": "x"}),
            ("x #shop", {"list": "Shopping List"}),
            ("x #\"Shopping List\"", {"list": "Shopping List"}),
            ("x #shoppinglist", {"list": "Shopping List"}),
            ("x #House", {"list": "🏡 House"}),
            ("x #nowhere", {"list": None, "listToken": "nowhere", "title": "x #nowhere"}),
            ("read https://example.com/a?b=c tonight", {"title": "read", "url": "https://example.com/a?b=c", "startLocal": "2026-09-28 20:00"}),
            ("read www.example.com", {"url": "https://www.example.com", "title": "read"}),
            ("x https://a.example https://b.example", {"url": "https://a.example", "notes": "https://b.example"}),
            ("x tomorrow // bring the ID", {"title": "x", "notes": "bring the ID", "startLocal": "2026-09-29 00:00"}),
            ("x\nsecond line\nthird", {"title": "x", "notes": "second line\nthird"}),
            ("\"Meeting at 5\" tomorrow", {"title": "Meeting at 5", "startLocal": "2026-09-29 00:00"}),
            ("“Fri night plans” sat", {"title": "Fri night plans", "startLocal": "2026-10-03 00:00"}),
            ("pay rent on", {"title": "pay rent on"}),
            ("say \"hi\" tomorrow", {"title": "say \"hi\"", "startLocal": "2026-09-29 00:00"}),
            ("in the garden tomorrow", {"title": "in the garden"}),
            ("  spaces   everywhere  ", {"title": "spaces everywhere"}),
            ("x, tomorrow,", {"title": "x"}),
        ])

    def test_default_time(self):
        cases = [{"text": "x tomorrow", "kind": "reminder", "defTime": {"h": 9, "mi": 0}}, {"text": "x tomorrow 3pm", "kind": "reminder", "defTime": {"h": 9, "mi": 0}}]
        r = parse_cases(cases)
        self.assertEqual((r[0]["startLocal"], r[0]["allDay"]), ("2026-09-29 09:00", False))
        self.assertEqual(r[1]["startLocal"], "2026-09-29 15:00")

    def test_events(self):
        self.check([
            ("lunch with Sam tomorrow 1pm for 1h at Cafe", {"title": "lunch with Sam", "startLocal": "2026-09-29 13:00", "endLocal": "2026-09-29 14:00", "location": "Cafe"}),
            ("call 1-2pm", {"title": "call", "startLocal": "2026-09-28 13:00", "endLocal": "2026-09-28 14:00"}),
            ("call 11-1pm", {"startLocal": "2026-09-28 11:00", "endLocal": "2026-09-28 13:00"}),
            ("call 1pm - 2:30pm", {"startLocal": "2026-09-28 13:00", "endLocal": "2026-09-28 14:30"}),
            ("call 13:00–14:30", {"startLocal": "2026-09-28 13:00", "endLocal": "2026-09-28 14:30"}),
            ("call from 1pm to 3pm", {"title": "call", "startLocal": "2026-09-28 13:00", "endLocal": "2026-09-28 15:00"}),
            ("call from 1 to 3", {"title": "call", "startLocal": "2026-09-28 13:00", "endLocal": "2026-09-28 15:00"}),
            ("call at 10-11", {"title": "call", "startLocal": "2026-09-29 10:00", "endLocal": "2026-09-29 11:00"}),
            ("read pages 10-12 tomorrow", {"title": "read pages 10-12", "allDay": True}),
            ("party 11pm-1am", {"startLocal": "2026-09-28 23:00", "endLocal": "2026-09-29 01:00"}),
            ("focus 2pm until 5pm", {"title": "focus", "startLocal": "2026-09-28 14:00", "endLocal": "2026-09-28 17:00"}),
            ("x 3pm for 90 min", {"endLocal": "2026-09-28 16:30"}),
            ("x 3pm for 1.5 hours", {"endLocal": "2026-09-28 16:30"}),
            ("x 3pm for an hour and a half", {"endLocal": "2026-09-28 16:00"}),
            ("x 3pm for 2h30", {"endLocal": "2026-09-28 17:30"}),
            ("x 3pm", {"endLocal": "2026-09-28 16:00"}),
            ("offsite oct 5 for 3 days", {"title": "offsite", "allDay": True, "startLocal": "2026-10-05 00:00", "endLocal": "2026-10-08 00:00"}),
            ("holiday tomorrow", {"allDay": True, "startLocal": "2026-09-29 00:00", "endLocal": "2026-09-30 00:00"}),
            ("vacation all day tomorrow", {"title": "vacation", "allDay": True, "startLocal": "2026-09-29 00:00"}),
            ("meet John at the station at 5pm", {"title": "meet John", "location": "the station", "startLocal": "2026-09-28 17:00"}),
            ("party sat 8pm @\"Joe’s Place\"", {"title": "party", "location": "Joe’s Place"}),
            ("party @Cafe Blue sat 8pm", {"title": "party", "location": "Cafe Blue"}),
            ("dinner at 7 at Luigi's", {"title": "dinner", "location": "Luigi's", "startLocal": "2026-09-28 19:00"}),
            ("sync tue 10am #personal", {"list": None, "listToken": "personal"}),
            ("team call every other week tue 10am", {"title": "team call", "rec": {"freq": "week", "interval": 2, "days": [2]}, "startLocal": "2026-09-29 10:00"}),
            ("x tomorrow 9am alert 10 min before", {"title": "x", "alert": 10}),
            ("x tomorrow 9am remind me 1 hour before", {"alert": 60}),
            ("x tomorrow 9am alert at start", {"alert": 0}),
            ("lunch", {"title": "lunch", "startLocal": "2026-09-28 11:00", "endLocal": "2026-09-28 12:00", "guessed": True}),
            ("standup !!! 9am", {"title": "standup !!!"}),
        ], kind="event")

    def test_location_can_be_turned_off(self):
        r = parse_cases([{"text": "look at the report tomorrow 3pm", "kind": "event", "location": False}])[0]
        self.assertEqual((r["title"], r["location"]), ("look at the report", None))
        r = parse_cases([{"text": "look at the report tomorrow 3pm @HQ", "kind": "event", "location": False}])[0]
        self.assertEqual(r["title"], "look at the report @HQ")

    def test_join_links(self):
        cases = [
            (["https://acme.zoom.us/j/123456789?pwd=abc"], "Zoom"),
            (["Dial in: https://zoom.us/my/room."], "Zoom"),
            (["zoommtg://zoom.us/join?confno=1"], "Zoom"),
            (["https://meet.google.com/abc-defg-hij"], "Google Meet"),
            (["https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=y"], "Teams"),
            (["https://teams.live.com/meet/9876"], "Teams"),
            (["https://acme.webex.com/acme/j.php?MTID=m1"], "Webex"),
            (["https://facetime.apple.com/join#v=1&p=abc"], "FaceTime"),
            (["https://evil.example/?next=meet.google.com/abc-defg-hij"], None),
            (["https://meet.google.com.evil.example/abc-defg-hij"], None),
            (["https://zoom.us/pricing"], None),
            (["http://meet.google.com/abc-defg-hij"], "Google Meet"),
            ([None, "", "no links here"], None),
        ]
        res = parse_cases([{"kind": "join", "texts": t} for t, _ in cases])
        for (t, service), r in zip(cases, res):
            self.assertEqual(r["service"] if r else None, service, t)
        self.assertEqual(res[11]["url"], "https://meet.google.com/abc-defg-hij")  # upgraded to https
        self.assertEqual(res[1]["url"], "https://zoom.us/my/room")  # trailing dot dropped


class TimeZoneTests(unittest.TestCase):
    def one(self, text, tz, now, kind="reminder", locale="en_US"):
        return parse_cases([{"text": text, "kind": kind}], {"TZ": tz, "RC_TEST_NOW": now, "RC_TEST_LOCALE": locale})[0]

    def test_dst_spring_forward_keeps_wall_time(self):
        # New York springs forward on 2026-03-08 at 02:00
        r = self.one("x tomorrow 9am", "America/New_York", "2026-03-07T10:00")
        self.assertEqual(r["startLocal"], "2026-03-08 09:00")
        self.assertEqual(r["start"], local_ms("2026-03-08 09:00", "America/New_York"))
        r = self.one("x in 3 days", "America/New_York", "2026-03-07T10:00")
        self.assertEqual(r["startLocal"], "2026-03-10 00:00")
        r = self.one("x in 2 days at 10am", "America/New_York", "2026-03-07T10:00")
        self.assertEqual(r["start"] - local_ms("2026-03-07 10:00", "America/New_York"), 47 * 3600 * 1000)  # one hour lost

    def test_dst_absolute_durations(self):
        r = self.one("x in 2 hours", "America/New_York", "2026-03-08T01:30")
        self.assertEqual(r["start"] - local_ms("2026-03-08 01:30", "America/New_York"), 2 * 3600 * 1000)
        self.assertEqual(r["startLocal"], "2026-03-08 04:30")

    def test_nonexistent_and_repeated_times(self):
        r = self.one("x 2:30am", "America/New_York", "2026-03-08T00:30")
        self.assertEqual(r["startLocal"], "2026-03-08 03:30")  # 02:30 doesn't exist: moved forward
        r = self.one("x 1:30am", "America/New_York", "2026-11-01T00:30")
        self.assertEqual(r["start"], local_ms("2026-11-01 01:30", "America/New_York"))  # the first 01:30 (EDT)

    def test_dst_event_across_change(self):
        r = self.one("party 11pm-3am", "Europe/London", "2026-10-24T12:00", "event", "en_GB")
        self.assertEqual((r["startLocal"], r["endLocal"]), ("2026-10-24 23:00", "2026-10-25 03:00"))
        self.assertEqual(r["end"] - r["start"], 5 * 3600 * 1000)  # the clocks go back: 5 real hours

    def test_explicit_zones(self):
        r = self.one("x 3pm UTC", "Asia/Kolkata", "2026-09-28T10:00")
        self.assertEqual(r["startLocal"], "2026-09-28 20:30")
        r = self.one("x 10am ET", "Europe/London", "2026-09-28T10:00")
        self.assertEqual(r["startLocal"], "2026-09-28 15:00")
        r = self.one("x 10am ET", "Europe/London", "2026-12-01T09:00")
        self.assertEqual(r["startLocal"], "2026-12-01 15:00")
        r = self.one("x tomorrow 9am PST", "Europe/Berlin", "2026-12-01T09:00")
        self.assertEqual(r["startLocal"], "2026-12-02 18:00")
        r = self.one("x 15:00 Europe/London", "America/New_York", "2026-09-28T08:00")
        self.assertEqual(r["startLocal"], "2026-09-28 10:00")
        r = self.one("x 9am +05:30", "UTC", "2026-09-28T01:00")
        self.assertEqual(r["startLocal"], "2026-09-28 03:30")
        r = self.one("x 9am utc-3", "UTC", "2026-09-28T01:00")
        self.assertEqual(r["startLocal"], "2026-09-28 12:00")
        r = self.one("flight 2026-10-05T14:30Z", "Asia/Tokyo", "2026-09-28T10:00")
        self.assertEqual(r["startLocal"], "2026-10-05 23:30")
        r = self.one("flight 2026-10-05T14:30-04:00", "UTC", "2026-09-28T10:00")
        self.assertEqual(r["startLocal"], "2026-10-05 18:30")
        r = self.one("sync 3pm-4pm UTC", "Asia/Kolkata", "2026-09-28T10:00", "event")
        self.assertEqual((r["startLocal"], r["endLocal"]), ("2026-09-28 20:30", "2026-09-28 21:30"))

    def test_zone_words_stay_out_of_titles(self):
        r = self.one("standup 9am PT", "America/New_York", "2026-09-28T08:00", "event")
        self.assertEqual((r["title"], r["startLocal"]), ("standup", "2026-09-28 12:00"))
        r = self.one("feed the cat 5pm", "America/New_York", "2026-09-28T08:00")
        self.assertEqual(r["title"], "feed the cat")

    def test_unusual_offsets(self):
        r = self.one("x tomorrow 9am", "Australia/Lord_Howe", "2026-10-03T12:00")  # DST: +30 min on 10-04
        self.assertEqual(r["startLocal"], "2026-10-04 09:00")
        r = self.one("x tomorrow", "Pacific/Kiritimati", "2026-12-31T23:30")
        self.assertEqual(r["startLocal"], "2027-01-01 00:00")
        r = self.one("x in 3 days", "America/Sao_Paulo", "2026-09-28T10:00")
        self.assertEqual(r["startLocal"], "2026-10-01 00:00")

    def test_year_end(self):
        r = self.one("x jan 2", "America/New_York", "2026-12-30T10:00")
        self.assertEqual(r["startLocal"], "2027-01-02 00:00")
        r = self.one("x next month", "America/New_York", "2026-12-30T10:00")
        self.assertEqual(r["startLocal"], "2027-01-01 00:00")
        r = self.one("x in 1 month", "America/New_York", "2026-01-31T10:00")
        self.assertEqual(r["startLocal"], "2026-02-28 00:00")  # clamped to the month's end


class LabelTests(unittest.TestCase):
    def labels(self, locale, when, now=NOW):
        ms = local_ms(when)
        return parse_cases([{"kind": "label", "ms": ms}], {"RC_TEST_LOCALE": locale, "RC_TEST_NOW": now})[0]

    def test_12_and_24_hour_display(self):
        us = self.labels("en_US", "2026-09-28 17:30")
        gb = self.labels("en_GB", "2026-09-28 17:30")
        self.assertEqual(us["when"], "Today 5:30\u202fPM" if "\u202f" in us["when"] else "Today 5:30 PM")
        self.assertEqual(gb["when"], "Today 17:30")
        self.assertFalse(us["h24"])
        self.assertTrue(gb["h24"])
        self.assertFalse(us["dmy"])
        self.assertTrue(gb["dmy"])

    def test_relative_day_names(self):
        self.assertEqual(self.labels("en_GB", "2026-09-29 09:00")["when"], "Tomorrow 09:00")
        self.assertEqual(self.labels("en_GB", "2026-09-27 09:00")["when"], "Yesterday 09:00")
        self.assertEqual(self.labels("en_GB", "2026-10-01 09:00")["when"], "Thursday 09:00")
        self.assertIn("5 Oct", self.labels("en_GB", "2026-10-05 09:00")["when"])
        self.assertIn("2027", self.labels("en_GB", "2027-01-05 09:00")["when"])


# ---------- Script Filters ----------

class RemindersViewTests(unittest.TestCase):
    def test_overview(self):
        e = Env()
        d = e.items("rems", "")
        t = titles(d)
        # overdue and today first, oldest due first
        self.assertEqual(t[:4], ["Water plants", "Pay rent", "Buy milk", "Call the bank"])
        self.assertIn("Scheduled · 5", t)
        self.assertIn("All · 6", t)
        self.assertIn("Home · 4", t)
        self.assertIn("Shopping List · 1", t)
        pay = row(d, "Pay rent")
        self.assertIn("Overdue", pay["subtitle"])
        self.assertIn("!!!", pay["subtitle"])
        self.assertEqual(pay["icon"]["path"], "icons/overdue.png")
        self.assertEqual(pay["variables"]["rc_action"], "complete")
        self.assertEqual(pay["mods"]["cmd"]["variables"]["rc_action"], "open")
        self.assertEqual(pay["mods"]["alt"]["arg"], "due")
        self.assertEqual(pay["mods"]["ctrl"]["arg"], "delete")
        self.assertEqual(pay["uid"], "r|R1")
        self.assertTrue(d["skipknowledge"])
        self.assertNotIn("IBAN", json.dumps(pay["subtitle"]))  # notes aren't shown in subtitles
        milk = row(d, "Buy milk")
        self.assertEqual(milk["mods"]["fn"]["arg"], "https://shop.example.com/milk")
        self.assertEqual(milk["quicklookurl"], "https://shop.example.com/milk")
        self.assertIn("Today", milk["subtitle"])
        self.assertFalse(row(d, "Scheduled")["valid"])
        self.assertEqual(row(d, "Scheduled")["autocomplete"], ":scheduled ")
        self.assertEqual(row(d, "Shopping List")["autocomplete"], '#"Shopping List" ')

    def test_views(self):
        e = Env()
        self.assertEqual(titles(e.items("rems", ":overdue")), ["Water plants", "Pay rent"])
        self.assertEqual(titles(e.items("rems", ":today")), ["Water plants", "Pay rent", "Buy milk", "Call the bank"])
        self.assertEqual(titles(e.items("rems", ":scheduled")), ["Water plants", "Pay rent", "Buy milk", "Call the bank", "Renew passport"])
        self.assertEqual(len(titles(e.items("rems", ":all"))), 6)
        self.assertEqual(titles(e.items("rems", ":sch")), ["Scheduled"])  # partial: suggestion
        self.assertEqual(sorted(titles(e.items("rems", ":"))), sorted(["Today", "Overdue", "Scheduled", "Flagged", "All", "Completed"]))

    def test_list_filter_and_search(self):
        e = Env()
        d = e.items("rems", "#Home ")
        self.assertEqual(titles(d), ["Water plants", "Pay rent", "Renew passport", "Read “Dune”"])
        self.assertNotIn("Home", row(d, "Pay rent")["subtitle"])  # the list isn't repeated
        self.assertEqual(titles(e.items("rems", "#\"Shopping List\" ")), ["Buy milk"])
        self.assertEqual(titles(e.items("rems", ":today #home ")), ["Water plants", "Pay rent"])
        d = e.items("rems", "#Ho")
        self.assertIn("Home · 4", titles(d))
        d = e.items("rems", "#nowhere ")
        self.assertIn("No list named “nowhere”", titles(d)[0])
        d = e.items("rems", "rent")
        self.assertEqual(titles(d)[0], "Pay rent")
        self.assertTrue(titles(d)[-1].startswith("Add as a reminder: rent"))
        d = e.items("rems", "iban")  # notes are searched
        self.assertEqual(titles(d)[0], "Pay rent")
        d = e.items("rems", "dune")
        self.assertEqual(titles(d)[0], "Read “Dune”")
        self.assertEqual(row(d, "Dune")["mods"]["fn"]["arg"], "https://books.example.org/dune")
        d = e.items("rems", "zzz nothing")
        self.assertIn("No reminders match", titles(d)[0])
        add = row(d, "Add as a reminder")
        self.assertEqual(add["variables"]["rc_action"], "add")

    def test_search_add_row_keeps_the_list(self):
        e = Env()
        d = e.items("rems", "#work new idea tomorrow")
        add = row(d, "Add as a reminder")
        p = json.loads(add["variables"]["rc_payload"])
        self.assertEqual((p["listId"], p["title"]), ("L-work", "new idea"))

    def test_done_view_and_uncomplete(self):
        e = Env()
        d = e.items("rems", ":done")
        self.assertEqual(titles(d), ["Old task"])  # only the last 7 days
        self.assertEqual(d["items"][0]["variables"]["rc_action"], "uncomplete")
        self.assertIn("Mark as not completed", d["items"][0]["subtitle"])
        self.assertEqual(e.act(d["items"][0]["variables"]), "“Old task” is no longer completed")
        self.assertFalse([r for r in e.read()["reminders"] if r["id"] == "R7"][0]["completed"])
        self.assertIn("Old task", titles(e.items("rems", ":all")))
        self.assertEqual(titles(e.items("rems", ":done")), ["No completed reminders"])

    def test_flagged_view(self):
        e = Env()
        d = e.items("rems", ":flagged")
        self.assertEqual(titles(d), ["Reading flagged reminders from Reminders…"])  # background, no bg in tests
        e.run("bg-flagged")
        d = e.items("rems", ":flagged")
        self.assertEqual(titles(d), ["Pay rent"])
        self.assertNotIn("rerun", d)

    def test_flagged_view_errors_and_setting(self):
        s = base_store()
        s["fail"] = {"flagged": "Error -1743: Not authorized to send Apple events to Reminders."}
        e = Env(s)
        e.run("bg-flagged")
        d = e.items("rems", ":flagged")
        self.assertEqual(titles(d)[0], "Alfred isn’t allowed to control Reminders")
        self.assertEqual(d["items"][0]["variables"]["rc_action"], "automation")
        e.act({"rc_action": "automation"})
        self.assertIn("open:x-apple.systempreferences:com.apple.preference.security?Privacy_Automation", e.logged())
        d = e.items("rems", ":flagged", {"flagged_view": "0"})
        self.assertEqual(titles(d)[0], "The Flagged view is turned off")
        self.assertNotIn("Flagged", titles(e.items("rems", "", {"flagged_view": "0"})))

    def test_empty_library(self):
        s = base_store()
        s["reminders"] = []
        e = Env(s)
        d = e.items("rems", "")
        self.assertEqual(titles(d)[0], "Nothing due today")
        self.assertIn("0 open reminders", d["items"][0]["subtitle"])
        self.assertEqual(titles(e.items("rems", ":overdue")), ["No overdue reminders"])

    def test_access_rows(self):
        for status, title, action in [("notDetermined", "Allow Alfred to use your reminders", "request"), ("denied", "Alfred isn’t allowed to use your reminders", "privacy"), ("restricted", "Alfred isn’t allowed to use your reminders", "privacy")]:
            s = base_store()
            s["access"]["reminder"] = status
            e = Env(s)
            for mode in ("rems", "radd", "ract"):
                d = e.items(mode, "")
                self.assertEqual(titles(d), [title], (status, mode))
                self.assertEqual(d["items"][0]["variables"]["rc_action"], action)
            self.assertNotIn("Pay rent", e.run("rems", ""))

    def test_request_access(self):
        s = base_store()
        s["access"]["reminder"] = "notDetermined"
        e = Env(s)
        v = e.items("rems", "")["items"][0]["variables"]
        self.assertEqual(e.act(v), "")
        self.assertEqual(e.read()["access"]["reminder"], "full")
        self.assertIn("search:rems ", e.logged())
        # refused in the dialog
        s["afterRequest"] = {"reminder": "denied"}
        e = Env(s)
        self.assertEqual(e.act(v), "Alfred isn’t allowed to use your reminders: turn it on in Privacy & Security")
        self.assertIn("open:x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders", e.logged())
        # a custom keyword is reopened
        s["afterRequest"] = {"reminder": "full"}
        e = Env(s)
        e.run("act", "go", dict(v, keyword_rems="todo"))
        self.assertIn("search:todo ", e.logged())

    def test_privacy_row_opens_settings(self):
        e = Env()
        self.assertEqual(e.act({"rc_action": "privacy", "rc_kind": "event"}), "")
        self.assertEqual(e.logged(), ["open:x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"])

    def test_read_error(self):
        s = base_store()
        s["fail"] = {"reminders": "The operation couldn’t be completed"}
        e = Env(s)
        d = e.items("rems", "")
        self.assertEqual(titles(d), ["Couldn’t read your reminders"])

    def test_output_is_fast_enough(self):
        s = base_store()
        s["reminders"] = [{"id": "B%d" % i, "title": "Task %d" % i, "listId": "L-home", "due": "2026-%02d-%02d" % (9 + i % 3, 1 + i % 28), "allDay": True, "created": "2026-01-01 08:00"} for i in range(1500)]
        e = Env(s)
        e.items("rems", "")  # first read fills the cache
        worst = 0
        for q in ["", "t", "ta", "task 1", ":today", "#home 12"]:
            e.items("rems", q)
            worst = max(worst, e.last_ms)
        self.assertLess(worst, 600, "a keystroke took %d ms" % worst)  # osascript start-up included; ~150-250 ms here


class CacheTests(unittest.TestCase):
    def test_cache_is_used_and_refreshed(self):
        e = Env()
        e.items("rems", "")
        s = e.read()
        s["reminders"].append({"id": "R9", "title": "Brand new", "listId": "L-home", "due": "2026-09-28", "allDay": True})
        e.write(s)
        self.assertNotIn("Brand new", titles(e.items("rems", "")))  # fresh cache
        d = e.items("rems", "", {"RC_TEST_NOW": "2026-09-28T10:01"})  # 60 s later: stale, quick read in the foreground
        self.assertIn("Brand new", titles(d))
        self.assertNotIn("rerun", d)

    def test_slow_reads_refresh_in_the_background(self):
        e = Env()
        e.items("rems", "")
        cache = os.path.join(e.cache, "rems.json")
        c = json.load(open(cache))
        c["took"] = 5000  # the last read was slow
        c["at"] -= 120000
        json.dump(c, open(cache, "w"))
        s = e.read()
        s["reminders"].append({"id": "R9", "title": "Brand new", "listId": "L-home", "due": "2026-09-28", "allDay": True})
        e.write(s)
        d = e.items("rems", "", {"RC_TEST_NO_BG": "0"})
        self.assertEqual(d.get("rerun"), 0.5)
        self.assertNotIn("Brand new", titles(d))  # the stale rows show at once
        for _ in range(100):
            if "Brand new" in json.dumps(json.load(open(cache))):
                break
            time.sleep(0.1)
        d = e.items("rems", "")
        self.assertIn("Brand new", titles(d))
        self.assertNotIn("rerun", d)
        self.assertFalse(os.path.exists(os.path.join(e.cache, "rems.lock")))
        self.assertEqual([f for f in os.listdir(e.cache) if ".tmp-" in f], [])

    def test_dead_lock_owner_is_ignored(self):
        e = Env()
        e.items("rems", "")
        lock = os.path.join(e.cache, "rems.lock")
        os.makedirs(lock)
        json.dump({"pid": 999999, "started": time.time()}, open(os.path.join(lock, "owner.json"), "w"))
        cache = os.path.join(e.cache, "rems.json")
        c = json.load(open(cache))
        c["took"] = 5000
        c["at"] -= 120000
        json.dump(c, open(cache, "w"))
        e.items("rems", "", {"RC_TEST_NO_BG": "0"})
        for _ in range(100):
            if json.load(open(cache))["at"] > c["at"]:
                break
            time.sleep(0.1)
        self.assertGreater(json.load(open(cache))["at"], c["at"])

    def test_background_error_is_shown(self):
        e = Env()
        e.items("rems", "")
        s = e.read()
        s["fail"] = {"reminders": "Reminders took too long to answer"}
        e.write(s)
        cache = os.path.join(e.cache, "rems.json")
        c = json.load(open(cache))
        c["took"] = 5000
        c["at"] -= 120000
        json.dump(c, open(cache, "w"))
        e.run("bg-rems")
        d = e.items("rems", "")
        self.assertEqual(titles(d)[0], "Couldn’t read your reminders")
        # the old rows still show, and a slow library isn't re-read on every keystroke (audit 1)
        self.assertIn("Pay rent", titles(d))
        self.assertNotIn("Couldn’t refresh your reminders", titles(d))

    def test_corrupt_cache(self):
        e = Env()
        os.makedirs(e.cache, exist_ok=True)
        with open(os.path.join(e.cache, "rems.json"), "w") as f:
            f.write("{not json")
        self.assertIn("Pay rent", titles(e.items("rems", "")))


# ---------- actions ----------

class ReminderActionTests(unittest.TestCase):
    def test_complete_and_undo(self):
        e = Env()
        d = e.items("rems", "")
        v = row(d, "Pay rent")["variables"]
        self.assertEqual(e.act(v), "Completed “Pay rent”")
        self.assertTrue([r for r in e.read()["reminders"] if r["id"] == "R1"][0]["completed"])
        d = e.items("rems", "")
        self.assertEqual(titles(d)[0], "Undo: completed “Pay rent”")
        self.assertNotIn("Pay rent", titles(d)[1:])
        self.assertEqual(e.act(d["items"][0]["variables"]), "“Pay rent” is no longer completed")
        self.assertFalse([r for r in e.read()["reminders"] if r["id"] == "R1"][0]["completed"])
        d = e.items("rems", "")
        self.assertIn("Pay rent", titles(d))
        self.assertFalse(titles(d)[0].startswith("Undo"))
        self.assertEqual(e.act({"rc_action": "undo"}), "Nothing to undo")

    def test_undo_row_only_on_the_empty_query(self):
        e = Env()
        e.act({"rc_action": "complete", "rc_id": "R2", "rc_title": "Call the bank"})
        self.assertFalse(titles(e.items("rems", "rent"))[0].startswith("Undo"))

    def test_open_and_links(self):
        e = Env()
        self.assertEqual(e.act({"rc_action": "open", "rc_id": "R1", "rc_title": "Pay rent"}), "")
        self.assertEqual(e.logged(), ["open:x-apple-reminderkit://REMCDReminder/R1"])
        self.assertEqual(e.act({"rc_action": "open", "rc_id": "R1/../x", "rc_title": "Pay rent"}), "Couldn’t open “Pay rent” in Reminders")
        e = Env()
        self.assertEqual(e.act({"rc_action": "openurl", "rc_url": "https://shop.example.com/milk"}), "")
        self.assertEqual(e.act({"rc_action": "openurl", "rc_url": "javascript:alert(1)"}), "Couldn’t open the link")
        self.assertEqual(e.act({"rc_action": "openurl", "rc_url": "file:///etc/passwd"}), "Couldn’t open the link")
        self.assertEqual(e.logged(), ["open:https://shop.example.com/milk"])

    def test_change_due_date_and_undo(self):
        e = Env()
        due = local_ms("2026-10-02 09:00")
        msg = e.act({"rc_action": "due", "rc_id": "R2", "rc_title": "Call the bank", "rc_due": str(due), "rc_allday": "0", "rc_alarm": "1"})
        self.assertEqual(msg, "“Call the bank” is due Friday 9:00\u202fAM" if "\u202f" in msg else "“Call the bank” is due Friday 9:00 AM")
        r = [x for x in e.read()["reminders"] if x["id"] == "R2"][0]
        self.assertEqual((r["due"], r["allDay"], r["alarms"]), (due, False, [due]))
        self.assertIn("Friday", row(e.items("rems", ":scheduled"), "Call the bank")["subtitle"])
        self.assertEqual(titles(e.items("rems", ""))[0], "Undo: changed the due date of “Call the bank”")
        self.assertEqual(e.act({"rc_action": "undo"}), "Restored the due date of “Call the bank”")
        r = [x for x in e.read()["reminders"] if x["id"] == "R2"][0]
        self.assertEqual(r["due"], local_ms("2026-09-28 15:00"))

    def test_remove_due_date(self):
        e = Env()
        self.assertEqual(e.act({"rc_action": "due", "rc_id": "R3", "rc_title": "Buy milk", "rc_due": "", "rc_allday": "1"}), "Removed the due date of “Buy milk”")
        self.assertIsNone([x for x in e.read()["reminders"] if x["id"] == "R3"][0]["due"])
        self.assertEqual(e.act({"rc_action": "due", "rc_id": "R3", "rc_title": "Buy milk", "rc_due": "soon"}), "Couldn’t read the new due date")

    def test_priority_move_delete(self):
        e = Env()
        self.assertEqual(e.act({"rc_action": "priority", "rc_id": "R2", "rc_title": "Call the bank", "rc_priority": "1"}), "“Call the bank” has high priority")
        self.assertEqual(e.act({"rc_action": "priority", "rc_id": "R2", "rc_title": "Call the bank", "rc_priority": "7"}), "Couldn’t read the priority")
        self.assertEqual(e.act({"rc_action": "move", "rc_id": "R2", "rc_title": "Call the bank", "rc_list": "L-home", "rc_list_title": "Home"}), "Moved “Call the bank” to Home")
        r = [x for x in e.read()["reminders"] if x["id"] == "R2"][0]
        self.assertEqual((r["priority"], r["listId"]), (1, "L-home"))
        self.assertEqual(e.act({"rc_action": "undo"}), "Moved “Call the bank” back")
        self.assertEqual([x for x in e.read()["reminders"] if x["id"] == "R2"][0]["listId"], "L-work")
        self.assertEqual(e.act({"rc_action": "delete", "rc_id": "R2", "rc_title": "Call the bank"}), "Deleted “Call the bank”")
        self.assertNotIn("R2", [x["id"] for x in e.read()["reminders"]])
        self.assertNotIn("Call the bank", titles(e.items("rems", ":all")))
        self.assertEqual(e.act({"rc_action": "delete", "rc_id": "R2", "rc_title": "Call the bank"}), "Couldn’t delete it: the reminder no longer exists")

    def test_errors_are_reported(self):
        s = base_store()
        s["fail"] = {"updateReminder": "Reminders refused the change"}
        e = Env(s)
        self.assertEqual(e.act({"rc_action": "complete", "rc_id": "R1", "rc_title": "Pay rent"}), "Couldn’t complete it: Reminders refused the change")
        self.assertEqual(e.act({"rc_action": "complete", "rc_id": "nope", "rc_title": "x"}), "Couldn’t complete it: Reminders refused the change")
        self.assertEqual(e.act({"rc_action": "whatever"}), "Unknown action: whatever")

    def test_success_prints_nothing_for_silent_actions(self):
        e = Env()
        out = e.run("act", "go", {"rc_action": "open", "rc_id": "R1"})
        self.assertEqual(out, "")  # not even a newline: no empty notification


class AddReminderTests(unittest.TestCase):
    def test_empty_query_hints(self):
        e = Env()
        d = e.items("radd", "")
        self.assertEqual(titles(d)[0], "Type a reminder")
        self.assertIn("Adds to Home (Reminders’ default list)", d["items"][0]["subtitle"])
        self.assertIn("pay rent fri 9am !high", titles(d))
        d = e.items("radd", "", {"default_list": "Work"})
        self.assertIn("Adds to Work", d["items"][0]["subtitle"])
        d = e.items("radd", "", {"default_list": "Nope"})
        self.assertIn("No list named “Nope”", titles(d)[1])

    def test_preview_and_add(self):
        e = Env()
        d = e.items("radd", "pay rent fri 9am !high #Work https://bank.example // ref 42")
        r = d["items"][0]
        self.assertEqual(r["title"], "pay rent")
        self.assertEqual(r["subtitle"], "Friday 9:00\u202fAM · Work · High priority · 🔗 bank.example · 📝 notes" if "\u202f" in r["subtitle"] else "Friday 9:00 AM · Work · High priority · 🔗 bank.example · 📝 notes")
        self.assertEqual(e.act(r["variables"]).replace("\u202f", " "), "Added “pay rent” · Friday 9:00 AM · Work")
        new = e.read()["reminders"][-1]
        self.assertEqual((new["title"], new["listId"], new["priority"], new["url"], new["notes"], new["allDay"]), ("pay rent", "L-work", 1, "https://bank.example", "ref 42", False))
        self.assertEqual(new["due"], local_ms("2026-10-02 09:00"))
        self.assertEqual(new["alarms"], [new["due"]])
        self.assertIn("pay rent", titles(e.items("rems", ":scheduled")))  # patched into the cache
        self.assertEqual(titles(e.items("rems", ""))[0], "Undo: added “pay rent”")
        self.assertEqual(e.act({"rc_action": "undo"}), "Removed “pay rent”")
        self.assertNotIn("pay rent", [x["title"] for x in e.read()["reminders"]])

    def test_alarm_setting(self):
        e = Env()
        r = e.items("radd", "x tomorrow 9am", {"reminder_alarm": "0"})["items"][0]
        e.act(r["variables"])
        self.assertEqual(e.read()["reminders"][-1]["alarms"], [])

    def test_modifiers(self):
        e = Env()
        r = e.items("radd", "call mom tomorrow")["items"][0]
        self.assertEqual(e.act(r["mods"]["cmd"]["variables"]), "")
        self.assertTrue(e.logged()[0].startswith("open:x-apple-reminderkit://REMCDReminder/new-"))
        alt = r["mods"]["alt"]
        self.assertIn("exactly as typed", alt["subtitle"])
        e.act(alt["variables"])
        new = e.read()["reminders"][-1]
        self.assertEqual((new["title"], new["due"], new["listId"]), ("call mom tomorrow", None, "L-home"))

    def test_list_suggestions(self):
        e = Env()
        d = e.items("radd", "milk #s")
        self.assertEqual(d["items"][0]["title"], "milk")  # #s matches Shopping List uniquely
        d = e.items("radd", "milk #o")  # Home, Work, Shopping List
        sug = [i for i in d["items"] if i["uid"].startswith("sug|")]
        self.assertEqual([i["title"] for i in sug], ["Home", "Work", "Shopping List"])
        self.assertEqual(sug[2]["autocomplete"], 'milk #"Shopping List" ')
        self.assertNotIn("Shared (read-only)", titles(d))
        d = e.items("radd", "milk #zzz")
        self.assertIn("No list “zzz”: Home", d["items"][0]["subtitle"])

    def test_empty_title_and_past(self):
        e = Env()
        d = e.items("radd", "tomorrow 5pm")
        self.assertEqual(d["items"][0]["title"], "Type what to be reminded of")
        self.assertFalse(d["items"][0]["valid"])
        d = e.items("radd", "x 2020-01-01")
        self.assertIn("⚠ in the past", d["items"][0]["subtitle"])

    def test_no_lists(self):
        s = base_store()
        s["lists"] = []
        e = Env(s)
        d = e.items("radd", "x")
        self.assertEqual(titles(d), ["Couldn’t add “x”"])

    def test_text_reaches_the_store_verbatim(self):
        e = Env()
        nasty = 'say "hi" & `rm -rf ~` $(whoami) \\n end; do shell script "x"'
        r = e.items("radd", nasty)["items"][0]
        e.act(r["variables"])
        self.assertEqual(e.read()["reminders"][-1]["title"], nasty)
        e = Env()
        multi = "first line tomorrow\nsecond “line”\n\tthird"
        r = e.items("radd", multi)["items"][0]
        e.act(r["variables"])
        new = e.read()["reminders"][-1]
        self.assertEqual((new["title"], new["notes"]), ("first line", "second “line”\n\tthird"))

    def test_bad_payloads(self):
        e = Env()
        for p in ["", "{", "[]", "null", '{"title": ""}', '{"title": 5}']:
            self.assertEqual(e.act({"rc_action": "add", "rc_payload": p}), "Couldn’t add the reminder: nothing to add")
        self.assertEqual(len(e.read()["reminders"]), len(base_store()["reminders"]))
        e.act({"rc_action": "add", "rc_payload": json.dumps({"title": "t", "priority": 3, "due": "x", "url": "javascript:alert(1)", "rec": {"freq": "hourly"}})})
        new = e.read()["reminders"][-1]
        self.assertEqual((new["priority"], new["due"], new["url"], new["rec"]), (0, None, None, None))


class ReminderActionsFilterTests(unittest.TestCase):
    def test_no_target(self):
        e = Env()
        d = e.items("ract", "")
        self.assertEqual(titles(d), ["Choose a reminder first"])
        self.assertEqual(d["items"][0]["variables"]["rc_action"], "search")

    def test_target_from_variables_and_file(self):
        e = Env()
        d = e.items("rems", "")
        alt = row(d, "Call the bank")["mods"]["alt"]
        out = e.run("target", alt["arg"], alt["variables"])
        self.assertEqual(out, "")  # opens ract with an empty query
        ctrl = row(d, "Call the bank")["mods"]["ctrl"]
        self.assertEqual(e.run("target", ctrl["arg"], ctrl["variables"]), "delete")
        # Alfred passed the variables on
        d = e.items("ract", "", alt["variables"])
        self.assertEqual(titles(d)[0], "Call the bank")
        # …or didn't: the file written by `target`
        d = e.items("ract", "")
        self.assertEqual(titles(d)[0], "Call the bank")

    def test_presets_keep_the_time(self):
        e = Env()
        d = e.items("ract", "", {"rc_id": "R2", "rc_title": "Call the bank"})
        t = titles(d)
        self.assertEqual(t[0], "Call the bank")
        self.assertTrue(t[1].startswith("In 1 hour · Today 11:00"), t[1])
        self.assertTrue(t[2].startswith("This evening · Today 6:00"), t[2])
        self.assertTrue(t[3].startswith("Tomorrow · Tomorrow 3:00"), t[3])  # the reminder's own time
        self.assertTrue(t[4].startswith("This weekend · Saturday 3:00"), t[4])
        self.assertTrue(t[5].startswith("Next week · Monday") or t[5].startswith("Next week · Mon"), t[5])
        self.assertIn("Remove the due date", t)
        v = row(d, "Tomorrow")["variables"]
        self.assertEqual(v["rc_due"], str(local_ms("2026-09-29 15:00")))
        self.assertEqual(v["rc_allday"], "0")
        self.assertIn("Delete…", t)
        self.assertEqual(row(d, "Delete…")["autocomplete"], "delete")

    def test_all_day_reminder_presets(self):
        e = Env()
        d = e.items("ract", "", {"rc_id": "R5", "rc_title": "Read"})
        self.assertNotIn("Remove the due date", titles(d))
        v = row(d, "Tomorrow")["variables"]
        self.assertEqual((v["rc_due"], v["rc_allday"]), (str(local_ms("2026-09-29 00:00")), "1"))
        d = e.items("ract", "", {"rc_id": "R5", "rc_title": "Read", "reminder_time": "9:00"})
        v = row(d, "Tomorrow")["variables"]
        self.assertEqual((v["rc_due"], v["rc_allday"]), (str(local_ms("2026-09-29 09:00")), "0"))

    def test_evening_preset_hidden_late(self):
        e = Env(RC_TEST_NOW="2026-09-28T18:00")
        self.assertNotIn("This evening", " ".join(titles(e.items("ract", "", {"rc_id": "R2"}))))

    def test_typed_dates(self):
        e = Env()
        d = e.items("ract", "fri", {"rc_id": "R2", "rc_title": "Call the bank"})
        self.assertTrue(titles(d)[1].startswith("Due Friday 3:00"), titles(d))  # keeps 15:00
        d = e.items("ract", "fri 9am", {"rc_id": "R2"})
        self.assertTrue(titles(d)[1].startswith("Due Friday 9:00"))
        d = e.items("ract", "in 2 hours", {"rc_id": "R2"})
        self.assertTrue(titles(d)[1].startswith("Due Today 12:00"))
        d = e.items("ract", "blah", {"rc_id": "R2"})
        self.assertEqual(titles(d)[1], "Type a new due date")
        v = e.items("ract", "tomorrow 8am", {"rc_id": "R2"})["items"][1]["variables"]
        self.assertEqual(e.act(v).startswith("“Call the bank” is due Tomorrow 8:00"), True)

    def test_priority_and_list_rows(self):
        e = Env()
        d = e.items("ract", "!", {"rc_id": "R2"})
        self.assertEqual(titles(d)[1:], ["Priority: High", "Priority: Medium", "Priority: Low", "Priority: None"])
        d = e.items("ract", "!h", {"rc_id": "R2"})
        self.assertEqual(titles(d)[1:], ["Priority: High"])
        d = e.items("ract", "!high", {"rc_id": "R2"})
        self.assertEqual(row(d, "Priority: High")["variables"]["rc_priority"], "1")
        d = e.items("ract", "#", {"rc_id": "R2"})
        self.assertEqual(titles(d)[1:], ["Move to Home", "Move to Shopping List"])  # not its own list or read-only ones
        d = e.items("ract", "#shop", {"rc_id": "R2"})
        self.assertEqual(titles(d)[1], "Move to Shopping List")
        d = e.items("ract", "#zzz", {"rc_id": "R2"})
        self.assertEqual(titles(d)[1], "No list named “zzz”")

    def test_delete_confirmation(self):
        e = Env()
        d = e.items("ract", "delete", {"rc_id": "R2", "rc_title": "Call the bank"})
        self.assertEqual(titles(d)[1:], ["Delete “Call the bank”?", "Keep it"])
        self.assertEqual(d["items"][1]["variables"]["rc_action"], "delete")
        self.assertFalse(d["items"][2]["valid"])
        self.assertEqual(titles(e.items("ract", "del", {"rc_id": "R2"}))[1], "Delete “Call the bank”?")
        self.assertNotIn("Delete “Call the bank”?", titles(e.items("ract", "de", {"rc_id": "R2"})))

    def test_missing_reminder(self):
        e = Env()
        d = e.items("ract", "", {"rc_id": "gone", "rc_title": "Old thing"})
        self.assertEqual(titles(d), ["“Old thing” no longer exists"])


# ---------- calendar ----------

class AgendaTests(unittest.TestCase):
    def test_upcoming(self):
        e = Env()
        d = e.items("agenda", "")
        t = titles(d)
        # on now first, then today's all-day, then in order; finished events are gone
        self.assertEqual(t[:6], ["Standup", "Mum’s birthday", "Lunch with Sam", "Design review", "Phishy", "Offsite"])
        self.assertNotIn("Early call", t)
        self.assertNotIn("Far away", t)  # outside the 7 days
        st = row(d, "Standup")
        self.assertTrue(st["subtitle"].startswith("Zoom · Now · until 10:15"), st["subtitle"])
        self.assertEqual(st["variables"]["rc_action"], "join")
        self.assertEqual(st["variables"]["rc_url"], "https://acme.zoom.us/j/123456789?pwd=abc")
        self.assertEqual(st["mods"]["cmd"]["variables"]["rc_action"], "eopen")
        self.assertEqual(st["icon"]["path"], "icons/join.png")
        lunch = row(d, "Lunch with Sam")
        self.assertIn("(in 3 h)", lunch["subtitle"])
        self.assertIn("Cafe Blue", lunch["subtitle"])
        self.assertEqual(lunch["variables"]["rc_action"], "eopen")
        self.assertEqual(lunch["variables"]["rc_cal_url"], "ical://ekevent/E2?method=show&options=more")
        dr = row(d, "Design review")
        self.assertEqual(dr["mods"]["cmd"]["variables"]["rc_cal_url"], "ical://ekevent/20260929T150000Z/E4?method=show&options=more")
        self.assertNotEqual(row(d, "Phishy")["variables"]["rc_action"], "join")
        self.assertIn("All day", row(d, "Offsite")["subtitle"])
        self.assertIn("Wednesday – Thursday", row(d, "Offsite")["subtitle"])

    def test_open_first_setting(self):
        e = Env()
        st = row(e.items("agenda", "", {"event_return": "open"}), "Standup")
        self.assertEqual(st["variables"]["rc_action"], "eopen")
        self.assertEqual(st["mods"]["cmd"]["variables"]["rc_action"], "join")

    def test_actions(self):
        e = Env()
        st = row(e.items("agenda", ""), "Standup")
        self.assertEqual(e.act(st["variables"]), "")
        self.assertEqual(e.act(st["mods"]["cmd"]["variables"]), "")
        self.assertEqual(e.act(st["mods"]["alt"]["variables"]), "Copied the meeting link")
        lunch = row(e.items("agenda", ""), "Lunch")
        self.assertEqual(e.act(lunch["mods"]["alt"]["variables"]), "Copied “Lunch with Sam”")
        log = e.logged()
        self.assertEqual(log[0], "open:https://acme.zoom.us/j/123456789?pwd=abc")
        self.assertEqual(log[1], "open:ical://ekevent/E1?method=show&options=more")
        self.assertEqual(log[2], "copy:https://acme.zoom.us/j/123456789?pwd=abc")
        self.assertTrue(log[3].startswith("copy:Lunch with Sam\nToday"))
        self.assertEqual(e.act({"rc_action": "join", "rc_url": "javascript:x"}), "Couldn’t open the meeting link")

    def test_search_and_days(self):
        e = Env()
        self.assertEqual(titles(e.items("agenda", "cafe")), ["Lunch with Sam"])
        self.assertEqual(titles(e.items("agenda", "zoom")), ["Standup"])
        self.assertEqual(titles(e.items("agenda", "tomorrow")), ["Design review", "Phishy"])
        self.assertEqual(titles(e.items("agenda", "today")), ["Mum’s birthday", "Early call", "Standup", "Lunch with Sam"])
        self.assertEqual(titles(e.items("agenda", "nov 20")), ["Far away"])  # outside the window: read directly
        self.assertEqual(titles(e.items("agenda", "sat")), ["No events on Saturday"])
        d = e.items("agenda", "qwerty")
        self.assertIn("No events match", titles(d)[0])
        add = row(d, "Add “qwerty” as an event")  # audit 1
        e.act(add["variables"])
        self.assertEqual(e.logged(), ["search:eadd qwerty"])

    def test_hidden_calendars(self):
        e = Env()
        d = e.items("agenda", ":calendars")
        self.assertEqual(titles(d), ["✓ Work", "✓ Personal", "✓ Birthdays"])
        e.act(row(d, "Birthdays")["variables"])
        self.assertEqual(e.logged(), ["search:agenda :calendars"])
        d = e.items("agenda", ":cal")
        self.assertEqual(titles(d)[2], "    Birthdays")
        d = e.items("agenda", "")
        self.assertNotIn("Mum’s birthday", titles(d))
        self.assertEqual(titles(d)[-1], "1 calendar hidden")
        e.act(row(e.items("agenda", ":calendars"), "Birthdays")["variables"])
        self.assertIn("Mum’s birthday", titles(e.items("agenda", "")))

    def test_days_setting(self):
        e = Env()
        self.assertNotIn("Offsite", titles(e.items("agenda", "", {"agenda_days": "1"})))
        self.assertIn("Far away", titles(e.items("agenda", "", {"agenda_days": "30", "RC_TEST_NOW": "2026-10-25T10:00"})))

    def test_access(self):
        for status, title in [("notDetermined", "Allow Alfred to use your calendars"), ("denied", "Alfred isn’t allowed to use your calendars"), ("writeOnly", "Alfred can only add events")]:
            s = base_store()
            s["access"]["event"] = status
            e = Env(s)
            self.assertEqual(titles(e.items("agenda", "")), [title])
        e = Env(s)  # write-only can still add
        d = e.items("eadd", "lunch tomorrow 1pm #personal")
        self.assertEqual(d["items"][0]["title"], "lunch #personal")
        self.assertIn("Calendars can’t be chosen", d["items"][0]["subtitle"])
        e.act(d["items"][0]["variables"])
        self.assertEqual(e.read()["events"][-1]["calendarId"], "C-work")

    def test_no_events(self):
        s = base_store()
        s["events"] = []
        e = Env(s)
        self.assertEqual(titles(e.items("agenda", "")), ["No events in the next 7 days"])


class AddEventTests(unittest.TestCase):
    def test_preview_and_add(self):
        e = Env()
        e.items("agenda", "")  # fills the events cache for the overlap check
        d = e.items("eadd", "lunch with Sam tomorrow 1pm for 1h at Cafe #personal")
        r = d["items"][0]
        self.assertEqual(r["title"], "lunch with Sam")
        sub = r["subtitle"].replace("\u202f", " ")
        self.assertEqual(sub, "Tomorrow 1:00 PM–2:00 PM · 📍 Cafe · Personal")
        self.assertEqual(e.act(r["variables"]).replace("\u202f", " "), "Added “lunch with Sam” · Tomorrow 1:00 PM · Personal")
        ev = e.read()["events"][-1]
        self.assertEqual((ev["title"], ev["calendarId"], ev["location"], ev["start"], ev["end"], ev["alert"]), ("lunch with Sam", "C-home", "Cafe", local_ms("2026-09-29 13:00"), local_ms("2026-09-29 14:00"), None))
        d = e.items("agenda", "")
        self.assertEqual(titles(d)[0], "Undo: add “lunch with Sam”")
        self.assertEqual(e.act(d["items"][0]["variables"]), "Removed the event “lunch with Sam”")
        self.assertNotIn("lunch with Sam", [x["title"] for x in e.read()["events"]])

    def test_overlap_alert_and_defaults(self):
        e = Env()
        e.items("agenda", "")
        d = e.items("eadd", "review tomorrow 11:30am alert 5 min before")
        self.assertIn("Overlaps “Design review”", d["items"][0]["subtitle"])
        self.assertIn("⏰ 5 min before", d["items"][0]["subtitle"])
        d = e.items("eadd", "focus tomorrow 3pm", {"event_duration": "30", "event_alert": "10", "default_calendar": "personal"})
        r = d["items"][0]
        self.assertIn("3:30", r["subtitle"])
        self.assertIn("⏰ 10 min before", r["subtitle"])
        self.assertIn("Personal", r["subtitle"])
        e.act(r["variables"])
        self.assertEqual(e.read()["events"][-1]["alert"], 10)
        d = e.items("eadd", "", {"default_calendar": "Nope"})
        self.assertIn("No calendar named “Nope”", titles(d)[1])

    def test_guessed_time_and_all_day(self):
        e = Env()
        r = e.items("eadd", "lunch")["items"][0]
        self.assertIn("(no time given)", r["subtitle"])
        r = e.items("eadd", "offsite oct 5 for 3 days")["items"][0]
        self.assertIn("All day", r["subtitle"])
        e.act(r["variables"])
        ev = e.read()["events"][-1]
        self.assertEqual((ev["allDay"], ev["start"], ev["end"]), (True, local_ms("2026-10-05 00:00"), local_ms("2026-10-08 00:00")))

    def test_join_link_and_open(self):
        e = Env()
        r = e.items("eadd", "call 4pm ET https://zoom.us/j/123")["items"][0]
        self.assertIn("Zoom", r["subtitle"])
        self.assertIn("5:00", r["subtitle"].replace("\u202f", " "))  # 4pm ET is 16:00 in New York… wait: New York is ET
        e.act(r["mods"]["cmd"]["variables"])
        self.assertTrue(e.logged()[0].startswith("open:ical://ekevent/ev-"))

    def test_calendar_suggestions_skip_read_only(self):
        e = Env()
        d = e.items("eadd", "x #b")
        self.assertNotIn("Birthdays", titles(d))
        d = e.items("eadd", "x #birthdays")
        self.assertIn("No calendar “birthdays”: Work", d["items"][0]["subtitle"])

    def test_empty(self):
        e = Env()
        d = e.items("eadd", "")
        self.assertEqual(titles(d)[0], "Type an event")
        d = e.items("eadd", "tomorrow 3pm")
        self.assertEqual(titles(d), ["Type the event’s title"])


# ---------- the runtime Alfred gives us ----------

class RuntimeTests(unittest.TestCase):
    def test_test_mode_without_store_refuses(self):
        env = {"HOME": os.environ.get("HOME", "/tmp"), "PATH": "/usr/bin:/bin", "RC_TEST_NOW": NOW, "alfred_workflow_cache": os.path.join(TMP, "nostore")}
        out = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", SCRIPT, "rems", ""], cwd=SRC, env=env, capture_output=True, text=True, timeout=30)
        data = json.loads(out.stdout)
        self.assertEqual(data["items"][0]["subtitle"], "test mode without RC_TEST_STORE")
        out = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", SCRIPT, "act"], cwd=SRC, env=dict(env, rc_action="complete", rc_id="x"), capture_output=True, text=True, timeout=30)
        self.assertIn("test mode without RC_TEST_STORE", out.stdout)

    def test_config_values(self):
        e = Env()
        for v in ["1", " 1 ", "true", "", "0", "garbage"]:
            e.items("rems", "", {"flagged_view": v, "reminder_alarm": v, "parse_location": v, "agenda_days": v, "event_duration": v, "reminder_time": v, "keyword_rems": v})
            e.items("eadd", "x at y tomorrow", {"parse_location": v, "event_duration": v, "event_alert": v, "agenda_days": v})
        self.assertEqual(e.items("eadd", "x at home tomorrow 3pm", {"parse_location": " 0 "})["items"][0]["title"], "x at home")
        for t, ok in [("9:00", True), (" 9 ", True), ("25:00", False), ("9:75", False), ("abc", False)]:
            r = e.items("radd", "x tomorrow", {"reminder_time": t})["items"][0]
            self.assertEqual("9:00" in r["subtitle"], ok, (t, r["subtitle"]))

    def test_odd_queries(self):
        e = Env()
        for q in ["'", '"', "“", "\\", "#", "!", ":", "//", "@", "#\"", "\n", "\t", "a\u202eb", "🙂" * 50, "x" * 3000, "constructor", "__proto__", "#__proto__", ":constructor", "every", "in", "for", "at", "0/0", "99:99", "2026-13-45"]:
            for mode in ("rems", "radd", "ract", "agenda", "eadd"):
                d = e.items(mode, q)
                self.assertTrue(d["items"], (mode, q))

    def test_bidi_and_control_characters_are_cleaned(self):
        s = base_store()
        s["reminders"].append({"id": "R9", "title": "evil\u202eexe.txt\nline", "listId": "L-home", "due": "2026-09-28", "allDay": True})
        e = Env(s)
        r = row(e.items("rems", ""), "evil")
        self.assertEqual(r["title"], "evilexe.txt line")
        self.assertEqual(r["text"]["copy"], "evil\u202eexe.txt\nline")  # the real value is kept for copying

    def test_minimal_environment(self):
        # Alfred's runtime: no LANG, bare PATH
        e = Env()
        env = {"HOME": os.environ.get("HOME", "/tmp"), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "RC_TEST_STORE": e.store_path, "RC_TEST_NOW": NOW, "TZ": BASE_TZ, "alfred_workflow_cache": e.cache, "alfred_workflow_data": e.data}
        out = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", SCRIPT, "rems", ""], cwd=SRC, env=env, capture_output=True, text=True, timeout=30)
        self.assertIn("Pay rent", json.loads(out.stdout)["items"][0]["title"] + json.loads(out.stdout)["items"][1]["title"])

    def test_cache_files_are_private_and_atomic(self):
        e = Env()
        e.items("rems", "")
        e.items("agenda", "")
        for f in os.listdir(e.cache):
            p = os.path.join(e.cache, f)
            if os.path.isfile(p):
                self.assertEqual(os.stat(p).st_mode & 0o777, 0o600, f)
        self.assertEqual([f for f in os.listdir(e.cache) if ".tmp-" in f], [])

    def test_event_notes_are_not_cached(self):
        e = Env()
        e.items("agenda", "")
        cached = open(os.path.join(e.cache, "events.json")).read()
        self.assertNotIn("Join:", cached)
        self.assertIn("acme.zoom.us", cached)  # only the detected link


class EventKitBridgeTests(unittest.TestCase):
    def test_conversions_on_unsaved_objects(self):
        # In-memory EventKit objects only: nothing is saved and nothing is read from the user's data
        e = Env()
        out = json.loads(e.run("selftest", None, {"RC_TEST_SELFTEST": "1"}))
        self.assertEqual(out["timed"]["due"], out["timedExpected"])
        self.assertFalse(out["timed"]["allDay"])
        self.assertEqual(out["timed"]["priority"], 1)
        self.assertEqual(out["timed"]["title"], "Pay rent “now”")
        self.assertEqual(out["timed"]["url"], "https://example.com/a?b=c")
        self.assertTrue(out["timed"]["recurring"])
        self.assertEqual(out["timed"]["alarms"], 1)
        self.assertEqual(out["allDay"]["due"], out["allDayExpected"])
        self.assertTrue(out["allDay"]["allDay"])
        self.assertIsNone(out["none"]["due"])
        self.assertEqual(out["rule"], {"freq": 1, "interval": 2, "days": [2, 5]})  # EventKit: 1 = Sunday
        self.assertEqual(out["event"]["join"]["service"], "Google Meet")
        self.assertEqual(out["snoozed"], {"due": out["snoozedExpected"], "alarms": 2, "absolute": [out["snoozedExpected"]]})

    def test_selftest_needs_its_flag(self):
        self.assertEqual(Env().run("selftest").strip(), "")


class BuildTests(unittest.TestCase):
    def test_build_check(self):
        out = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "build.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)

    def test_plist(self):
        info = plistlib.load(open(os.path.join(SRC, "info.plist"), "rb"))
        self.assertEqual(info["bundleid"], "io.github.x-o-r-r-o.reminders-calendar")
        kws = sorted(o["config"]["keyword"] for o in info["objects"] if "keyword" in o["config"])
        self.assertEqual(kws, ["{var:keyword_agenda}", "{var:keyword_eadd}", "{var:keyword_ract}", "{var:keyword_radd}", "{var:keyword_rems}"])
        defaults = {c["variable"]: c["config"]["default"] for c in info["userconfigurationconfig"] if c["variable"].startswith("keyword_")}
        self.assertEqual(defaults, {"keyword_rems": "rems", "keyword_radd": "radd", "keyword_ract": "ract", "keyword_agenda": "agenda", "keyword_eadd": "eadd"})
        family = set("aitext anc ask audio bright case dev diff dls enc epoch font fredo gcal gdoc goo gtask gws hash hist icon img json jwt layout lin linact logo m365 media meet mic models nadd new nnew notes obb obd obm obn obs obv onenote outlook pomo race regex res shot ssh stock teams tldr tomd tra track trh uuid vid warp ytt rem".split())
        for k in defaults.values():
            self.assertGreaterEqual(len(k), 3)
            self.assertNotIn(k, family)
            self.assertFalse(k.startswith(("bu", "brew")))

    def test_no_code_from_data(self):
        js = open(SCRIPT).read()
        for bad in ["eval(", "doShellScript", "/bin/sh", "new Function", "runScript"]:
            self.assertNotIn(bad, js)

    def test_icons(self):
        icons = json.load(open(os.path.join(ROOT, "tools", "icons.json")))
        for name in icons:
            if name != "icon":
                self.assertTrue(os.path.exists(os.path.join(SRC, "icons", name + ".png")), name)


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
