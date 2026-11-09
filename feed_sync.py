"""Pulls attestation reports straight from Comfy Feed (elearning.comfy.ua) —
the same "Звіт по заняттях" an operator would otherwise export to .xls and
upload by hand — using the operator's own Feed login, entered per sync and
never stored anywhere (see /api/feed-sync).

Feed has no public API: this talks to the same internal endpoints its own
Angular frontend calls. Two things it needs besides the user's session
cookie:
  * an app-level HTTP Basic header the frontend sends with every request —
    read at runtime from Feed's own public JS bundle (never copied into this
    repo), so it keeps working if Feed rotates it;
  * an identifiable User-Agent — Feed's Cloudflare rejects urllib's default
    one with 403.

Stdlib only (urllib), so the compiled production build needs no new deps.
"""

import base64
import json
import os
import re
import ssl
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

FEED_BASE_URL = "https://elearning.comfy.ua/"
USER_AGENT = "COMFY-training-dashboard/1.0 (+hr-board.comfy.ua)"
TIMEOUT = 60


def _ssl_context():
    """Default HTTPS verification, plus the system CA bundle loaded
    explicitly when Python found none on its own — the production image is a
    PyInstaller/staticx single binary on a minimal base where the bundled
    OpenSSL's default paths may not exist, but the image does ship
    /etc/ssl/certs/ca-certificates.crt (see tpl.dockerfile)."""
    ctx = ssl.create_default_context()
    if not ctx.cert_store_stats().get("x509_ca"):
        for path in (os.environ.get("SSL_CERT_FILE"), "/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem"):
            if path and os.path.isfile(path):
                ctx.load_verify_locations(cafile=path)
                break
    return ctx


class FeedError(Exception):
    """A failure worth showing the operator as-is (wrong password, Feed
    changed its format, network down...)."""


class FeedClient:
    def __init__(self, base_url=FEED_BASE_URL):
        self.base_url = base_url
        self.api_url = base_url + "source/"
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(CookieJar()),
            urllib.request.HTTPSHandler(context=_ssl_context()),
        )
        self._basic = None

    def _request(self, url, body=None, headers=None):
        req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            with self._opener.open(req, timeout=TIMEOUT) as resp:
                return resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            raise FeedError(f"Feed відповів помилкою {e.code}") from e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            reason = getattr(e, "reason", None) or e
            raise FeedError(f"Не вдалося з'єднатися з Feed (elearning.comfy.ua): {reason}") from e

    def _app_basic_auth(self):
        if self._basic is None:
            index = self._request(self.base_url + "feed/")
            m = re.search(r"main\.[0-9a-f]+\.js", index)
            if not m:
                raise FeedError("Не вдалося розпізнати сторінку Feed — можливо, Feed оновився")
            bundle = self._request(self.base_url + "feed/" + m.group(0))
            cfg = re.search(r'BACKEND_USER:"([^"]*)",BACKEND_PASS:"([^"]*)"', bundle)
            if not cfg:
                raise FeedError("Не вдалося підключитися до Feed — можливо, Feed оновився")
            self._basic = base64.b64encode(f"{cfg.group(1)}:{cfg.group(2)}".encode()).decode()
        return self._basic

    def post(self, path, payload):
        """POST to a Feed API module path (e.g. "common/login/process") and
        return the response's `data`, or raise FeedError with Feed's own
        message when `success` is false."""
        raw = self._request(
            self.api_url + path,
            body=json.dumps(payload or {}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Basic " + self._app_basic_auth(),
                "Origin": self.base_url.rstrip("/"),
                "Referer": self.base_url + "feed/",
            },
        )
        try:
            resp = json.loads(raw)
        except ValueError as e:
            raise FeedError("Feed повернув неочікувану відповідь") from e
        if not resp.get("success"):
            data = resp.get("data") or {}
            if isinstance(data, dict) and data.get("auth") is False:
                raise FeedError("Feed не прийняв вхід — сесія не відкрилась")
            msg = str(resp.get("message") or "").split(":", 1)[-1].strip()
            raise FeedError(f"Feed: {msg}" if msg else "Feed повернув помилку")
        return resp.get("data")

    def login(self, login, password):
        try:
            data = self.post("common/login/process", {"login": login, "password": password})
        except FeedError as e:
            if "wrong_auth" in str(e):
                raise FeedError("Невірний логін або пароль Feed") from e
            raise FeedError(f"Не вдалося увійти у Feed: {e}") from e
        data = data or {}
        if data.get("password_reset"):
            raise FeedError("Feed вимагає змінити пароль — зайдіть у Feed, змініть його й спробуйте ще раз")
        if not data.get("access"):
            raise FeedError("Невірний логін або пароль Feed")
        # A fresh login isn't usable for API calls yet — Feed's own frontend
        # follows it with a full page load of the site root, which is what
        # actually activates the PHP session (API calls before it get "auth:
        # false"). Do the same.
        self._request(self.base_url)


