"""Кадровий резерв (Leader Hub): what became of each programme participant,
read off the employee position history exported from BI "Аналітика.
Роздріб" -> "Історія працівника" — plus internal vs external appointments
(ВП / ЗП) for the KPI page, from the same history.

Rules agreed with the team:
- position levels: linear (seller, cashier, storekeeper...) < товарознавець
  (store first line) < заступник (ТП / ІТ) < директор; moving to a higher
  level is a promotion, a temporary transfer included;
- target position: Leader Hub 1.0 -> заступник or higher, 2.0 -> директор,
  Leader Hub БЕК (code TZ) -> товарознавець or higher;
- a participant is matched to the history by tab number, or — when the
  participants file has none — by an exact, unique full-name match.
"""

import datetime
import re

TARGET_RANK = {"TZ": 2, "LH1": 3, "LH2": 4}
PROGRAMS = ("LH1", "LH2", "TZ")  # TZ — Leader Hub БЕК (back office -> товарознавець)
# programme statuses replaced by «Призначення» when the history shows the target post
AUTO_APPOINTED_FROM = {"Сертифікований", "Кадровий резерв", "ІПР"}
GRAD_STATUSES = {"Сертифікований", "Кадровий резерв", "ІПР", "Призначення"}
# LH 2.0 only: certified, the director interview may still be ahead
LH2_ONLY_STATUSES = {"Сертифікований"}
# status of a participant within the programme ("Навчається" = stream in progress)
PROGRAM_STATUSES = ["Навчається", "Сертифікований", "Кадровий резерв", "ІПР", "Призначення", "Не сертифікований",
                    "Не пройшов навчання", "Відмова", "Мобілізація", "Звільнення"]
# reserve statuses that can be set by hand on "Статуси резерву"
# ("Призначений" / "Звільнений" always come from the employee history)
# who can be marked «Потенційний» toward a post (short position names, see _POSITIONS)
POTENTIAL_FROM = {
    "TZ": {"Вантажник", "Комірник", "Касир", "Сервіс менеджер", "Продавець"},
    "LH1": {"Продавець", "ІТ-спеціаліст", "Товарознавець"},
    "LH2": {"Заступник з ТП", "Заступник з ІТ", "Товарознавець"},
}
RESERVE_MANUAL_STATUSES = ["Кадровий резерв", "Потенційний", "Пониження", "Не в резерві"]
CURRENT_END = "2049-01-01"  # BI marks the current position with end date 2050-01-01

# full LMS/HR title (lower-case) -> (short name, rank)
_POSITIONS = [
    ("керуючий магазином", "Директор", 4),
    ("заступник керуючого магазином з торгових процесів", "Заступник з ТП", 3),
    ("заступник керуючого магазином з іт", "Заступник з ІТ", 3),
    ("товарознавець", "Товарознавець", 2),
    ("продавець", "Продавець", 1),
    ("касир", "Касир", 1),
    ("фахівець з прийому і видачі", "Комірник", 1),
    ("фахівець з прийому і викладки", "Комірник", 1),
    ("фахівець з викладки", "Вантажник", 1),
    ("фахівець по роботі з комп", "ІТ-спеціаліст", 1),
    ("менеджер в роздрібній торгівлі", "Сервіс менеджер", 1),
    ("фахівець дрібної побутової техніки", "Продавець", 1),
    # short names from the Leader Hub participants file — the same posts as
    # the HR titles above: «ІТ-лід» = заступник з ІТ-сервісів, «ІТ-спеціаліст» /
    # «Фахівець з ІТ» = фахівець по роботі з комп'ютерними системами (checked
    # against the employee history at the stream start, 2026-11-26)
    ("заступник з тп", "Заступник з ТП", 3),
    ("заступник з іт", "Заступник з ІТ", 3),
    ("іт-лід", "Заступник з ІТ", 3),
    ("іт лід", "Заступник з ІТ", 3),
    ("іт-спеціаліст", "ІТ-спеціаліст", 1),
    ("іт спеціаліст", "ІТ-спеціаліст", 1),
    ("фахівець з іт", "ІТ-спеціаліст", 1),
]

# positions whose vacancies the ВП/ЗП KPI counts (rotations — same position,
# another store — are not appointments)
APPOINTMENT_GROUPS = {
    "Директор": "Директор", "Заступник з ТП": "Заступник", "Заступник з ІТ": "Заступник",
    "Товарознавець": "Товарознавець", "Комірник": "Комірник",
}


def position_info(title):
    t = str(title or "").strip().lower()
    for needle, short, rank in _POSITIONS:
        if t.startswith(needle) or needle in t:
            return short, rank
    return (str(title or "").strip().capitalize() or "—"), 1


