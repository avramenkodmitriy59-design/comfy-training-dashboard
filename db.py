import sqlite3
import os
import json

from paths import DATA_DIR

DB_PATH = os.path.join(DATA_DIR, "dashboard.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_type TEXT NOT NULL,
    stream_key TEXT NOT NULL,
    label TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    has_details INTEGER NOT NULL DEFAULT 0,
    totals_json TEXT NOT NULL,
    by_region_json TEXT NOT NULL,
    by_store_json TEXT NOT NULL,
    by_position_json TEXT NOT NULL,
    distribution_json TEXT,
    period_year INTEGER,
    period_quarter INTEGER,
    aep_goal INTEGER
);

CREATE TABLE IF NOT EXISTS details (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
    region TEXT,
    store TEXT,
    position TEXT,
    name TEXT,
    assigned REAL,
    completed REAL,
    progress REAL,
    score REAL,
    tests_percent REAL,
    homework_score REAL,
    homework_max REAL,
    homework_percent REAL,
    tests_assigned_count REAL,
    tests_completed_count REAL,
    event_date TEXT,
    actual_entered INTEGER
);
CREATE INDEX IF NOT EXISTS idx_details_period ON details(period_id);

-- Per-topic breakdown of an LMS period ("Звіт по заняттях" pulled from
-- Feed — the .xls export only has per-person totals, so manually uploaded
-- periods have no rows here). One row per person per topic (training);
-- region/store/position/name mirror the person's details row so the same
-- filters apply. mark is NULL for a topic without a test (or not taken);
-- done_at is when Feed recorded it as passed.
CREATE TABLE IF NOT EXISTS detail_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
    region TEXT,
    store TEXT,
    position TEXT,
    name TEXT,
    topic TEXT NOT NULL,
    schedule_id INTEGER,
    dt_start TEXT,
    dt_end TEXT,
    threshold REAL,
    mark REAL,
    done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_detail_topics_period ON detail_topics(period_id, topic);

-- Trainees from Feed's "Премія за наставництво" (see feed_sync.fetch_trainees),
-- one row per trainee per month of planned internship end. raw_json keeps the
-- full Feed record so new fields (e.g. sales norms) can be read later without
-- a re-sync; the columns are just the ones queried directly.
CREATE TABLE IF NOT EXISTS trainees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    feed_user_id INTEGER,
    name TEXT,
    region TEXT,
    store TEXT,
    newbie_type TEXT,
    position TEXT,
    dismissed INTEGER NOT NULL DEFAULT 0,  -- during the internship (feed_sync.dismissed_during_internship)
    date_start TEXT,
    date_end_plan TEXT,
    date_end_fact TEXT,
    bonus INTEGER,
    success INTEGER,  -- feed_sync.trainee_success: 1/0, NULL = not judged (dismissed / no targets yet)
    raw_json TEXT,
    synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trainees_month ON trainees(year, month);

-- KPI page: values for KPIs with no data source yet (retail plan, internal
-- appointments, 2nd category, knowledge by category), per period ("2027-H1").
CREATE TABLE IF NOT EXISTS kpi_manual (
    period TEXT NOT NULL,
    kpi_key TEXT NOT NULL,
    values_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (period, kpi_key)
);
CREATE INDEX IF NOT EXISTS idx_periods_stream ON periods(stream_type, stream_key);

CREATE TABLE IF NOT EXISTS positions_config (
    position TEXT PRIMARY KEY,
    segment TEXT NOT NULL DEFAULT 'back',
    first_line INTEGER NOT NULL DEFAULT 0,
    needs_classification INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS aep_roster (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_norm TEXT NOT NULL,
    store TEXT,
    tier TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aep_roster_norm ON aep_roster(name_norm);

CREATE TABLE IF NOT EXISTS aep_attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_year INTEGER NOT NULL,
    period_quarter INTEGER NOT NULL,
    event_name TEXT NOT NULL,
    event_date TEXT NOT NULL,
    status TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    name_norm TEXT,
    store TEXT
);
CREATE INDEX IF NOT EXISTS idx_aep_attendance_quarter ON aep_attendance(period_year, period_quarter);
CREATE INDEX IF NOT EXISTS idx_aep_attendance_event ON aep_attendance(event_name, event_date);

CREATE TABLE IF NOT EXISTS aep_name_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_name TEXT NOT NULL,
    raw_name_norm TEXT NOT NULL UNIQUE,
    target_name TEXT NOT NULL,
    target_name_norm TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aep_aliases_raw ON aep_name_aliases(raw_name_norm);

CREATE TABLE IF NOT EXISTS aep_name_dismissals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_name TEXT NOT NULL,
    raw_name_norm TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aep_dismissals_raw ON aep_name_dismissals(raw_name_norm);

CREATE TABLE IF NOT EXISTS aep_roster_dup_dismissals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_a TEXT NOT NULL,
    name_norm_a TEXT NOT NULL,
    name_b TEXT NOT NULL,
    name_norm_b TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(name_norm_a, name_norm_b)
);

