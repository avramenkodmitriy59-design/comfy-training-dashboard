import os
import json
import re
import secrets
import hmac
import datetime

from flask import Flask, request, session, jsonify, send_from_directory
from werkzeug.utils import redirect

import db
from aggregate import (
    aggregate, clean_row, detect_attestation_stream, distribution, ATTESTATION_STREAMS,
    aggregate_project, clean_project_row, distribution_project,
    clean_aep_row, aep_goal_for_quarter, aggregate_aep, distribution_aep,
    normalize_person_name, normalize_roster_tier, build_roster_matcher, find_near_duplicate_names,
    suggest_name_matches, find_roster_duplicate_rows, clean_director_report_row,
    clean_lesson_report_row, clean_category_report_row,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, "data")
SECRETS_PATH = os.path.join(INSTANCE_DIR, "secrets.json")

WORDS_A = ["sunny", "steady", "bright", "clear", "green", "swift", "solid", "prime"]
WORDS_B = ["training", "progress", "growth", "comfy", "result", "campus", "learning", "team"]


def load_or_create_secrets():
    os.makedirs(INSTANCE_DIR, exist_ok=True)
    if os.path.exists(SECRETS_PATH):
        with open(SECRETS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    password = f"{secrets.choice(WORDS_A)}-{secrets.choice(WORDS_B)}-{secrets.randbelow(9000) + 1000}"
    data = {
        "flask_secret_key": secrets.token_hex(32),
        "password": os.environ.get("DASHBOARD_PASSWORD", password),
    }
    with open(SECRETS_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return data


SECRETS = load_or_create_secrets()

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.secret_key = SECRETS["flask_secret_key"]
app.json.sort_keys = False  # preserve insertion order (e.g. distribution buckets lt40..gte90)
# The app is also served from this subpath (https://host/retail-lnd/). Requests
# with the prefix are stripped here, so it works both when a reverse proxy keeps
# the prefix and when it strips it; the root URL keeps working too.
# Override with the URL_PREFIX env var (empty value disables the prefix).
URL_PREFIX = os.environ.get("URL_PREFIX", "/retail-lnd").rstrip("/")
app.config.update(
    # unique name so the cookie doesn't clash with other apps on the same host
    SESSION_COOKIE_NAME="comfy_training_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
)

if URL_PREFIX:
    _inner_wsgi_app = app.wsgi_app

    def _strip_url_prefix(environ, start_response):
        path = environ.get("PATH_INFO", "")
        if path == URL_PREFIX:
            # "/retail-lnd" -> "/retail-lnd/", otherwise relative asset URLs break
            return redirect(URL_PREFIX + "/", 301)(environ, start_response)
        if path.startswith(URL_PREFIX + "/"):
            environ["SCRIPT_NAME"] = environ.get("SCRIPT_NAME", "") + URL_PREFIX
            environ["PATH_INFO"] = path[len(URL_PREFIX):]
        return _inner_wsgi_app(environ, start_response)

    app.wsgi_app = _strip_url_prefix

db.init_db()


def backfill_distribution():
    """Periods uploaded before distribution_json existed have it NULL — recompute
    it from their detail rows (every period keeps its detail rows now)."""
    conn = db.get_db()
    rows = conn.execute(
        "SELECT id, stream_type FROM periods WHERE distribution_json IS NULL"
    ).fetchall()
    for r in rows:
        if r["stream_type"] == "project":
            detail_rows = conn.execute(
                "SELECT region, store, position, name, tests_percent, homework_score, "
                "homework_max, homework_percent FROM details WHERE period_id = ?",
                (r["id"],),
            ).fetchall()
            project_rows = [
                {**db.row_to_dict(x), "testsPercent": x["tests_percent"]}
                for x in detail_rows
            ]
            dist = distribution_project(project_rows)
        elif r["stream_type"] == "aep":
            detail_rows = conn.execute(
                "SELECT region, store, position, name, assigned, completed, progress, score "
                "FROM details WHERE period_id = ?",
                (r["id"],),
            ).fetchall()
            dist = distribution_aep([db.row_to_dict(x) for x in detail_rows])
        else:
            detail_rows = conn.execute(
                "SELECT region, store, position, name, assigned, completed, progress, score "
                "FROM details WHERE period_id = ?",
                (r["id"],),
            ).fetchall()
            dist = distribution([db.row_to_dict(x) for x in detail_rows])
        conn.execute(
            "UPDATE periods SET distribution_json = ? WHERE id = ?",
            (json.dumps(dist, ensure_ascii=False), r["id"]),
        )
    conn.commit()
    conn.close()


backfill_distribution()


# ---------- auth ----------

def is_authenticated():
    return bool(session.get("authenticated"))


@app.before_request
def require_auth():
    path = request.path
    if path.startswith("/api/login") or path.startswith("/api/session"):
        return None
    if path.startswith("/static/") or path == "/" or path == "/favicon.ico":
        return None
    if path.startswith("/api/") and not is_authenticated():
        return jsonify({"error": "unauthorized"}), 401


@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}
    password = str(data.get("password", ""))
    if hmac.compare_digest(password.encode("utf-8"), SECRETS["password"].encode("utf-8")):
        session["authenticated"] = True
        session.permanent = True
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "Невірний пароль"}), 401


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/session")
def session_status():
    return jsonify({"authenticated": is_authenticated()})


# ---------- static / SPA ----------

@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if os.environ.get("DEV_SERVE_REPORTS") == "1":
    REPORTS_DIR = os.path.join(BASE_DIR, "Звіти")

    @app.get("/devfiles/<path:filename>")
    def dev_reports(filename):
        return send_from_directory(REPORTS_DIR, filename)


# ---------- positions config ----------

@app.get("/api/config")
def get_config():
    conn = db.get_db()
    rows = conn.execute("SELECT * FROM positions_config ORDER BY position").fetchall()
    conn.close()
    return jsonify({
        "positions": [db.row_to_dict(r) for r in rows],
        "attestationStreams": ATTESTATION_STREAMS,
    })


@app.post("/api/config/position")
def set_position_config():
    data = request.get_json(silent=True) or {}
    position = str(data.get("position", "")).strip()
    segment = data.get("segment")
    first_line = 1 if data.get("firstLine") else 0
    if not position or segment not in ("front", "back"):
        return jsonify({"error": "Вкажіть посаду і сегмент (front/back)"}), 400
    conn = db.get_db()
    conn.execute(
        "INSERT INTO positions_config (position, segment, first_line, needs_classification) "
        "VALUES (?, ?, ?, 0) "
        "ON CONFLICT(position) DO UPDATE SET segment=excluded.segment, first_line=excluded.first_line, "
        "needs_classification=0",
        (position, segment, first_line),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- streams ----------

@app.get("/api/streams")
def list_streams():
    conn = db.get_db()
    rows = conn.execute(
        "SELECT stream_type, stream_key, MAX(uploaded_at) AS last_updated FROM periods "
        "GROUP BY stream_type, stream_key ORDER BY stream_type, stream_key"
    ).fetchall()
    conn.close()
    streams = [
        {"streamType": r["stream_type"], "streamKey": r["stream_key"], "lastUpdated": r["last_updated"]}
        for r in rows
    ]
    projects = sorted({r["stream_key"] for r in rows if r["stream_type"] == "project"})
    aep_rows = [r for r in rows if r["stream_type"] == "aep"]
    aep_available = bool(aep_rows)
    aep_last_updated = max((r["last_updated"] for r in aep_rows), default=None)

    return jsonify({
        "streams": streams,
        "attestationStreams": ATTESTATION_STREAMS,
        "projects": projects,
        "aepAvailable": aep_available,
        "aepLastUpdated": aep_last_updated,
    })


# ---------- upload ----------

@app.post("/api/upload")
def upload():
    data = request.get_json(silent=True) or {}
    stream_type = data.get("streamType")
    label = str(data.get("label", "")).strip()
    raw_rows = data.get("rows") or []

    if stream_type not in ("overall", "attestation", "project"):
        return jsonify({"error": "Невідомий тип звіту"}), 400
    if not label:
        return jsonify({"error": "Вкажіть період (наприклад: Вересень 2026)"}), 400
    if not raw_rows:
        return jsonify({"error": "У файлі не знайдено жодного рядка співробітників"}), 400

    if stream_type == "project":
        project_name = str(data.get("projectName", "")).strip()
        if not project_name:
            return jsonify({"error": "Вкажіть назву проєкту"}), 400
        stream_key = project_name

        rows = [clean_project_row(r) for r in raw_rows]
        rows = [r for r in rows if r["region"] or r["name"]]

        totals, by_region, by_store, by_position = aggregate_project(rows)
        dist = distribution_project(rows)
    else:
        rows = [clean_row(r) for r in raw_rows]
        rows = [r for r in rows if r["region"] or r["name"]]

        if stream_type == "overall":
            stream_key = "overall"
        else:
            canonical, dominant_raw = detect_attestation_stream(rows)
            if not canonical:
                return jsonify({
                    "error": f"Не вдалося визначити атестаційну посаду за колонкою «Посада» "
                             f"(зустрілось: «{dominant_raw or '—'}»). Перевірте файл.",
                }), 400
            stream_key = canonical

        totals, by_region, by_store, by_position = aggregate(rows)
        dist = distribution(rows)

    unclassified = sorted({r["position"] for r in rows if r["position"]} - _known_positions())

    conn = db.get_db()
    try:
        conn.execute("BEGIN")
        # Every DISTINCT period keeps its detail rows permanently (not just the
        # latest one per stream) so any past quarter can be browsed and filtered
        # in full — but re-uploading the SAME period (same stream + label, e.g.
        # a corrected/updated file part-way through the quarter) replaces it
        # outright instead of piling up a duplicate. This mirrors the AEP
        # upload's upsert-by-quarter behavior.
        old = conn.execute(
            "SELECT id FROM periods WHERE stream_type=? AND stream_key=? AND label=?",
            (stream_type, stream_key, label),
        ).fetchall()
        for o in old:
            conn.execute("DELETE FROM periods WHERE id=?", (o["id"],))

        cur = conn.execute(
            "INSERT INTO periods (stream_type, stream_key, label, uploaded_at, has_details, "
            "totals_json, by_region_json, by_store_json, by_position_json, distribution_json) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                stream_type, stream_key, label,
                datetime.datetime.utcnow().isoformat() + "Z", 1,
                json.dumps(totals, ensure_ascii=False),
                json.dumps(by_region, ensure_ascii=False),
                json.dumps(by_store, ensure_ascii=False),
                json.dumps(by_position, ensure_ascii=False),
                json.dumps(dist, ensure_ascii=False),
            ),
        )
        period_id = cur.lastrowid

        if stream_type == "project":
            for r in rows:
                conn.execute(
                    "INSERT INTO details (period_id, region, store, position, name, "
                    "tests_percent, homework_score, homework_max, homework_percent, "
                    "tests_assigned_count, tests_completed_count) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (period_id, r["region"], r["store"], r["position"], r["name"],
                     r["testsPercent"], r["homeworkScore"], r["homeworkMax"], r["homeworkPercent"],
                     r["testsAssignedCount"], r["testsCompletedCount"]),
                )
        else:
            for r in rows:
                conn.execute(
                    "INSERT INTO details (period_id, region, store, position, name, assigned, completed, "
                    "progress, score) VALUES (?,?,?,?,?,?,?,?,?)",
                    (period_id, r["region"], r["store"], r["position"], r["name"],
                     r["assigned"], r["completed"], r["progress"], r["score"]),
                )

        for pos in unclassified:
            conn.execute(
                "INSERT OR IGNORE INTO positions_config (position, segment, first_line, needs_classification) "
                "VALUES (?, 'back', 0, 1)",
                (pos,),
            )

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return jsonify({
        "ok": True,
        "periodId": period_id,
        "streamType": stream_type,
        "streamKey": stream_key,
        "rowsCount": len(rows),
        "unclassifiedPositions": unclassified,
        "totals": totals,
    })