def name_key(name):
    """Exact full-name match key: case, apostrophes and spacing folded."""
    s = str(name or "").lower().replace("`", "'").replace("’", "'").replace("ʼ", "'")
    return " ".join(re.sub(r"[^\w' -]", " ", s).split())


def _history_by_tab(conn):
    by_tab = {}
    for r in conn.execute(
        "SELECT tab, name, position, store, status, date_start, date_end FROM employee_history "
        "ORDER BY tab, date_start"
    ).fetchall():
        by_tab.setdefault(r["tab"], []).append(dict(r))
    return by_tab


def appointments(conn, quarters):
    """ВП / ЗП: appointments to director / deputy / товарознавець / комірник
    starting in the given quarters. External (ЗП) = hired straight into the
    position; internal (ВП) = moved there from another position. A rotation
    (same position, another store) is not an appointment."""
    bounds = [(f"{y}-{(q - 1) * 3 + 1:02d}-01",
               f"{y + (q == 4)}-{(q % 4) * 3 + 1:02d}-01") for y, q in quarters]
    counts = {}
    for rows in _history_by_tab(conn).values():
        prev = None
        for r in rows:
            pos, _ = position_info(r["position"])
            group = APPOINTMENT_GROUPS.get(pos)
            start = r["date_start"] or ""
            if group and any(a <= start < b for a, b in bounds) and (prev is None or position_info(prev["position"])[0] != pos):
                fresh_hire = r["status"] == "Прийнятий" and (
                    prev is None or prev["status"] == "Звільнений" or _days_between(prev["date_end"], start) > 1)
                kind = "ЗП" if fresh_hire else "ВП"
                counts.setdefault(group, {"ВП": 0, "ЗП": 0})[kind] += 1
            prev = r
    return counts


def _days_between(a, b):
    try:
        return (datetime.date.fromisoformat(b[:10]) - datetime.date.fromisoformat(a[:10])).days
    except (TypeError, ValueError):
        return 9999


# ---------------------------------------------------------------------------
# Dataset for the "Кадровий резерв" tab (shape of the prototype's data.json:
# people / parts / apps / aps / leaves / stores — see static/js/reserve.js).
# ---------------------------------------------------------------------------

GROUP_BY_RANK = {2: "Товарознавець", 3: "Заступник", 4: "Директор"}
GROUP_PROGRAM = {"Товарознавець": "TZ", "Заступник": "LH1", "Директор": "LH2"}
VACANCY_GROUP_BY_RANK = {2: "Товарознавець", 3: "Заступник", 4: "Директор"}
APPOINTMENTS_SINCE = "2024-01-01"
LEAVES_SINCE_DAYS = 760  # enough for a rolling 12 months plus the previous year


def _fresh_hire(prev, row):
    return row["status"] == "Прийнятий" and (
        prev is None or prev["status"] == "Звільнений" or _days_between(prev["date_end"], row["date_start"]) > 1)