-- "Звіт для РК" — per-topic training rows for directors (АТТ +
-- "Додаткове навчання" modules), one row per topic per person per
-- quarter. Doesn't fit the periods/details shared schema (one row per
-- employee per period) any more than AEP's per-session data did — same
-- "growing file, quarter from row date" shape as aep_attendance.
CREATE TABLE IF NOT EXISTS director_report_details (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_year INTEGER NOT NULL,
    period_quarter INTEGER NOT NULL,
    topic TEXT NOT NULL,
    training_type TEXT NOT NULL,
    region TEXT,
    store TEXT,
    position TEXT,
    name TEXT,
    score REAL,
    uploaded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_director_report_quarter ON director_report_details(period_year, period_quarter);

-- "Звіт по заняттям" — per-person results for ONE specific training
-- session (e.g. "Звіт по заняттю #1732: ..."), unlike periods/details
-- (which are per-quarter across all trainings for a stream). Each
-- lesson_reports row is one uploaded lesson, keyed by the lesson number
-- parsed from the file so re-uploading the same lesson replaces it
-- (same upsert shape as director_report/AEP) instead of piling up.
CREATE TABLE IF NOT EXISTS lesson_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    uploaded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lesson_report_details (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_report_id INTEGER NOT NULL REFERENCES lesson_reports(id) ON DELETE CASCADE,
    region TEXT,
    store TEXT,
    position TEXT,
    tab_number TEXT,
    name TEXT,
    material REAL,
    test REAL,
    test_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_lesson_report_details_report ON lesson_report_details(lesson_report_id);

-- "Аналіз категорій" — quarterly attestation/categorization reports, one
-- upload per position (category_reports), keyed by (position, period)
-- so re-uploading the same position+quarter replaces it (growing-file
-- upsert, same shape as AEP/director report) while past quarters stay
-- browsable. category_report_details holds one row per person with the
-- raw attestation metrics the category is computed from (tests, process
-- errors, returns, unaccounted goods, pickup speed) plus the RC's
-- override request/comment — the same column set the source file uses,
-- since every position's export follows this one standardized shape.
-- category_criteria is a free-text per-position reference (what the
-- category thresholds actually are) shown on screen as a hint, entered
-- once per position and reused thereafter.
CREATE TABLE IF NOT EXISTS category_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position TEXT NOT NULL,
    period_label TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    UNIQUE(position, period_label)
);

CREATE TABLE IF NOT EXISTS category_report_details (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_report_id INTEGER NOT NULL REFERENCES category_reports(id) ON DELETE CASCADE,
    region TEXT,
    store TEXT,
    store_category TEXT,
    complexity_level REAL,
    name TEXT,
    login TEXT,
    prev_category REAL,
    potential_category REAL,
    rk_wish TEXT,
    rk_comment TEXT,
    tests REAL,
    open_questions TEXT,
    process_errors REAL,
    returns_flag TEXT,
    unaccounted_flag TEXT,
    pickup_speed_min REAL,
    confirmed TEXT,
    hire_date TEXT,
    metrics_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_category_report_details_report ON category_report_details(category_report_id);

-- Every position has its own criteria shape (different metrics entirely —
-- a storekeeper's "pickup speed" has no equivalent for a merchandiser),
-- so thresholds aren't fixed columns. rules_json holds an ordered list of
-- requirements; each is either a single rule or an "ЧИ" (OR) group of
-- rules, and ALL top-level entries must pass for category 1. A rule
-- references a metric by the exact column header it came from in that
-- position's uploaded file (category_report_details.metrics_json), so
-- the same engine works for any position without code changes — only
-- "Тести" is special-cased since it's a fixed, universal column.
CREATE TABLE IF NOT EXISTS category_criteria (
    position TEXT PRIMARY KEY,
    criteria_text TEXT NOT NULL,
    rules_json TEXT,
    updated_at TEXT NOT NULL
);
"""

DEFAULT_POSITIONS = [
    # position, segment, first_line
    # Raw LMS titles are normalized to these short names before storage
    # (see aggregate.POSITION_ALIASES), so only canonical names live here.
    ("Продавець", "front", 0),
    ("ІТ фахівець", "front", 0),
    ("ІТ лідер", "front", 1),
    ("Заступник з ТП", "front", 1),
    ("Керуючий магазином", "front", 1),  # includes "В/о керуючого магазином"
    ("Касир", "back", 0),
    ("Товарознавець", "back", 1),
    ("Комірник", "back", 0),
    ("Вантажник", "back", 0),
    ("Сервіс менеджер", "back", 0),
]


def get_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript(SCHEMA)
    # migration for DBs created before distribution_json existed
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(periods)").fetchall()]
    if "distribution_json" not in cols:
        conn.execute("ALTER TABLE periods ADD COLUMN distribution_json TEXT")
    # migration for DBs created before project (tests/homework) columns existed
    detail_cols = [r["name"] for r in conn.execute("PRAGMA table_info(details)").fetchall()]
    for col in ("tests_percent", "homework_score", "homework_max", "homework_percent",
                "tests_assigned_count", "tests_completed_count"):
        if col not in detail_cols:
            conn.execute(f"ALTER TABLE details ADD COLUMN {col} REAL")
    if "event_date" not in detail_cols:
        conn.execute("ALTER TABLE details ADD COLUMN event_date TEXT")
    if "actual_entered" not in detail_cols:
        conn.execute("ALTER TABLE details ADD COLUMN actual_entered INTEGER")
    # migration for DBs created before AEP (quarter-goal tracking) columns existed
    for col, coltype in (("period_year", "INTEGER"), ("period_quarter", "INTEGER"), ("aep_goal", "INTEGER")):
        if col not in cols:
            conn.execute(f"ALTER TABLE periods ADD COLUMN {col} {coltype}")
    # migration for DBs created before category_report_details.hire_date/metrics_json existed
    cat_detail_cols = [r["name"] for r in conn.execute("PRAGMA table_info(category_report_details)").fetchall()]
    if cat_detail_cols and "hire_date" not in cat_detail_cols:
        conn.execute("ALTER TABLE category_report_details ADD COLUMN hire_date TEXT")
    if cat_detail_cols and "metrics_json" not in cat_detail_cols:
        conn.execute("ALTER TABLE category_report_details ADD COLUMN metrics_json TEXT")
    # migration for DBs created before category_criteria switched from fixed
    # threshold columns to a flexible rules_json (per-position rule list)
    crit_cols = [r["name"] for r in conn.execute("PRAGMA table_info(category_criteria)").fetchall()]
    if crit_cols and "rules_json" not in crit_cols:
        conn.execute("ALTER TABLE category_criteria ADD COLUMN rules_json TEXT")
    trainee_cols = [r["name"] for r in conn.execute("PRAGMA table_info(trainees)").fetchall()]
    if trainee_cols and "success" not in trainee_cols:
        conn.execute("ALTER TABLE trainees ADD COLUMN success INTEGER")
    _renormalize_aep_names(conn)
    for position, segment, first_line in DEFAULT_POSITIONS:
        conn.execute(
            "INSERT OR IGNORE INTO positions_config (position, segment, first_line, needs_classification) "
            "VALUES (?, ?, ?, 0)",
            (position, segment, first_line),
        )
    conn.commit()
    conn.close()


def _renormalize_aep_names(conn):
    """Stored AEP name_norm values are computed once, at upload/merge time.
    Whenever normalize_person_name changes (e.g. Latin→Cyrillic
    transliteration, ё→е), older rows keep the old form while new uploads
    and new merges use the new one — so a confirmed merge silently stops
    applying and the person "comes back" as unmatched. Recompute every
    stored norm from its original text on startup; a no-op once in sync."""
    from aggregate import normalize_person_name

    for r in conn.execute("SELECT id, first_name, last_name, name_norm FROM aep_attendance").fetchall():
        norm = normalize_person_name(f"{r['first_name'] or ''} {r['last_name'] or ''}")
        if norm != r["name_norm"]:
            conn.execute("UPDATE aep_attendance SET name_norm=? WHERE id=?", (norm, r["id"]))
    for r in conn.execute("SELECT id, name, name_norm FROM aep_roster").fetchall():
        norm = normalize_person_name(r["name"])
        if norm != r["name_norm"]:
            conn.execute("UPDATE aep_roster SET name_norm=? WHERE id=?", (norm, r["id"]))
    # raw_name_norm is UNIQUE — two old spellings can collapse into one new
    # norm; keep the first and drop the now-redundant duplicate.
    for table, cols in (("aep_name_aliases", ("raw", "target")), ("aep_name_dismissals", ("raw",))):
        select = ", ".join(f"{c}_name, {c}_name_norm" for c in cols)
        for r in conn.execute(f"SELECT id, {select} FROM {table} ORDER BY id").fetchall():
            updates = {f"{c}_name_norm": normalize_person_name(r[f"{c}_name"]) for c in cols}
            if all(updates[k] == r[k] for k in updates):
                continue
            try:
                conn.execute(
                    f"UPDATE {table} SET " + ", ".join(f"{k}=?" for k in updates) + " WHERE id=?",
                    (*updates.values(), r["id"]),
                )
            except sqlite3.IntegrityError:
                conn.execute(f"DELETE FROM {table} WHERE id=?", (r["id"],))
    for r in conn.execute(
        "SELECT id, name_a, name_norm_a, name_b, name_norm_b FROM aep_roster_dup_dismissals ORDER BY id"
    ).fetchall():
        pair = sorted([(normalize_person_name(r["name_a"]), r["name_a"]), (normalize_person_name(r["name_b"]), r["name_b"])])
        if (pair[0][0], pair[1][0]) == (r["name_norm_a"], r["name_norm_b"]):
            continue
        try:
            conn.execute(
                "UPDATE aep_roster_dup_dismissals SET name_a=?, name_norm_a=?, name_b=?, name_norm_b=? WHERE id=?",
                (pair[0][1], pair[0][0], pair[1][1], pair[1][0], r["id"]),
            )
        except sqlite3.IntegrityError:
            conn.execute("DELETE FROM aep_roster_dup_dismissals WHERE id=?", (r["id"],))


def row_to_dict(row):
    return {k: row[k] for k in row.keys()}
