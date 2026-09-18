"""Server-side aggregation — mirrors the client-side parsing rule:
rows with assigned == 0 (nothing assigned) are excluded from count/progressSum/
scoreSum in every cut (total, region, store, position), and counted separately
as noAssignment so they don't silently drag averages down.
"""

import re
from itertools import permutations

ATTESTATION_STREAMS = ["Директор", "Товарознавець", "Комірник", "Касир", "Сервіс менеджер", "Продавець"]

# Real LMS exports use formal, bureaucratic job titles instead of the short
# names people actually use (verified against real reports, and corrected
# against the org chart): "Комірник" is exported as "Фахівець з прийому і
# видачі товару в магазині", "Вантажник" as "Фахівець з викладки", etc. We
# normalize these to the short name once, at ingestion, so every chart/filter/
# table downstream shows one consistent, readable label instead of the raw
# LMS title. "В/о керуючого магазином" (acting store manager) is folded into
# "Керуючий магазином" — same position for dashboard purposes.
POSITION_ALIASES = {
    "фахівець з прийому і видачі товару в магазині": "Комірник",
    "фахівець з викладки": "Вантажник",
    "заступник керуючого магазином з іт-сервісів": "ІТ лідер",
    "заступник з іт": "ІТ лідер",
    "заступник керуючого магазином з торгових процесів": "Заступник з ТП",
    "менеджер в роздрібній торгівлі побутовими товарами та їх ремонті": "Сервіс менеджер",
    "в/о керуючого магазином": "Керуючий магазином",
}


def normalize_position(position):
    key = position.strip().lower()
    return POSITION_ALIASES.get(key, position.strip())


# Position names are normalized (see above) before this runs, so matching is
# a plain substring check against the short canonical names.
_STREAM_MATCHERS = [
    ("Директор", "керуючий магазином"),
    ("Товарознавець", "товарознав"),
    ("Комірник", "комірник"),
    ("Касир", "касир"),
    ("Сервіс менеджер", "сервіс менеджер"),
    ("Продавець", "продавець"),
]


def detect_attestation_stream(rows):
    """Guess which of the 5 attestation positions this file belongs to,
    from the (dominant) value of the Посада column across the uploaded rows."""
    counts = {}
    for r in rows:
        pos = (r.get("position") or "").strip()
        if pos:
            counts[pos] = counts.get(pos, 0) + 1
    if not counts:
        return None, None
    dominant = max(counts.items(), key=lambda kv: kv[1])[0]
    dominant_lower = dominant.lower()
    for canonical, needle in _STREAM_MATCHERS:
        if needle in dominant_lower:
            return canonical, dominant
    return None, dominant


def _new_bucket(extra=None):
    b = {
        "assigned": 0,
        "completed": 0,
        "count": 0,
        "progressSum": 0.0,
        "scoreSum": 0.0,
        "scoreCount": 0,
        "noAssignment": 0,
    }
    if extra:
        b.update(extra)
    return b


def aggregate(rows):
    totals = _new_bucket()
    totals["notStarted"] = 0
    by_region = {}
    by_store = {}
    by_position = {}

    def bump(bucket, key, row, extra=None):
        if key not in bucket:
            bucket[key] = _new_bucket(extra)
        b = bucket[key]
        b["assigned"] += row["assigned"]
        b["completed"] += row["completed"]
        if row["assigned"] == 0:
            b["noAssignment"] += 1
            return
        b["count"] += 1
        b["progressSum"] += row["progress"]
        # Average score is computed only over people who actually started
        # (progress > 0) — otherwise everyone who hasn't begun yet (score 0)
        # drags the average down alongside people who genuinely failed.
        if row["progress"] > 0:
            b["scoreSum"] += row["score"]
            b["scoreCount"] += 1

    for row in rows:
        totals["assigned"] += row["assigned"]
        totals["completed"] += row["completed"]
        if row["assigned"] == 0:
            totals["noAssignment"] += 1
        else:
            totals["count"] += 1
            totals["progressSum"] += row["progress"]
            if row["progress"] == 0:
                totals["notStarted"] += 1
            else:
                totals["scoreSum"] += row["score"]
                totals["scoreCount"] += 1

        if row.get("region"):
            bump(by_region, row["region"], row)
        if row.get("store"):
            bump(by_store, row["store"], row, {"region": row.get("region", "")})
        if row.get("position"):
            bump(by_position, row["position"], row)

    return totals, by_region, by_store, by_position