def _known_positions():
    conn = db.get_db()
    rows = conn.execute("SELECT position FROM positions_config").fetchall()
    conn.close()
    return {r["position"] for r in rows}


# ---------- AEP upload (one file = the whole multi-year training log; each ----------
# ---------- upload re-derives and replaces every quarter it touches) ----------

def load_aep_aliases(conn):
    rows = conn.execute("SELECT raw_name_norm, target_name_norm FROM aep_name_aliases").fetchall()
    return {r["raw_name_norm"]: r["target_name_norm"] for r in rows}


def load_aep_dismissals(conn):
    rows = conn.execute("SELECT raw_name_norm FROM aep_name_dismissals").fetchall()
    return {r["raw_name_norm"] for r in rows}


def load_aep_roster_dup_dismissals(conn):
    rows = conn.execute("SELECT name_norm_a, name_norm_b FROM aep_roster_dup_dismissals").fetchall()
    return {(r["name_norm_a"], r["name_norm_b"]) for r in rows}


@app.post("/api/upload-aep")
def upload_aep():
    data = request.get_json(silent=True) or {}
    raw_rows = data.get("rows") or []
    attendance_rows = data.get("attendance") or []
    if not raw_rows:
        return jsonify({"error": "Не знайдено жодного рядка"}), 400

    groups = {}
    for r in raw_rows:
        year, quarter = r.get("year"), r.get("quarter")
        if not year or not quarter:
            continue
        groups.setdefault((int(year), int(quarter)), []).append(r)

    if not groups:
        return jsonify({"error": "Не вдалося визначити рік/квартал жодного рядка"}), 400

    attendance_groups = {}
    for r in attendance_rows:
        year, quarter = r.get("year"), r.get("quarter")
        if not year or not quarter:
            continue
        attendance_groups.setdefault((int(year), int(quarter)), []).append(r)

    conn = db.get_db()
    summary = []
    try:
        conn.execute("BEGIN")
        for (year, quarter) in attendance_groups:
            conn.execute(
                "DELETE FROM aep_attendance WHERE period_year=? AND period_quarter=?",
                (year, quarter),
            )
        for (year, quarter), a_rows in attendance_groups.items():
            for r in a_rows:
                first_name = str(r.get("firstName") or "").strip()
                last_name = str(r.get("lastName") or "").strip()
                conn.execute(
                    "INSERT INTO aep_attendance (period_year, period_quarter, event_name, event_date, "
                    "status, first_name, last_name, name_norm, store) VALUES (?,?,?,?,?,?,?,?,?)",
                    (year, quarter, str(r.get("eventName") or "").strip(), str(r.get("date") or "").strip(),
                     str(r.get("status") or "").strip(), first_name, last_name,
                     normalize_person_name(f"{first_name} {last_name}"), str(r.get("store") or "").strip()),
                )
        for (year, quarter), group_rows in sorted(groups.items()):
            rows = [clean_aep_row(r) for r in group_rows]
            rows = [r for r in rows if r["position"]]  # must have a topic
            if not rows:
                continue
            totals, by_region, by_store, by_position = aggregate_aep(rows)
            dist = distribution_aep(rows)
            goal = aep_goal_for_quarter(year, quarter)
            label = f"Q{quarter} {year}"

            # A quarter re-appearing in a later upload of the growing master
            # file replaces that quarter's data outright (not a new period).
            old = conn.execute(
                "SELECT id FROM periods WHERE stream_type='aep' AND stream_key='aep' "
                "AND period_year=? AND period_quarter=?",
                (year, quarter),
            ).fetchall()
            for o in old:
                conn.execute("DELETE FROM periods WHERE id=?", (o["id"],))

            cur = conn.execute(
                "INSERT INTO periods (stream_type, stream_key, label, uploaded_at, has_details, "
                "totals_json, by_region_json, by_store_json, by_position_json, distribution_json, "
                "period_year, period_quarter, aep_goal) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "aep", "aep", label, datetime.datetime.utcnow().isoformat() + "Z", 1,
                    json.dumps(totals, ensure_ascii=False),
                    json.dumps(by_region, ensure_ascii=False),
                    json.dumps(by_store, ensure_ascii=False),
                    json.dumps(by_position, ensure_ascii=False),
                    json.dumps(dist, ensure_ascii=False),
                    year, quarter, goal,
                ),
            )
            period_id = cur.lastrowid

            for r in rows:
                conn.execute(
                    "INSERT INTO details (period_id, region, store, position, name, assigned, completed, "
                    "progress, score, event_date, actual_entered) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (period_id, r["region"], r["store"], r["position"], r["name"],
                     r["assigned"], r["completed"], r["progress"], r["score"], r["date"],
                     1 if r["held"] else 0),
                )

            topics_reached = sum(1 for b in by_position.values() if b["completed"] >= goal)
            summary.append({
                "label": label, "year": year, "quarter": quarter, "goal": goal,
                "sessions": len(rows), "topics": len(by_position), "topicsReachedGoal": topics_reached,
                "totalPlanned": totals["assigned"], "totalActual": totals["completed"],
            })

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return jsonify({"ok": True, "quarters": summary})


@app.post("/api/upload-aep-roster")
def upload_aep_roster():
    """Whole-roster replace — this file is a current snapshot (who IS a
    champion/reservist right now), not a period, so re-uploading it always
    overwrites the previous roster rather than accumulating history."""
    data = request.get_json(silent=True) or {}
    raw_rows = data.get("rows") or []
    if not raw_rows:
        return jsonify({"error": "Не знайдено жодного рядка"}), 400

    entries = []
    for r in raw_rows:
        name = str(r.get("name") or "").strip()
        tier = normalize_roster_tier(r.get("status"))
        if not name or not tier:
            continue
        entries.append((name, normalize_person_name(name), str(r.get("store") or "").strip(), tier))

    if not entries:
        return jsonify({"error": "Не знайдено жодного чемпіона чи резервіста"}), 400

    conn = db.get_db()
    try:
        conn.execute("BEGIN")
        conn.execute("DELETE FROM aep_roster")
        conn.executemany(
            "INSERT INTO aep_roster (name, name_norm, store, tier) VALUES (?,?,?,?)",
            entries,
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    champions = sum(1 for e in entries if e[3] == "Apple чемпіон")
    reservists = sum(1 for e in entries if e[3] == "Резервіст")
    # Surface likely typo'd duplicate rows (same person listed twice under
    # slightly different spellings) so they can be cleaned up in the source
    # file — matching routes around these at query time, but a duplicate row
    # still permanently shows 0 attendance under its own name.
    dup_pairs = find_near_duplicate_names([(e[0], e[1]) for e in entries])
    return jsonify({
        "ok": True, "total": len(entries), "champions": champions, "reservists": reservists,
        "duplicates": [{"a": a, "b": b} for a, b in dup_pairs],
    })


@app.get("/api/aep-attendance-summary")
def aep_attendance_summary():
    year, quarter = request.args.get("year"), request.args.get("quarter")
    if not year or not quarter:
        return jsonify({"error": "year і quarter обов'язкові"}), 400
    conn = db.get_db()
    rows = conn.execute(
        "SELECT status, name_norm FROM aep_attendance WHERE period_year=? AND period_quarter=? "
        "AND status != 'CANCELLED'",
        (year, quarter),
    ).fetchall()
    matcher = build_roster_matcher(
        conn.execute("SELECT name_norm, tier FROM aep_roster").fetchall(), load_aep_aliases(conn)
    )
    conn.close()

    tiers = {}

    def bucket(tier):
        if tier not in tiers:
            tiers[tier] = {"total": 0, "checkedIn": 0, "people": set()}
        return tiers[tier]

    for r in rows:
        matched = matcher(r["name_norm"])
        tier = matched["tier"] if matched else "Інші учасники"
        b = bucket(tier)
        b["total"] += 1
        # Key people by the matched roster row's own name_norm (not the raw
        # attendance name_norm) so a nicknamed/typo'd record ("Ксюша") and
        # the roster's own spelling ("Ксенія") count as the same person.
        b["people"].add(matched["name_norm"] if matched else r["name_norm"])
        if r["status"] == "CHECKED_IN":
            b["checkedIn"] += 1

    for b in tiers.values():
        b["rate"] = round((b["checkedIn"] / b["total"]) * 100, 1) if b["total"] else 0.0
        b["uniquePeople"] = len(b["people"])
        del b["people"]

    return jsonify({"tiers": tiers})


@app.get("/api/aep-attendance-sessions")
def aep_attendance_sessions():
    year, quarter = request.args.get("year"), request.args.get("quarter")
    if not year or not quarter:
        return jsonify({"error": "year і quarter обов'язкові"}), 400
    conn = db.get_db()
    rows = conn.execute(
        "SELECT event_name, event_date, status FROM aep_attendance "
        "WHERE period_year=? AND period_quarter=?",
        (year, quarter),
    ).fetchall()
    conn.close()

    sessions = {}
    for r in rows:
        key = (r["event_name"], r["event_date"])
        if key not in sessions:
            sessions[key] = {
                "eventName": r["event_name"], "date": r["event_date"],
                "total": 0, "checkedIn": 0,
            }
        s = sessions[key]
        if r["status"] != "CANCELLED":
            s["total"] += 1
        if r["status"] == "CHECKED_IN":
            s["checkedIn"] += 1

    result = sorted(sessions.values(), key=lambda s: s["date"])
    return jsonify({"sessions": result})


@app.get("/api/aep-attendance-detail")
def aep_attendance_detail():
    event_name, event_date = request.args.get("eventName"), request.args.get("date")
    tier_filter = request.args.get("tier")
    if not event_name or not event_date:
        return jsonify({"error": "eventName і date обов'язкові"}), 400
    conn = db.get_db()
    rows = conn.execute(
        "SELECT first_name, last_name, store, status, name_norm FROM aep_attendance "
        "WHERE event_name=? AND event_date=? ORDER BY last_name, first_name",
        (event_name, event_date),
    ).fetchall()
    matcher = build_roster_matcher(
        conn.execute("SELECT name_norm, tier FROM aep_roster").fetchall(), load_aep_aliases(conn)
    )
    conn.close()

    attendees = []
    for r in rows:
        matched = matcher(r["name_norm"])
        tier = matched["tier"] if matched else "Інші учасники"
        if tier_filter and tier != tier_filter:
            continue
        attendees.append({
            "name": f"{r['first_name']} {r['last_name']}".strip(),
            "store": r["store"],
            "status": r["status"],
            "tier": tier,
        })
    return jsonify({"attendees": attendees})


@app.get("/api/aep-no-shows")
def aep_no_shows():
    """Denominator is every unique training held this quarter (not just the
    ones a person registered for) — champions/reservists are expected to
    attend the full program, so this also surfaces people who never
    registered at all, not only people who registered and skipped. Scoped to
    the roster (champions+reservists): ordinary "Інші учасники" retail staff
    aren't expected to attend every session, so measuring them against the
    full quarter would just flag most of the store network."""
    year, quarter = request.args.get("year"), request.args.get("quarter")
    tier_filter = request.args.get("tier")
    if not year or not quarter:
        return jsonify({"error": "year і quarter обов'язкові"}), 400
    conn = db.get_db()
    # The canonical list of trainings this quarter — and each slot's date —
    # comes from the topics table (details/periods, same source as "Теми
    # цього кварталу"), NOT from aep_attendance.event_name: the two source
    # sheets (Training_Planning vs Apple_Certified_-_Attendance) name the
    # same session differently often enough that string matching on the
    # name is unreliable (e.g. "Ведіть ЕФЕКТИВНІ бесіди" in the topics sheet
    # vs "Ведіть ЧУДОВІ бесіди" in the attendance sheet for the same
    # session, or "Mac Hands-on (Champions by list)" vs "Практична робота з
    # комп'ютерами Mac"). The slot DATE is consistent between both sheets,
    # so that's the join key: map each date to its canonical topic name.
    topic_rows = conn.execute(
        "SELECT d.position AS topic, substr(d.event_date, 1, 10) AS day FROM details d "
        "JOIN periods p ON p.id = d.period_id "
        "WHERE p.stream_type='aep' AND p.period_year=? AND p.period_quarter=? "
        "AND d.position IS NOT NULL AND d.event_date IS NOT NULL",
        (year, quarter),
    ).fetchall()
    date_to_topic = {r["day"]: r["topic"] for r in topic_rows}
    total_sessions = len({r["topic"] for r in topic_rows})
    roster = conn.execute("SELECT id, name, name_norm, store, tier FROM aep_roster").fetchall()
    aliases = load_aep_aliases(conn)
    checked_rows = conn.execute(
        "SELECT DISTINCT name_norm, event_date FROM aep_attendance "
        "WHERE period_year=? AND period_quarter=? AND status='CHECKED_IN'",
        (year, quarter),
    ).fetchall()
    conn.close()

    if not total_sessions or not roster:
        return jsonify({"people": [], "totalSessions": total_sessions})

    # Resolve each attendee to their best-matching roster row (exact >
    # nickname-folded > fuzzy typo) against the FULL roster, then count
    # distinct TRAININGS (via date_to_topic, not the attendance log's own
    # event_name — see above) per roster row id — this way a near-duplicate
    # roster entry (e.g. the same person listed twice with a typo'd surname)
    # doesn't get credit that belongs to their "real" entry, a nicknamed
    # attendance record ("Ксюша") still counts toward the roster's full-name
    # entry ("Ксенія"), and checking into any one slot of a multi-slot topic
    # counts as attending that training once. The tier filter (if any) is
    # applied afterwards, only to which roster rows get listed in the
    # response.
    matcher = build_roster_matcher(roster, aliases)
    if tier_filter:
        roster = [r for r in roster if r["tier"] == tier_filter]
        if not roster:
            return jsonify({"people": [], "totalSessions": total_sessions})
    checked_by_roster_id = {}
    for r in checked_rows:
        topic = date_to_topic.get(str(r["event_date"])[:10])
        if not topic:
            continue
        matched = matcher(r["name_norm"])
        if not matched:
            continue
        checked_by_roster_id.setdefault(matched["id"], set()).add(topic)

    people = [{
        "name": r["name"], "store": r["store"], "tier": r["tier"],
        "checkedIn": len(checked_by_roster_id.get(r["id"], ())), "total": total_sessions,
        "rate": round((len(checked_by_roster_id.get(r["id"], ())) / total_sessions) * 100, 1),
    } for r in roster]
    people.sort(key=lambda p: (p["rate"], -p["checkedIn"]))
    return jsonify({"people": people[:50], "totalSessions": total_sessions})


@app.get("/api/aep-name-suggestions")
def aep_name_suggestions():
    """Attendance names the matcher (exact/nickname/≤2-edit fuzzy, plus any
    confirmed alias) still couldn't resolve to a roster entry — typically a
    bigger typo or an abbreviated signature ("О. Іванов"). Paired with
    roster candidates similar enough (see suggest_name_matches' default
    threshold) so an operator can review and
    confirm a merge. Scoped across all quarters, not just the one currently
    viewed, since a merge decision should apply everywhere."""
    conn = db.get_db()
    roster = conn.execute("SELECT id, name, name_norm, tier FROM aep_roster").fetchall()
    aliases = load_aep_aliases(conn)
    dismissed = load_aep_dismissals(conn)
    attendance = conn.execute(
        "SELECT first_name, last_name, name_norm FROM aep_attendance WHERE status != 'CANCELLED'"
    ).fetchall()
    conn.close()

    if not roster or not attendance:
        return jsonify({"suggestions": []})

    matcher = build_roster_matcher(roster, aliases)
    unmatched_by_norm = {}
    for r in attendance:
        if r["name_norm"] in aliases or r["name_norm"] in dismissed or matcher(r["name_norm"]):
            continue
        unmatched_by_norm.setdefault(r["name_norm"], f"{r['first_name']} {r['last_name']}".strip())

    unmatched = [(display_name, name_norm) for name_norm, display_name in unmatched_by_norm.items()]
    suggestions = suggest_name_matches(unmatched, roster, population_name_norms=[r["name_norm"] for r in attendance])
    return jsonify({"suggestions": suggestions})


@app.get("/api/aep-name-aliases")
def list_aep_name_aliases():
    conn = db.get_db()
    rows = conn.execute(
        "SELECT id, raw_name, target_name, created_at FROM aep_name_aliases ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return jsonify({"aliases": [
        {"id": r["id"], "rawName": r["raw_name"], "targetName": r["target_name"], "createdAt": r["created_at"]}
        for r in rows
    ]})


