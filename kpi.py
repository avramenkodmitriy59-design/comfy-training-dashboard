"""KPI 2027 of the retail training department ("KPI відділу навчання
Роздрібу 2027"): per-role KPI lists with weights / bases / targets, the
facts computed from data the dashboard already has (attestation, "Все
навчання", trainees, AEP), manual values for the KPIs with no source yet,
and the bonus index.

Bonus mechanics (from the KPI document): target = base × 1.04 (unless the
document fixes it), achievement = fact / target capped at 110%, index =
weight-weighted achievement, bonus if index ≥ 95%.
"""

import datetime
import json

ACHIEVEMENT_CAP = 1.10
BONUS_THRESHOLD = 0.95
GROWTH = 1.04
# Where the document says "база — потрібна", the base is computed from this
# quarter (the document's own base period for attestation).
BASE_PERIOD = (2026, 3)

ATTESTATION_POSITIONS = ["Директор", "Товарознавець", "Комірник", "Касир", "Сервіс менеджер", "Продавець"]
BACK_POSITIONS = ["Товарознавець", "Касир", "Сервіс менеджер", "Комірник"]
# engagement covers every back-office store position — loaders included
# (they have training assigned, just no attestation / internship KPI)
ENGAGEMENT_BACK_POSITIONS = BACK_POSITIONS + ["Вантажник"]
# trainees.newbie_type for each back-office position
TRAINEE_TYPE_BY_POSITION = {"Товарознавець": "tv", "Касир": "kass", "Сервіс менеджер": "sm", "Комірник": "klad"}

# Manual KPIs: value entered on the KPI page per period. "inputs" lists the
# numbers asked for; "compute" turns them into the fact (in %).
MANUAL = {
    "retail_plan": {"inputs": [("pct", "Виконання плану, %")], "compute": lambda v: v.get("pct")},
    "internal_appointments": {
        "inputs": [("vp", "ВП (внутрішні призначення)"), ("zp", "ЗП (зовнішні)")],
        "compute": lambda v: (v["vp"] * 100 / (v["vp"] + v["zp"]))
        if v.get("vp") is not None and v.get("zp") is not None and (v["vp"] + v["zp"]) > 0 else None,
    },
    "category2": {"inputs": [("pct", "Вийшли на 2-гу кат. і вище, %")], "compute": lambda v: v.get("pct")},
    "knowledge_categories": {"inputs": [("score", "Середній бал за своїми категоріями")],
                             "compute": lambda v: v.get("score")},
}

# (key, name, how, weight, base, target, unit). base None = compute from
# BASE_PERIOD; target None = base × GROWTH.
ROLES = [
    {"key": "head", "name": "Керівник відділу навчання Роздрібу", "kpis": [
        ("retail_plan", "Виконання плану роздрібу", "Факт продажів роздрібу / план", 0.10, None, 100.0, "%"),
        ("att_retail", "Середній бал атестації роздрібу",
         "Середнє із середніх балів по кожній посаді (6 посад), кожна важить однаково", 0.40, 89.0, 92.6, "бал"),
        ("trainees_all", "Успішність стажерів (усі посади)",
         "Успішно завершили стажування / усі, хто завершив, за плановою датою завершення", 0.30, None, None, "%"),
        ("internal_appointments", "Закриття вакансій внутрішніми призначеннями",
         "ВП / (ВП + ЗП): директор, заступники, товарознавець, комірник. Без ротацій", 0.20, 86.0, 89.4, "%"),
    ]},
    {"key": "product_lead", "name": "Керівник групи продуктового навчання", "kpis": [
        ("trainees_sellers", "Успішність стажерів продавців",
         "Виконали обидві норми (товарообіг і асс + сервіси) / усі, хто завершив", 0.30, 70.0, 72.8, "%"),
        ("category2", "Вихід на 2-гу категорію",
         "Вийшли на 2-гу категорію і вище / усі, хто завершив стажування (відступ 2 міс.)", 0.15, 47.0, 48.9, "%"),
        ("att_sellers", "Рівень знань продавців",
         "Середній бал квартальної атестації продавців, лише ті, хто розпочав", 0.35, 87.8, 91.3, "бал"),
        ("aep", "Залученість до тренінгів AEP",
         "Факт / план учасників; факт теми — не більше 100% плану", 0.20, 85.0, 88.4, "%"),
    ]},
    {"key": "process_lead", "name": "Керівник групи навчання з процесів", "kpis": [
        ("att_back", "Середній бал атестації бек-посад",
         "Середнє із середніх по посадах: товарознавець, касир, СМ, комірник", 0.40, 88.5, 92.0, "бал"),
        ("trainees_back", "Успішність стажерів бек-посад",
         "Пройшли стажування за критеріями посади у Feed / усі, хто завершив", 0.35, None, None, "%"),
        ("engagement_back", "Залученість бек-посад до навчання",
         "Середній прогрес по всьому призначеному навчанню (АТТ + регулярне): ТЗ, касир, СМ, комірник, вантажник. "
         "Без тих, хто без призначень", 0.25, 57.8, 60.1, "%"),
    ]},
    {"key": "product_spec", "name": "Фахівець з розвитку персоналу (продуктове навчання)", "kpis": [
        ("trainees_sellers", "Успішність стажерів продавців", "Як у керівника групи, по всій мережі",
         0.40, 70.0, 72.8, "%"),
        ("knowledge_categories", "Знання за своїми категоріями",
         "Середній бал атестації продавців за закріпленими категоріями товарів", 0.30, 87.8, None, "бал"),
        ("category2", "Вихід на 2-гу категорію", "Як у керівника групи", 0.30, 47.0, 48.9, "%"),
    ]},
    {"key": "process_spec", "name": "Фахівець з розвитку персоналу (навчання з процесів)", "own_positions": True, "kpis": [
        ("att_own", "Середній бал атестації своїх посад", "Середнє із середніх по закріплених бек-посадах",
         0.40, None, None, "бал"),
        ("trainees_own", "Успішність стажерів своїх посад", "Пройшли стажування / усі, хто завершив, по своїх посадах",
         0.30, None, None, "%"),
        ("engagement_own", "Залученість своїх посад до навчання",
         "Середній прогрес закріплених посад по всьому призначеному навчанню", 0.30, None, None, "%"),
    ]},
]