def distribution(rows):
    """Progress-range buckets (critical/weak/needs-attention/good), in that
    fixed order so chart legends line up with the red/orange/yellow/green scale."""
    buckets = {"lt40": 0, "from40to69": 0, "from70to89": 0, "gte90": 0}
    for r in rows:
        if r["assigned"] == 0:
            continue
        p = r["progress"]
        if p < 40:
            buckets["lt40"] += 1
        elif p < 70:
            buckets["from40to69"] += 1
        elif p < 90:
            buckets["from70to89"] += 1
        else:
            buckets["gte90"] += 1
    return buckets


def _new_project_bucket(extra=None):
    b = {
        "count": 0,
        "active": 0,
        "testsSum": 0.0,
        "homeworkPercentSum": 0.0,
        "homeworkScoreSum": 0.0,
        "homeworkMaxSum": 0.0,
        "testsAssignedSum": 0.0,
        "testsCompletedSum": 0.0,
    }
    if extra:
        b.update(extra)
    return b


def _is_active(row):
    """'Actually participating' — started at least one test or homework,
    as opposed to merely being enrolled (present in the export) with 0% everywhere."""
    return row["testsPercent"] > 0 or row["homeworkPercent"] > 0


def aggregate_project(rows):
    """Course-project metrics: % of tests passed and homework score/percent,
    plus engagement — how many of the assigned tests people actually attempted
    (testsCompletedSum / testsAssignedSum), and how many enrolled (count) vs.
    actually participating (active, i.e. progress > 0 somewhere). Every row is
    a real participant (no 'nothing assigned' concept here), so unlike
    aggregate(), nothing is excluded from the averages — they're just pulled
    down by the inactive ones, which is the point: it shows real engagement,
    not just active-user averages."""
    totals = _new_project_bucket()
    by_region, by_store, by_position = {}, {}, {}

    def bump(bucket, key, row, extra=None):
        if key not in bucket:
            bucket[key] = _new_project_bucket(extra)
        b = bucket[key]
        b["count"] += 1
        if _is_active(row):
            b["active"] += 1
        b["testsSum"] += row["testsPercent"]
        b["homeworkPercentSum"] += row["homeworkPercent"]
        b["homeworkScoreSum"] += row["homeworkScore"]
        b["homeworkMaxSum"] += row["homeworkMax"]
        b["testsAssignedSum"] += row["testsAssignedCount"]
        b["testsCompletedSum"] += row["testsCompletedCount"]

    for row in rows:
        totals["count"] += 1
        if _is_active(row):
            totals["active"] += 1
        totals["testsSum"] += row["testsPercent"]
        totals["homeworkPercentSum"] += row["homeworkPercent"]
        totals["homeworkScoreSum"] += row["homeworkScore"]
        totals["homeworkMaxSum"] += row["homeworkMax"]
        totals["testsAssignedSum"] += row["testsAssignedCount"]
        totals["testsCompletedSum"] += row["testsCompletedCount"]

        if row.get("region"):
            bump(by_region, row["region"], row)
        if row.get("store"):
            bump(by_store, row["store"], row, {"region": row.get("region", "")})
        if row.get("position"):
            bump(by_position, row["position"], row)

    return totals, by_region, by_store, by_position


