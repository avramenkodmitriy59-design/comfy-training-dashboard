import os
import json
import re
import secrets
import hmac
import hashlib
import datetime
import gzip
import time
import threading

from flask import Flask, request, session, jsonify, send_from_directory, g
from werkzeug.utils import redirect

import db
from paths import STATIC_DIR, DATA_DIR
import kpi
import reserve
from feed_sync import (
    FeedClient, FeedError, fetch_attestation_reports, fetch_overall_report, fetch_sellers_report, fetch_trainees,
    trainee_success, dismissed_during_internship, trainee_failure_reasons, TRAINEE_TYPE_LABELS,
    relative_quarter_period, allowed_regions as feed_allowed_regions,
)
from aggregate import (
    aggregate, clean_row, detect_attestation_stream, distribution, ATTESTATION_STREAMS,
    aggregate_project, clean_project_row, distribution_project,
    clean_aep_row, aep_goal_for_quarter, aggregate_aep, distribution_aep,
    normalize_person_name, normalize_roster_tier, build_roster_matcher, find_near_duplicate_names,
    suggest_name_matches, find_roster_duplicate_rows, clean_category_report_row,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTANCE_DIR = DATA_DIR
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

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
app.secret_key = SECRETS["flask_secret_key"]
app.json.sort_keys = False  # preserve insertion order (e.g. distribution buckets lt40..gte90)
# The app is also served from this subpath (https://host/retail-lnd/). Requests
# with the prefix are stripped here, so it works both when a reverse proxy keeps
# the prefix and when it strips it; the root URL keeps working too.
# Override with the URL_PREFIX env var (empty value disables the prefix).
URL_PREFIX = os.environ.get("URL_PREFIX", "/retail-lnd").rstrip("/")
print(f"static dir: {STATIC_DIR} | data dir: {DATA_DIR} | url prefix: {URL_PREFIX!r}", flush=True)
app.config.update(
    # unique name so the cookie doesn't clash with other apps on the same host
    SESSION_COOKIE_NAME="comfy_training_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # one working day from sign-in (not extended by activity): the password is
    # asked daily, so access rules and the Feed auto-sync run on every new day
    PERMANENT_SESSION_LIFETIME=datetime.timedelta(hours=12),
    SESSION_REFRESH_EACH_REQUEST=False,
)
SESSION_HOURS = 12

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
# Two ways in: the Feed login (everyone; the role comes from the access rules
# matched against the Feed profile — department, position) and the old site
# password (admin only, a spare way in when Feed is down). Sessions from
# before the roles existed count as admin.

ROLES = ("admin", "hr")
# HR: the reports of «Все навчання», «Атестація», «Стажери», «Кадровий резерв»
# (read) + work with potentials (PUT /api/reserve-status, checked inside)
HR_GET = {
    "/api/session", "/api/config", "/api/streams", "/api/periods", "/api/latest", "/api/summary",
    "/api/topics", "/api/details", "/api/trainees", "/api/reserve", "/api/employees/search",
    "/api/feed-auto",
}
HR_WRITE = {("PUT", "/api/reserve-status"), ("PUT", "/api/reserve-note"), ("POST", "/api/logout")}
FAILED_LOGINS = {}  # login -> [timestamps] (simple brute-force brake)
LOGIN_TRIES, LOGIN_WINDOW = 8, 15 * 60


# who may set up access («👥 Доступ»): only these Feed logins, never the shared
# site password. Kept as sha256 of the lower-case login so the repo holds no
# names; ACCESS_OWNERS (comma-separated logins) adds more without a release.
ACCESS_OWNER_HASHES = {"13d06fdf10c7d033a2a36369801d6f0b5c0219a666c58f74f1fc6c7bdd1654a3"}


def is_access_owner():
    login = str((session.get("user") or {}).get("login") or "").strip().lower()
    if not login or current_role() != "admin":
        return False
    extra = {x.strip().lower() for x in os.environ.get("ACCESS_OWNERS", "").split(",") if x.strip()}
    return login in extra or hashlib.sha256(login.encode("utf-8")).hexdigest() in ACCESS_OWNER_HASHES


def is_authenticated():
    # a session from before the Feed login (no role in it) no longer counts:
    # everyone signs in again — through Feed or the spare site password
    # the 12 h are checked here too, not only by the cookie's expiry
    try:
        fresh = (time.time() - float(session.get("at") or 0)) < SESSION_HOURS * 3600
    except (TypeError, ValueError):
        fresh = False
    return bool(session.get("authenticated")) and session.get("role") in ROLES and fresh


def current_role():
    if not is_authenticated():
        return None
    return session.get("role")


def current_user_label():
    u = session.get("user") or {}
    return u.get("short") or u.get("fio") or ("адмін (пароль)" if current_role() == "admin" else "")


# ---- the regional team's regions (from Feed at sign-in, see login) ----
def region_key(name):
    """One key for a region across sources: Feed / LMS write «Київський
    Правий», the store reference «Київ Правобережний»."""
    k = " ".join(str(name or "").lower().replace("регіон", "").split())
    return {"київський правий": "київ правобережний", "київський лівий": "київ лівобережний"}.get(k, k)


def user_regions():
    """Region keys the regional team member is limited to, or None (admins,
    or nothing known — the whole network)."""
    if current_role() != "hr":
        return None
    regs = (session.get("user") or {}).get("regions")
    return {region_key(x) for x in regs} if regs else None


def region_allowed(name):
    keys = user_regions()
    return keys is None or region_key(name) in keys


def hr_allowed(method, path):
    if method == "GET":
        return path in HR_GET
    return (method, path) in HR_WRITE


@app.before_request
def require_auth():
    path = request.path
    if path.startswith("/api/login") or path.startswith("/api/session"):
        return None
    if path.startswith("/static/") or path == "/" or path == "/favicon.ico":
        return None
    if path.startswith("/api/"):
        role = current_role()
        if not role:
            return jsonify({"error": "unauthorized"}), 401
        if role == "hr" and not hr_allowed(request.method, path):
            return jsonify({"error": "Немає доступу"}), 403
        if path.startswith("/api/access") and not is_access_owner():
            return jsonify({"error": "Налаштовувати доступ може лише власник дашборда"}), 403
        if path.startswith("/api/kpi") and not is_access_owner():  # KPI: owner only for now
            return jsonify({"error": "Немає доступу"}), 403
    return None


# fixed order, no priorities to set: a personal «Без доступу» beats any role,
# then the highest role wins (Адмін before Регіональна команда)
ROLE_ORDER = "CASE role WHEN 'none' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END"


def _access_for(conn, prof):
    """The strongest access rule the Feed profile matches -> (role, label)."""
    for r in conn.execute(f"SELECT * FROM access_rules ORDER BY {ROLE_ORDER}, id"):
        have = str(prof.get(r["field"]) or "").strip().lower()
        want = str(r["value"] or "").strip().lower()
        if want and (have == want if r["op"] == "equals" else want in have):
            return r["role"], r["label"] or r["value"]
    return None, None


def _now():
    return datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z"


def audit(section, action, details=None, who=None, conn=None):
    """One line in «Журнал». who — a Feed profile / session user; by default
    whoever is logged in (the site-password login has no name)."""
    u = who if who is not None else (session.get("user") or {})
    fio = u.get("fio") or (None if u.get("login") else "Адмін (пароль сайту)")
    own = conn is None
    conn = conn or db.get_db()
    try:
        conn.execute(
            "INSERT INTO audit_log (at, login, tab, fio, position, mag, reg, section, action, details) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (_now(), u.get("login"), u.get("tab"), fio, u.get("position"), u.get("mag"), u.get("reg"),
             section, action, (str(details)[:1000] if details else None)))
        conn.commit()
    finally:
        if own:
            conn.close()


def _log_login(conn, prof, role, result):
    if role:
        audit("Вхід", "Вхід", f"{ACCESS_ROLE_NAMES.get(role, role)} · {result or ''}", who=prof, conn=conn)
    else:
        audit("Вхід", "Немає доступу", result, who=prof, conn=conn)


ACCESS_ROLE_NAMES = {"admin": "Адмін", "hr": "Регіональна команда", "none": "Без доступу"}


@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}
    password = str(data.get("password", ""))
    feed_login = str(data.get("login") or "").strip()
    if not feed_login:  # the old site password: admin only
        if hmac.compare_digest(password.encode("utf-8"), SECRETS["password"].encode("utf-8")):
            session.clear()
            session.update(authenticated=True, role="admin", user=None, at=time.time())
            session.permanent = True
            audit("Вхід", "Вхід", "Адмін · пароль сайту", who={})
            return jsonify({"ok": True, "role": "admin"})
        audit("Вхід", "Невдала спроба", "пароль сайту", who={})
        return jsonify({"ok": False, "error": "Невірний пароль"}), 401

    now = datetime.datetime.utcnow().timestamp()
    key = feed_login.lower()
    tries = [t for t in FAILED_LOGINS.get(key, []) if now - t < LOGIN_WINDOW]
    if len(tries) >= LOGIN_TRIES:
        return jsonify({"ok": False, "error": "Забагато невдалих спроб. Спробуйте за 15 хвилин"}), 429
    try:
        client = FeedClient()
        client.login(feed_login, password)  # the password goes to Feed only, never stored
        prof = client.profile()
    except FeedError as e:
        FAILED_LOGINS[key] = tries + [now]
        audit("Вхід", "Невдала спроба", str(e)[:200], who={"login": feed_login, "fio": feed_login})
        return jsonify({"ok": False, "error": str(e)}), 401
    FAILED_LOGINS.pop(key, None)
    conn = db.get_db()
    role, label = _access_for(conn, prof)
    if prof.get("blocked"):
        role = None
    if role not in ROLES:
        _log_login(conn, prof, None, "немає доступу")
        conn.close()
        return jsonify({"ok": False, "error": "Немає доступу до дашборда. Зверніться до Відділу навчання роздрібу"}), 403
    regions = None
    if role == "hr":
        # the regions Feed lets this person see; all of them (or none
        # known) — no limit, e.g. the central office
        try:
            regions = feed_allowed_regions(client)
        except FeedError:
            regions = None
        n_all = conn.execute("SELECT COUNT(DISTINCT region) AS n FROM store_regions").fetchone()["n"] or 9
        if not regions or len({region_key(x) for x in regions}) >= n_all:
            regions = None
    _log_login(conn, prof, role, (label or "") + (f" · регіони: {', '.join(regions)}" if regions else ""))
    conn.close()
    session.clear()
    session.update(authenticated=True, role=role, at=time.time(),
                   user={**{k: prof.get(k) for k in ("login", "tab", "fio", "short", "position", "mag")}, "regions": regions})
    session.permanent = True
    started = maybe_start_feed_auto(client, {**{k: prof.get(k) for k in ("login", "tab", "fio", "position", "mag", "reg")}, "role": role})
    return jsonify({"ok": True, "role": role, "feedAuto": started})


