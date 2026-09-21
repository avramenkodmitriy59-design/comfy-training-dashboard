import os
import json
import secrets
import hmac
import datetime

from flask import Flask, request, session, jsonify, send_from_directory

import db
from aggregate import (
    aggregate, clean_row, detect_attestation_stream, distribution, ATTESTATION_STREAMS,
    aggregate_project, clean_project_row, distribution_project,
    clean_aep_row, aep_goal_for_quarter, aggregate_aep, distribution_aep,
    normalize_person_name, normalize_roster_tier, build_roster_matcher, find_near_duplicate_names,
    suggest_name_matches, find_roster_duplicate_rows,
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
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
)

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
    total_sessions = conn.execute(
        # Counts distinct TRAININGS (event_name), not slots — one topic held
        # across several date/time slots (see "Слоти" in the topics table)
        # is one training either way, whichever slot someone attends.
        "SELECT COUNT(DISTINCT event_name) AS c FROM aep_attendance "
        "WHERE period_year=? AND period_quarter=?",
        (year, quarter),
    ).fetchone()["c"]
    roster = conn.execute("SELECT id, name, name_norm, store, tier FROM aep_roster").fetchall()
    aliases = load_aep_aliases(conn)
    checked_rows = conn.execute(
        "SELECT DISTINCT name_norm, event_name FROM aep_attendance "
        "WHERE period_year=? AND period_quarter=? AND status='CHECKED_IN'",
        (year, quarter),
    ).fetchall()
    conn.close()

    if not total_sessions or not roster:
        return jsonify({"people": [], "totalSessions": total_sessions})

    # Resolve each attendee to their best-matching roster row (exact >
    # nickname-folded > fuzzy typo) against the FULL roster, then count
    # distinct TRAININGS (event_name, not event_name+date — see
    # total_sessions above) per roster row id — this way a near-duplicate
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
        matched = matcher(r["name_norm"])
        if not matched:
            continue
        checked_by_roster_id.setdefault(matched["id"], set()).add(r["event_name"])

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
    suggestions = suggest_name_matches(unmatched, roster)
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