def lh_dataset(conn, today=None):
    today_d = today or datetime.date.today()
    today = today_d.isoformat()
    leaves_since = (today_d - datetime.timedelta(days=LEAVES_SINCE_DAYS)).isoformat()
    history = _history_by_tab(conn)
    region_of = {r["store"]: r["region"] for r in conn.execute("SELECT store, region FROM store_regions")}
    names = _NameIndex(history)

    stream_start = {(r["program"], r["year"]): r["date_start"]
                    for r in conn.execute("SELECT program, year, date_start FROM lh_streams WHERE date_start IS NOT NULL")}
    # participants -> person ids (tab when matched, else a per-row id)
    parts, people, grad_since = [], {}, {}
    for p in conn.execute("SELECT * FROM lh_participants ORDER BY year, program, name").fetchall():
        p = dict(p)
        tab = (p["tab"] or "").strip() or None
        matched = None
        if tab and tab in history:
            matched = "tab"
        elif not tab:
            tab, matched = names.match(p["name"], p["year"], p["store"])
        pid = tab if matched else f"p{p['id']}"
        if pid not in people:
            people[pid] = _person(pid, tab, p["name"], history.get(tab) if matched else None, region_of, today)
            people[pid]["matchedBy"] = matched
        person = people[pid]
        # results count from the stream start (1 January when the dates are unknown)
        since = stream_start.get((p["program"], p["year"])) or f"{p['year']}-01-01"
        target = TARGET_RANK.get(p["program"], 3)
        grad = p["status"] in GRAD_STATUSES
        reached = any(e["mv"] in ("up", "ext") and e["rank_to"] >= target and e["d"] >= since for e in person["ev"])
        appointed = p["status"] == "Призначення" or reached or (person["cur_rank"] >= target and person["work"])
        if grad:
            g = GROUP_BY_RANK[target]
            grad_since[(pid, g)] = min(grad_since.get((pid, g), "9999"), since)
        # history shows the target post, the programme status lags behind
        # (e.g. «Кадровий резерв» from the file) -> shown as «Призначення»
        status, status_file = p["status"], None
        if appointed and status in AUTO_APPOINTED_FROM:
            status, status_file = "Призначення", p["status"]
        dz = p["dz"]
        parts.append({
            "id": p["id"], "pid": pid, "prog": p["program"], "year": p["year"], "reg": p["region"], "store": p["store"],
            # one name per post («ІТ-лід» / «Заступник з ІТ», «ІТ-спеціаліст» /
            # «Фахівець по роботі з комп'ютерними системами»...)
            "pos_in": position_info(p["position"])[0] if p["position"] else p["position"], "test": p["test"], "dz": f"{dz:g}" if dz is not None else "", "dzp": dz,
            "status": status, "statusFile": status_file, "passed1": bool(p["passed1"]) or grad, "grad": grad, "appointed": appointed,
            "work": person["work"],
        })

    # appointments to deputy / director across the network, and leaves from them
    apps, aps, leaves = [], [], []
    for tab, rows in history.items():
        prev = None
        for r in rows:
            pos, rank = position_info(r["position"])
            group = VACANCY_GROUP_BY_RANK.get(rank)
            start = r["date_start"] or ""
            prev_pos, prev_rank = position_info(prev["position"]) if prev else (None, 0)
            prev_group = VACANCY_GROUP_BY_RANK.get(prev_rank) if prev else None
            # someone leaves a deputy/director post: dismissed from it, or moved to another post
            if prev_group and start >= leaves_since and (
                    r["status"] == "Звільнений" or (group != prev_group)):
                kind = ("Звільнення" if r["status"] == "Звільнений" else
                        "Підвищення" if rank > prev_rank else "Пониження" if rank < prev_rank else "Інша посада")
                leaves.append({"d": start, "grp": prev_group, "r": region_of.get(prev["store"]), "s": prev["store"],
                               "kind": kind, "n": r["name"]})
            if group and start >= APPOINTMENTS_SINCE and group != prev_group and r["status"] != "Звільнений":
                external = _fresh_hire(prev, r)
                lh = not external and grad_since.get((tab, group), "9999") <= start
                cat = "ЗП" if external else "LH" if lh else "ВП"
                aps.append({"d": start, "y": int(start[:4]), "grp": group, "cat": cat,
                            "r": region_of.get(r["store"]), "s": r["store"], "n": r["name"]})
                if not external and group in GROUP_PROGRAM:
                    apps.append({"d": start, "y": int(start[:4]), "to": group, "frm": prev_pos,
                                 "rf": region_of.get(prev["store"]), "sf": prev["store"],
                                 "rt": region_of.get(r["store"]), "stt": r["store"], "g": lh})
            prev = r

    # statuses set by hand; "Потенційний" may be someone outside the programmes
    rstatus = {}
    for r in conn.execute("SELECT pid, program, status, note, updated_at, updated_by FROM reserve_status"):
        pid = r["pid"]
        if pid not in people:
            if pid not in history:
                continue
            people[pid] = _person(pid, pid, None, history[pid], region_of, today)
            people[pid]["matchedBy"] = "tab"
        rstatus[f"{pid}|{r['program']}"] = {"status": r["status"], "note": r["note"] or "", "at": r["updated_at"], "by": r["updated_by"] or ""}

    rnotes = {f"{r['pid']}|{r['program']}": {"note": r["note"], "at": r["updated_at"], "by": r["updated_by"] or ""}
              for r in conn.execute("SELECT pid, program, note, updated_at, updated_by FROM reserve_notes")}
    stores = [[r["region"], r["store"]] for r in conn.execute("SELECT region, store FROM store_regions ORDER BY region, store")]
    return {"today": today, "people": people, "parts": parts, "apps": apps, "aps": aps, "leaves": leaves,
            "stores": stores, "rstatus": rstatus, "rnotes": rnotes}


_LATIN_TO_CYR = str.maketrans("aceiopxyk", "асеіорхук")


def match_key(name):
    """name_key with Latin look-alikes (i, a, o...) read as Cyrillic."""
    return name_key(name).translate(_LATIN_TO_CYR)


def _one_edit_apart(a, b):
    """True when a and b differ by at most one letter (replace/insert/delete)."""
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) > len(b):
        a, b = b, a
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    return a[i + (len(a) == len(b)):] == b[i + 1:]


def _edits(a, b):
    """Levenshtein distance (short strings)."""
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