@app.post("/api/logout")
def logout():
    if session.get("authenticated"):
        audit("Вхід", "Вихід")
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/session")
def session_status():
    return jsonify({"authenticated": is_authenticated(), "role": current_role(), "user": session.get("user"),
                    "accessOwner": is_access_owner()})


# access rules and the login log («Доступ», admin only — HR never reaches here)
ACCESS_FIELDS = ("mag", "reg", "position", "tab", "login")


@app.get("/api/access")
def access_get():
    conn = db.get_db()
    rules = [dict(r) for r in conn.execute(f"SELECT * FROM access_rules ORDER BY {ROLE_ORDER}, id")]
    conn.close()
    return jsonify({"rules": rules})


@app.get("/api/access-audit")
def access_audit():
    """«Журнал»: the last 500 entries for the filters (person, section, days)
    plus everyone who appears in the log, for the person filter."""
    who, section = request.args.get("who") or "", request.args.get("section") or ""
    days = request.args.get("days", type=int)
    where, params = [], []
    if who:
        where.append("COALESCE(login, fio) = ?"); params.append(who)
    if section:
        where.append("section = ?"); params.append(section)
    if days:
        since = datetime.datetime.utcnow() - datetime.timedelta(days=days)
        where.append("at >= ?"); params.append(since.isoformat(timespec="seconds") + "Z")
    conn = db.get_db()
    rows = [dict(r) for r in conn.execute(
        f"SELECT * FROM audit_log {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY id DESC LIMIT 500", params)]
    for row in rows:  # the 0.0.17 probe rows: keep only what matters — the regions
        if row["action"] == "Регіони у Feed":
            m = re.search(r"structure \(\d+\): ([^;]*)", row["details"] or "")
            row["action"], row["details"] = "Регіони", (m.group(1).strip() if m else "Feed не повернув переліку регіонів")
    people = [dict(r) for r in conn.execute(
        "SELECT COALESCE(login, fio) AS key, MAX(fio) AS fio, MAX(position) AS position, COUNT(*) AS n "
        "FROM audit_log GROUP BY COALESCE(login, fio) ORDER BY MAX(fio)")]
    sections = [r[0] for r in conn.execute("SELECT DISTINCT section FROM audit_log ORDER BY section")]
    conn.close()
    return jsonify({"rows": rows, "people": people, "sections": sections})


@app.post("/api/access-rules")
def access_rule_save():
    d = request.get_json(silent=True) or {}
    role, field, op = d.get("role"), d.get("field"), d.get("op") or "contains"
    value = str(d.get("value") or "").strip()
    if role not in ROLES + ("none",) or field not in ACCESS_FIELDS or op not in ("contains", "equals") or not value:
        return jsonify({"error": "Заповніть роль, поле й значення"}), 400
    conn = db.get_db()
    args = (role, field, op, value, str(d.get("label") or "").strip() or None)
    if d.get("id"):
        conn.execute("UPDATE access_rules SET role=?, field=?, op=?, value=?, label=? WHERE id=?", args + (int(d["id"]),))
    else:
        conn.execute("INSERT INTO access_rules (role, field, op, value, label) VALUES (?,?,?,?,?)", args)
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.delete("/api/access-rules/<int:rule_id>")
def access_rule_delete(rule_id):
    conn = db.get_db()
    conn.execute("DELETE FROM access_rules WHERE id = ?", (rule_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- «Журнал»: what each change on the dashboard did ----------
# One describer per write endpoint: (section, action, details) from the
# request (and the response / what was there before). Only successful
# requests are logged; login, logout and Feed auto-sync log themselves.

RESERVE_FOR = {"LH1": "на Заступника", "LH2": "на Директора", "TZ": "на Товарознавця"}
PROG_NAME = {"LH1": "LH 1.0", "LH2": "LH 2.0", "TZ": "LH БЕК"}


def _person(conn, pid):
    pid = str(pid or "")
    if pid.startswith("p") and pid[1:].isdigit():
        r = conn.execute("SELECT name, store FROM lh_participants WHERE id = ?", (int(pid[1:]),)).fetchone()
    else:
        r = conn.execute("SELECT name, store FROM employee_history WHERE tab = ? ORDER BY date_start DESC LIMIT 1",
                         (pid,)).fetchone()
    return f"{r['name']}{', ' + r['store'] if r['store'] else ''}" if r else pid


def _audit_before():
    """What is there before a change — for «з якого на який»."""
    ep, d, va = request.endpoint, request.get_json(silent=True) or {}, request.view_args or {}
    conn = db.get_db()
    try:
        if ep == "reserve_status_set":
            prog = str(d.get("program")) if str(d.get("program")) in RESERVE_FOR else "LH1"
            old = conn.execute("SELECT status, note FROM reserve_status WHERE pid = ? AND program = ?",
                               (str(d.get("pid") or ""), prog)).fetchone()
            return {"who": _person(conn, d.get("pid")), "old": old["status"] if old else "",
                    "oldNote": (old["note"] or "") if old else ""}
        if ep == "admin_note_set":
            prog = reserve.program_code(d.get("program"))
            old = conn.execute("SELECT note FROM admin_notes WHERE key = ?",
                               (f"{d.get('pid')}|{prog}|{d.get('year')}",)).fetchone()
            return {"who": _person(conn, d.get("pid")), "old": old["note"] if old else ""}
        if ep == "reserve_note_set":
            prog = reserve.program_code(d.get("program"))
            old = conn.execute("SELECT note FROM reserve_notes WHERE pid = ? AND program = ?",
                               (str(d.get("pid") or ""), prog)).fetchone()
            return {"who": _person(conn, d.get("pid")), "old": old["note"] if old else ""}
        if ep in ("lh_participant_update", "lh_participant_delete"):
            r = conn.execute("SELECT * FROM lh_participants WHERE id = ?", (va.get("pid"),)).fetchone()
            return dict(r) if r else {}
        if ep == "access_rule_delete":
            r = conn.execute("SELECT * FROM access_rules WHERE id = ?", (va.get("rule_id"),)).fetchone()
            return dict(r) if r else {}
    finally:
        conn.close()
    return {}


def _audit_reserve(d, b, resp):
    prog = str(d.get("program")) if str(d.get("program")) in RESERVE_FOR else "LH1"
    new, old = (d.get("status") or "").strip(), b.get("old") or ""
    note = (d.get("note") or "").strip()
    if new == "Потенційний" and old != "Потенційний":
        action = "Додав у потенційні"
    elif new == old == "Потенційний":
        action = "Змінив коментар" if note != b.get("oldNote") else "✓ Залишив у потенційних"
    elif not new:
        action = "Прибрав з потенційних" if old == "Потенційний" else "Скинув ручний статус"
    elif new == "Не в резерві":
        action = "✕ Прибрав з потенційних"
    else:
        action = "Змінив статус"
    det = f"{b.get('who')} · {RESERVE_FOR[prog]}"
    if action in ("Змінив статус", "Скинув ручний статус"):
        det += f" · {old or 'авто'} → {new or 'авто'}"
    if note and note != b.get("oldNote"):
        det += f" · «{note}»"
    return "Кадровий резерв", action, det


def _audit_lh_update(d, b, resp):
    who = f"{b.get('name', '')} · {PROG_NAME.get(b.get('program'), b.get('program'))} {b.get('year', '')}"
    if "status" in d:
        return "Налаштування LH", "Змінив статус учасника", f"{who} · {b.get('status') or '—'} → {d['status']}"
    return "Налаштування LH", "Змінив модуль 1", f"{who} · {'пройшов' if d.get('passed1') else 'не пройшов'}"


def _upload_name(d):
    t = d.get("streamType")
    return {"overall": "Все навчання", "attestation": "Атестація", "project": f"Проєкт «{d.get('projectName', '')}»"}.get(t, t)


AUDIT = {
    "upload": lambda d, b, r: ("Завантаження", "Завантажив звіт",
        f"{_upload_name(d)}{' · ' + r.get('streamKey') if d.get('streamType') == 'attestation' else ''} · {d.get('label', '')} · {r.get('rowsCount', 0)} рядків"),
    "upload_employee_history": lambda d, b, r: ("Завантаження", "Завантажив «Історію працівника»", f"{r.get('total', '')} рядків")
        if int(d.get("part") or 0) >= int(d.get("parts") or 1) - 1 else None,
    "upload_lh_participants": lambda d, b, r: ("Завантаження", "Завантажив учасників Leader Hub",
        f"{r.get('participants')} учасників, {r.get('stores')} магазинів"),
    "upload_aep": lambda d, b, r: ("Завантаження", "Завантажив звіт AEP", None),
    "upload_aep_roster": lambda d, b, r: ("Завантаження", "Завантажив ростер AEP", None),
    "upload_category_report": lambda d, b, r: ("Завантаження", "Завантажив звіт категорій",
        f"{d.get('position', '')} · {d.get('periodLabel', '')} · {r.get('rowsCount', 0)} рядків"),
    "reserve_status_set": _audit_reserve,
    "admin_note_set": lambda d, b, r: ("Налаштування LH",
        "Видалив адмін-коментар" if not (d.get("note") or "").strip() else "Змінив адмін-коментар" if b.get("old") else "Додав адмін-коментар",
        f"{b.get('who')} · {PROG_NAME.get(reserve.program_code(d.get('program')), '')} {d.get('year', '')}"
        + (f" · «{(d.get('note') or '').strip()}»" if (d.get("note") or "").strip() else "")),
    "reserve_note_set": lambda d, b, r: ("Кадровий резерв",
        "Видалив коментар" if not (d.get("note") or "").strip() else "Змінив коментар" if b.get("old") else "Додав коментар",
        f"{b.get('who')} · {RESERVE_FOR.get(reserve.program_code(d.get('program')), '')}"
        + (f" · «{(d.get('note') or '').strip()}»" if (d.get("note") or "").strip() else "")),
    "lh_stream_create": lambda d, b, r: ("Налаштування LH", "Зберіг потік",
        f"{PROG_NAME.get(d.get('program'), d.get('program'))} {d.get('year')} · {d.get('dateStart') or '—'} – {d.get('dateEnd') or '—'}"),
    "lh_stream_delete": lambda d, b, r: ("Налаштування LH", "Видалив потік",
        f"{PROG_NAME.get(request.view_args.get('program'), request.view_args.get('program'))} {request.view_args.get('year')}"),
    "lh_participant_add": lambda d, b, r: ("Налаштування LH", "Додав учасника",
        f"{d.get('name', '')} · {PROG_NAME.get(d.get('program'), d.get('program'))} {d.get('year', '')}"),
    "lh_participant_update": _audit_lh_update,
    "lh_participant_delete": lambda d, b, r: ("Налаштування LH", "Видалив учасника",
        f"{b.get('name', '')} · {PROG_NAME.get(b.get('program'), b.get('program'))} {b.get('year', '')}"),
    "set_position_config": lambda d, b, r: ("Налаштування", "Класифікував посаду",
        f"{d.get('position', '')} · {d.get('segment') or ''}{' · перша лінія' if d.get('firstLine') else ''}"),
    "kpi_manual_save": lambda d, b, r: ("KPI", "Вніс значення KPI", f"{d.get('kpi', '')} · {d.get('period', '')}"),
    "set_category_criteria": lambda d, b, r: ("Налаштування", "Змінив критерії категорій", d.get("position")),
    "create_aep_name_alias": lambda d, b, r: ("AEP", "Об'єднав імена", None),
    "delete_aep_name_alias": lambda d, b, r: ("AEP", "Скасував об'єднання імен", None),
    "create_aep_name_dismissal": lambda d, b, r: ("AEP", "Відхилив підказку імені", None),
    "delete_aep_name_dismissal": lambda d, b, r: ("AEP", "Повернув підказку імені", None),
    "dedupe_aep_roster": lambda d, b, r: ("AEP", "Прибрав дубль у ростері", None),
    "dismiss_aep_roster_dup": lambda d, b, r: ("AEP", "Позначив «не дубль»", f"{d.get('nameA', '')} / {d.get('nameB', '')}"),
    "undo_aep_roster_dup_dismiss": lambda d, b, r: ("AEP", "Скасував «не дубль»", None),
    "access_rule_save": lambda d, b, r: ("Доступ", "Змінив правило" if d.get("id") else "Додав правило",
        f"{ACCESS_ROLE_NAMES.get(d.get('role'), d.get('role'))} · {d.get('field')} {d.get('op') or 'contains'} «{d.get('value', '')}»"),
    "access_rule_delete": lambda d, b, r: ("Доступ", "Видалив правило",
        f"{ACCESS_ROLE_NAMES.get(b.get('role'), b.get('role'))} · {b.get('field')} {b.get('op')} «{b.get('value', '')}»"),
}


@app.before_request
def audit_capture():
    if request.method != "GET" and request.endpoint in AUDIT and current_role():
        try:
            g.audit_before = _audit_before()
        except Exception:  # noqa: BLE001 — the log never blocks the change
            g.audit_before = {}


@app.after_request
def bump_on_write(resp):
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and resp.status_code < 400 \
            and request.path.startswith("/api/") and not request.path.startswith(("/api/login", "/api/logout")):
        try:
            _bump_data_ver()
        except Exception as e:  # noqa: BLE001
            app.logger.warning("data_ver bump failed: %s", e)
    return resp


@app.after_request
def gzip_json(resp):
    """Big JSON (the reserve dataset is ~1.2 MB) goes gzipped: ~6x smaller."""
    if (resp.status_code < 300 and resp.mimetype == "application/json" and not resp.direct_passthrough
            and "gzip" in (request.headers.get("Accept-Encoding") or "").lower()
            and "Content-Encoding" not in resp.headers):
        body = resp.get_data()
        if len(body) > 2048:
            resp.set_data(gzip.compress(body, compresslevel=5))
            resp.headers["Content-Encoding"] = "gzip"
            resp.headers["Content-Length"] = str(len(resp.get_data()))
            resp.vary.add("Accept-Encoding")
    return resp


@app.after_request
def audit_write(resp):
    fn = AUDIT.get(request.endpoint)
    if fn and request.method != "GET" and resp.status_code < 400 and current_role():
        try:
            out = fn(request.get_json(silent=True) or {}, getattr(g, "audit_before", {}),
                     (resp.get_json(silent=True) if resp.is_json else None) or {})
            if out:
                audit(*out)
        except Exception as e:  # noqa: BLE001
            app.logger.warning("audit failed for %s: %s", request.endpoint, e)
    return resp


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

class UploadError(ValueError):
    """Validation failure in save_lms_period — message is shown to the user."""


@app.post("/api/upload")
def upload():
    data = request.get_json(silent=True) or {}
    try:
        result = save_lms_period(
            data.get("streamType"), str(data.get("label", "")).strip(),
            data.get("rows") or [], str(data.get("projectName", "")).strip(),
        )
    except UploadError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, **result})