def distribution_project(rows):
    """Same critical/weak/needs-attention/good buckets, based on % tests passed."""
    buckets = {"lt40": 0, "from40to69": 0, "from70to89": 0, "gte90": 0}
    for r in rows:
        p = r["testsPercent"]
        if p < 40:
            buckets["lt40"] += 1
        elif p < 70:
            buckets["from40to69"] += 1
        elif p < 90:
            buckets["from70to89"] += 1
        else:
            buckets["gte90"] += 1
    return buckets


def clean_project_row(raw):
    def num(v):
        try:
            n = float(v)
        except (TypeError, ValueError):
            return 0.0
        return n if n == n else 0.0

    return {
        "region": str(raw.get("region") or "").strip(),
        "store": str(raw.get("store") or "").strip(),
        "position": normalize_position(str(raw.get("position") or "")),
        "name": str(raw.get("name") or "").strip(),
        "testsPercent": round(num(raw.get("testsPercent")) * 100) / 100,
        "homeworkScore": num(raw.get("homeworkScore")),
        "homeworkMax": num(raw.get("homeworkMax")),
        "homeworkPercent": round(num(raw.get("homeworkPercent")) * 100) / 100,
        "testsAssignedCount": num(raw.get("testsAssignedCount")),
        "testsCompletedCount": num(raw.get("testsCompletedCount")),
    }


def clean_row(raw):
    def num(v):
        try:
            n = float(v)
        except (TypeError, ValueError):
            return 0.0
        return n if n == n else 0.0  # filter NaN

    return {
        "region": str(raw.get("region") or "").strip(),
        "store": str(raw.get("store") or "").strip(),
        "position": normalize_position(str(raw.get("position") or "")),
        "name": str(raw.get("name") or "").strip(),
        "assigned": num(raw.get("assigned")),
        "completed": num(raw.get("completed")),
        "progress": round(num(raw.get("progress")) * 100) / 100,
        "score": round(num(raw.get("score")) * 100) / 100,
    }


# ---------- AEP (Apple Excellence Program) ----------
#
# Training_Planning tracks training SESSIONS (not people): each row is one
# slot of a training topic, with a planned/actual attendee count. The goal is
# cumulative per topic per quarter (all slots summed). Field names are
# repurposed from the generic person-row shape: position→topic, region→tier
# (Apple чемпіони / Непрограмні учасники), store→event type, name→responsible,
# assigned→planned, completed→actual, progress→this slot's fill rate
# (actual/planned). No per-topic naming collision risk with
# normalize_position() since we skip it here — clean_aep_row does its own
# trimming only.
#
# IMPORTANT: the source file merges the "план" (and "%") cells across a
# topic's slot-rows in the UI — only the first slot's row carries the actual
# planned number, the rest parse as blank/0. The generic aggregate() treats
# assigned==0 as "nothing assigned, exclude this row" (right for LMS person
# rows, wrong here — a blank merged cell isn't a real zero-plan slot), which
# would undercount "Слотів" to 1 instead of the real slot count. So AEP gets
# its own aggregate_aep()/distribution_aep() that count every row as a slot,
# no matter what its (possibly merge-blanked) planned value is.
#
# The quarterly goal itself changed over time (60 per topic before AEP's
# launch, 100 from Q3 2026 on) — it's stored per period (periods.aep_goal),
# not hardcoded, so historical quarters compare against their own goal.
def aep_goal_for_quarter(year, quarter):
    if year > 2026 or (year == 2026 and quarter >= 3):
        return 100
    return 60


def clean_aep_row(raw):
    def num(v):
        try:
            n = float(v)
        except (TypeError, ValueError):
            return 0.0
        return n if n == n else 0.0

    planned = num(raw.get("planned"))
    actual = num(raw.get("actual"))
    fill_rate = round((actual / planned) * 100, 2) if planned > 0 else 0.0

    return {
        "region": str(raw.get("tier") or "").strip(),
        "store": str(raw.get("eventType") or "").strip(),
        "position": str(raw.get("topic") or "").strip(),
        "name": str(raw.get("responsible") or "").strip(),
        "date": str(raw.get("date") or "").strip(),
        "held": bool(raw.get("held")),
        "assigned": planned,
        "completed": actual,
        "progress": fill_rate,
        "score": 0.0,
    }


