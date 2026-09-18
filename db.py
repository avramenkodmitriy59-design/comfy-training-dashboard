import sqlite3
import os
import json

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "dashboard.db")

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
    for position, segment, first_line in DEFAULT_POSITIONS:
        conn.execute(
            "INSERT OR IGNORE INTO positions_config (position, segment, first_line, needs_classification) "
            "VALUES (?, ?, ?, 0)",
            (position, segment, first_line),
        )
    conn.commit()
    conn.close()


def row_to_dict(row):
    return {k: row[k] for k in row.keys()}