class _NameIndex:
    """Finds a participant without a tab number in the employee history by
    full name: exact (Latin look-alikes folded), then no patronymic (surname +
    first name, unique), then one-letter typo. A rehired person has several
    tab numbers — the one employed in the stream year is taken, then the one
    from the participant's store, then the latest."""

    def __init__(self, history):
        self.history = history
        self.exact, self.by_surname = {}, {}
        for tab, rows in history.items():
            for k in {match_key(r["name"]) for r in rows}:
                if not k:
                    continue
                self.exact.setdefault(k, set()).add(tab)
                self.by_surname.setdefault(k.split()[0], set()).add(k)

    def match(self, name, year, store):
        key = match_key(name)
        if not key:
            return None, None
        tabs, how = self.exact.get(key), "name"
        if not tabs:
            words = key.split()
            same = self.by_surname.get(words[0], set())
            if len(words) == 2:
                keys = {k for k in same if k.split()[:2] == words}
                tabs = set().union(*(self.exact[k] for k in keys)) if len(keys) == 1 else None
            if not tabs:
                keys = {k for k in same if len(k.split()) == len(words) and _one_edit_apart(k, key)}
                tabs = set().union(*(self.exact[k] for k in keys)) if len(keys) == 1 else None
            if not tabs and len(words) == 3:
                # patronymic misspelt in two letters ("Васіливна" / "Василівна")
                keys = {k for k in same if k.split()[:2] == words[:2] and len(k.split()) == 3
                        and _edits(k.split()[2], words[2]) <= 2}
                tabs = set().union(*(self.exact[k] for k in keys)) if len(keys) == 1 else None
            how = "name~"
        if not tabs:
            return None, None
        return self._pick(tabs, year, store), how

    def _pick(self, tabs, year, store):
        tabs = sorted(tabs)
        if len(tabs) > 1:
            a, b = f"{year}-01-01", f"{year}-12-31"
            active = [t for t in tabs if any(
                (r["date_start"] or "") <= b and (r["date_end"] or "") >= a and r["status"] != "Звільнений"
                for r in self.history[t])]
            tabs = active or tabs
        if len(tabs) > 1 and store:
            here = [t for t in tabs if any(r["store"] == store for r in self.history[t])]
            tabs = here or tabs
        # still several: the latest employment
        return max(tabs, key=lambda t: self.history[t][0]["date_start"] or "")


def _person(pid, tab, name, rows, region_of, today):
    if not rows:
        return {"id": pid, "name": name, "tab": tab, "work": None, "cur_pos": None, "cur_rank": 0, "cur_store": None,
                "cur_reg": None, "hire": None, "ev": [], "max_rank": 0, "demoted": False}
    last = rows[-1]
    work = last["status"] != "Звільнений" and (last["date_end"] or "") >= today
    cur_pos, cur_rank = position_info(last["position"])
    ev, prev, max_rank = [], None, 0
    for r in rows:
        pos, rank = position_info(r["position"])
        if r["status"] == "Звільнений":
            prev = None
            continue
        if prev is None:
            if rank >= 3 and r["date_start"] >= APPOINTMENTS_SINCE:
                ev.append({"d": r["date_start"], "frm": None, "to": pos, "mv": "ext", "rank_to": rank,
                           "store_fr": None, "store_to": r["store"]})
        elif rank != prev[1]:
            ev.append({"d": r["date_start"], "frm": prev[0], "to": pos, "mv": "up" if rank > prev[1] else "down",
                       "rank_to": rank, "store_fr": prev[2], "store_to": r["store"]})
        max_rank = max(max_rank, rank)
        prev = (pos, rank, r["store"])
    hire = next((r["date_start"] for r in reversed(rows) if r["status"] == "Прийнятий"), rows[0]["date_start"])
    demoted = bool(work and max_rank >= 3 and cur_rank < max_rank)
    # dismissal: the last row is the "Звільнений" event; the post held is the row before it
    dismissed_on = last["date_start"] if last["status"] == "Звільнений" else None
    held = rows[-2] if dismissed_on and len(rows) > 1 else last
    return {"id": pid, "name": last["name"] or name, "tab": tab, "work": work, "cur_pos": cur_pos, "cur_rank": cur_rank,
            "cur_store": last["store"], "cur_reg": region_of.get(last["store"]), "hire": hire, "ev": ev,
            "max_rank": max_rank, "demoted": demoted, "dismissed": dismissed_on,
            "last_pos": position_info(held["position"])[0], "last_store": held["store"]}


def program_code(value):
    """Programme from a file / request: «LH 1.0», «LH2», «LH БЕК» / «LHB» / «TZ»."""
    v = str(value or "").upper().replace(" ", "").replace(".0", "")
    if v in PROGRAMS:
        return v
    if "БЕК" in v or "BEK" in v or "BACK" in v or v in ("LHB", "LHБ"):
        return "TZ"
    return "LH2" if "2" in v else "LH1"