def _new_aep_bucket(extra=None):
    b = {"assigned": 0, "completed": 0, "count": 0, "progressSum": 0.0, "scoreSum": 0.0, "scoreCount": 0}
    if extra:
        b.update(extra)
    return b


def aggregate_aep(rows):
    """Sum planned/actual per topic/region/eventType. Every row is a real
    slot — never excluded, unlike aggregate() (see module note above)."""
    totals = _new_aep_bucket()
    by_region, by_store, by_position = {}, {}, {}

    def bump(bucket, key, row, extra=None):
        if key not in bucket:
            bucket[key] = _new_aep_bucket(extra)
        b = bucket[key]
        b["assigned"] += row["assigned"]
        b["completed"] += row["completed"]
        b["count"] += 1
        b["progressSum"] += row["progress"]

    for row in rows:
        totals["assigned"] += row["assigned"]
        totals["completed"] += row["completed"]
        totals["count"] += 1
        totals["progressSum"] += row["progress"]

        if row.get("region"):
            bump(by_region, row["region"], row)
        if row.get("store"):
            bump(by_store, row["store"], row, {"region": row.get("region", "")})
        if row.get("position"):
            bump(by_position, row["position"], row)
            if row.get("date"):
                by_position[row["position"]].setdefault("sessions", []).append(
                    {"date": row["date"], "held": bool(row.get("held"))}
                )

    for b in by_position.values():
        b.setdefault("sessions", []).sort(key=lambda s: s["date"])

    return totals, by_region, by_store, by_position


def distribution_aep(rows):
    """Fill-rate distribution across slots — kept for API-shape parity with
    the other streams, even though the AEP view doesn't chart it today."""
    buckets = {"lt40": 0, "from40to69": 0, "from70to89": 0, "gte90": 0}
    for r in rows:
        p = r["progress"]
        if p < 40:
            buckets["lt40"] += 1
        elif p < 70:
            buckets["from40to69"] += 1
        elif p < 90:
            buckets["from70to89"] += 1
        else:
            buckets["gte90"] += 1
    return buckets


# ---------- AEP roster + per-attendee attendance ----------
# Two extra sheets bundled in the same training-log file, unrelated to the
# planned/actual session counts above: a roster of who is currently a
# champion/reservist (re-uploaded standalone, whole-roster replace), and a
# per-attendee CHECKED_IN/REGISTERED/... log per training session. Matching
# an attendee to the roster is done by normalized full name — there's no
# shared ID between the two source files, and name spelling/order isn't
# perfectly consistent between them, so this join is best-effort.

_UA_RU_FOLD = str.maketrans("іїєґ", "иие" "г")


def normalize_person_name(name):
    """Order- and case-insensitive key for matching a person's name across
    the roster and the attendance log (which record it as "Ім'я Прізвище"
    and "Прізвище Ім'я" respectively, inconsistently). Also folds Ukrainian
    letters onto their Russian look-alikes (і/ї→и, є→е, ґ→г) — people type
    the same person's name in whichever keyboard layout they're used to
    ("Віталій Суфлітін" vs "Виталий Суфлитин"), and without this the two
    spellings never match."""
    cleaned = re.sub(r"[^a-zа-яіїєґ\s]", "", str(name or "").lower())
    cleaned = cleaned.translate(_UA_RU_FOLD)
    return " ".join(sorted(cleaned.split()))


def normalize_roster_tier(status):
    """Collapse the roster's free-text "Статус" into one of two program
    tiers, tolerating the typos found in the real file ("Рзервіст", "Не
    чемпіон" meaning explicitly removed from the champions tier)."""
    s = str(status or "").strip().lower()
    if s.startswith("не "):
        return None
    if "резерв" in s:
        return "Резервіст"
    if "чемпіон" in s:
        return "Apple чемпіон"
    return None