def save_lms_period(stream_type, label, raw_rows, project_name=""):
    """Validate, aggregate and store one LMS report period — shared by the
    manual .xls upload and the Feed sync (see /api/feed-sync), so both go
    through exactly the same cleaning and replace-same-label rules."""
    if stream_type not in ("overall", "attestation", "project"):
        raise UploadError("Невідомий тип звіту")
    if not label:
        raise UploadError("Вкажіть період (наприклад: Вересень 2026)")
    if not raw_rows:
        raise UploadError("У файлі не знайдено жодного рядка співробітників")

    if stream_type == "project":
        if not project_name:
            raise UploadError("Вкажіть назву проєкту")
        stream_key = project_name

        rows = [clean_project_row(r) for r in raw_rows]
        rows = [r for r in rows if r["region"] or r["name"]]

        totals, by_region, by_store, by_position = aggregate_project(rows)
        dist = distribution_project(rows)
    else:
        # "_topics" rides along untouched (aggregate() ignores it) — only
        # Feed-synced rows have it; see detail_topics.
        rows = [{**clean_row(r), "_topics": r.get("topics") or []} for r in raw_rows]
        rows = [r for r in rows if r["region"] or r["name"]]

        if stream_type == "overall":
            stream_key = "overall"
        else:
            canonical, dominant_raw = detect_attestation_stream(rows)
            if not canonical:
                raise UploadError(
                    f"Не вдалося визначити атестаційну посаду за колонкою «Посада» "
                    f"(зустрілось: «{dominant_raw or '—'}»). Перевірте файл."
                )
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
                for t in r["_topics"]:
                    conn.execute(
                        "INSERT INTO detail_topics (period_id, region, store, position, name, topic, "
                        "schedule_id, dt_start, dt_end, threshold, mark, done_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                        (period_id, r["region"], r["store"], r["position"], r["name"], t["topic"],
                         t.get("scheduleId"), t.get("start"), t.get("end"), t.get("threshold"),
                         t.get("mark"), t.get("doneAt")),
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

    return {
        "periodId": period_id,
        "streamType": stream_type,
        "streamKey": stream_key,
        "rowsCount": len(rows),
        "unclassifiedPositions": unclassified,
        "totals": totals,
    }


@app.post("/api/feed-sync")
def feed_sync():
    """Pull reports straight from Comfy Feed with the operator's own Feed
    login — same data as exporting "Звіт по заняттях" to .xls and uploading
    it by hand: attestation (one report per position) and/or "Все
    навчання". The password is used for this one request only: never
    logged, stored, or echoed back."""
    data = request.get_json(silent=True) or {}
    login = str(data.get("login") or "").strip()
    password = str(data.get("password") or "")
    att_period = str(data.get("attPeriod") or "").strip()
    reports = [r for r in (data.get("reports") or ["attestation"]) if r in ("attestation", "sellers", "overall", "trainees")]
    if not login or not password:
        return jsonify({"error": "Вкажіть логін і пароль Feed"}), 400
    if not re.fullmatch(r"\d{4}-[1-4]", att_period):
        return jsonify({"error": "Невірний період (очікується РРРР-К, наприклад 2026-4)"}), 400
    if not reports:
        return jsonify({"error": "Оберіть, які звіти оновити"}), 400
    year, quarter = (int(x) for x in att_period.split("-"))
    label = f"{quarter} квартал {year}"
    period = relative_quarter_period(year, quarter, datetime.date.today())
    if not period and ("overall" in reports or "sellers" in reports):
        return jsonify({
            "error": "«Все навчання» і атестацію продавців Feed формує лише за поточний або попередній "
                     "квартал — оберіть один із них або завантажте старіший період файлом.",
        }), 400

    client = FeedClient()
    try:
        client.login(login, password)  # quick; the reports themselves take minutes
    except FeedError as e:
        return jsonify({"error": str(e)}), 502
    who = dict(session.get("user") or {})
    job_id = _job_start("manual", who)
    if not job_id:
        return jsonify({"error": "Зараз уже йде оновлення з Feed (можливо, автоматичне після входу) — спробуйте за кілька хвилин"}), 409
    # runs in the background: the proxy in front of the site cuts requests
    # longer than a minute (504); the page polls /api/feed-job/<id>
    threading.Thread(target=_feed_manual_run, args=(client, job_id, year, quarter, period, reports, label, who), daemon=True).start()
    return jsonify({"ok": True, "jobId": job_id})