def period_quarters(period_key):
    """"2026-Q3" -> [(2026, 3)]. KPI are measured per quarter; a half-year
    key ("2027-H1" -> both its quarters) is still understood."""
    year, part = period_key.split("-")
    year, n = int(year), int(part[1:])
    if part[0] == "H":
        return [(year, 2 * n - 1), (year, 2 * n)]
    return [(year, n)]


def _mean(values):
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


class KpiData:
    """Fact lookups over the dashboard DB for a set of quarters."""

    def __init__(self, conn, today=None):
        self.conn = conn
        self.today = (today or datetime.date.today()).isoformat()

    def attestation_avg(self, position, quarters):
        """Average score (started only) of one position, averaged over the
        quarters that have its attestation."""
        vals = []
        for y, q in quarters:
            row = self.conn.execute(
                "SELECT totals_json FROM periods WHERE stream_type = 'attestation' AND stream_key = ? AND label = ?",
                (position, f"{q} квартал {y}"),
            ).fetchone()
            if row:
                t = json.loads(row["totals_json"])
                if t.get("scoreCount"):
                    vals.append(t["scoreSum"] / t["scoreCount"])
        return _mean(vals)

    def attestation_mean_of_positions(self, positions, quarters):
        """Mean of the per-position averages — each position weighs the same,
        positions with no attestation in the period are skipped."""
        return _mean([self.attestation_avg(p, quarters) for p in positions])

    def trainee_success(self, quarters, types=None):
        """% successful among trainees whose internship was planned to end in
        the period and is over (dismissed-during-internship / unjudged left
        out — see feed_sync.trainee_success)."""
        months = [(y, (q - 1) * 3 + i) for y, q in quarters for i in (1, 2, 3)]
        where = " OR ".join("(year = ? AND month = ?)" for _ in months)
        params = [x for ym in months for x in ym]
        sql = (f"SELECT SUM(success) AS ok, COUNT(success) AS n FROM trainees WHERE ({where}) "
               "AND dismissed = 0 AND success IS NOT NULL AND substr(date_end_plan, 1, 10) <= ?")
        params.append(self.today)
        if types is not None:
            sql += f" AND newbie_type IN ({','.join('?' for _ in types)})"
            params += list(types)
        row = self.conn.execute(sql, params).fetchone()
        return (row["ok"] * 100 / row["n"]) if row["n"] else None

    def engagement(self, positions, quarters):
        """Average progress over all assigned training ("Все навчання") for
        the positions, people with nothing assigned left out; averaged over
        the quarters with data."""
        vals = []
        for y, q in quarters:
            row = self.conn.execute(
                "SELECT AVG(d.progress) AS p FROM details d JOIN periods p ON p.id = d.period_id "
                f"WHERE p.stream_type = 'overall' AND p.label = ? AND d.assigned > 0 "
                f"AND d.position IN ({','.join('?' for _ in positions)})",
                [f"{q} квартал {y}", *positions],
            ).fetchone()
            vals.append(row["p"])
        return _mean(vals)

    def aep(self, quarters):
        """Fact / plan of AEP participants, each topic's fact capped at its
        plan, summed over the period's quarters."""
        fact = plan = 0.0
        for y, q in quarters:
            row = self.conn.execute(
                "SELECT by_position_json FROM periods WHERE stream_type = 'aep' AND period_year = ? AND period_quarter = ?",
                (y, q),
            ).fetchone()
            if not row:
                continue
            for b in json.loads(row["by_position_json"]).values():
                if b.get("assigned"):
                    plan += b["assigned"]
                    fact += min(b.get("completed") or 0, b["assigned"])
        return fact * 100 / plan if plan else None