def _levenshtein(a, b):
    if a == b:
        return 0
    la, lb = len(a), len(b)
    if la == 0:
        return lb
    if lb == 0:
        return la
    prev = list(range(lb + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * lb
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[lb]


def _token_similarity(a, b):
    """0-100 similarity between two single name tokens (first name OR
    surname — never a whole name). Beyond a plain typo (edit distance),
    recognizes an abbreviated first name ("влад" for "владислав") via a
    length-gated prefix check, and a bare initial ("в" — what "В." becomes
    once normalize_person_name strips punctuation) matched against the
    first letter — both weighted below an exact/near-exact match so they
    only tip a merge suggestion over the threshold together with a strong
    match on the *other* token (see name_similarity_percent)."""
    if not a or not b:
        return 0.0
    if a == b:
        return 100.0
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    if len(shorter) == 1:
        return 70.0 if shorter == longer[0] else 0.0
    if len(shorter) >= 3 and longer.startswith(shorter):
        return 85.0
    max_len = max(len(a), len(b))
    return round(max(0.0, 1 - _levenshtein(a, b) / max_len) * 100, 1)


def name_similarity_percent(a_norm, b_norm):
    """Similarity between two normalized (space-joined, alphabetically
    sorted token) names, meant for surfacing merge SUGGESTIONS for a human
    to confirm — not for automatic matching (see build_roster_matcher's
    tighter, silent ≤2-edit fuzzy match for that). Compares token-by-token,
    trying every alignment between the two names' tokens, and scores each
    alignment by its WEAKEST token match rather than the average: a pair is
    only a plausible match if every token has *some* correspondence, so two
    different people who happen to share a common first name (e.g.
    "Олександр") don't score high just because that one token lines up
    while the surname is completely different."""
    a_tokens, b_tokens = a_norm.split(), b_norm.split()
    if not a_tokens or not b_tokens:
        return 0.0
    if len(a_tokens) != len(b_tokens):
        max_len = max(len(a_norm), len(b_norm))
        if not max_len:
            return 0.0
        return round(max(0.0, 1 - _levenshtein(a_norm, b_norm) / max_len) * 100, 1)
    best = 0.0
    for perm in permutations(b_tokens):
        best = max(best, min(_token_similarity(x, y) for x, y in zip(a_tokens, perm)))
    return round(best, 1)


# Conservative, unambiguous diminutive -> full-form mapping for first names —
# deliberately leaves out ambiguous ones (e.g. "Саша" could be Олександр OR
# Олександра) to avoid merging two different people. Names are already
# UA/RU-folded (see normalize_person_name) by the time this is consulted.
_NICKNAME_TO_FULL = {
    "ксюша": "ксения", "дима": "дмитрий", "митя": "дмитрий",
    "женя": "евгений", "толя": "анатолий", "вова": "владимир",
    "коля": "николай", "юра": "юрий", "миша": "михаил",
    "настя": "анастасия", "таня": "татьяна", "оля": "ольга",
    "катя": "екатерина", "аня": "анна", "маша": "мария",
    "ваня": "иван", "петя": "петр", "сережа": "сергей",
    "андрюша": "андрей", "рома": "роман", "стас": "станислав",
    "паша": "павел", "гриша": "григорий", "костя": "константин",
    "лена": "елена", "наташа": "наталия", "света": "светлана",
    "люда": "людмила", "надя": "надежда", "боря": "борис",
    "слава": "вячеслав",
}


def _fold_nicknames(name_norm):
    tokens = name_norm.split()
    return " ".join(sorted(_NICKNAME_TO_FULL.get(t, t) for t in tokens))


def find_near_duplicate_names(entries):
    """entries: list of (name, name_norm) tuples from one roster upload.
    Returns pairs whose normalized forms are identical or within edit
    distance 2 — almost always a typo'd duplicate row for the same person
    (e.g. "Суфлітін Віталій" / "Віталій Суфтілін") rather than two different
    people, given how short most surnames are relative to that threshold."""
    pairs = []
    for i in range(len(entries)):
        for j in range(i + 1, len(entries)):
            name_a, norm_a = entries[i]
            name_b, norm_b = entries[j]
            if norm_a == norm_b or _levenshtein(norm_a, norm_b) <= 2:
                pairs.append((name_a, name_b))
    return pairs


def find_roster_duplicate_rows(roster_rows):
    """Like find_near_duplicate_names, but works on full roster rows (with
    id/store/tier) so the caller can offer a "keep this one, remove that
    one" action against the CURRENT roster — not just a one-time heads-up
    at upload time. Same identical-or-≤2-edit rule; note that
    normalize_person_name sorts tokens alphabetically, so "Микола Котко"
    and "Котко Микола" (same person, word order swapped between exports)
    collapse to an IDENTICAL name_norm and are always caught here."""
    pairs = []
    rows = list(roster_rows)
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            a, b = rows[i], rows[j]
            if a["name_norm"] == b["name_norm"] or _levenshtein(a["name_norm"], b["name_norm"]) <= 2:
                pairs.append((a, b))
    return pairs


def build_roster_matcher(roster_rows, aliases=None):
    """Given roster rows (each with at least name_norm + tier), returns a
    function name_norm -> matching roster row or None. Tries, in order:
    operator-confirmed alias (see aep_name_aliases — a raw attendance
    name_norm someone explicitly merged into a roster name_norm, for typos
    or abbreviated signatures too different for the automatic fuzzy match
    below), exact match, nickname-folded match ("Ксюша Ютовець" vs "Ксенія
    Ютовець"), then fuzzy match (edit distance <= 2, catches typos like
    "Суфтілін" vs "Суфлітін"). Roster is small (tens of people), so a linear
    fuzzy scan per unmatched name is cheap."""
    aliases = aliases or {}
    exact, folded, entries = {}, {}, []
    for r in roster_rows:
        exact.setdefault(r["name_norm"], r)
        folded.setdefault(_fold_nicknames(r["name_norm"]), r)
        entries.append(r)

    def match(name_norm):
        name_norm = aliases.get(name_norm, name_norm)
        if name_norm in exact:
            return exact[name_norm]
        f = _fold_nicknames(name_norm)
        if f in folded:
            return folded[f]
        best, best_dist = None, 3  # threshold: allow up to 2 edits
        for r in entries:
            d = _levenshtein(name_norm, r["name_norm"])
            if d < best_dist:
                best_dist, best = d, r
        return best

    return match


def suggest_name_matches(unmatched, roster_rows, min_similarity=65.0, max_candidates=3):
    """unmatched: list of (display_name, name_norm) tuples for attendance
    people the matcher (including aliases) couldn't resolve to any roster
    entry. For each, finds roster names at least `min_similarity`% similar
    — catches bigger typos and abbreviated signatures the automatic ≤2-edit
    fuzzy match misses — so an operator can review and confirm a merge.
    Returns only names that have at least one candidate, best match first."""
    suggestions = []
    for display_name, name_norm in unmatched:
        scored = [
            (name_similarity_percent(name_norm, r["name_norm"]), r)
            for r in roster_rows
        ]
        scored = [(sim, r) for sim, r in scored if sim >= min_similarity]
        if not scored:
            continue
        scored.sort(key=lambda x: -x[0])
        suggestions.append({
            "name": display_name,
            "nameNorm": name_norm,
            "candidates": [
                {
                    "rosterId": r["id"], "rosterName": r["name"],
                    "tier": r["tier"], "similarity": sim,
                }
                for sim, r in scored[:max_candidates]
            ],
        })
    return suggestions