def _feed_manual_run(client, job_id, year, quarter, period, reports, label, who):
    try:
        result = run_feed_sync(client, year, quarter, period, reports)
        if not result["saved"] and not result["skipped"]:
            _job_finish(job_id, "error", {"error": f"У Feed немає атестаційних занять за {label}"})
            return
        _job_finish(job_id, "done", {"ok": True, **result})
        detail = f"{result['label']}: збережено {len(result['saved'])}"
        if result["skipped"]:
            detail += ", " + _skip_summary(result["skipped"])
        audit("Feed", "Оновив з Feed вручну", detail, who=who or {})
    except Exception as e:  # noqa: BLE001 — reported to the page through the job
        _job_finish(job_id, "error", {"error": str(e)[:300]})


@app.get("/api/feed-job/<int:job_id>")
def feed_job(job_id):
    conn = db.get_db()
    try:
        r = conn.execute("SELECT * FROM feed_jobs WHERE id = ?", (job_id,)).fetchone()
    finally:
        conn.close()
    if not r:
        return jsonify({"error": "Не знайдено"}), 404
    return jsonify({"status": r["status"], "result": json.loads(r["result"]) if r["result"] else None})


def _stored_coverage(stream_type, stream_key, label):
    """(regions, rows) already stored for this report period, or None."""
    conn = db.get_db()
    try:
        p = conn.execute("SELECT id FROM periods WHERE stream_type=? AND stream_key=? AND label=?",
                         (stream_type, stream_key, label)).fetchone()
        if not p:
            return None
        r = conn.execute("SELECT COUNT(DISTINCT region) AS regs, COUNT(*) AS n FROM details WHERE period_id=?",
                         (p["id"],)).fetchone()
        return r["regs"], r["n"]
    finally:
        conn.close()


def _looks_partial(new_regions, new_rows, stored):
    """Auto sync guard: Feed gives a person only what their rights cover, so
    a regional login may get one region. Don't let that overwrite the whole
    network — skip when it covers fewer regions, or under 90% of the people,
    than what is already stored."""
    if not stored:
        return False
    regs, n = stored
    return new_regions < regs or new_rows < n * 0.9


FEED_ATT_NAMES = {"dir": "Директори", "tv": "Товарознавці", "klad": "Комірники", "kass": "Касири",
                  "sm": "Сервіс-менеджери", "prod": "Продавці", "sellers": "Продавці"}


def _skip_summary(skipped):
    """«пропущено N (…)» grouped by reason: «Директори, Касири — причина»."""
    by = {}
    for x in skipped:
        by.setdefault(x["reason"], []).append(_report_name(x).replace("Атестація: ", ""))
    return f"пропущено {len(skipped)} (" + "; ".join(f"{', '.join(v)} — {k}" for k, v in by.items()) + ")"


def _report_name(x):
    if x.get("streamType") == "overall":
        return "Все навчання"
    if x.get("streamType") == "trainees":
        return "Стажери"
    return f"Атестація: {FEED_ATT_NAMES.get(x.get('attType'), x.get('attType') or '')}"


FEED_PARTIAL = "У Feed видно менше регіонів або людей, ніж уже є на дашборді — не перезаписано"


def run_feed_sync(client, year, quarter, period, reports, guard=False):
    """Fetch and save the chosen reports for one quarter with an already
    logged-in FeedClient. guard=True (sync on login) skips any report that
    looks narrower than what is stored (see _looks_partial)."""
    label = f"{quarter} квартал {year}"
    att_reports = []
    if "attestation" in reports:
        _, att_reports = fetch_attestation_reports(client, f"{year}-{quarter}", period or "current_quarter")
    sellers_rows = fetch_sellers_report(client, period) if "sellers" in reports else None
    overall_rows = fetch_overall_report(client, period) if "overall" in reports else None
    months = [(quarter - 1) * 3 + i for i in (1, 2, 3)]
    trainees_by_month = {m: fetch_trainees(client, year, m) for m in months} if "trainees" in reports else {}

    saved, skipped = [], []
    partial = FEED_PARTIAL

    def save(stream_type, rows, att_type=None):
        if guard:
            regions = len({str(r.get("region") or "").strip() for r in rows if r.get("region")})
            if stream_type == "overall":
                key = "overall"
            else:
                key, _ = detect_attestation_stream([clean_row(r) for r in rows])
            if key and _looks_partial(regions, len(rows), _stored_coverage(stream_type, key, label)):
                skipped.append({"streamType": stream_type, "attType": att_type, "reason": partial})
                return
        try:
            result = save_lms_period(stream_type, label, rows)
        except UploadError as e:
            skipped.append({"streamType": stream_type, "attType": att_type, "reason": str(e)})
            return
        saved.append({
            "streamType": stream_type, "attType": att_type, "streamKey": result["streamKey"],
            "rowsCount": result["rowsCount"], "unclassifiedPositions": result["unclassifiedPositions"],
        })

    for att_type, rows in att_reports:
        # sellers have their own source ("Звіт з АТТ") — don't let a
        # "Звіт по заняттях" prod report overwrite the same Продавець period
        if att_type == "prod" and "sellers" in reports:
            continue
        save("attestation", rows, att_type)
    if sellers_rows:
        save("attestation", sellers_rows, "sellers")
    elif "sellers" in reports:
        skipped.append({"streamType": "attestation", "attType": "sellers", "reason": f"У Feed немає оцінок продавців за {label}"})
    if overall_rows is not None:
        save("overall", overall_rows)
    elif "overall" in reports:
        skipped.append({"streamType": "overall", "attType": None, "reason": f"У Feed немає занять за {label}"})
    if trainees_by_month:
        if guard:
            conn = db.get_db()
            for m in list(trainees_by_month):
                old = conn.execute("SELECT COUNT(DISTINCT region) AS regs, COUNT(*) AS n FROM trainees WHERE year=? AND month=?",
                                   (year, m)).fetchone()
                new = trainees_by_month[m]
                regs = len({str((e.get("user") or {}).get("reg") or "").strip() for e in new} - {""})
                if old["n"] and _looks_partial(regs, len(new), (old["regs"], old["n"])):
                    trainees_by_month.pop(m)
            conn.close()
            if len(trainees_by_month) < len(months):
                skipped.append({"streamType": "trainees", "attType": None, "reason": partial})
        if trainees_by_month:
            counts = save_trainees(year, trainees_by_month)
            saved.append({"streamType": "trainees", "attType": None, "streamKey": "Стажери",
                          "rowsCount": sum(counts.values()), "unclassifiedPositions": []})
    return {"label": label, "saved": saved, "skipped": skipped}


# ---- sync on login: whoever logs in through Feed (admin or Регіональна
# команда) refreshes the current quarter in the background with the Feed
# session that login just opened — the password is not kept. At most once
# per FEED_AUTO_HOURS, one run at a time.
FEED_AUTO_HOURS = float(os.environ.get("FEED_AUTO_HOURS", "6"))
FEED_AUTO_REPORTS = ["attestation", "sellers", "overall", "trainees"]
FEED_JOB_STALE_MIN = 30  # a «running» job older than this is treated as dead


def _job_start(kind, who):
    """Register a Feed job unless one is already running (any worker) -> id or None."""
    conn = db.get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        since = (datetime.datetime.utcnow() - datetime.timedelta(minutes=FEED_JOB_STALE_MIN)).isoformat(timespec="seconds") + "Z"
        if conn.execute("SELECT 1 FROM feed_jobs WHERE status = 'running' AND started_at >= ?", (since,)).fetchone():
            conn.rollback()
            return None
        cur = conn.execute("INSERT INTO feed_jobs (kind, status, started_at, by_login) VALUES (?, 'running', ?, ?)",
                           (kind, _now(), (who or {}).get("login")))
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def _job_finish(job_id, status, result):
    conn = db.get_db()
    try:
        conn.execute("UPDATE feed_jobs SET status = ?, finished_at = ?, result = ? WHERE id = ?",
                     (status, _now(), json.dumps(result, ensure_ascii=False), job_id))
        conn.commit()
    finally:
        conn.close()


def _job_running(kind=None):
    since = (datetime.datetime.utcnow() - datetime.timedelta(minutes=FEED_JOB_STALE_MIN)).isoformat(timespec="seconds") + "Z"
    conn = db.get_db()
    try:
        q = "SELECT 1 FROM feed_jobs WHERE status = 'running' AND started_at >= ?" + (" AND kind = ?" if kind else "")
        return bool(conn.execute(q, (since, kind) if kind else (since,)).fetchone())
    finally:
        conn.close()


def _feed_auto_last(conn):
    r = conn.execute("SELECT rows, uploaded_at FROM data_uploads WHERE kind='feed_auto'").fetchone()
    return (r["uploaded_at"], r["rows"]) if r else (None, None)


def _prev_quarter(today=None):
    today = today or datetime.date.today()
    year, quarter = today.year, (today.month - 1) // 3 + 1
    return (year - 1, 4) if quarter == 1 else (year, quarter - 1)


def _prev_quarter_pending(conn):
    """The previous quarter's final results haven't been pulled yet — the
    first sync of a new quarter does it (and keeps trying until it works)."""
    y, q = _prev_quarter()
    r = conn.execute("SELECT rows FROM data_uploads WHERE kind='feed_auto_prev'").fetchone()
    return not r or r["rows"] != y * 10 + q