# Same filter the "Звіт по заняттях" page sends: all regions/stores/
# positions, every training of the period selected. `period` is one of
# Feed's fixed relative ranges (see relative_quarter_period) — Feed has no
# arbitrary date range for this report.
def _report_filter(period="current_quarter", for_att=False, att_period=None, att_type=None, schedule_ids=None):
    return {
        "reportContext": "users", "forAttOnly": for_att, "attType": att_type,
        "scheduleId": 0, "scheduleIds": schedule_ids or [], "for_course": False,
        "positions": [], "period": period, "regId": 0, "magId": 0,
        "reportType": "type_shops", "lang": "ua", "attPeriod": att_period,
    }


def _att_filter(att_period, att_type=None, schedule_ids=None, period="current_quarter"):
    return _report_filter(period, True, att_period, att_type, schedule_ids)


def relative_quarter_period(year, quarter, today):
    """Feed's report period for a calendar quarter: "current_quarter" /
    "previous_quarter" relative to `today`, or None for anything older or
    in the future (Feed can't report on those)."""
    current = (today.year, (today.month - 1) // 3 + 1)
    previous = (current[0] - 1, 4) if current[1] == 1 else (current[0], current[1] - 1)
    if (year, quarter) == current:
        return "current_quarter"
    if (year, quarter) == previous:
        return "previous_quarter"
    return None


def report_entry_to_row(entry):
    """One person from Feed's report response -> the same row shape the
    .xls upload produces (see extractRows in app.js): Feed's own export
    writes exactly these fields into the Регіон/Магазин/Посада/ПІБ/Всього
    призначено/Пройдено/Прогрес/Оцінка columns. A person with nothing
    assigned comes back with data=null — kept as an assigned=0 row, same as
    the export, so they count toward "Без призначеного навчання"."""
    user = entry.get("user") or {}
    summary = ((entry.get("data") or {}).get("summary")) or {}

    def num(v):
        try:
            return float(v or 0)
        except (TypeError, ValueError):
            return 0.0

    topics = []
    for it in ((entry.get("data") or {}).get("items")) or []:
        title = str(it.get("title") or "").strip()
        if not title:
            continue
        mark = it.get("mark")
        topics.append({
            "topic": title,
            "scheduleId": it.get("id"),
            "start": it.get("begin"),
            "end": it.get("end"),
            "threshold": num(it.get("test_threshold")) or None,
            "mark": round(float(mark), 2) if mark is not None else None,
            "doneAt": it.get("dt_mark"),
        })

    return {
        "region": str(user.get("reg") or "").strip(),
        "store": str(user.get("mag") or "").strip(),
        "position": str(user.get("position") or "").strip(),
        "name": str(user.get("fio") or "").strip(),
        "assigned": num(summary.get("cnt")),
        "completed": num(summary.get("done")),
        "progress": round(num(summary.get("progress")), 2),
        "score": round(num(summary.get("mark_avg")), 2),
        # per-topic breakdown (Feed sync only — see detail_topics in db.py)
        "topics": topics,
    }


def _fetch_report(client, report_filter):
    """Every training Feed lists for the filter -> the per-person report."""
    schedule = client.post("feed/schedule-results/schedule-for-report", report_filter) or []
    ids = [s["id"] for s in schedule if s.get("id")]
    if not ids:
        return None
    entries = client.post("feed/schedule-results/report", {**report_filter, "scheduleIds": ids}) or []
    return [report_entry_to_row(e) for e in entries]


def fetch_attestation_reports(client, att_period=None, period="current_quarter"):
    """Returns (att_period, [(att_type, rows), ...]) — one report per
    attestation type (dir, tv, klad...) that has trainings in the period.
    att_period is Feed's "YYYY-Q" (e.g. "2026-4"); defaults to the latest
    one Feed offers."""
    init = client.post("feed/schedule-results/init-report", _att_filter(att_period, period=period)) or {}
    periods = init.get("att_periods") or []
    if att_period is None:
        if not periods:
            raise FeedError("У Feed не знайдено жодного періоду атестації")
        att_period = periods[0]
    elif periods and att_period not in periods:
        raise FeedError(f"У Feed немає атестації за період {att_period}")
    year, quarter = (int(x) for x in att_period.split("-"))

    att_types = []
    for s in init.get("schedule") or []:
        if not s.get("for_att") or s.get("deleted"):
            continue
        if int(s.get("att_year") or 0) != year or int(s.get("att_quart") or 0) != quarter:
            continue
        for t in s.get("att_types") or []:
            if t not in att_types:
                att_types.append(t)

    reports = []
    for att_type in att_types:
        rows = _fetch_report(client, _att_filter(att_period, att_type, period=period))
        if rows is not None:
            reports.append((att_type, rows))
    return att_period, reports


def fetch_overall_report(client, period):
    """"Все навчання": every training (not just attestation) in `period`
    ("current_quarter" / "previous_quarter") for the store positions Feed
    offers in the report's "Посади" filter. Those must be passed explicitly:
    an empty list means "no filter" to Feed and pulls in everyone else too
    (promoters, regional management...)."""
    init = client.post("feed/schedule-results/init-report", _report_filter(period)) or {}
    positions = [int(p["code"]) for p in init.get("positions") or [] if p.get("code") is not None]
    if not positions:
        raise FeedError("Feed не повернув список посад для звіту «Все навчання»")
    return _fetch_report(client, {**_report_filter(period), "positions": positions})


# "Звіти → Звіт з АТТ" (feed/show/reports/att) with "Для АТТ", "Тільки
# відповіді за період" and position "Продавець" — the only Feed source for
# sellers' attestation. Unlike "Звіт по заняттях" it has no export button and
# gives one final mark per person, nothing about assigned/completed courses.
SELLER_POSITION_CODE = 41


def _seller_filter(period):
    return {
        "reportType": "type_shops", "reportScheme": "by_themes", "reportLevels": [],
        "personalType": "front", "positions": [SELLER_POSITION_CODE], "period": period,
        "forAttOnly": True, "regId": 0, "magId": 0, "periodMarksOnly": True, "lang": "ua",
    }


def fetch_sellers_report(client, period):
    """Sellers' attestation marks in `period` ("current_quarter" /
    "previous_quarter"), as dashboard rows. Same shape the manual Продавець
    upload always had (see isProdavetsAttestation in app.js): the mark is
    the only real number, assigned/completed are a flat 1/1 and progress
    100% — except a person with no mark (Feed reports 0 for someone who
    hasn't answered anything this period), kept as not started (progress 0)
    so they show under "Ще не розпочали" instead of dragging the average
    score down as a 0%."""
    client.post("feed/reports/initAttReport", _seller_filter(period))
    entries = client.post("feed/reports/getAttReport", _seller_filter(period)) or []
    rows = []
    for e in entries:
        if not e.get("user_id"):
            continue  # Feed's own "Разом" average row
        mark = e.get("mark")
        if mark is not None and float(mark) <= 0:
            mark = None
        rows.append({
            "region": str(e.get("reg") or "").strip(),
            "store": str(e.get("mag") or "").strip(),
            "position": str(e.get("position_full") or "").strip(),
            "name": str(e.get("fio") or "").strip(),
            "assigned": 1.0,
            "completed": 1.0 if mark is not None else 0.0,
            "progress": 100.0 if mark is not None else 0.0,
            "score": round(float(mark), 2) if mark is not None else 0.0,
        })
    return rows


# "Наставництво → Премія за наставництво" (feed/show/cabinet/tutoring): every
# trainee whose internship was planned to end in the given month — sellers
# and back-office positions, successful or not (the .xls export only lists
# the ones with a bonus). Source for the "Успішність стажерів" KPI.
def fetch_trainees(client, year, month):
    data = client.post("feed/pps-tutoring/bonus-for-month", {"year": int(year), "month": int(month)}) or {}
    return data.get("data") or []


def dismissed_during_internship(entry):
    """Dismissed before the internship's planned end — left out of the KPI
    (didn't complete it). Someone dismissed AFTER finishing still counts:
    they did complete the internship (same as BI "Ефективність стажерів",
    which keeps them under "Статус на сьогодні: звільнений")."""
    blocked_on = str((entry.get("user") or {}).get("date_block") or "")[:10]
    planned_end = str((entry.get("process") or {}).get("date_end_plan") or "")[:10]
    return bool(blocked_on) and (not planned_end or blocked_on < planned_end)


def trainee_success(entry):
    """Whether a trainee passed their internship, by the 2027 KPI rule — or
    None when it can't be judged (dismissed during the internship — left out
    of the KPI entirely; a seller with no sales targets yet is still
    mid-evaluation).
    Seller: met BOTH the sales-per-hour norm (2nd category −20%) and the
    services + accessories norm — in the shop where they worked the most
    hours, if they worked in several. Feed's own "Премія" flag is NOT used
    for sellers: it can be approved/removed by hand.
    Back-office (касир, комірник, СМ, товарознавець): Feed's own verdict
    on that position's criteria — `kpi[].passed` (final exam plus e.g. CSI
    and cash errors for a cashier, order-assembly speed and process errors
    for a storekeeper), from the latest evaluation period if there are
    several."""
    if dismissed_during_internship(entry):
        return None
    if entry.get("newbie_type") != "prod":
        kpi = entry.get("kpi") or []
        if not kpi:
            return None
        return 1 if max(kpi, key=lambda k: k.get("end") or "").get("passed") else 0
    sales = [s for s in entry.get("sales") or [] if s.get("target_sales_fte")]
    if not sales:
        return None
    shop = max(sales, key=lambda s: s.get("hours") or 0)
    met_sales = (shop.get("sales_fte") or 0) >= shop["target_sales_fte"]
    met_serv = (shop.get("serv_fte") or 0) >= (shop.get("target_serv_fte") or 0)
    return 1 if met_sales and met_serv else 0


TRAINEE_TYPE_LABELS = {
    "prod": "Продавець", "kass": "Касир", "klad": "Комірник", "sm": "Сервіс менеджер", "tv": "Товарознавець",
}

# kpi[].results keys (back-office) -> how to show a failed criterion
_BACK_CRITERIA = {
    "mark": ("Підсумковий іспит", lambda v: v.get("pps_mark"), "{:.0f}%"),
    "satisfaction": ("CSI (задоволеність)", lambda v: (v.get("csi") or {}).get("satisfaction"), "{:.0f}%"),
    "errors": ("Помилки", lambda v: v.get("kass_errors", v.get("process_errors")), "{:.0f}"),
    # Feed sends seconds (pass/fail split sits at ~600 s = 10 min)
    "assembly_orders_duration": ("Швидкість збору замовлень",
                                 lambda v: (v.get("assembly_orders_duration") or 0) / 60 or None, "{:.1f} хв"),
    "percent_sales": ("% продажів після повернення",
                      lambda v: (v.get("sales_after_return") or {}).get("percent_sales"), "{:.1f}%"),
}


def trainee_failure_reasons(entry):
    """Human-readable list of what a trainee missed — the "why" next to an
    unsuccessful internship. Mirrors trainee_success's rules."""
    if entry.get("newbie_type") == "prod":
        sales = [s for s in entry.get("sales") or [] if s.get("target_sales_fte")]
        if not sales:
            return []
        shop = max(sales, key=lambda s: s.get("hours") or 0)
        reasons = []
        for label, fact_key, target_key in (("Товарообіг/год", "sales_fte", "target_sales_fte"),
                                            ("Асс + сервіси/год", "serv_fte", "target_serv_fte")):
            fact, target = shop.get(fact_key) or 0, shop.get(target_key) or 0
            if target and fact < target:
                reasons.append(f"{label}: {fact:,} з {target:,} грн ({(fact - target) / target * 100:+.1f}%)"
                               .replace(",", " "))
        return reasons
    kpi = entry.get("kpi") or []
    if not kpi:
        return []
    k = max(kpi, key=lambda x: x.get("end") or "")
    values = k.get("values") or {}
    reasons = []
    for key, ok in (k.get("results") or {}).items():
        if ok:
            continue
        label, getter, fmt = _BACK_CRITERIA.get(key, (key, lambda v: None, "{}"))
        value = getter(values)
        reasons.append(f"{label}: {fmt.format(value)}" if isinstance(value, (int, float)) else label)
    return reasons