@app.post("/api/aep-name-alias")
def create_aep_name_alias():
    """Persists an operator-confirmed "this attendance name IS this roster
    person" decision, keyed by the raw name's normalized form so it applies
    to every quarter and survives future roster re-uploads (which replace
    aep_roster wholesale) as long as the target keeps the same name."""
    data = request.get_json(silent=True) or {}
    raw_name_norm = str(data.get("rawNameNorm") or "").strip()
    target_roster_id = data.get("targetRosterId")
    if not raw_name_norm or not target_roster_id:
        return jsonify({"error": "rawNameNorm і targetRosterId обов'язкові"}), 400

    conn = db.get_db()
    target = conn.execute("SELECT name, name_norm FROM aep_roster WHERE id=?", (target_roster_id,)).fetchone()
    if not target:
        conn.close()
        return jsonify({"error": "Учасника ростера не знайдено"}), 404
    raw_row = conn.execute(
        "SELECT first_name, last_name FROM aep_attendance WHERE name_norm=? LIMIT 1", (raw_name_norm,)
    ).fetchone()
    raw_name = f"{raw_row['first_name']} {raw_row['last_name']}".strip() if raw_row else raw_name_norm
    conn.execute(
        "INSERT INTO aep_name_aliases (raw_name, raw_name_norm, target_name, target_name_norm, created_at) "
        "VALUES (?,?,?,?,?) ON CONFLICT(raw_name_norm) DO UPDATE SET "
        "target_name=excluded.target_name, target_name_norm=excluded.target_name_norm, created_at=excluded.created_at",
        (raw_name, raw_name_norm, target["name"], target["name_norm"], datetime.datetime.utcnow().isoformat() + "Z"),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.delete("/api/aep-name-alias/<int:alias_id>")
def delete_aep_name_alias(alias_id):
    conn = db.get_db()
    conn.execute("DELETE FROM aep_name_aliases WHERE id=?", (alias_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.get("/api/aep-name-dismissals")
def list_aep_name_dismissals():
    conn = db.get_db()
    rows = conn.execute(
        "SELECT id, raw_name, created_at FROM aep_name_dismissals ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return jsonify({"dismissals": [
        {"id": r["id"], "rawName": r["raw_name"], "createdAt": r["created_at"]} for r in rows
    ]})


@app.post("/api/aep-name-dismiss")
def create_aep_name_dismissal():
    """Persists an operator-confirmed "this attendance name is NOT any of
    the suggested roster people" decision — keeps it out of future
    suggestion lists (across quarters and roster re-uploads) without
    merging it to anyone."""
    data = request.get_json(silent=True) or {}
    raw_name_norm = str(data.get("rawNameNorm") or "").strip()
    if not raw_name_norm:
        return jsonify({"error": "rawNameNorm обов'язковий"}), 400

    conn = db.get_db()
    raw_row = conn.execute(
        "SELECT first_name, last_name FROM aep_attendance WHERE name_norm=? LIMIT 1", (raw_name_norm,)
    ).fetchone()
    raw_name = f"{raw_row['first_name']} {raw_row['last_name']}".strip() if raw_row else raw_name_norm
    conn.execute(
        "INSERT INTO aep_name_dismissals (raw_name, raw_name_norm, created_at) VALUES (?,?,?) "
        "ON CONFLICT(raw_name_norm) DO UPDATE SET created_at=excluded.created_at",
        (raw_name, raw_name_norm, datetime.datetime.utcnow().isoformat() + "Z"),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.delete("/api/aep-name-dismiss/<int:dismissal_id>")
def delete_aep_name_dismissal(dismissal_id):
    conn = db.get_db()
    conn.execute("DELETE FROM aep_name_dismissals WHERE id=?", (dismissal_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.get("/api/aep-roster-duplicates")
def aep_roster_duplicates():
    """Two (or more) CURRENT roster rows that are almost certainly the same
    person uploaded twice — typically the same name with first/last word
    order swapped between LMS exports, which collapses to an IDENTICAL
    name_norm (normalize_person_name sorts tokens), or a straight typo.
    Unlike the one-time toast shown at roster-upload time
    (find_near_duplicate_names), this re-scans the roster on every request
    so the pair stays visible until someone resolves it."""
    conn = db.get_db()
    roster = conn.execute("SELECT id, name, name_norm, store, tier FROM aep_roster").fetchall()
    dismissed = load_aep_roster_dup_dismissals(conn)
    conn.close()

    duplicates = []
    for a, b in find_roster_duplicate_rows(roster):
        key = tuple(sorted((a["name_norm"], b["name_norm"])))
        if key in dismissed:
            continue
        duplicates.append({
            "a": {"id": a["id"], "name": a["name"], "nameNorm": a["name_norm"], "store": a["store"], "tier": a["tier"]},
            "b": {"id": b["id"], "name": b["name"], "nameNorm": b["name_norm"], "store": b["store"], "tier": b["tier"]},
        })
    return jsonify({"duplicates": duplicates})


@app.post("/api/aep-roster-dedupe")
def dedupe_aep_roster():
    """Removes one of two roster rows confirmed to be the same person —
    a direct fix to the current roster snapshot, not reversible by undo
    (re-upload the roster file to restore a row removed by mistake)."""
    data = request.get_json(silent=True) or {}
    keep_id, remove_id = data.get("keepId"), data.get("removeId")
    if not keep_id or not remove_id or keep_id == remove_id:
        return jsonify({"error": "keepId і removeId обов'язкові й мають відрізнятись"}), 400
    conn = db.get_db()
    conn.execute("DELETE FROM aep_roster WHERE id=?", (remove_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.get("/api/aep-roster-dup-dismissals")
def list_aep_roster_dup_dismissals():
    conn = db.get_db()
    rows = conn.execute(
        "SELECT id, name_a, name_b, created_at FROM aep_roster_dup_dismissals ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return jsonify({"dismissals": [
        {"id": r["id"], "nameA": r["name_a"], "nameB": r["name_b"], "createdAt": r["created_at"]}
        for r in rows
    ]})


@app.post("/api/aep-roster-dup-dismiss")
def dismiss_aep_roster_dup():
    data = request.get_json(silent=True) or {}
    name_a = str(data.get("nameA") or "").strip()
    norm_a = str(data.get("nameNormA") or "").strip()
    name_b = str(data.get("nameB") or "").strip()
    norm_b = str(data.get("nameNormB") or "").strip()
    if not norm_a or not norm_b:
        return jsonify({"error": "nameNormA і nameNormB обов'язкові"}), 400
    if norm_b < norm_a:
        name_a, norm_a, name_b, norm_b = name_b, norm_b, name_a, norm_a
    conn = db.get_db()
    conn.execute(
        "INSERT INTO aep_roster_dup_dismissals (name_a, name_norm_a, name_b, name_norm_b, created_at) "
        "VALUES (?,?,?,?,?) ON CONFLICT(name_norm_a, name_norm_b) DO UPDATE SET created_at=excluded.created_at",
        (name_a, norm_a, name_b, norm_b, datetime.datetime.utcnow().isoformat() + "Z"),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.delete("/api/aep-roster-dup-dismiss/<int:dismissal_id>")
def undo_aep_roster_dup_dismiss(dismissal_id):
    conn = db.get_db()
    conn.execute("DELETE FROM aep_roster_dup_dismissals WHERE id=?", (dismissal_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- "Звіт для РК" — director АТТ + Додаткове навчання ----------
# Same growing-file model as AEP: one row per topic per director per
# quarter, quarter resolved client-side from the row's own date, re-upload
# replaces only the quarters present in that upload.

@app.post("/api/upload-director-report")
def upload_director_report():
    data = request.get_json(silent=True) or {}
    raw_rows = data.get("rows") or []
    if not raw_rows:
        return jsonify({"error": "Не знайдено жодного рядка"}), 400

    groups = {}
    for r in raw_rows:
        year, quarter = r.get("year"), r.get("quarter")
        if not year or not quarter:
            continue
        groups.setdefault((int(year), int(quarter)), []).append(r)

    if not groups:
        return jsonify({"error": "Не вдалося визначити рік/квартал жодного рядка"}), 400

    conn = db.get_db()
    summary = []
    try:
        conn.execute("BEGIN")
        for (year, quarter) in groups:
            conn.execute(
                "DELETE FROM director_report_details WHERE period_year=? AND period_quarter=?",
                (year, quarter),
            )
        uploaded_at = datetime.datetime.utcnow().isoformat() + "Z"
        for (year, quarter), group_rows in sorted(groups.items()):
            rows = [clean_director_report_row(r) for r in group_rows]
            rows = [r for r in rows if r["topic"] and r["trainingType"]]
            for r in rows:
                conn.execute(
                    "INSERT INTO director_report_details (period_year, period_quarter, topic, training_type, "
                    "region, store, position, name, score, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (year, quarter, r["topic"], r["trainingType"], r["region"], r["store"],
                     r["position"], r["name"], r["score"], uploaded_at),
                )
            summary.append({"year": year, "quarter": quarter, "label": f"Q{quarter} {year}", "rows": len(rows)})
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return jsonify({"ok": True, "quarters": summary})


@app.get("/api/director-report-last-updated")
def director_report_last_updated():
    conn = db.get_db()
    row = conn.execute("SELECT MAX(uploaded_at) AS last FROM director_report_details").fetchone()
    conn.close()
    return jsonify({"lastUpdated": row["last"]})


@app.get("/api/director-report-periods")
def director_report_periods():
    conn = db.get_db()
    rows = conn.execute(
        "SELECT DISTINCT period_year, period_quarter FROM director_report_details "
        "ORDER BY period_year, period_quarter"
    ).fetchall()
    conn.close()
    periods = [
        {"year": r["period_year"], "quarter": r["period_quarter"], "label": f"Q{r['period_quarter']} {r['period_year']}"}
        for r in rows
    ]
    return jsonify({"periods": periods})


@app.get("/api/director-report-filters")
def director_report_filters():
    year, quarter = request.args.get("year"), request.args.get("quarter")
    region = request.args.get("region")
    if not year or not quarter:
        return jsonify({"error": "year і quarter обов'язкові"}), 400
    conn = db.get_db()
    regions = conn.execute(
        "SELECT DISTINCT region FROM director_report_details "
        "WHERE period_year=? AND period_quarter=? AND region != '' ORDER BY region",
        (year, quarter),
    ).fetchall()
    store_where = "period_year=? AND period_quarter=? AND store != ''"
    store_params = [year, quarter]
    if region:
        store_where += " AND region=?"
        store_params.append(region)
    stores = conn.execute(
        f"SELECT DISTINCT store FROM director_report_details WHERE {store_where} ORDER BY store",
        store_params,
    ).fetchall()
    conn.close()
    return jsonify({"regions": [r["region"] for r in regions], "stores": [r["store"] for r in stores]})


def _director_report_where(args):
    clauses = ["period_year=?", "period_quarter=?"]
    params = [args.get("year"), args.get("quarter")]
    if args.get("region"):
        clauses.append("region=?")
        params.append(args["region"])
    if args.get("store"):
        clauses.append("store=?")
        params.append(args["store"])
    return " AND ".join(clauses), params


@app.get("/api/director-report-raw")
def director_report_raw():
    """All rows for one quarter, unfiltered — used only by the client-side
    HTML export (downloadDirectorReportHtml), which bakes them into the
    downloaded file so region/store filtering keeps working with zero
    server round trips once it's out of the browser."""
    year, quarter = request.args.get("year"), request.args.get("quarter")
    if not year or not quarter:
        return jsonify({"error": "year і quarter обов'язкові"}), 400
    conn = db.get_db()
    rows = conn.execute(
        "SELECT topic, training_type, region, store, name, score FROM director_report_details "
        "WHERE period_year=? AND period_quarter=?",
        (year, quarter),
    ).fetchall()
    conn.close()
    return jsonify({"rows": [
        {"topic": r["topic"], "trainingType": r["training_type"], "region": r["region"],
         "store": r["store"], "name": r["name"], "score": r["score"]}
        for r in rows
    ]})


@app.get("/api/director-report-raw-all")
def director_report_raw_all():
    """Every row across every uploaded quarter, unfiltered — used only by
    the standalone HTML export to compute the "historically low" card
    (and its per-person quarter trend) entirely offline, since that
    analysis spans quarters rather than the one the export was taken
    for."""
    conn = db.get_db()
    rows = conn.execute(
        "SELECT period_year, period_quarter, training_type, region, store, name, score "
        "FROM director_report_details"
    ).fetchall()
    conn.close()
    return jsonify({"rows": [
        {"year": r["period_year"], "quarter": r["period_quarter"], "trainingType": r["training_type"],
         "region": r["region"], "store": r["store"], "name": r["name"], "score": r["score"]}
        for r in rows
    ]})


def _director_report_historical_people(region=None, store=None):
    """Per-director averages across EVERY uploaded quarter (not just the
    one currently selected) — only people present in at least 2 distinct
    quarters count, so a single bad quarter doesn't get flagged as a
    historical pattern."""
    clauses = ["name != ''"]
    params = []
    if region:
        clauses.append("region=?")
        params.append(region)
    if store:
        clauses.append("store=?")
        params.append(store)
    where = " AND ".join(clauses)
    conn = db.get_db()
    rows = conn.execute(
        f"SELECT period_year, period_quarter, training_type, region, store, name, score "
        f"FROM director_report_details WHERE {where}",
        params,
    ).fetchall()
    conn.close()

    people = {}
    for r in rows:
        p = people.setdefault(r["name"], {
            "name": r["name"], "region": r["region"], "store": r["store"],
            "latestKey": None, "quarters": set(),
            "attSum": 0.0, "attCount": 0, "addSum": 0.0, "addCount": 0,
            "allSum": 0.0, "allCount": 0,
        })
        qkey = (r["period_year"], r["period_quarter"])
        p["quarters"].add(qkey)
        if p["latestKey"] is None or qkey > p["latestKey"]:
            p["latestKey"] = qkey
            p["region"] = r["region"]
            p["store"] = r["store"]
        p["allSum"] += r["score"]
        p["allCount"] += 1
        if r["training_type"] == "АТТ":
            p["attSum"] += r["score"]
            p["attCount"] += 1
        elif r["training_type"] == "Додаткове навчання":
            p["addSum"] += r["score"]
            p["addCount"] += 1

    result = []
    for p in people.values():
        if len(p["quarters"]) < 2:
            continue
        result.append({
            "name": p["name"], "region": p["region"], "store": p["store"],
            "quarterCount": len(p["quarters"]),
            "att": round(p["attSum"] / p["attCount"], 1) if p["attCount"] else None,
            "additional": round(p["addSum"] / p["addCount"], 1) if p["addCount"] else None,
            "overall": round(p["allSum"] / p["allCount"], 1) if p["allCount"] else None,
        })
    return result


DIRECTOR_REPORT_HISTORICAL_LOW_THRESHOLD = 70  # below this = needs priority attention


@app.get("/api/director-report-historical-low")
def director_report_historical_low():
    people = _director_report_historical_people(request.args.get("region"), request.args.get("store"))
    people = [p for p in people if p["overall"] is not None and p["overall"] < DIRECTOR_REPORT_HISTORICAL_LOW_THRESHOLD]
    people.sort(key=lambda p: (p["overall"], -p["quarterCount"]))
    return jsonify({"people": people[:100], "threshold": DIRECTOR_REPORT_HISTORICAL_LOW_THRESHOLD})


@app.get("/api/director-report-historical-trend")
def director_report_historical_trend():
    """Per-quarter breakdown for one director — the drill-down behind a
    row in the historically-low table."""
    name = request.args.get("name")
    if not name:
        return jsonify({"error": "name обов'язкове"}), 400
    conn = db.get_db()
    rows = conn.execute(
        "SELECT period_year, period_quarter, "
        "AVG(CASE WHEN training_type='АТТ' THEN score END) AS att, "
        "AVG(CASE WHEN training_type='Додаткове навчання' THEN score END) AS additional, "
        "AVG(score) AS overall "
        "FROM director_report_details WHERE name=? "
        "GROUP BY period_year, period_quarter ORDER BY period_year, period_quarter",
        (name,),
    ).fetchall()
    conn.close()
    return jsonify({"quarters": [{
        "year": r["period_year"], "quarter": r["period_quarter"],
        "att": round(r["att"], 1) if r["att"] is not None else None,
        "additional": round(r["additional"], 1) if r["additional"] is not None else None,
        "overall": round(r["overall"], 1) if r["overall"] is not None else None,
    } for r in rows]})


@app.get("/api/director-report-summary")
def director_report_summary():
    year, quarter = request.args.get("year"), request.args.get("quarter")
    if not year or not quarter:
        return jsonify({"error": "year і quarter обов'язкові"}), 400
    where, params = _director_report_where(request.args)
    conn = db.get_db()

    def avg_for(training_type=None):
        w, p = where, list(params)
        if training_type:
            w += " AND training_type=?"
            p.append(training_type)
        return conn.execute(
            f"SELECT AVG(score) AS avg, COUNT(*) AS c FROM director_report_details WHERE {w}",
            p,
        ).fetchone()

    att = avg_for("АТТ")
    additional = avg_for("Додаткове навчання")
    overall = avg_for(None)
    conn.close()
    return jsonify({
        "att": round(att["avg"], 1) if att["avg"] is not None else None,
        "additional": round(additional["avg"], 1) if additional["avg"] is not None else None,
        "overall": round(overall["avg"], 1) if overall["avg"] is not None else None,
        "count": overall["c"],
    })


@app.get("/api/director-report-by-region")
def director_report_by_region():
    """Always the full region breakdown (ignores the region/store filter —
    that's the point: an at-a-glance table across every region, like the
    source workbook's "ЗАГАЛЬНИЙ АТТ" sheet)."""
    year, quarter = request.args.get("year"), request.args.get("quarter")
    if not year or not quarter:
        return jsonify({"error": "year і quarter обов'язкові"}), 400
    conn = db.get_db()
    rows = conn.execute(
        "SELECT region, "
        "AVG(CASE WHEN training_type='АТТ' THEN score END) AS att, "
        "AVG(CASE WHEN training_type='Додаткове навчання' THEN score END) AS additional, "
        "AVG(score) AS overall "
        "FROM director_report_details WHERE period_year=? AND period_quarter=? AND region != '' "
        "GROUP BY region ORDER BY overall DESC",
        (year, quarter),
    ).fetchall()
    conn.close()
    return jsonify({"regions": [{
        "region": r["region"],
        "att": round(r["att"], 1) if r["att"] is not None else None,
        "additional": round(r["additional"], 1) if r["additional"] is not None else None,
        "overall": round(r["overall"], 1) if r["overall"] is not None else None,
    } for r in rows]})


@app.get("/api/director-report-by-employee")
def director_report_by_employee():
    """Per-employee breakdown within the selected region (and optionally
    store) — shown instead of the by-region table once a region is picked,
    since "all regions at a glance" stops being the useful view at that
    point."""
    year, quarter = request.args.get("year"), request.args.get("quarter")
    if not year or not quarter:
        return jsonify({"error": "year і quarter обов'язкові"}), 400
    where, params = _director_report_where(request.args)
    conn = db.get_db()
    rows = conn.execute(
        f"SELECT name, store, "
        f"AVG(CASE WHEN training_type='АТТ' THEN score END) AS att, "
        f"AVG(CASE WHEN training_type='Додаткове навчання' THEN score END) AS additional, "
        f"AVG(score) AS overall "
        f"FROM director_report_details WHERE {where} AND name != '' "
        f"GROUP BY name, store ORDER BY overall DESC",
        params,
    ).fetchall()
    conn.close()
    return jsonify({"employees": [{
        "name": r["name"],
        "store": r["store"],
        "att": round(r["att"], 1) if r["att"] is not None else None,
        "additional": round(r["additional"], 1) if r["additional"] is not None else None,
        "overall": round(r["overall"], 1) if r["overall"] is not None else None,
    } for r in rows]})


@app.get("/api/director-report-employee-topics")
def director_report_employee_topics():
    """Per-topic breakdown for one director — the drill-down behind a row
    in the by-employee table (store is included to disambiguate same-name
    directors across different stores)."""
    year, quarter = request.args.get("year"), request.args.get("quarter")
    name = request.args.get("name")
    if not year or not quarter or not name:
        return jsonify({"error": "year, quarter і name обов'язкові"}), 400
    where, params = _director_report_where(request.args)
    where += " AND name=?"
    params = params + [name]
    conn = db.get_db()
    rows = conn.execute(
        f"SELECT topic, training_type, score FROM director_report_details "
        f"WHERE {where} ORDER BY training_type, topic",
        params,
    ).fetchall()
    conn.close()
    return jsonify({"topics": [
        {"topic": r["topic"], "trainingType": r["training_type"], "score": r["score"]}
        for r in rows
    ]})


@app.get("/api/director-report-topics")
def director_report_topics():
    year, quarter = request.args.get("year"), request.args.get("quarter")
    if not year or not quarter:
        return jsonify({"error": "year і quarter обов'язкові"}), 400
    where, params = _director_report_where(request.args)
    conn = db.get_db()
    rows = conn.execute(
        f"SELECT topic, training_type, AVG(score) AS avg, COUNT(*) AS c, "
        f"SUM(CASE WHEN score > 0 THEN 1 ELSE 0 END) AS passed FROM director_report_details "
        f"WHERE {where} GROUP BY topic, training_type ORDER BY training_type, topic",
        params,
    ).fetchall()
    conn.close()
    return jsonify({"topics": [{
        "topic": r["topic"], "trainingType": r["training_type"], "avg": round(r["avg"], 1), "count": r["c"],
        "completionRate": round((r["passed"] / r["c"]) * 100, 1) if r["c"] else None,
    } for r in rows]})


@app.get("/api/director-report-top")
def director_report_top():
    """Best performers this quarter in one combined ranking — position is
    the arithmetic mean of the person's average АТТ score and average
    "Додаткове навчання" score (unweighted by how many topics each type
    had), not the row-weighted "Загальний результат" used elsewhere."""
    year, quarter = request.args.get("year"), request.args.get("quarter")
    if not year or not quarter:
        return jsonify({"error": "year і quarter обов'язкові"}), 400
    where, params = _director_report_where(request.args)
    conn = db.get_db()
    rows = conn.execute(
        f"SELECT name, region, store, "
        f"AVG(CASE WHEN training_type='АТТ' THEN score END) AS att, "
        f"AVG(CASE WHEN training_type='Додаткове навчання' THEN score END) AS additional "
        f"FROM director_report_details WHERE {where} AND name != '' GROUP BY name, region, store",
        params,
    ).fetchall()
    conn.close()
    people = []
    for r in rows:
        att = round(r["att"], 1) if r["att"] is not None else None
        additional = round(r["additional"], 1) if r["additional"] is not None else None
        values = [v for v in (att, additional) if v is not None]
        if not values:
            continue
        rank_score = round(sum(values) / len(values), 1)
        if rank_score <= 90:
            continue
        people.append({
            "name": r["name"], "region": r["region"], "store": r["store"],
            "att": att, "additional": additional,
            "rankScore": rank_score,
        })
    people.sort(key=lambda p: -p["rankScore"])
    return jsonify({"people": people[:100]})


# ---------- "Звіт по заняттям" — single-training-session reports ----------

@app.post("/api/upload-lesson-report")
def upload_lesson_report():
    data = request.get_json(silent=True) or {}
    lesson_key = str(data.get("lessonKey", "")).strip()
    title = str(data.get("title", "")).strip()
    raw_rows = data.get("rows") or []
    if not lesson_key or not title:
        return jsonify({"error": "Не вдалося визначити номер і назву заняття з файлу"}), 400
    if not raw_rows:
        return jsonify({"error": "У файлі не знайдено жодного рядка учасників"}), 400

    rows = [clean_lesson_report_row(r) for r in raw_rows]
    rows = [r for r in rows if r["name"]]

    conn = db.get_db()
    try:
        conn.execute("BEGIN")
        existing = conn.execute(
            "SELECT id FROM lesson_reports WHERE lesson_key=?", (lesson_key,)
        ).fetchone()
        uploaded_at = datetime.datetime.utcnow().isoformat() + "Z"
        if existing:
            lesson_report_id = existing["id"]
            conn.execute(
                "UPDATE lesson_reports SET title=?, uploaded_at=? WHERE id=?",
                (title, uploaded_at, lesson_report_id),
            )
            conn.execute("DELETE FROM lesson_report_details WHERE lesson_report_id=?", (lesson_report_id,))
        else:
            cur = conn.execute(
                "INSERT INTO lesson_reports (lesson_key, title, uploaded_at) VALUES (?,?,?)",
                (lesson_key, title, uploaded_at),
            )
            lesson_report_id = cur.lastrowid

        for r in rows:
            conn.execute(
                "INSERT INTO lesson_report_details (lesson_report_id, region, store, position, "
                "tab_number, name, material, test, test_date) VALUES (?,?,?,?,?,?,?,?,?)",
                (lesson_report_id, r["region"], r["store"], r["position"], r["tabNumber"],
                 r["name"], r["material"], r["test"], r["testDate"]),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return jsonify({"ok": True, "lessonReportId": lesson_report_id, "rowsCount": len(rows)})


@app.get("/api/lesson-reports")
def list_lesson_reports():
    conn = db.get_db()
    rows = conn.execute(
        "SELECT id, lesson_key, title, uploaded_at FROM lesson_reports ORDER BY uploaded_at ASC"
    ).fetchall()
    conn.close()
    return jsonify({"lessons": [
        {"id": r["id"], "lessonKey": r["lesson_key"], "title": r["title"], "uploadedAt": r["uploaded_at"]}
        for r in rows
    ]})


def _lesson_report_where(args):
    clauses = ["lesson_report_id=?"]
    params = [args.get("lessonReportId")]
    if args.get("region"):
        clauses.append("region=?")
        params.append(args["region"])
    if args.get("store"):
        clauses.append("store=?")
        params.append(args["store"])
    if args.get("position"):
        clauses.append("position=?")
        params.append(args["position"])
    return " AND ".join(clauses), params


@app.get("/api/lesson-report-filters")
def lesson_report_filters():
    lesson_report_id = request.args.get("lessonReportId")
    if not lesson_report_id:
        return jsonify({"error": "lessonReportId обов'язковий"}), 400
    region = request.args.get("region")
    conn = db.get_db()
    regions = conn.execute(
        "SELECT DISTINCT region FROM lesson_report_details WHERE lesson_report_id=? AND region != '' ORDER BY region",
        (lesson_report_id,),
    ).fetchall()
    store_where = "lesson_report_id=? AND store != ''"
    store_params = [lesson_report_id]
    if region:
        store_where += " AND region=?"
        store_params.append(region)
    stores = conn.execute(
        f"SELECT DISTINCT store FROM lesson_report_details WHERE {store_where} ORDER BY store",
        store_params,
    ).fetchall()
    positions = conn.execute(
        "SELECT DISTINCT position FROM lesson_report_details WHERE lesson_report_id=? AND position != '' ORDER BY position",
        (lesson_report_id,),
    ).fetchall()
    conn.close()
    return jsonify({
        "regions": [r["region"] for r in regions],
        "stores": [r["store"] for r in stores],
        "positions": [r["position"] for r in positions],
    })


@app.get("/api/lesson-report-summary")
def lesson_report_summary():
    if not request.args.get("lessonReportId"):
        return jsonify({"error": "lessonReportId обов'язковий"}), 400
    where, params = _lesson_report_where(request.args)
    conn = db.get_db()
    row = conn.execute(
        f"SELECT AVG(material) AS material, AVG(test) AS test, COUNT(*) AS total, "
        f"SUM(CASE WHEN test >= 100 THEN 1 ELSE 0 END) AS passed "
        f"FROM lesson_report_details WHERE {where}",
        params,
    ).fetchone()
    conn.close()
    return jsonify({
        "material": round(row["material"], 1) if row["material"] is not None else None,
        "test": round(row["test"], 1) if row["test"] is not None else None,
        "total": row["total"],
        "passed": row["passed"],
    })


@app.get("/api/lesson-report-by-region")
def lesson_report_by_region():
    """Always the full region breakdown (ignores region/store/position
    filters) — an at-a-glance table across every region regardless of
    what's currently selected."""
    lesson_report_id = request.args.get("lessonReportId")
    if not lesson_report_id:
        return jsonify({"error": "lessonReportId обов'язковий"}), 400
    conn = db.get_db()
    rows = conn.execute(
        "SELECT region, AVG(test) AS test, AVG(material) AS material, COUNT(*) AS total "
        "FROM lesson_report_details WHERE lesson_report_id=? AND region != '' "
        "GROUP BY region ORDER BY test DESC",
        (lesson_report_id,),
    ).fetchall()
    conn.close()
    return jsonify({"regions": [{
        "region": r["region"],
        "test": round(r["test"], 1) if r["test"] is not None else None,
        "material": round(r["material"], 1) if r["material"] is not None else None,
        "total": r["total"],
    } for r in rows]})


@app.get("/api/lesson-report-people")
def lesson_report_people():
    if not request.args.get("lessonReportId"):
        return jsonify({"error": "lessonReportId обов'язковий"}), 400
    where, params = _lesson_report_where(request.args)
    search = request.args.get("search")
    if search:
        where += " AND name LIKE ?"
        params = params + [f"%{search}%"]
    conn = db.get_db()
    rows = conn.execute(
        f"SELECT region, store, position, name, material, test, test_date "
        f"FROM lesson_report_details WHERE {where} ORDER BY test ASC, material ASC",
        params,
    ).fetchall()
    conn.close()
    return jsonify({"people": [{
        "region": r["region"], "store": r["store"], "position": r["position"], "name": r["name"],
        "material": r["material"], "test": r["test"], "testDate": r["test_date"],
    } for r in rows]})


@app.get("/api/lesson-report-raw")
def lesson_report_raw():
    """All rows for one lesson, unfiltered — used only by the client-side
    HTML export, which bakes them into the downloaded file so filtering
    keeps working with zero server round trips once it's out of the
    browser."""
    lesson_report_id = request.args.get("lessonReportId")
    if not lesson_report_id:
        return jsonify({"error": "lessonReportId обов'язковий"}), 400
    conn = db.get_db()
    rows = conn.execute(
        "SELECT region, store, position, name, material, test, test_date "
        "FROM lesson_report_details WHERE lesson_report_id=?",
        (lesson_report_id,),
    ).fetchall()
    conn.close()
    return jsonify({"rows": [{
        "region": r["region"], "store": r["store"], "position": r["position"], "name": r["name"],
        "material": r["material"], "test": r["test"], "testDate": r["test_date"],
    } for r in rows]})


# ---------- "Аналіз категорій" — per-position attestation/categorization ----------

@app.post("/api/upload-category-report")
def upload_category_report():
    data = request.get_json(silent=True) or {}
    position = str(data.get("position", "")).strip()
    period_label = str(data.get("periodLabel", "")).strip()
    raw_rows = data.get("rows") or []
    if not position or not period_label:
        return jsonify({"error": "Не вдалося визначити посаду і період з файлу"}), 400
    if not raw_rows:
        return jsonify({"error": "У файлі не знайдено жодного рядка співробітників"}), 400

    rows = [clean_category_report_row(r) for r in raw_rows]
    rows = [r for r in rows if r["name"]]

    conn = db.get_db()
    try:
        conn.execute("BEGIN")
        existing = conn.execute(
            "SELECT id FROM category_reports WHERE position=? AND period_label=?",
            (position, period_label),
        ).fetchone()
        uploaded_at = datetime.datetime.utcnow().isoformat() + "Z"
        if existing:
            category_report_id = existing["id"]
            conn.execute("UPDATE category_reports SET uploaded_at=? WHERE id=?", (uploaded_at, category_report_id))
            conn.execute("DELETE FROM category_report_details WHERE category_report_id=?", (category_report_id,))
        else:
            cur = conn.execute(
                "INSERT INTO category_reports (position, period_label, uploaded_at) VALUES (?,?,?)",
                (position, period_label, uploaded_at),
            )
            category_report_id = cur.lastrowid

        for r in rows:
            conn.execute(
                "INSERT INTO category_report_details (category_report_id, region, store, store_category, "
                "complexity_level, name, login, prev_category, potential_category, rk_wish, rk_comment, "
                "tests, open_questions, process_errors, returns_flag, unaccounted_flag, pickup_speed_min, confirmed, "
                "hire_date, metrics_json) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (category_report_id, r["region"], r["store"], r["storeCategory"], r["complexityLevel"],
                 r["name"], r["login"], r["prevCategory"], r["potentialCategory"], r["rkWish"], r["rkComment"],
                 r["tests"], r["openQuestions"], r["processErrors"], r["returnsFlag"], r["unaccountedFlag"],
                 r["pickupSpeedMin"], r["confirmed"], r["hireDate"], json.dumps(r["metrics"], ensure_ascii=False)),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return jsonify({"ok": True, "categoryReportId": category_report_id, "rowsCount": len(rows)})


@app.get("/api/category-reports")
def list_category_reports():
    conn = db.get_db()
    rows = conn.execute(
        "SELECT id, position, period_label, uploaded_at FROM category_reports ORDER BY uploaded_at ASC"
    ).fetchall()
    conn.close()
    return jsonify({"reports": [
        {"id": r["id"], "position": r["position"], "periodLabel": r["period_label"], "uploadedAt": r["uploaded_at"]}
        for r in rows
    ]})


def _category_report_where(args):
    clauses = ["category_report_id=?"]
    params = [args.get("categoryReportId")]
    if args.get("region"):
        clauses.append("region=?")
        params.append(args["region"])
    return " AND ".join(clauses), params


@app.get("/api/category-report-filters")
def category_report_filters():
    category_report_id = request.args.get("categoryReportId")
    if not category_report_id:
        return jsonify({"error": "categoryReportId обов'язковий"}), 400
    conn = db.get_db()
    regions = conn.execute(
        "SELECT DISTINCT region FROM category_report_details WHERE category_report_id=? AND region != '' ORDER BY region",
        (category_report_id,),
    ).fetchall()
    conn.close()
    return jsonify({"regions": [r["region"] for r in regions]})


def _get_criteria(conn, position):
    return conn.execute("SELECT * FROM category_criteria WHERE position=?", (position,)).fetchone()


def _tests_value(row):
    """A blank test score means the person didn't take it, not that it
    doesn't count — treated as 0%, same as if they'd scored it, rather
    than excluded from averages and fail-reason checks."""
    return row["tests"] if row["tests"] is not None else 0.0


_PERIOD_LABEL_RE = re.compile(r"(\d+)\s*квартал\s*(\d{4})", re.IGNORECASE)


def _quarter_bounds(year, quarter):
    """[start, end) calendar-date bounds for a "N квартал YYYY" period,
    as ISO date strings — hire_date is stored the same way, so a plain
    string comparison works."""
    start_month = (quarter - 1) * 3 + 1
    start = datetime.date(year, start_month, 1)
    end = datetime.date(year + 1, 1, 1) if start_month == 10 else datetime.date(year, start_month + 3, 1)
    return start.isoformat(), end.isoformat()


def _is_newcomer(row, period_label):
    """Hired during the same quarter this report covers — parsed from the
    report's own "N квартал YYYY" label, not today's date, so past
    quarters' reports keep reporting the newcomer count that was true
    for THAT quarter."""
    if not row["hire_date"]:
        return False
    m = _PERIOD_LABEL_RE.search(period_label or "")
    if not m:
        return False
    quarter, year = int(m.group(1)), int(m.group(2))
    start, end = _quarter_bounds(year, quarter)
    return start <= row["hire_date"] < end


def _effective_category(row, with_approvals):
    """The category that actually counts — the raw calculated one, unless
    "з погодженнями" is on AND the RC's wish for this person was
    confirmed, in which case their requested category wins. Reasons a
    person failed category-1 conditions are reported separately and
    always reflect the raw calculation, regardless of this toggle — an
    approved exception doesn't change what was actually wrong."""
    if with_approvals and row["confirmed"] == "Так" and row["rk_wish"]:
        try:
            return float(row["rk_wish"])
        except (TypeError, ValueError):
            pass
    return row["potential_category"]


_RULE_OPS = {
    ">=": lambda v, t: v >= t, "<=": lambda v, t: v <= t,
    ">": lambda v, t: v > t, "<": lambda v, t: v < t, "==": lambda v, t: v == t,
}


def _rule_passes(rule, metrics, tests_value):
    """A single requirement against one person's data. "Тести" is the
    one metric every position shares (a fixed column); everything else
    is looked up by its exact column header in that row's metrics_json,
    so the same engine works for any position's differently-shaped file.
    A blank/unparseable cell on any metric OTHER than "Тести" passes the
    rule rather than failing it — a blank error count or blank pickup
    speed means "not measured", not "proof something's wrong", so it
    shouldn't count against the person. "Тести" is the one deliberate
    exception: a blank test is explicitly treated as 0% (tests_value is
    never None), per an earlier explicit decision for that metric only."""
    metric_key = rule.get("metric", "")
    if metric_key == "Тести":
        m = {"raw": "" if tests_value is None else str(tests_value), "value": tests_value}
    else:
        m = metrics.get(metric_key) or {"raw": "", "value": None}
    op = rule.get("op")
    if op in ("flagAbsent", "flagPresent"):
        # A numeric cell (e.g. an error COUNT) is "present" when nonzero,
        # not merely non-blank — "0" is a real zero, not a mark. A
        # non-numeric cell (e.g. "Так"/blank) is "present" when non-blank.
        present = (m.get("value") != 0) if m.get("value") is not None else bool(m.get("raw"))
        return (not present) if op == "flagAbsent" else present
    val = m.get("value")
    if val is None:
        return True
    fn = _RULE_OPS.get(op)
    if not fn:
        return True
    try:
        return fn(val, float(rule.get("value")))
    except (TypeError, ValueError):
        return True


def _rule_label(rule):
    return rule.get("label") or rule.get("metric") or ""


def _failed_criteria(row, criteria):
    """Which of the position's category-1 requirements this person's raw
    values fail — only positions with rules configured report anything,
    so an unconfigured position just shows no reasons rather than
    guessing. Each top-level entry in rules_json is either one required
    rule, or an {"or": [...]} group that passes if any member does —
    matching the source files' own "ЧИ" alternative conditions."""
    if not criteria or not criteria["rules_json"]:
        return []
    try:
        rules = json.loads(criteria["rules_json"])
    except (TypeError, ValueError):
        return []
    metrics = {}
    if row["metrics_json"]:
        try:
            metrics = json.loads(row["metrics_json"])
        except (TypeError, ValueError):
            metrics = {}
    tests_value = _tests_value(row)
    failed = []
    for entry in rules:
        if isinstance(entry, dict) and "or" in entry:
            group = entry["or"]
            if not any(_rule_passes(r, metrics, tests_value) for r in group):
                failed.append(" ЧИ ".join(_rule_label(r) for r in group))
        elif not _rule_passes(entry, metrics, tests_value):
            failed.append(_rule_label(entry))
    return failed


@app.get("/api/category-report-summary")
def category_report_summary():
    category_report_id = request.args.get("categoryReportId")
    if not category_report_id:
        return jsonify({"error": "categoryReportId обов'язковий"}), 400
    with_approvals = request.args.get("withApprovals") == "1"
    where, params = _category_report_where(request.args)
    conn = db.get_db()
    report = conn.execute("SELECT period_label FROM category_reports WHERE id=?", (category_report_id,)).fetchone()
    rows = conn.execute(f"SELECT * FROM category_report_details WHERE {where}", params).fetchall()
    conn.close()
    cat1 = sum(1 for r in rows if _effective_category(r, with_approvals) == 1)
    cat2 = sum(1 for r in rows if _effective_category(r, with_approvals) == 2)
    tests = [_tests_value(r) for r in rows]
    period_label = report["period_label"] if report else ""
    newcomers = sum(1 for r in rows if _is_newcomer(r, period_label))
    return jsonify({
        "total": len(rows),
        "avgTests": round(sum(tests) / len(tests), 1) if tests else None,
        "category1": cat1,
        "category2": cat2,
        "newcomers": newcomers,
        "newcomersPct": round(newcomers / len(rows) * 100, 1) if rows else None,
    })


@app.get("/api/category-report-by-region")
def category_report_by_region():
    """Always the full region breakdown (ignores the region filter) plus,
    for people who didn't reach category 1, which specific criteria they
    failed — the "problem zone" signal: a region with a cluster of the
    same failed criterion points at a real, fixable local issue rather
    than scattered individual misses."""
    category_report_id = request.args.get("categoryReportId")
    if not category_report_id:
        return jsonify({"error": "categoryReportId обов'язковий"}), 400
    with_approvals = request.args.get("withApprovals") == "1"
    conn = db.get_db()
    report = conn.execute("SELECT position FROM category_reports WHERE id=?", (category_report_id,)).fetchone()
    if not report:
        conn.close()
        return jsonify({"regions": []})
    criteria = _get_criteria(conn, report["position"])
    rows = conn.execute(
        "SELECT * FROM category_report_details WHERE category_report_id=? AND region != ''",
        (category_report_id,),
    ).fetchall()
    conn.close()

    by_region = {}
    for r in rows:
        b = by_region.setdefault(r["region"], {
            "region": r["region"], "total": 0, "category1": 0, "category2": 0,
            "testsSum": 0.0, "testsCount": 0, "failReasons": {},
        })
        b["total"] += 1
        effective = _effective_category(r, with_approvals)
        if effective == 1:
            b["category1"] += 1
        elif effective == 2:
            b["category2"] += 1
        b["testsSum"] += _tests_value(r)
        b["testsCount"] += 1
        # Reasons always reflect the raw calculation, not the toggle — an
        # approved exception doesn't change what actually failed.
        if r["potential_category"] == 2:
            for reason in _failed_criteria(r, criteria):
                b["failReasons"][reason] = b["failReasons"].get(reason, 0) + 1

    regions = []
    for b in by_region.values():
        regions.append({
            "region": b["region"], "total": b["total"], "category1": b["category1"], "category2": b["category2"],
            "avgTests": round(b["testsSum"] / b["testsCount"], 1) if b["testsCount"] else None,
            "failReasons": sorted(
                [{"reason": k, "count": v} for k, v in b["failReasons"].items()],
                key=lambda x: -x["count"],
            ),
        })
    regions.sort(key=lambda r: -(r["category2"] / r["total"] if r["total"] else 0))
    return jsonify({"regions": regions, "hasCriteria": criteria is not None})


@app.get("/api/category-report-by-store")
def category_report_by_store():
    """Store breakdown within one region — the drill-down opened from a
    "По регіонах" row, same shape as category_report_by_region but
    grouped one level down and scoped to a single region."""
    category_report_id = request.args.get("categoryReportId")
    region = request.args.get("region")
    if not category_report_id or not region:
        return jsonify({"error": "categoryReportId і region обов'язкові"}), 400
    with_approvals = request.args.get("withApprovals") == "1"
    conn = db.get_db()
    report = conn.execute("SELECT position FROM category_reports WHERE id=?", (category_report_id,)).fetchone()
    criteria = _get_criteria(conn, report["position"]) if report else None
    rows = conn.execute(
        "SELECT * FROM category_report_details WHERE category_report_id=? AND region=? AND store != ''",
        (category_report_id, region),
    ).fetchall()
    conn.close()

    by_store = {}
    for r in rows:
        b = by_store.setdefault(r["store"], {
            "store": r["store"], "total": 0, "category1": 0, "category2": 0,
            "testsSum": 0.0, "testsCount": 0,
            "failReasons": {},
        })
        b["total"] += 1
        effective = _effective_category(r, with_approvals)
        if effective == 1:
            b["category1"] += 1
        elif effective == 2:
            b["category2"] += 1
        b["testsSum"] += _tests_value(r)
        b["testsCount"] += 1
        # Reasons always reflect the raw calculation, not the toggle — an
        # approved exception doesn't change what actually failed. Driven
        # entirely by this position's own criteria rules (not fixed
        # columns), same as category_report_by_region — a position with
        # a completely different metric set (e.g. a merchandiser's "%
        # утримання обороту") gets its own correct reasons here, not a
        # storekeeper's unrelated columns.
        if r["potential_category"] == 2:
            for reason in _failed_criteria(r, criteria):
                b["failReasons"][reason] = b["failReasons"].get(reason, 0) + 1

    stores = []
    for b in by_store.values():
        stores.append({
            "store": b["store"], "total": b["total"], "category1": b["category1"], "category2": b["category2"],
            "avgTests": round(b["testsSum"] / b["testsCount"], 1) if b["testsCount"] else None,
            "failReasons": sorted(
                [{"reason": k, "count": v} for k, v in b["failReasons"].items()],
                key=lambda x: -x["count"],
            ),
        })
    stores.sort(key=lambda s: -(s["category2"] / s["total"] if s["total"] else 0))
    return jsonify({"stores": stores, "hasCriteria": criteria is not None})


@app.get("/api/category-report-people")
def category_report_people():
    category_report_id = request.args.get("categoryReportId")
    if not category_report_id:
        return jsonify({"error": "categoryReportId обов'язковий"}), 400
    with_approvals = request.args.get("withApprovals") == "1"
    where, params = _category_report_where(request.args)
    conn = db.get_db()
    report = conn.execute("SELECT position, period_label FROM category_reports WHERE id=?", (category_report_id,)).fetchone()
    criteria = _get_criteria(conn, report["position"]) if report else None
    period_label = report["period_label"] if report else ""
    rows = conn.execute(
        f"SELECT * FROM category_report_details WHERE {where} ORDER BY potential_category DESC, tests ASC",
        params,
    ).fetchall()
    conn.close()
    return jsonify({"people": [{
        "region": r["region"], "store": r["store"], "name": r["name"],
        "prevCategory": r["prev_category"], "potentialCategory": r["potential_category"],
        "effectiveCategory": _effective_category(r, with_approvals),
        "rkWish": r["rk_wish"], "rkComment": r["rk_comment"],
        "tests": _tests_value(r), "processErrors": r["process_errors"],
        "returnsFlag": r["returns_flag"], "unaccountedFlag": r["unaccounted_flag"],
        "pickupSpeedMin": r["pickup_speed_min"], "confirmed": r["confirmed"],
        "failedCriteria": _failed_criteria(r, criteria),
        "hireDate": r["hire_date"], "isNewcomer": _is_newcomer(r, period_label),
    } for r in rows]})


def _raw_metrics(row):
    try:
        return json.loads(row["metrics_json"]) if row["metrics_json"] else {}
    except (TypeError, ValueError):
        return {}


@app.get("/api/category-report-raw")
def category_report_raw():
    """Every row, every raw metric, plus the position's criteria rules —
    the full self-contained payload for the offline HTML export (same
    pattern as the lesson report's /raw endpoint): the exported file
    re-runs the category/fail-reason engine client-side from this, so
    the region/approvals filters keep working fully offline."""
    category_report_id = request.args.get("categoryReportId")
    if not category_report_id:
        return jsonify({"error": "categoryReportId обов'язковий"}), 400
    conn = db.get_db()
    report = conn.execute("SELECT position, period_label FROM category_reports WHERE id=?", (category_report_id,)).fetchone()
    if not report:
        conn.close()
        return jsonify({"error": "Звіт не знайдено"}), 404
    criteria = _get_criteria(conn, report["position"])
    rows = conn.execute(
        "SELECT * FROM category_report_details WHERE category_report_id=? ORDER BY potential_category DESC, tests ASC",
        (category_report_id,),
    ).fetchall()
    conn.close()
    try:
        rules = json.loads(criteria["rules_json"]) if criteria and criteria["rules_json"] else []
    except (TypeError, ValueError):
        rules = []
    return jsonify({
        "position": report["position"], "periodLabel": report["period_label"],
        "criteriaText": criteria["criteria_text"] if criteria else "",
        "rules": rules,
        "people": [{
            "region": r["region"], "store": r["store"], "name": r["name"],
            "prevCategory": r["prev_category"], "potentialCategory": r["potential_category"],
            "rkWish": r["rk_wish"], "rkComment": r["rk_comment"],
            "tests": _tests_value(r), "confirmed": r["confirmed"],
            "hireDate": r["hire_date"], "isNewcomer": _is_newcomer(r, report["period_label"]),
            "metrics": _raw_metrics(r),
        } for r in rows],
    })


@app.get("/api/category-criteria")
def get_category_criteria():
    position = request.args.get("position")
    if not position:
        return jsonify({"error": "position обов'язковий"}), 400
    conn = db.get_db()
    row = _get_criteria(conn, position)
    conn.close()
    if not row:
        return jsonify({"criteria": None})
    try:
        rules = json.loads(row["rules_json"]) if row["rules_json"] else []
    except (TypeError, ValueError):
        rules = []
    return jsonify({"criteria": {"criteriaText": row["criteria_text"], "rules": rules}})


_RULE_OP_SET = {">=", "<=", ">", "<", "==", "flagAbsent", "flagPresent"}


def _clean_rule(r):
    if not isinstance(r, dict):
        return None
    metric = str(r.get("metric", "")).strip()
    op = r.get("op")
    if not metric or op not in _RULE_OP_SET:
        return None
    cleaned = {"metric": metric, "op": op, "label": str(r.get("label", "")).strip() or metric}
    if op not in ("flagAbsent", "flagPresent"):
        try:
            cleaned["value"] = float(r.get("value"))
        except (TypeError, ValueError):
            return None
    return cleaned


def _clean_rules(rules):
    """Validate/normalize a rules_json payload — drops anything malformed
    rather than rejecting the whole save, so one bad row in a big list
    doesn't block saving the rest."""
    cleaned = []
    for entry in (rules or []):
        if isinstance(entry, dict) and "or" in entry:
            group = [g for g in (_clean_rule(r) for r in (entry.get("or") or [])) if g]
            if len(group) >= 2:
                cleaned.append({"or": group})
        else:
            r = _clean_rule(entry)
            if r:
                cleaned.append(r)
    return cleaned


@app.post("/api/category-criteria")
def set_category_criteria():
    data = request.get_json(silent=True) or {}
    position = str(data.get("position", "")).strip()
    criteria_text = str(data.get("criteriaText", "")).strip()
    if not position:
        return jsonify({"error": "position обов'язковий"}), 400
    rules = _clean_rules(data.get("rules"))

    conn = db.get_db()
    conn.execute(
        "INSERT INTO category_criteria (position, criteria_text, rules_json, updated_at) VALUES (?,?,?,?) "
        "ON CONFLICT(position) DO UPDATE SET criteria_text=excluded.criteria_text, "
        "rules_json=excluded.rules_json, updated_at=excluded.updated_at",
        (position, criteria_text, json.dumps(rules, ensure_ascii=False), datetime.datetime.utcnow().isoformat() + "Z"),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.get("/api/category-report-metrics")
def category_report_metrics():
    """Every metric column name seen in this report's uploaded file,
    beyond the handful of universal ones — feeds the criteria editor's
    metric picker so you choose from what the file actually has instead
    of retyping a column header exactly."""
    category_report_id = request.args.get("categoryReportId")
    if not category_report_id:
        return jsonify({"error": "categoryReportId обов'язковий"}), 400
    conn = db.get_db()
    rows = conn.execute(
        "SELECT metrics_json FROM category_report_details WHERE category_report_id=? AND metrics_json IS NOT NULL",
        (category_report_id,),
    ).fetchall()
    conn.close()
    keys = []
    seen = {"Тести"}
    for r in rows:
        try:
            metrics = json.loads(r["metrics_json"])
        except (TypeError, ValueError):
            continue
        for k in metrics:
            if k not in seen:
                seen.add(k)
                keys.append(k)
    return jsonify({"metrics": ["Тести"] + keys})


# ---------- periods / trend ----------

@app.get("/api/periods")
def periods():
    stream_type = request.args.get("streamType")
    stream_key = request.args.get("streamKey")
    if not stream_type or not stream_key:
        return jsonify({"error": "streamType і streamKey обов'язкові"}), 400
    order_sql = (
        "ORDER BY period_year ASC, period_quarter ASC" if stream_type == "aep" else "ORDER BY uploaded_at ASC"
    )
    conn = db.get_db()
    rows = conn.execute(
        f"SELECT id, label, uploaded_at, has_details, totals_json, by_position_json, aep_goal, "
        f"period_year, period_quarter FROM periods "
        f"WHERE stream_type = ? AND stream_key = ? {order_sql}",
        (stream_type, stream_key),
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        totals = json.loads(r["totals_json"])
        if stream_type == "project":
            primary_label, secondary_label = "Середній % тестів", "Середній % ДЗ"
            avg_primary = round(totals["testsSum"] / totals["count"], 2) if totals["count"] else None
            avg_secondary = round(totals["homeworkPercentSum"] / totals["count"], 2) if totals["count"] else None
        elif stream_type == "aep":
            primary_label, secondary_label = "Середній % досягнення цілі", "% тем, що досягли цілі"
            by_topic = json.loads(r["by_position_json"])
            goal = r["aep_goal"] or 100
            topic_pcts = [min(b["completed"] / goal * 100, 200) for b in by_topic.values() if goal]
            avg_primary = round(sum(topic_pcts) / len(topic_pcts), 2) if topic_pcts else None
            reached = sum(1 for b in by_topic.values() if b["completed"] >= goal)
            avg_secondary = round(reached / len(by_topic) * 100, 2) if by_topic else None
        else:
            primary_label, secondary_label = "Середній прогрес, %", "Середня оцінка, %"
            score_count = totals.get("scoreCount", totals["count"])  # fallback for periods saved before scoreCount existed
            avg_primary = round(totals["progressSum"] / totals["count"], 2) if totals["count"] else None
            avg_secondary = round(totals["scoreSum"] / score_count, 2) if score_count else None
        out.append({
            "id": r["id"],
            "label": r["label"],
            "uploadedAt": r["uploaded_at"],
            "hasDetails": bool(r["has_details"]),
            "totals": totals,
            "avgPrimary": avg_primary,
            "avgSecondary": avg_secondary,
            "primaryLabel": primary_label,
            "secondaryLabel": secondary_label,
            "year": r["period_year"],
            "quarter": r["period_quarter"],
        })
    return jsonify({"periods": out})


@app.get("/api/latest")
def latest():
    stream_type = request.args.get("streamType")
    stream_key = request.args.get("streamKey")
    if not stream_type or not stream_key:
        return jsonify({"error": "streamType і streamKey обов'язкові"}), 400
    conn = db.get_db()
    row = _resolve_period(conn, stream_type, stream_key, request.args.get("periodId"))
    if not row:
        conn.close()
        return jsonify({"period": None})

    filters_rows = conn.execute(
        "SELECT DISTINCT region, store, position FROM details WHERE period_id = ?",
        (row["id"],),
    ).fetchall()
    conn.close()

    regions = sorted({r["region"] for r in filters_rows if r["region"]})
    positions = sorted({r["position"] for r in filters_rows if r["position"]})
    stores_by_region = {}
    for r in filters_rows:
        if r["store"]:
            stores_by_region.setdefault(r["region"], set()).add(r["store"])
    stores_by_region = {k: sorted(v) for k, v in stores_by_region.items()}

    return jsonify({
        "period": {
            "id": row["id"],
            "label": row["label"],
            "uploadedAt": row["uploaded_at"],
        },
        "filters": {
            "regions": regions,
            "positions": positions,
            "storesByRegion": stores_by_region,
        },
    })


# ---------- shared filtering (summary + employee table both work off a chosen period's detail rows) ----------

def _resolve_period(conn, stream_type, stream_key, period_id):
    """A specific period by id (validated to belong to this stream), or the
    current one for this stream if no id was given. For AEP, "current" means
    chronologically latest quarter (period_year/period_quarter) — re-uploading
    the growing master file to fix an older quarter shouldn't change which
    quarter is "current". Everything else uses most-recently-uploaded."""
    if period_id:
        return conn.execute(
            "SELECT * FROM periods WHERE id = ? AND stream_type = ? AND stream_key = ?",
            (period_id, stream_type, stream_key),
        ).fetchone()
    if stream_type == "aep":
        return conn.execute(
            "SELECT * FROM periods WHERE stream_type = ? AND stream_key = ? "
            "ORDER BY period_year DESC, period_quarter DESC, id DESC LIMIT 1",
            (stream_type, stream_key),
        ).fetchone()
    return conn.execute(
        "SELECT * FROM periods WHERE stream_type = ? AND stream_key = ? ORDER BY id DESC LIMIT 1",
        (stream_type, stream_key),
    ).fetchone()


def _build_where(conn, period_id, args):
    where = ["period_id = ?"]
    params = [period_id]

    region = args.get("region")
    store = args.get("store")
    position = args.get("position")
    segment = args.get("segment")  # front|back|all
    first_line = args.get("firstLine")  # all|only|exclude

    if region:
        where.append("region = ?")
        params.append(region)
    if store:
        where.append("store = ?")
        params.append(store)
    if position:
        where.append("position = ?")
        params.append(position)

    if segment in ("front", "back"):
        positions = conn.execute(
            "SELECT position FROM positions_config WHERE segment = ?", (segment,)
        ).fetchall()
        pos_list = [p["position"] for p in positions]
        if pos_list:
            where.append(f"position IN ({','.join('?' for _ in pos_list)})")
            params.extend(pos_list)
        else:
            where.append("1 = 0")

    if first_line in ("only", "exclude"):
        fl_positions = conn.execute(
            "SELECT position FROM positions_config WHERE first_line = 1"
        ).fetchall()
        fl_list = [p["position"] for p in fl_positions] or ["__none__"]
        placeholders = ",".join("?" for _ in fl_list)
        if first_line == "only":
            where.append(f"position IN ({placeholders})")
        else:
            where.append(f"position NOT IN ({placeholders})")
        params.extend(fl_list)

    return " AND ".join(where), params


# ---------- filtered summary (KPIs + charts, reacts to the current filter set) ----------

@app.get("/api/summary")
def summary():
    stream_type = request.args.get("streamType")
    stream_key = request.args.get("streamKey")
    if not stream_type or not stream_key:
        return jsonify({"error": "streamType і streamKey обов'язкові"}), 400

    conn = db.get_db()
    period = _resolve_period(conn, stream_type, stream_key, request.args.get("periodId"))
    if not period:
        conn.close()
        return jsonify({"period": None})

    is_project = period["stream_type"] == "project"
    is_aep = period["stream_type"] == "aep"
    columns = (
        "region, store, position, name, tests_percent, homework_score, homework_max, homework_percent, "
        "tests_assigned_count, tests_completed_count"
        if is_project else
        "region, store, position, name, assigned, completed, progress, score, event_date, actual_entered"
        if is_aep else
        "region, store, position, name, assigned, completed, progress, score"
    )
    where_sql, params = _build_where(conn, period["id"], request.args)
    rows = conn.execute(f"SELECT {columns} FROM details WHERE {where_sql}", params).fetchall()
    conn.close()

    rows = [db.row_to_dict(r) for r in rows]
    if is_project:
        rows = [{
            **r, "testsPercent": r["tests_percent"], "homeworkScore": r["homework_score"],
            "homeworkMax": r["homework_max"], "homeworkPercent": r["homework_percent"],
            "testsAssignedCount": r["tests_assigned_count"], "testsCompletedCount": r["tests_completed_count"],
        } for r in rows]
        totals, by_region, by_store, by_position = aggregate_project(rows)
        dist = distribution_project(rows)
    elif is_aep:
        rows = [{**r, "date": r["event_date"], "held": bool(r["actual_entered"])} for r in rows]
        totals, by_region, by_store, by_position = aggregate_aep(rows)
        dist = distribution_aep(rows)
    else:
        totals, by_region, by_store, by_position = aggregate(rows)
        dist = distribution(rows)

    response = {
        "periodId": period["id"],
        "totals": totals,
        "byRegion": by_region,
        "byStore": by_store,
        "byPosition": by_position,
        "distribution": dist,
        "rowCount": len(rows),
    }
    if period["stream_type"] == "aep":
        response["aepGoal"] = period["aep_goal"] or 100
    return jsonify(response)


# ---------- employee detail table ----------

DETAIL_SORT_COLUMNS = {
    "region": "region", "store": "store", "position": "position", "name": "name",
    "assigned": "assigned", "completed": "completed", "progress": "progress", "score": "score",
    "testsPercent": "tests_percent", "homeworkScore": "homework_score",
    "homeworkMax": "homework_max", "homeworkPercent": "homework_percent",
    "testsAssignedCount": "tests_assigned_count", "testsCompletedCount": "tests_completed_count",
}


@app.get("/api/details")
def details():
    stream_type = request.args.get("streamType")
    stream_key = request.args.get("streamKey")
    if not stream_type or not stream_key:
        return jsonify({"error": "streamType і streamKey обов'язкові"}), 400

    conn = db.get_db()
    period = _resolve_period(conn, stream_type, stream_key, request.args.get("periodId"))
    if not period:
        conn.close()
        return jsonify({"rows": [], "total": 0, "shown": 0})

    is_project = period["stream_type"] == "project"
    default_sort = "testsPercent" if is_project else "progress"
    columns = (
        "region, store, position, name, tests_percent, homework_score, homework_max, homework_percent, "
        "tests_assigned_count, tests_completed_count"
        if is_project else
        "region, store, position, name, assigned, completed, progress, score"
    )

    where_sql, params = _build_where(conn, period["id"], request.args)

    search = request.args.get("search")
    if search:
        where_sql += " AND name LIKE ?"
        params = params + [f"%{search}%"]

    sort = request.args.get("sort", default_sort)
    sort_col = DETAIL_SORT_COLUMNS.get(sort, default_sort)
    direction = "DESC" if request.args.get("dir", "asc") == "desc" else "ASC"
    limit = min(int(request.args.get("limit", 400) or 400), 1000)

    total = conn.execute(f"SELECT COUNT(*) c FROM details WHERE {where_sql}", params).fetchone()["c"]
    rows = conn.execute(
        f"SELECT {columns} FROM details WHERE {where_sql} ORDER BY {sort_col} {direction} LIMIT ?",
        params + [limit],
    ).fetchall()
    conn.close()

    rows = [db.row_to_dict(r) for r in rows]
    if is_project:
        rows = [{
            "region": r["region"], "store": r["store"], "position": r["position"], "name": r["name"],
            "testsPercent": r["tests_percent"], "homeworkScore": r["homework_score"],
            "homeworkMax": r["homework_max"], "homeworkPercent": r["homework_percent"],
            "testsAssignedCount": r["tests_assigned_count"], "testsCompletedCount": r["tests_completed_count"],
        } for r in rows]

    return jsonify({"rows": rows, "total": total, "shown": len(rows)})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    print(f"Пароль для входу: {SECRETS['password']}")
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("FLASK_DEBUG") == "1")