def maybe_start_feed_auto(client, who):
    # admins only: a regional team login sees just its part of the network in
    # Feed (checked 2026-11-26 — every report came back partial), so its run
    # would save nothing and only hold the 6-hour pause
    if who.get("role") != "admin":
        return False
    conn = db.get_db()
    try:
        last, _ = _feed_auto_last(conn)
        pending = _prev_quarter_pending(conn)
    finally:
        conn.close()
    if last:
        last_dt = datetime.datetime.fromisoformat(last.rstrip("Z"))
        # only the very first run of a new quarter skips the pause; a previous
        # quarter still pending is retried with the next regular run (every
        # FEED_AUTO_HOURS), not on every login
        quarter_start = datetime.datetime.combine(
            datetime.date(datetime.date.today().year, (datetime.date.today().month - 1) // 3 * 3 + 1, 1), datetime.time())
        new_quarter = pending and last_dt < quarter_start
        if not new_quarter and (datetime.datetime.utcnow() - last_dt).total_seconds() < FEED_AUTO_HOURS * 3600:
            return False
    job_id = _job_start("auto", who)
    if not job_id:
        return False
    threading.Thread(target=_feed_auto_run, args=(client, who, job_id), daemon=True).start()
    return True


def _feed_auto_run(client, who, job_id):
    today = datetime.date.today()
    year, quarter = today.year, (today.month - 1) // 3 + 1
    jobs = [(year, quarter, "current_quarter")]
    conn = db.get_db()
    try:
        if _prev_quarter_pending(conn):
            # first sync in a new quarter: the previous one's final results too
            jobs.insert(0, (*_prev_quarter(today), "previous_quarter"))
    finally:
        conn.close()
    prev_done = False
    n = 0
    try:
        notes = []
        for y, q, period in jobs:
            try:
                res = run_feed_sync(client, y, q, period, FEED_AUTO_REPORTS, guard=True)
                note = f"{res['label']}: збережено {len(res['saved'])}"
                if res["skipped"]:
                    # which report and why — so «пропущено» can be understood from the log
                    note += ", " + _skip_summary(res["skipped"])
                n += len(res["saved"])
                # the previous quarter is pulled once: an admin sees the whole
                # network, so whatever they got is final; a regional login
                # that only saw part of it leaves it for the next run
                if period == "previous_quarter" and (who.get("role") == "admin"
                                                     or not any(x["reason"] == FEED_PARTIAL for x in res["skipped"])):
                    prev_done = True
            except Exception as e:  # noqa: BLE001 — logged, never breaks the login
                note = f"{q} квартал {y}: помилка — {str(e)[:200]}"
            notes.append(note)
        note = "автооновлення " + "; ".join(notes)
        conn = db.get_db()
        try:
            _mark_upload(conn, "feed_auto", n)
            if prev_done:
                y, q = _prev_quarter(today)
                _mark_upload(conn, "feed_auto_prev", y * 10 + q)
            conn.commit()
            audit("Feed", "Автооновлення", note.removeprefix("автооновлення "), who=who, conn=conn)
        finally:
            conn.close()
    finally:
        _job_finish(job_id, "done", {"saved": n})


@app.get("/api/feed-auto")
def feed_auto_status():
    conn = db.get_db()
    try:
        last, n = _feed_auto_last(conn)
    finally:
        conn.close()
    return jsonify({"running": _job_running("auto"), "lastAt": last, "lastSaved": n})


# ---------- Кадровий резерв (Leader Hub) ----------

def _mark_upload(conn, kind, rows):
    conn.execute(
        "INSERT INTO data_uploads (kind, rows, uploaded_at) VALUES (?,?,?) "
        "ON CONFLICT(kind) DO UPDATE SET rows = excluded.rows, uploaded_at = excluded.uploaded_at",
        (kind, rows, datetime.datetime.utcnow().isoformat() + "Z"),
    )


@app.post("/api/upload-lh-participants")
def upload_lh_participants():
    """Leader Hub participants (all streams — replaces the previous list) and,
    optionally, the store -> region map from the same file."""
    data = request.get_json(silent=True) or {}
    rows = data.get("participants") or []
    stores = data.get("stores") or []
    if not rows:
        return jsonify({"error": "У файлі не знайдено учасників"}), 400

    def num(v):
        try:
            return float(str(v).replace(",", ".").replace("%", "").strip())
        except (TypeError, ValueError):
            return None

    clean = []
    for r in rows:
        prog = reserve.program_code(r.get("program"))
        try:
            year = int(float(r.get("year")))
        except (TypeError, ValueError):
            continue
        name = str(r.get("name") or "").strip()
        if not name:
            continue
        tab = str(r.get("tab") or "").strip()
        tab = tab[:-2] if tab.endswith(".0") else tab
        clean.append((prog, year, tab or None, name, str(r.get("region") or "").strip(),
                      str(r.get("store") or "").strip(), str(r.get("position") or "").strip(),
                      num(r.get("test")), num(r.get("dz")), str(r.get("status") or "").strip(),
                      1 if str(r.get("passed1") or "").strip().lower() in ("так", "true", "1", "yes") else 0))
    if not clean:
        return jsonify({"error": "Не вдалося розпізнати жодного учасника (потрібні Програма, Потік, ПІБ)"}), 400
    conn = db.get_db()
    try:
        conn.execute("BEGIN")
        # replace only the streams present in the file — streams created and
        # filled by hand on the site stay as they are
        for prog, year in {(c[0], c[1]) for c in clean}:
            conn.execute("DELETE FROM lh_participants WHERE program = ? AND year = ?", (prog, year))
            conn.execute("INSERT OR IGNORE INTO lh_streams (program, year) VALUES (?, ?)", (prog, year))
        conn.executemany(
            "INSERT INTO lh_participants (program, year, tab, name, region, store, position, test, dz, status, passed1) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)", clean,
        )
        # optional «Потоки» sheet: stream dates
        for st in data.get("streams") or []:
            sp = reserve.program_code(st.get("program"))
            try:
                sy = int(float(st.get("year")))
            except (TypeError, ValueError):
                continue
            conn.execute(
                "INSERT INTO lh_streams (program, year, date_start, date_end) VALUES (?,?,?,?) "
                "ON CONFLICT(program, year) DO UPDATE SET date_start = COALESCE(excluded.date_start, date_start), "
                "date_end = COALESCE(excluded.date_end, date_end)",
                (sp, sy, st.get("dateStart") or None, st.get("dateEnd") or None),
            )
        store_rows = [(str(st).strip(), str(rg).strip()) for rg, st in stores if str(st or "").strip() and str(rg or "").strip()]
        if store_rows:
            conn.execute("DELETE FROM store_regions")
            conn.executemany("INSERT OR REPLACE INTO store_regions (store, region) VALUES (?,?)", store_rows)
        _mark_upload(conn, "lh_participants", len(clean))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return jsonify({"ok": True, "participants": len(clean), "stores": len(stores)})


@app.post("/api/upload-employee-history")
def upload_employee_history():
    """BI "Історія працівника", sent in parts (a 130k-row file is far over a
    typical proxy body limit). Parts accumulate in a staging table; the last
    part swaps it in, so a failed upload never leaves a half-replaced
    history. rows: [tab, name, position, store, status, date_start, date_end]."""
    data = request.get_json(silent=True) or {}
    rows = data.get("rows") or []
    part, parts = int(data.get("part") or 0), int(data.get("parts") or 1)
    conn = db.get_db()
    try:
        conn.execute("BEGIN")
        if part == 0:
            conn.execute("DELETE FROM employee_history_staging")
        conn.executemany(
            "INSERT INTO employee_history_staging (tab, name, position, store, status, date_start, date_end) "
            "VALUES (?,?,?,?,?,?,?)",
            [tuple(str(x or "").strip() for x in r[:7]) for r in rows if len(r) >= 7 and str(r[0] or "").strip()],
        )
        total = None
        if part == parts - 1:
            total = conn.execute("SELECT COUNT(*) FROM employee_history_staging").fetchone()[0]
            if not total:
                raise ValueError("empty history")
            conn.execute("DELETE FROM employee_history")
            conn.execute("INSERT INTO employee_history SELECT * FROM employee_history_staging")
            conn.execute("DELETE FROM employee_history_staging")
            _mark_upload(conn, "employee_history", total)
        conn.commit()
    except ValueError:
        conn.rollback()
        return jsonify({"error": "У файлі історії не знайдено жодного рядка"}), 400
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return jsonify({"ok": True, "part": part, "total": total})


def _current_employee(conn, tab):
    row = conn.execute(
        "SELECT tab, name, position, store FROM employee_history WHERE tab = ? ORDER BY date_start DESC LIMIT 1", (tab,)
    ).fetchone()
    return dict(row) if row else None


@app.get("/api/employees/search")
def employees_search():
    """Current state of people in the employee history, by name or tab —
    for adding participants to a Leader Hub stream."""
    q = (request.args.get("q") or "").strip()
    store = (request.args.get("store") or "").strip()  # everyone working in one store
    # potentials: only the posts we consider toward that post
    pot_from = reserve.POTENTIAL_FROM.get(request.args.get("potential") or "")
    if len(q) < 2 and not store:
        return jsonify({"employees": []})
    conn = db.get_db()
    up = conn.execute("SELECT uploaded_at FROM data_uploads WHERE kind = 'employee_history'").fetchone()
    as_of = up["uploaded_at"][:10] if up else datetime.date.today().isoformat()
    # match in Python: SQLite LIKE ignores case only for Latin letters, and
    # every word of the query may come in any order («ім'я прізвище»)
    words = reserve.name_key(q).split()
    rows = [r for r in conn.execute(
        "SELECT h.tab, h.name, h.position, h.store, sr.region FROM employee_history h "
        "LEFT JOIN store_regions sr ON sr.store = h.store "
        "WHERE h.date_start = (SELECT MAX(date_start) FROM employee_history WHERE tab = h.tab) "
        "AND h.status != 'Звільнений' AND h.date_end >= ?",
        (as_of,),
    ) if (not store or r["store"] == store) and (not pot_from or reserve.position_info(r["position"])[0] in pot_from) and (
        len(q) < 2 or r["tab"] == q or (words and all(w in reserve.name_key(r["name"]) for w in words)))]
    if user_regions() is not None:  # regional team: people of its regions only
        rows = [r for r in rows if region_allowed(r["region"])]
    if store:  # the store's team: senior posts first
        rows.sort(key=lambda r: (-(reserve.position_info(r["position"])[1] or 0), r["name"] or ""))
        rows = rows[:300]
    else:
        rows.sort(key=lambda r: r["name"] or "")
        rows = rows[:30]
    conn.close()
    # only people who work now (as of the employee-history upload)
    return jsonify({"employees": [{
        "tab": r["tab"], "name": r["name"], "position": reserve.position_info(r["position"])[0],
        "rank": reserve.position_info(r["position"])[1], "store": r["store"],
        "region": r["region"], "working": True,
    } for r in rows]})


@app.post("/api/lh-streams")
def lh_stream_create():
    data = request.get_json(silent=True) or {}
    prog = reserve.program_code(data.get("program"))
    try:
        year = int(data.get("year"))
    except (TypeError, ValueError):
        return jsonify({"error": "Вкажіть рік потоку"}), 400
    conn = db.get_db()
    conn.execute(
        "INSERT INTO lh_streams (program, year, date_start, date_end) VALUES (?,?,?,?) "
        "ON CONFLICT(program, year) DO UPDATE SET date_start = excluded.date_start, date_end = excluded.date_end",
        (prog, year, data.get("dateStart") or None, data.get("dateEnd") or None),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.delete("/api/lh-streams/<program>/<int:year>")
def lh_stream_delete(program, year):
    """Only an empty stream can be removed (participants first)."""
    conn = db.get_db()
    if conn.execute("SELECT 1 FROM lh_participants WHERE program = ? AND year = ?", (program, year)).fetchone():
        conn.close()
        return jsonify({"error": "У потоці є учасники — спершу приберіть їх"}), 400
    conn.execute("DELETE FROM lh_streams WHERE program = ? AND year = ?", (program, year))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.post("/api/lh-participants")
def lh_participant_add():
    """Add a person from the employee history to a stream; start region /
    store / position are their current ones."""
    data = request.get_json(silent=True) or {}
    prog = reserve.program_code(data.get("program"))
    try:
        year = int(data.get("year"))
    except (TypeError, ValueError):
        return jsonify({"error": "Невірний потік"}), 400
    tab = str(data.get("tab") or "").strip()
    conn = db.get_db()
    emp = _current_employee(conn, tab)
    if not emp:
        conn.close()
        return jsonify({"error": "Співробітника не знайдено в історії"}), 404
    if conn.execute("SELECT 1 FROM lh_participants WHERE program = ? AND year = ? AND tab = ?", (prog, year, tab)).fetchone():
        conn.close()
        return jsonify({"error": "Цей співробітник уже є в потоці"}), 400
    region = conn.execute("SELECT region FROM store_regions WHERE store = ?", (emp["store"],)).fetchone()
    conn.execute("INSERT OR IGNORE INTO lh_streams (program, year) VALUES (?, ?)", (prog, year))
    conn.execute(
        "INSERT INTO lh_participants (program, year, tab, name, region, store, position, status, passed1) "
        "VALUES (?,?,?,?,?,?,?,?,0)",
        (prog, year, tab, emp["name"], region["region"] if region else None, emp["store"],
         reserve.position_info(emp["position"])[0], "Навчається"),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.patch("/api/lh-participants/<int:pid>")
def lh_participant_update(pid):
    data = request.get_json(silent=True) or {}
    sets, params = [], []
    if "status" in data:
        if data["status"] not in reserve.PROGRAM_STATUSES:
            return jsonify({"error": "Невідомий статус"}), 400
        if data["status"] in reserve.LH2_ONLY_STATUSES:
            c = db.get_db()
            row = c.execute("SELECT program FROM lh_participants WHERE id = ?", (pid,)).fetchone()
            c.close()
            if row and row["program"] != "LH2":
                return jsonify({"error": f"Статус «{data['status']}» — лише для Leader Hub 2.0"}), 400
        sets.append("status = ?"); params.append(data["status"])
    if "passed1" in data:
        sets.append("passed1 = ?"); params.append(1 if data["passed1"] else 0)
    if not sets:
        return jsonify({"error": "Нічого змінювати"}), 400
    conn = db.get_db()
    conn.execute(f"UPDATE lh_participants SET {', '.join(sets)} WHERE id = ?", (*params, pid))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.delete("/api/lh-participants/<int:pid>")
def lh_participant_delete(pid):
    conn = db.get_db()
    conn.execute("DELETE FROM lh_participants WHERE id = ?", (pid,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


def _auto_potential(conn, pid, prog):
    """In the programme with ІПР / Сертифікований — a potential without a mark by hand."""
    if pid.startswith("p") and pid[1:].isdigit():
        return bool(conn.execute("SELECT 1 FROM lh_participants WHERE id = ? AND program = ? AND status IN ('ІПР','Сертифікований')",
                                 (int(pid[1:]), prog)).fetchone())
    rows = conn.execute("SELECT tab, name FROM lh_participants WHERE program = ? AND status IN ('ІПР','Сертифікований')", (prog,)).fetchall()
    if any((r["tab"] or "").strip() == pid for r in rows):
        return True
    h = conn.execute("SELECT name FROM employee_history WHERE tab = ? ORDER BY date_start DESC LIMIT 1", (pid,)).fetchone()
    key = reserve.name_key(h["name"]) if h else None
    return bool(key) and any(not (r["tab"] or "").strip() and reserve.name_key(r["name"]) == key for r in rows)


def _person_region(conn, pid):
    """Where the person works now (store reference region) — or, for a
    participant not found in the history, their region from the file."""
    if pid.startswith("p") and pid[1:].isdigit():
        r = conn.execute("SELECT region FROM lh_participants WHERE id = ?", (int(pid[1:]),)).fetchone()
        return r["region"] if r else None
    r = conn.execute("SELECT sr.region FROM employee_history h LEFT JOIN store_regions sr ON sr.store = h.store "
                     "WHERE h.tab = ? ORDER BY h.date_start DESC LIMIT 1", (pid,)).fetchone()
    return r["region"] if r else None


def _hr_reserve_check(conn, pid, prog, status):
    """HR may add / keep / remove potentials — nothing else in the reserve —
    and only for people working in their own regions."""
    if user_regions() is not None and not region_allowed(_person_region(conn, pid)):
        return "Змінювати потенційних можна лише у своїх регіонах"
    cur = conn.execute("SELECT status FROM reserve_status WHERE pid = ? AND program = ?", (pid, prog)).fetchone()
    cur = cur["status"] if cur else None
    if status == "Потенційний" and cur in (None, "Потенційний", "Не в резерві"):
        return None
    if status == "" and cur == "Потенційний":
        return None
    if status == "Не в резерві" and cur in (None, "Потенційний") and _auto_potential(conn, pid, prog):
        return None
    return "Можна змінювати лише потенційних"


@app.put("/api/reserve-status")
def reserve_status_set():
    """Set (or clear — empty status) the reserve status of a person for a
    programme by hand. A person outside the programmes (pid = tab number from
    the employee history) can be marked "Потенційний"."""
    data = request.get_json(silent=True) or {}
    pid = str(data.get("pid") or "").strip()
    # LH1 / LH2 — reserve toward the programme target; TZ — potential товарознавець
    prog = str(data.get("program")) if str(data.get("program")) in ("LH1", "LH2", "TZ") else "LH1"
    status = (data.get("status") or "").strip()
    note = (data.get("note") or "").strip()[:500]
    if not pid:
        return jsonify({"error": "Не вказано працівника"}), 400
    conn = db.get_db()
    known = conn.execute("SELECT 1 FROM employee_history WHERE tab = ? LIMIT 1", (pid,)).fetchone() or (
        pid.startswith("p") and pid[1:].isdigit()
        and conn.execute("SELECT 1 FROM lh_participants WHERE id = ?", (int(pid[1:]),)).fetchone())
    if not known:
        conn.close()
        return jsonify({"error": "Працівника не знайдено"}), 404
    if current_role() == "hr":  # HR: only the potentials
        err = _hr_reserve_check(conn, pid, prog, status)
        if err:
            conn.close()
            return jsonify({"error": err}), 403
        if status == "Потенційний" and not _auto_potential(conn, pid, prog):
            data["check"] = True
    if status == "Потенційний" and data.get("check"):
        # adding a new potential: only from the posts we consider toward that post
        cur = conn.execute("SELECT position FROM employee_history WHERE tab = ? AND status != 'Звільнений' "
                           "ORDER BY date_start DESC LIMIT 1", (pid,)).fetchone()
        pos = reserve.position_info(cur["position"])[0] if cur else None
        if pos not in reserve.POTENTIAL_FROM[prog]:
            conn.close()
            return jsonify({"error": f"{pos or 'Ця посада'}: не розглядаємо як потенційного на цю посаду"}), 400
    if not status:
        conn.execute("DELETE FROM reserve_status WHERE pid = ? AND program = ?", (pid, prog))
    elif status not in reserve.RESERVE_MANUAL_STATUSES:
        conn.close()
        return jsonify({"error": "Невідомий статус"}), 400
    else:
        conn.execute(
            "INSERT INTO reserve_status (pid, program, status, note, updated_at, updated_by) VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(pid, program) DO UPDATE SET status = excluded.status, note = excluded.note, "
            "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
            (pid, prog, status, note or None, datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z",
             current_user_label() or None),
        )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.put("/api/admin-note")
def admin_note_set():
    """Admin-only comment on a programme participant (HR is blocked in
    require_auth: not in HR_WRITE). Key: pid|program|year; empty removes."""
    data = request.get_json(silent=True) or {}
    pid = str(data.get("pid") or "").strip()
    prog = reserve.program_code(data.get("program"))
    try:
        year = int(data.get("year"))
    except (TypeError, ValueError):
        return jsonify({"error": "Не вказано потік"}), 400
    if not pid:
        return jsonify({"error": "Не вказано працівника"}), 400
    key, note = f"{pid}|{prog}|{year}", str(data.get("note") or "").strip()[:1000]
    conn = db.get_db()
    if note:
        conn.execute(
            "INSERT INTO admin_notes (key, note, updated_at, updated_by) VALUES (?,?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
            (key, note, _now(), current_user_label() or None))
    else:
        conn.execute("DELETE FROM admin_notes WHERE key = ?", (key,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.put("/api/reserve-note")
def reserve_note_set():
    """Comment on a person in the reserve — anyone with access (HR too);
    an empty note removes it."""
    data = request.get_json(silent=True) or {}
    pid = str(data.get("pid") or "").strip()
    prog = reserve.program_code(data.get("program"))
    note = str(data.get("note") or "").strip()[:500]
    if not pid:
        return jsonify({"error": "Не вказано працівника"}), 400
    conn = db.get_db()
    if note:
        conn.execute(
            "INSERT INTO reserve_notes (pid, program, note, updated_at, updated_by) VALUES (?,?,?,?,?) "
            "ON CONFLICT(pid, program) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at, "
            "updated_by = excluded.updated_by",
            (pid, prog, note, _now(), current_user_label() or None))
    else:
        conn.execute("DELETE FROM reserve_notes WHERE pid = ? AND program = ?", (pid, prog))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# The reserve dataset walks the whole employee history (≈137k rows) — computed
# once and reused until anything changes (every successful write bumps
# «data_ver» in the DB, so both gunicorn workers notice).
_RESERVE_CACHE = {"key": None, "data": None}
_reserve_lock = threading.Lock()


def _data_ver(conn):
    r = conn.execute("SELECT value FROM app_meta WHERE key = 'data_ver'").fetchone()
    return r["value"] if r else 0


def _bump_data_ver():
    conn = db.get_db()
    try:
        conn.execute("INSERT INTO app_meta (key, value) VALUES ('data_ver', 1) "
                     "ON CONFLICT(key) DO UPDATE SET value = value + 1")
        conn.commit()
    finally:
        conn.close()


def _reserve_dataset(conn, as_of):
    key = (_data_ver(conn), as_of)
    with _reserve_lock:
        if _RESERVE_CACHE["key"] != key:
            _RESERVE_CACHE.update(key=key, data=reserve.lh_dataset(conn, as_of))
        return _RESERVE_CACHE["data"]


@app.get("/api/reserve")
def reserve_view():
    """Everything the "Кадровий резерв" tab needs (see reserve.lh_dataset and
    static/js/reserve.js) — computed client-side from here on."""
    conn = db.get_db()
    # "as of" = when the employee history was exported/uploaded, not today:
    # "works now" and the 12-month windows must match the data, or the
    # numbers drift down as the file ages
    up = conn.execute("SELECT uploaded_at FROM data_uploads WHERE kind = 'employee_history'").fetchone()
    as_of = datetime.date.fromisoformat(up["uploaded_at"][:10]) if up else None
    data = dict(_reserve_dataset(conn, as_of))
    data["streams"] = [dict(r) for r in conn.execute(
        "SELECT program, year, date_start, date_end FROM lh_streams ORDER BY year DESC, program")]
    data["uploads"] = {r["kind"]: {"rows": r["rows"], "uploadedAt": r["uploaded_at"]}
                       for r in conn.execute("SELECT kind, rows, uploaded_at FROM data_uploads")}
    data["statuses"] = reserve.PROGRAM_STATUSES
    data["lh2OnlyStatuses"] = sorted(reserve.LH2_ONLY_STATUSES)
    data["reserveStatuses"] = reserve.RESERVE_MANUAL_STATUSES
    # admin-only comments on participants: the regional team never gets them
    data["adminNotes"] = {} if current_role() != "admin" else {
        r["key"]: {"note": r["note"], "at": r["updated_at"], "by": r["updated_by"] or ""}
        for r in conn.execute("SELECT key, note, updated_at, updated_by FROM admin_notes")}
    conn.close()
    return jsonify(data)


_KPI_PERIOD_RE = re.compile(r"\d{4}-(H[12]|Q[1-4])")


@app.get("/api/kpi")
def kpi_page():
    period = request.args.get("period") or ""
    if not _KPI_PERIOD_RE.fullmatch(period):
        return jsonify({"error": "Невірний період (очікується РРРР-H1 або РРРР-Q3)"}), 400
    own = [p for p in (request.args.get("own") or "").split(",") if p]
    conn = db.get_db()
    manual = {r["kpi_key"]: json.loads(r["values_json"]) for r in conn.execute(
        "SELECT kpi_key, values_json FROM kpi_manual WHERE period = ?", (period,)
    ).fetchall()}
    result = kpi.compute(conn, period, own, manual)
    conn.close()
    return jsonify(result)


@app.post("/api/kpi-manual")
def kpi_manual_save():
    data = request.get_json(silent=True) or {}
    period, key = str(data.get("period") or ""), str(data.get("kpi") or "")
    if not _KPI_PERIOD_RE.fullmatch(period) or key not in kpi.MANUAL:
        return jsonify({"error": "Невірний період або KPI"}), 400
    allowed = {k for k, _ in kpi.MANUAL[key]["inputs"]}
    values = {}
    for k, v in (data.get("values") or {}).items():
        if k not in allowed or v in (None, ""):
            continue
        try:
            values[k] = float(str(v).replace(",", "."))
        except ValueError:
            return jsonify({"error": f"«{v}» — не число"}), 400
    conn = db.get_db()
    if values:
        conn.execute(
            "INSERT INTO kpi_manual (period, kpi_key, values_json, updated_at) VALUES (?,?,?,?) "
            "ON CONFLICT(period, kpi_key) DO UPDATE SET values_json = excluded.values_json, updated_at = excluded.updated_at",
            (period, key, json.dumps(values), datetime.datetime.utcnow().isoformat() + "Z"),
        )
    else:
        conn.execute("DELETE FROM kpi_manual WHERE period = ? AND kpi_key = ?", (period, key))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.get("/api/trainees")
def trainees_list():
    """Every synced trainee, with the KPI verdict already resolved into a
    status — the "Стажери" tab filters and aggregates client-side (a few
    hundred rows a quarter). status: success / fail / dismissed (during the
    internship — out of the KPI) / pending (planned end not reached yet) /
    nodata (over, but nothing for Feed to judge it by)."""
    today = datetime.date.today().isoformat()
    conn = db.get_db()
    rows = conn.execute(
        "SELECT year, month, name, region, store, newbie_type, dismissed, date_start, date_end_plan, "
        "date_end_fact, success, raw_json, synced_at FROM trainees ORDER BY year, month, name"
    ).fetchall()
    conn.close()
    out = []
    keys = user_regions()
    if keys is not None:  # regional team: its regions only
        rows = [r for r in rows if region_key(r["region"]) in keys]
    for r in rows:
        e = json.loads(r["raw_json"])
        reasons = []
        if r["dismissed"]:
            status = "dismissed"
        elif not r["date_end_plan"] or r["date_end_plan"][:10] > today:
            status = "pending"
        elif r["success"] is None:
            # internship is over but Feed has nothing to judge it by — in
            # practice 0 hours worked in the evaluation period (often a
            # dismissal Feed recorded without a date)
            status = "nodata"
            reasons = ["Немає годин роботи за період оцінки"
                       + (" · заблокований у Feed без дати звільнення" if (e.get("user") or {}).get("blocked") else "")]
        else:
            status = "success" if r["success"] else "fail"
        tutor = e.get("tutor") or {}
        out.append({
            "year": r["year"], "month": r["month"], "name": r["name"], "region": r["region"], "store": r["store"],
            "type": r["newbie_type"], "position": TRAINEE_TYPE_LABELS.get(r["newbie_type"], r["newbie_type"]),
            "status": status, "dateStart": r["date_start"], "dateEndPlan": r["date_end_plan"],
            "mentor": tutor.get("fio_full") or tutor.get("fio"), "mentorPosition": tutor.get("position"),
            "examMark": (e.get("pps") or {}).get("final_test_mark"),
            "reasons": trainee_failure_reasons(e) if status == "fail" else reasons,
        })
    synced = max((r["synced_at"] for r in rows), default=None)
    return jsonify({"trainees": out, "syncedAt": synced})


def save_trainees(year, trainees_by_month):
    """Replace each month's trainees with what Feed returned for it (a
    re-sync mid-month picks up newly finished internships and bonus
    decisions). Returns {month: count}."""
    now = datetime.datetime.utcnow().isoformat() + "Z"
    conn = db.get_db()
    counts = {}
    try:
        conn.execute("BEGIN")
        for month, entries in trainees_by_month.items():
            conn.execute("DELETE FROM trainees WHERE year = ? AND month = ?", (year, month))
            for e in entries:
                user = e.get("user") or {}
                process = e.get("process") or {}
                conn.execute(
                    "INSERT INTO trainees (year, month, feed_user_id, name, region, store, newbie_type, position, "
                    "dismissed, date_start, date_end_plan, date_end_fact, bonus, success, raw_json, synced_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (year, month, user.get("user_id"), str(user.get("fio") or "").strip(),
                     str(user.get("reg") or "").strip(), str(user.get("mag") or "").strip(),
                     e.get("newbie_type"), str(user.get("position") or "").strip(),
                     1 if dismissed_during_internship(e) else 0,
                     process.get("date_start"), process.get("date_end_plan"), process.get("date_end_fact"),
                     1 if e.get("bonus") else 0, trainee_success(e), json.dumps(e, ensure_ascii=False), now),
                )
            counts[month] = len(entries)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return counts


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
    # The fuzzy fallback inside matcher() is a full linear scan over the
    # roster — attendance has many rows per person (one per training
    # session), so running it per ROW instead of per distinct name_norm
    # redid the same expensive lookup 3-4x over on real data (1218 rows,
    # 360 distinct names) for no benefit, since every row for the same
    # person resolves identically either way.
    seen_norms = set()
    unmatched_by_norm = {}
    for r in attendance:
        name_norm = r["name_norm"]
        if name_norm in seen_norms:
            continue
        seen_norms.add(name_norm)
        if name_norm in aliases or name_norm in dismissed or matcher(name_norm):
            continue
        unmatched_by_norm.setdefault(name_norm, f"{r['first_name']} {r['last_name']}".strip())

    unmatched = [(display_name, name_norm) for name_norm, display_name in unmatched_by_norm.items()]
    suggestions = suggest_name_matches(unmatched, roster, population_name_norms=seen_norms)
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

def _merged_attestation_periods(conn):
    """Attestation "Усі посади" periods: one entry per label, every
    position's totals summed (shaped like a periods row), keyed by the
    group's newest period id — _resolve_scope maps that id back to the
    whole group. Ordered by when the label first appeared."""
    groups = {}
    for r in conn.execute(
        "SELECT id, stream_key, label, uploaded_at, has_details, totals_json FROM periods "
        "WHERE stream_type = 'attestation' ORDER BY uploaded_at ASC"
    ).fetchall():
        g = groups.setdefault(r["label"], {
            "id": r["id"], "label": r["label"], "uploaded_at": r["uploaded_at"], "has_details": 0,
            "totals": {}, "by_position_json": "{}", "aep_goal": None, "period_year": None, "period_quarter": None,
        })
        g["id"] = max(g["id"], r["id"])
        g["uploaded_at"] = max(g["uploaded_at"], r["uploaded_at"])
        g["has_details"] = g["has_details"] or r["has_details"]
        totals = json.loads(r["totals_json"])
        if r["stream_key"] in SCORE_ONLY_ATTESTATION:
            totals = {"scoreSum": totals.get("scoreSum", 0), "scoreCount": totals.get("scoreCount", 0)}
        for k, v in totals.items():
            if isinstance(v, (int, float)):
                g["totals"][k] = g["totals"].get(k, 0) + v
    return [{**g, "totals_json": json.dumps(g.pop("totals"))} for g in groups.values()]


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
    if _is_all_attestation(stream_type, stream_key):
        rows = _merged_attestation_periods(conn)
    else:
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
    row, ids, _ = _resolve_scope(conn, stream_type, stream_key, request.args.get("periodId"))
    if not row:
        conn.close()
        return jsonify({"period": None})

    in_ids = ",".join("?" for _ in ids)
    filters_rows = conn.execute(
        f"SELECT DISTINCT region, store, position FROM details WHERE period_id IN ({in_ids})", ids,
    ).fetchall()
    topics = [r["topic"] for r in conn.execute(
        f"SELECT DISTINCT topic FROM detail_topics WHERE period_id IN ({in_ids}) ORDER BY topic", ids
    ).fetchall()]
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
            "topics": topics,
        },
    })


# ---------- shared filtering (summary + employee table both work off a chosen period's detail rows) ----------

def _detail_source(args):
    """FROM-clause for the summary / employee table: the per-person details
    table, or — with ?topic= — that one topic's per-person rows from
    detail_topics, reshaped into the same columns (assigned 1, completed /
    progress = passed or not, score = the topic's mark) so _build_where and
    aggregate() work on it unchanged. has_score keeps a passed topic with no
    test (mark NULL) out of the average score instead of counting it as 0%."""
    topic = (args.get("topic") or "").strip()
    if not topic:
        return "details", []
    return (
        "(SELECT period_id, region, store, position, name, 1.0 AS assigned, "
        "CASE WHEN done_at IS NOT NULL THEN 1.0 ELSE 0.0 END AS completed, "
        "CASE WHEN done_at IS NOT NULL THEN 100.0 ELSE 0.0 END AS progress, "
        "COALESCE(mark, 0) AS score, (mark IS NOT NULL) AS has_score, done_at "
        "FROM detail_topics WHERE topic = ?)",
        [topic],
    )


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


# Attestation "Усі посади": every position's attestation period sharing one
# label (e.g. "4 квартал 2026"), merged on the fly — each position is still
# stored as its own period (one upload / Feed report per position).
ALL_ATTESTATION_KEY = "__all__"
# positions whose attestation source gives a mark only — their stored
# progress is a stand-in (see fetch_sellers_report), so "Усі посади" leaves
# them out of progress and counts them toward the average score only
SCORE_ONLY_ATTESTATION = {"Продавець"}


def _is_all_attestation(stream_type, stream_key):
    return stream_type == "attestation" and stream_key == ALL_ATTESTATION_KEY


def _resolve_scope(conn, stream_type, stream_key, period_id):
    """(period, period_ids, stream_by_period) for the chosen period. For a
    normal stream that's just the one period. For attestation "Усі посади"
    `period` is a stand-in for the whole group sharing the chosen period's
    label (latest-uploaded label by default), and stream_by_period maps each
    member period to its position (stream_key)."""
    if not _is_all_attestation(stream_type, stream_key):
        period = _resolve_period(conn, stream_type, stream_key, period_id)
        return period, ([period["id"]] if period else []), {}
    anchor = conn.execute(
        "SELECT label FROM periods WHERE stream_type = 'attestation' AND id = ?", (period_id,)
    ).fetchone() if period_id else None
    if not anchor:
        anchor = conn.execute(
            "SELECT label FROM periods WHERE stream_type = 'attestation' ORDER BY id DESC LIMIT 1"
        ).fetchone()
    if not anchor:
        return None, [], {}
    members = conn.execute(
        "SELECT id, stream_key, uploaded_at FROM periods WHERE stream_type = 'attestation' AND label = ?",
        (anchor["label"],),
    ).fetchall()
    period = {
        "id": max(m["id"] for m in members), "label": anchor["label"],
        "uploaded_at": max(m["uploaded_at"] for m in members),
        "stream_type": "attestation", "stream_key": ALL_ATTESTATION_KEY, "aep_goal": None,
    }
    return period, [m["id"] for m in members], {m["id"]: m["stream_key"] for m in members}


def _build_where(conn, period_ids, args):
    if not isinstance(period_ids, (list, tuple)):
        period_ids = [period_ids]
    where = [f"period_id IN ({','.join('?' for _ in period_ids)})" if period_ids else "1 = 0"]
    params = list(period_ids)

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
    # regional team: only its regions (compare=1 — the «за регіонами» charts,
    # which get the network split by region only, see summary)
    keys = user_regions()
    if keys is not None and not args.get("compare"):
        if region:
            if region_key(region) not in keys:
                where.append("1 = 0")
        else:
            names = [r["region"] for r in conn.execute(
                f"SELECT DISTINCT region FROM details WHERE period_id IN ({','.join('?' for _ in period_ids)})", list(period_ids))
                if region_key(r["region"]) in keys] if period_ids else []
            where.append(f"region IN ({','.join('?' for _ in names)})" if names else "1 = 0")
            params.extend(names)
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
    period, ids, stream_by_period = _resolve_scope(conn, stream_type, stream_key, request.args.get("periodId"))
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
    source_sql, source_params = ("details", []) if (is_project or is_aep) else _detail_source(request.args)
    if source_sql != "details":
        columns += ", has_score"
    if stream_by_period:
        columns += ", period_id"
    where_sql, params = _build_where(conn, ids, request.args)
    rows = conn.execute(f"SELECT {columns} FROM {source_sql} WHERE {where_sql}", source_params + params).fetchall()
    conn.close()

    rows = [db.row_to_dict(r) for r in rows]
    if stream_by_period:
        # "Усі посади": group by attestation position (Директор, Касир...)
        # rather than the raw LMS job titles inside each position's report
        for r in rows:
            r["position"] = stream_by_period.get(r.pop("period_id"), r["position"])
            r["score_only"] = r["position"] in SCORE_ONLY_ATTESTATION
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

    if user_regions() is not None and request.args.get("compare"):
        # regional team: other regions only as numbers per region, for comparison
        return jsonify({"periodId": period["id"], "byRegion": by_region})
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
    "doneAt": "done_at",
}


@app.get("/api/topics")
def topics_summary():
    """"Результати по темах": per topic of the chosen period (Feed-synced
    LMS periods only — see detail_topics), under the same region / store /
    position filters as everything else: how many people it was assigned
    to, how many passed it, and the average mark among those with one."""
    stream_type = request.args.get("streamType")
    stream_key = request.args.get("streamKey")
    if not stream_type or not stream_key:
        return jsonify({"error": "streamType і streamKey обов'язкові"}), 400
    conn = db.get_db()
    period, ids, _ = _resolve_scope(conn, stream_type, stream_key, request.args.get("periodId"))
    if not period or period["stream_type"] not in ("overall", "attestation"):
        conn.close()
        return jsonify({"topics": []})
    where_sql, params = _build_where(conn, ids, request.args)
    rows = conn.execute(
        "SELECT topic, COUNT(*) AS assigned, SUM(done_at IS NOT NULL) AS completed, "
        "AVG(mark) AS avg_mark, COUNT(mark) AS marked, MIN(dt_start) AS dt_start, MAX(dt_end) AS dt_end "
        f"FROM detail_topics WHERE {where_sql} GROUP BY topic",
        params,
    ).fetchall()
    conn.close()
    topics = [{
        "topic": r["topic"], "assigned": r["assigned"], "completed": r["completed"],
        "completionPct": round(r["completed"] * 100 / r["assigned"], 1) if r["assigned"] else 0,
        "avgScore": round(r["avg_mark"], 1) if r["avg_mark"] is not None else None,
        "marked": r["marked"], "start": r["dt_start"], "end": r["dt_end"],
    } for r in rows]
    topics.sort(key=lambda t: (-t["assigned"], t["topic"]))
    return jsonify({"topics": topics})


@app.get("/api/details")
def details():
    stream_type = request.args.get("streamType")
    stream_key = request.args.get("streamKey")
    if not stream_type or not stream_key:
        return jsonify({"error": "streamType і streamKey обов'язкові"}), 400

    conn = db.get_db()
    period, ids, stream_by_period = _resolve_scope(conn, stream_type, stream_key, request.args.get("periodId"))
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

    source_sql, source_params = ("details", []) if is_project else _detail_source(request.args)
    if source_sql != "details":
        columns += ", has_score, done_at"
    if stream_by_period:
        columns += ", period_id"
    where_sql, params = _build_where(conn, ids, request.args)
    params = source_params + params

    search = request.args.get("search")
    if search:
        where_sql += " AND name LIKE ?"
        params = params + [f"%{search}%"]

    sort = request.args.get("sort", default_sort)
    sort_col = DETAIL_SORT_COLUMNS.get(sort, default_sort)
    if sort_col == "done_at" and source_sql == "details":
        sort_col = DETAIL_SORT_COLUMNS[default_sort]
    direction = "DESC" if request.args.get("dir", "asc") == "desc" else "ASC"
    limit = min(int(request.args.get("limit", 400) or 400), 1000)

    total = conn.execute(f"SELECT COUNT(*) c FROM {source_sql} WHERE {where_sql}", params).fetchone()["c"]
    rows = conn.execute(
        f"SELECT {columns} FROM {source_sql} WHERE {where_sql} ORDER BY {sort_col} {direction} LIMIT ?",
        params + [limit],
    ).fetchall()
    conn.close()

    rows = [db.row_to_dict(r) for r in rows]
    if stream_by_period:
        for r in rows:
            r["scoreOnly"] = stream_by_period.get(r.pop("period_id")) in SCORE_ONLY_ATTESTATION
    if source_sql != "details":
        # a passed topic without a test has no mark — show it as blank, not 0%
        for r in rows:
            if not r.pop("has_score"):
                r["score"] = None
            r["doneAt"] = r.pop("done_at")
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