def _fact(key, data, quarters, own_positions):
    if key == "att_retail":
        return data.attestation_mean_of_positions(ATTESTATION_POSITIONS, quarters)
    if key == "att_back":
        return data.attestation_mean_of_positions(BACK_POSITIONS, quarters)
    if key == "att_sellers":
        return data.attestation_avg("Продавець", quarters)
    if key == "att_own":
        att = [p for p in own_positions if p in BACK_POSITIONS]
        return data.attestation_mean_of_positions(att, quarters) if att else None
    if key == "trainees_all":
        return data.trainee_success(quarters)
    if key == "trainees_sellers":
        return data.trainee_success(quarters, ["prod"])
    if key == "trainees_back":
        return data.trainee_success(quarters, list(TRAINEE_TYPE_BY_POSITION.values()))
    if key == "trainees_own":
        types = [TRAINEE_TYPE_BY_POSITION[p] for p in own_positions if p in TRAINEE_TYPE_BY_POSITION]
        return data.trainee_success(quarters, types) if types else None
    if key == "engagement_back":
        return data.engagement(ENGAGEMENT_BACK_POSITIONS, quarters)
    if key == "engagement_own":
        return data.engagement(own_positions, quarters) if own_positions else None
    if key == "aep":
        return data.aep(quarters)
    return None


def compute(conn, period_key, own_positions, manual_values):
    """manual_values: {kpi_key: {input_key: number}} for this period."""
    data = KpiData(conn)
    quarters = period_quarters(period_key)
    base_quarters = [BASE_PERIOD]
    roles = []
    for role in ROLES:
        own = [p for p in own_positions if p in ENGAGEMENT_BACK_POSITIONS] if role.get("own_positions") else []
        kpis = []
        for key, name, how, weight, base, target, unit in role["kpis"]:
            manual = MANUAL.get(key)
            base_note = "з документа KPI"
            if base is None:
                base = None if manual else _fact(key, data, base_quarters, own)
                base_note = f"з даних {BASE_PERIOD[1]} кв. {BASE_PERIOD[0]}" if base is not None else "немає даних"
            if target is None and base is not None:
                target = base * GROWTH
            values = (manual_values or {}).get(key) or {}
            fact = manual["compute"](values) if manual else _fact(key, data, quarters, own)
            achievement = min(fact / target, ACHIEVEMENT_CAP) if fact is not None and target else None
            kpis.append({
                "key": key, "name": name, "how": how, "weight": weight, "unit": unit,
                "base": base, "baseNote": base_note, "target": target, "fact": fact, "achievement": achievement,
                "manual": [{"key": k, "label": lbl, "value": values.get(k)} for k, lbl in manual["inputs"]]
                if manual else None,
            })
        measured = [k for k in kpis if k["achievement"] is not None]
        weight = sum(k["weight"] for k in measured)
        index = sum(k["weight"] * k["achievement"] for k in measured) / weight if weight else None
        roles.append({
            "key": role["key"], "name": role["name"], "ownPositions": bool(role.get("own_positions")),
            # index over the KPIs that have a fact (re-weighted); no bonus
            # verdict until every KPI of the role is measured
            "kpis": kpis, "index": index, "measured": len(measured), "complete": len(measured) == len(kpis),
            "bonus": (index >= BONUS_THRESHOLD) if index is not None and len(measured) == len(kpis) else None,
        })
    return {
        "period": period_key, "roles": roles, "backPositions": ENGAGEMENT_BACK_POSITIONS,
        "bonusThreshold": BONUS_THRESHOLD, "cap": ACHIEVEMENT_CAP,
    }
