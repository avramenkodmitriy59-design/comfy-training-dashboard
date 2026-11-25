'use strict';

/* ===================== constants ===================== */

const ATTESTATION_STREAMS = ['Директор', 'Товарознавець', 'Комірник', 'Касир', 'Сервіс менеджер', 'Продавець'];
const ATTESTATION_ALL = '__all__';

// These small leadership-track courses have a couple dozen people spread
// thin across positions and stores (mostly 1 person per store) — a
// by-position or by-store breakdown, and the Сегмент/Перша лінія filters
// that scope by position, are just noise there, unlike SEB academy where
// the numbers are meaningful.
const SPARSE_PROJECTS = ['LEADER HUB 2.0', 'SERVICE HUB'];

const STATUS_COLORS = {
  good: '#2abd13',
  yellow: '#f0b400',
  orange: '#fc5e0f',
  red: '#e5342a',
};

const DISTRIBUTION_LABELS = {
  lt40: '< 40% (критично)',
  from40to69: '40–69% (слабко)',
  from70to89: '70–89% (треба уваги)',
  gte90: '≥ 90% (добре)',
};

/* ===================== state ===================== */

const state = {
  tab: 'overall',
  attestationPosition: null,
  projects: [], // [projectName, ...]  (SEB-style: person rows, tests/homework %)
  selectedProject: null,
  aepAvailable: false,
  selectedProjectKind: 'project', // 'project' (SEB-style) | 'aep' (topic/quarter-goal style)
  aepGoal: 100,
  aepTierFilter: '', // real roster tier filter — scoped to the attendance widgets, not the topics table
  streams: [],
  positionsConfig: [],
  filters: { region: '', store: '', position: '', segment: 'all', firstLine: 'all', search: '' },
  sort: { col: 'progress', dir: 'asc' },
  selectedPeriodId: null, // null = most recently uploaded period
  summary: null,
  periods: [],
  details: { rows: [], total: 0, shown: 0 },
  charts: {},
  loading: false,
  categoryAnalysis: { reports: [], categoryReportId: null, region: '', withApprovals: false, criteriaExpanded: false },
};

/* ===================== utils ===================== */

async function api(path, opts) {
  // Relative URL (no leading slash) so the app also works when served from a
  // subpath behind a reverse proxy, e.g. https://host/retail-lnd/.
  const res = await fetch(path.replace(/^\//, ''), {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Помилка запиту (${res.status})`);
  }
  return data;
}

function qs(params) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') usp.set(k, v);
  });
  return usp.toString();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function statusBucket(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  if (value >= 90) return 'good';
  if (value >= 70) return 'yellow';
  if (value >= 40) return 'orange';
  return 'red';
}

function fmtPct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${Math.round(value * 10) / 10}%`;
}

function fmtNum(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Math.round(value).toLocaleString('uk-UA');
}

function avg(sum, count) {
  return count > 0 ? sum / count : null;
}

let toastTimer = null;
function showToast(message, isError, durationMs) {
  const root = document.getElementById('toast-root');
  root.innerHTML = `<div class="toast ${isError ? 'error' : ''}">${escapeHtml(message)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { root.innerHTML = ''; }, durationMs || 4000);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ===================== pagination (client-side, over an already-fetched
   array — 10 rows at a time, with "show all" and prev/next escape hatches,
   for the various long person-list tables around the app) ===================== */

const PAGE_SIZE = 10;

function getPageState(key) {
  if (!state._pagination) state._pagination = {};
  if (!state._pagination[key]) state._pagination[key] = { page: 0, expanded: false };
  return state._pagination[key];
}

function resetPageState(key) {
  state._pagination = state._pagination || {};
  state._pagination[key] = { page: 0, expanded: false };
}

function pageSlice(key, rows) {
  const st = getPageState(key);
  if (st.expanded) return rows;
  const start = st.page * PAGE_SIZE;
  return rows.slice(start, start + PAGE_SIZE);
}

function paginationBarHtml(key, totalRows) {
  if (totalRows <= PAGE_SIZE) return '';
  const st = getPageState(key);
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  if (st.expanded) {
    return `
      <div class="pagination-bar">
        <span class="muted">Показано всі ${totalRows}.</span>
        <button class="btn btn-secondary btn-sm pg-btn" data-action="collapse" data-key="${key}">Згорнути до ${PAGE_SIZE}</button>
      </div>`;
  }
  return `
    <div class="pagination-bar">
      <button class="btn btn-secondary btn-sm pg-btn" data-action="prev" data-key="${key}" ${st.page === 0 ? 'disabled' : ''}>← Назад</button>
      <span class="muted">Сторінка ${st.page + 1} з ${totalPages} (${totalRows} усього)</span>
      <button class="btn btn-secondary btn-sm pg-btn" data-action="next" data-key="${key}" ${st.page >= totalPages - 1 ? 'disabled' : ''}>Далі →</button>
      <button class="btn btn-secondary btn-sm pg-btn" data-action="expand" data-key="${key}">Показати всі ${totalRows}</button>
    </div>`;
}

// Call after setting a pagination-bar container's innerHTML to
// paginationBarHtml(key, ...) — wires its buttons to update page state and
// call `rerender` (the same function that drew the table + this bar).
function wirePagination(container, key, rerender) {
  if (!container) return;
  container.querySelectorAll(`.pg-btn[data-key="${key}"]`).forEach((btn) => {
    btn.onclick = () => {
      const st = getPageState(key);
      if (btn.dataset.action === 'prev') st.page = Math.max(0, st.page - 1);
      else if (btn.dataset.action === 'next') st.page += 1;
      else if (btn.dataset.action === 'expand') st.expanded = true;
      else if (btn.dataset.action === 'collapse') { st.expanded = false; st.page = 0; }
      rerender();
    };
  });
}

/* ===================== excel parsing (client-side, per LMS export spec) ===================== */

function parsePercent(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number') return v <= 1 ? v * 100 : v;
  const s = String(v).replace('%', '').replace(',', '.').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function parseNum(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(',', '.').trim());
  return isNaN(n) ? 0 : n;
}

function extractRows(sheetRows) {
  let headerIdx = -1, cols = null;
  for (let i = 0; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    if (!row || !row.length) continue;
    const asStr = row.map((c) => String(c || '').trim());
    if (asStr.includes('Регіон') && asStr.includes('ПІБ')) { headerIdx = i; cols = asStr; break; }
  }
  if (headerIdx === -1) throw new Error('Не знайдено заголовок звіту (очікувались колонки «Регіон», «ПІБ»)');
  const idx = {
    region: cols.indexOf('Регіон'), store: cols.indexOf('Магазин'), position: cols.indexOf('Посада'),
    name: cols.indexOf('ПІБ'), assigned: cols.indexOf('Всього призначено'), completed: cols.indexOf('Пройдено'),
    progress: cols.indexOf('Прогрес'), score: cols.indexOf('Оцінка'),
  };
  const rows = [];
  for (let i = headerIdx + 1; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    if (!row || row.length === 0) continue;
    const region = row[idx.region], name = row[idx.name];
    if (!region && !name) continue;
    const assigned = parseNum(row[idx.assigned]);
    const completed = parseNum(row[idx.completed]);
    const progress = idx.progress > -1 ? parsePercent(row[idx.progress]) : (assigned > 0 ? (completed / assigned) * 100 : 0);
    const score = idx.score > -1 ? parsePercent(row[idx.score]) : 0;
    rows.push({
      region: String(row[idx.region] || '').trim(), store: String(row[idx.store] || '').trim(),
      position: String(row[idx.position] || '').trim(), name: String(row[idx.name] || '').trim(),
      assigned, completed,
      progress: Math.round(progress * 100) / 100, score: Math.round(score * 100) / 100,
    });
  }
  return rows;
}

async function readWorkbookRows(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const sheetRows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  return extractRows(sheetRows);
}

/* Project ("SEB-марафон"-style) course reports: Рейтинг/Регіон/Магазин/Посада/
   Таб.№/ПІБ/ІПН/Тест1..N/ДЗ.../Тести(%)/ДЗ("400 (70%)") — very different
   columns from the LMS assignment export above. */
function parseHomeworkCell(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/^(-?[\d.,]+)\s*\(([\d.,]+)\s*%\)$/);
  if (!m) {
    const score = parseNum(v);
    return { score, max: score, percent: 0 };
  }
  const score = parseNum(m[1]);
  const percent = parsePercent(`${m[2]}%`);
  // "400 (70%)" = 400 points scored, which is 70% of that person's max at
  // this point — max isn't printed directly, so back it out from the %.
  const max = percent > 0 ? Math.round(score / (percent / 100)) : score;
  return { score, max, percent };
}

function extractProjectRows(sheetRows) {
  let headerIdx = -1, cols = null;
  for (let i = 0; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    if (!row || !row.length) continue;
    const asStr = row.map((c) => String(c || '').trim());
    if (asStr.includes('Регіон') && asStr.includes('ПІБ')) { headerIdx = i; cols = asStr; break; }
  }
  if (headerIdx === -1) throw new Error('Не знайдено заголовок звіту (очікувались колонки «Регіон», «ПІБ»)');
  const idx = {
    region: cols.indexOf('Регіон'), store: cols.indexOf('Магазин'), position: cols.indexOf('Посада'),
    name: cols.indexOf('ПІБ'), tests: cols.indexOf('Тести'), homework: cols.indexOf('ДЗ'),
  };
  // Individual test columns ("Тест 1".."Тест N") — distinct from the summary
  // "Тести" column — let us count how many of the assigned tests a person
  // actually attempted, not just their average score.
  const testColumnIdx = cols
    .map((c, i) => (/^Тест \d+$/.test(c) ? i : -1))
    .filter((i) => i > -1);

  const rows = [];
  for (let i = headerIdx + 1; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    if (!row || row.length === 0) continue;
    const region = row[idx.region], name = row[idx.name];
    if (!region && !name) continue;
    const hw = idx.homework > -1 ? parseHomeworkCell(row[idx.homework]) : { score: 0, max: 0, percent: 0 };
    const testsAssignedCount = testColumnIdx.length;
    const testsCompletedCount = testColumnIdx.filter((ci) => parsePercent(row[ci]) > 0).length;
    rows.push({
      region: String(row[idx.region] || '').trim(), store: String(row[idx.store] || '').trim(),
      position: String(row[idx.position] || '').trim(), name: String(row[idx.name] || '').trim(),
      testsPercent: idx.tests > -1 ? parsePercent(row[idx.tests]) : 0,
      homeworkScore: hw.score, homeworkMax: hw.max, homeworkPercent: hw.percent,
      testsAssignedCount, testsCompletedCount,
    });
  }
  return rows;
}

async function readProjectWorkbookRows(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const sheetRows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  return extractProjectRows(sheetRows);
}

function detectProjectPositionClient(rows) {
  const counts = {};
  rows.forEach((r) => { if (r.position) counts[r.position] = (counts[r.position] || 0) + 1; });
  const entries = Object.entries(counts);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

/* AEP ("Графік тренінгів Apple") — Training_Planning sheet: one row per
   training-session SLOT. Dates in this sheet come both as real date cells
   and as human-typed text ("Tue, Jan 16, 2024 15:00" / "Wednesday, 10 July
   2024, 10:00") — both parse fine via Date.parse / are already Date objects. */
function parseAepDate(v) {
  if (v instanceof Date) return v;
  const ts = Date.parse(v);
  return isNaN(ts) ? null : new Date(ts);
}

function aepQuarterOf(d) {
  return Math.floor(d.getMonth() / 3) + 1;
}

function formatIsoDate(d) {
  if (!d) return '';
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// "Поточний" badge on a period selector means "this is the real calendar
// quarter right now" — not "the most recently uploaded period", which can
// lag behind once a new quarter starts before that quarter's data exists.
function isCurrentQuarter(year, quarter) {
  const now = new Date();
  return Number(year) === now.getFullYear() && Number(quarter) === Math.floor(now.getMonth() / 3) + 1;
}

// AEP periods carry year/quarter columns directly; "overall"/"attestation"
// periods don't (only a free-text label), but that label is always typed via
// the upload modal's quarter+year fields in a fixed "N квартал YYYY" shape —
// parse it back out. Project periods have neither, so they never badge.
function periodIsCurrentQuarter(p) {
  if (p.year && p.quarter) return isCurrentQuarter(p.year, p.quarter);
  const m = /^(\d+)\s*квартал\s*(\d+)/.exec(p.label || '');
  return m ? isCurrentQuarter(m[2], m[1]) : false;
}

function stripTopicSlot(topic) {
  return String(topic).replace(/\s*\(#?\d+\)\s*$/, '').trim();
}

// Only "Champions" is a program-tracked tier in the source data today —
// everything else (Retail, etc.) is treated as non-program participants.
function aepTierFor(audience) {
  return String(audience || '').trim() === 'Champions' ? 'Apple чемпіони' : 'Непрограмні учасники';
}

function extractAepRows(sheetRows) {
  let headerIdx = -1, cols = null;
  for (let i = 0; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    if (!row || !row.length) continue;
    const asStr = row.map((c) => String(c || '').trim());
    if (asStr.includes('Тема') && asStr.includes('Дата і час')) { headerIdx = i; cols = asStr; break; }
  }
  if (headerIdx === -1) throw new Error('Не знайдено заголовок звіту (очікувались колонки «Тема», «Дата і час»)');
  const idx = {
    program: cols.indexOf('Програма (Apple Certified / ASBIS Internal)'),
    responsible: cols.indexOf('Відповідальний'),
    eventType: cols.indexOf('Тип заходу'),
    audience: cols.indexOf('Цільова аудиторія'),
    date: cols.indexOf('Дата і час'),
    planned: cols.indexOf('Кількість учасників - план'),
    actual: cols.indexOf('Кількість учасників - факт'),
    topic: cols.indexOf('Тема'),
  };
  const rows = [];
  for (let i = headerIdx + 1; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    if (!row || row.length === 0) continue;
    const topicRaw = row[idx.topic];
    if (!topicRaw || !String(topicRaw).trim()) continue;
    const d = parseAepDate(row[idx.date]);
    if (!d) continue;
    // "факт" (actual attendance) is NOT a merged column — each slot has its
    // own cell. A blank cell on a date that's already fully in the past means
    // the session happened with 0 attendance (the organizer just didn't type
    // a 0) — count it as held. A blank cell on today's/a future date means
    // it genuinely hasn't been reported yet — it only becomes "held" once the
    // file is re-uploaded with факт filled in, not just because time passed.
    const actualRaw = row[idx.actual];
    const actualEntered = actualRaw !== '' && actualRaw !== undefined && actualRaw !== null;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfEventDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const held = actualEntered || startOfEventDay < startOfToday;
    rows.push({
      program: String(row[idx.program] || '').trim(),
      responsible: String(row[idx.responsible] || '').trim(),
      eventType: String(row[idx.eventType] || '').trim(),
      tier: aepTierFor(row[idx.audience]),
      topic: stripTopicSlot(topicRaw),
      planned: parseNum(row[idx.planned]),
      actual: parseNum(actualRaw),
      held,
      date: d.toISOString(),
      year: d.getFullYear(),
      quarter: aepQuarterOf(d),
    });
  }
  return rows;
}

// "Apple_Certified_-_Attendance" sheet — one row per PERSON per session
// (unlike Training_Planning, which is one row per session slot). Columns:
// Event Name, Starts, Attendee Status, First Name*, Last Name*, HQ address,
// HQ name, store address, store name. Used to cross-reference real attendees
// against the champions/reservists roster (see extractAepRosterRows).
function extractAepAttendanceRows(sheetRows) {
  if (!sheetRows || !sheetRows.length) return [];
  const cols = (sheetRows[0] || []).map((c) => String(c || '').trim());
  const idx = {
    event: cols.indexOf('Event Name'),
    starts: cols.indexOf('Starts'),
    status: cols.indexOf('Attendee Status'),
    first: cols.indexOf('First Name*'),
    last: cols.indexOf('Last Name*'),
    store: cols.indexOf('Назва точки продажу'),
  };
  if (idx.event === -1 || idx.starts === -1) return [];
  const rows = [];
  // The source export genuinely contains exact duplicate rows for some
  // people (same event+date+status+name repeated) — not a parsing artifact,
  // confirmed by inspecting the raw sheet. Deduping here keeps a person from
  // showing up twice in a single session's attendee list.
  const seen = new Set();
  for (let i = 1; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    if (!row || !row[idx.event]) continue;
    const d = parseAepDate(row[idx.starts]);
    if (!d) continue;
    const status = String(row[idx.status] || '').trim();
    const firstName = String(row[idx.first] || '').trim();
    const lastName = String(row[idx.last] || '').trim();
    const eventName = String(row[idx.event] || '').trim();
    const dedupeKey = `${eventName}|${d.toISOString()}|${status}|${firstName}|${lastName}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    rows.push({
      eventName,
      date: d.toISOString(),
      status,
      firstName,
      lastName,
      store: String(row[idx.store] || '').trim(),
      year: d.getFullYear(),
      quarter: aepQuarterOf(d),
    });
  }
  return rows;
}

// Sheet tab names in these Apple-exported files have drifted between
// uploads (e.g. "Apple_Certified_-_Attendance" one time, "Apple Certified -
// Attendance" another — underscores swapped for spaces) — matching the exact
// string silently returned no sheet and dropped a whole file's worth of data
// with no error. Compare on letters/digits only so spacing/punctuation/case
// differences never cause a silent miss.
function normalizeSheetName(name) {
  return String(name || '').toLowerCase().replace(/[^a-zа-яіїєґ0-9]/gi, '');
}

function findSheet(wb, targetName) {
  const target = normalizeSheetName(targetName);
  const match = wb.SheetNames.find((n) => normalizeSheetName(n) === target);
  return match ? wb.Sheets[match] : null;
}

async function readAepWorkbookRows(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const sheet = findSheet(wb, 'Training_Planning') || wb.Sheets[wb.SheetNames[0]];
  const sheetRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  const attendanceSheet = findSheet(wb, 'Apple_Certified_-_Attendance');
  const attendance = attendanceSheet
    ? extractAepAttendanceRows(XLSX.utils.sheet_to_json(attendanceSheet, { header: 1, defval: '', raw: true }))
    : [];
  return { rows: extractAepRows(sheetRows), attendance };
}

// "Резервісти та чемпіони" sheet in the separate roster file — store name is
// a merged cell spanning that store's people, so it's blank on every row but
// the first and must be carried forward manually while scanning.
function extractAepRosterRows(sheetRows) {
  if (!sheetRows || sheetRows.length < 2) return [];
  const cols = (sheetRows[0] || []).map((c) => String(c || '').trim());
  const idx = { store: cols.indexOf('Магазин'), name: cols.indexOf('ПІБ'), status: cols.indexOf('Статус') };
  if (idx.name === -1 || idx.status === -1) return [];
  const rows = [];
  let currentStore = '';
  for (let i = 1; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    if (!row) continue;
    const store = String(row[idx.store] || '').trim();
    if (store) currentStore = store;
    const name = String(row[idx.name] || '').trim();
    const status = String(row[idx.status] || '').trim();
    if (!name || name === 'Вакантне' || !status) continue;
    rows.push({ name, store: currentStore, status });
  }
  return rows;
}

async function readAepRosterWorkbookRows(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const sheet = findSheet(wb, 'Резервісти та чемпіони') || wb.Sheets[wb.SheetNames[0]];
  const sheetRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  return extractAepRosterRows(sheetRows);
}

// "Аттестация 2026 квартал 3 Комірники" — a per-position quarterly
// categorization/attestation file. Title row carries year/quarter/
// position; the data rows carry the raw metrics the category (1 = meets
// every condition, 2 = misses at least one) was computed from.
function extractCategoryReportRows(sheetRows) {
  if (!sheetRows || sheetRows.length < 3) throw new Error('Файл порожній або має неочікувану структуру');
  const titleRaw = String(sheetRows[0]?.[0] || '');
  const m = /(\d{4})\s*квартал\s*(\d)\s+(.+)/i.exec(titleRaw);
  if (!m) throw new Error('Не вдалося розпізнати заголовок «Аттестация YYYY квартал N Посада» у першому рядку файлу');
  const year = m[1], quarter = m[2], position = m[3].trim();
  const periodLabel = `${quarter} квартал ${year}`;

  let headerIdx = -1, cols = null;
  for (let i = 0; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    if (!row || !row.length) continue;
    const asStr = row.map((c) => String(c || '').trim());
    if (asStr.includes('ПІБ') && asStr.includes('Потенц. кат.')) { headerIdx = i; cols = asStr; break; }
  }
  if (headerIdx === -1) throw new Error('Не знайдено заголовок таблиці (очікувались колонки «ПІБ», «Потенц. кат.»)');
  const idx = {
    region: cols.indexOf('Регіон'), store: cols.indexOf('Магазин'),
    storeCategory: cols.indexOf('Кат-я м-на (Front/Back)'), complexityLevel: cols.indexOf('Рівень складності складу'),
    name: cols.indexOf('ПІБ'), login: cols.indexOf('Логін'),
    prevCategory: cols.indexOf('Попередня кат.'), potentialCategory: cols.indexOf('Потенц. кат.'),
    rkWish: cols.indexOf('Побажання РК'), rkComment: cols.indexOf('Коментар РК'),
    tests: cols.indexOf('Тести'), openQuestions: cols.indexOf('Відкриті питання'),
    processErrors: cols.indexOf('Помилки в проц.'),
    returnsFlag: cols.indexOf('Повернення на РЦ-Порожня коробка/некомплект'),
    unaccountedFlag: cols.indexOf('Неоприбуткований товар'),
    pickupSpeedRaw: cols.indexOf('Швидкість збору інтернет-замовлень, хв'),
    confirmed: cols.indexOf('Підтвердження'),
    hireDate: cols.indexOf('Дата прийому'),
  };
  // Everything except identity/context columns is a potential criteria
  // metric — captured generically by its exact header text so a
  // position-specific column (e.g. a merchandiser's "% утримання
  // обороту") works without any code change, not just the handful of
  // columns the storekeeper file happens to share.
  const identityCols = new Set([
    'Регіон', 'Магазин', 'Кат-я м-на (Front/Back)', 'Рівень складності складу',
    'ПІБ', 'Логін', 'Попередня кат.', 'Потенц. кат.', 'Побажання РК', 'Коментар РК',
    'Відкриті питання', 'Підтвердження', 'Дата прийому',
  ]);
  const metricCols = cols.map((c, i) => ({ name: c, i })).filter((c) => c.name && !identityCols.has(c.name));

  const rows = [];
  for (let i = headerIdx + 1; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    if (!row || !row[idx.name]) continue;
    const metrics = {};
    metricCols.forEach((c) => { metrics[c.name] = row[c.i]; });
    rows.push({
      region: String(row[idx.region] || '').trim(),
      store: String(row[idx.store] || '').trim(),
      storeCategory: String(row[idx.storeCategory] || '').trim(),
      complexityLevel: row[idx.complexityLevel],
      name: String(row[idx.name] || '').trim(),
      login: String(row[idx.login] || '').trim(),
      prevCategory: row[idx.prevCategory],
      potentialCategory: row[idx.potentialCategory],
      rkWish: String(row[idx.rkWish] || '').trim(),
      rkComment: String(row[idx.rkComment] || '').trim(),
      tests: row[idx.tests],
      openQuestions: String(row[idx.openQuestions] || '').trim(),
      processErrors: row[idx.processErrors],
      returnsFlag: String(row[idx.returnsFlag] || '').trim(),
      unaccountedFlag: String(row[idx.unaccountedFlag] || '').trim(),
      pickupSpeedRaw: String(row[idx.pickupSpeedRaw] || '').trim(),
      confirmed: String(row[idx.confirmed] || '').trim(),
      hireDate: formatIsoDate(parseAepDate(row[idx.hireDate])),
      metrics,
    });
  }
  return { position, periodLabel, rows };
}

async function readCategoryReportWorkbookRows(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const sheetRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  return extractCategoryReportRows(sheetRows);
}

function detectAttestationPositionClient(rows) {
  const counts = {};
  rows.forEach((r) => { if (r.position) counts[r.position] = (counts[r.position] || 0) + 1; });
  const entries = Object.entries(counts);
  if (!entries.length) return { canonical: null, raw: null };
  entries.sort((a, b) => b[1] - a[1]);
  const dominant = entries[0][0];
  // LMS exports aren't consistent about "Сервіс менеджер" vs "Сервіс-менеджер"
  // (and similar punctuation drift elsewhere) — a hyphen is treated the same
  // as a space here so matching doesn't silently break when the export
  // changes its formatting. Mirrors the same normalization server-side
  // (aggregate.py's detect_attestation_stream).
  const lower = dominant.toLowerCase().replace(/-/g, ' ');
  // Director titles matched via startsWith (not includes) so "Заступник керуючого
  // магазином з ..." (a deputy) doesn't false-match on "керуюч".
  const directorPrefixes = ['керуючий магазином', 'в/о керуючого магазином'];
  if (directorPrefixes.some((p) => lower.startsWith(p))) return { canonical: 'Директор', raw: dominant };
  const rules = [
    ['Товарознавець', ['товарознав']],
    ['Комірник', ['прийому і видачі товару', 'комірник']],
    ['Касир', ['касир']],
    ['Сервіс менеджер', ['роздрібній торгівлі побутовими товарами', 'сервіс менеджер']],
  ];
  for (const [canonical, kws] of rules) {
    if (kws.some((kw) => lower.includes(kw))) return { canonical, raw: dominant };
  }
  return { canonical: null, raw: dominant };
}

/* ===================== auth ===================== */

function showLogin() {
  document.getElementById('login-screen').hidden = false;
  document.getElementById('app').hidden = true;
}

function showApp() {
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app').hidden = false;
}

// roles: admin — everything; hr — «Все навчання», «Атестація», «Стажери»,
// «Кадровий резерв» (read) + work with potentials. The server enforces the
// same split; hiding here only keeps the page tidy.
const HR_TABS = ['overall', 'attestation', 'trainees', 'reserve'];
const ADMIN_ONLY_BUTTONS = ['btn-category-analysis', 'btn-classify', 'btn-feed-sync', 'btn-upload'];
function applyRole(data) {
  state.role = data.role || 'admin';
  state.user = data.user || null;
  const hr = state.role === 'hr';
  // KPI — only in the owner's account for now (the server checks it too)
  const tabAllowed = (t) => (t === 'kpi' ? !!data.accessOwner : !hr || HR_TABS.includes(t));
  document.querySelectorAll('.tabs .tab-btn[data-tab]').forEach((b) => { b.hidden = !tabAllowed(b.dataset.tab); });
  ADMIN_ONLY_BUTTONS.forEach((id) => { const b = document.getElementById(id); if (b) b.hidden = hr; });
  document.getElementById('btn-access').hidden = !data.accessOwner; // only the owner sets up access
  const u = state.user;
  document.getElementById('user-label').textContent = u ? `${u.short || u.fio || u.login}${hr ? ' · Регіональна команда' : ''}` : 'адмін';
  if (!tabAllowed(state.tab)) {
    state.tab = 'overall';
    document.querySelectorAll('.tabs .tab-btn[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'overall'));
  }
}

async function checkSession() {
  const data = await api('/api/session');
  if (data.authenticated) {
    applyRole(data);
    showApp();
    await bootstrap();
    watchFeedAuto();
  } else {
    showLogin();
  }
}

let loginByPassword = false; // the spare admin way in (site password)
function toggleLoginMode() {
  loginByPassword = !loginByPassword;
  document.getElementById('login-user').hidden = loginByPassword;
  document.getElementById('login-password').placeholder = loginByPassword ? 'Пароль сайту' : 'Пароль Feed';
  document.getElementById('login-subtitle').textContent = loginByPassword ? 'Запасний вхід для адміністратора' : 'Увійдіть з логіном і паролем Feed';
  document.getElementById('login-mode').textContent = loginByPassword ? 'Увійти через Feed' : 'Вхід адміністратора за паролем сайту';
  document.getElementById('login-error').textContent = '';
}

async function doLogin() {
  const user = document.getElementById('login-user');
  const input = document.getElementById('login-password');
  const btn = document.getElementById('login-submit');
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  if (!loginByPassword && !user.value.trim()) { errorEl.textContent = 'Введіть логін Feed'; return; }
  btn.disabled = true; btn.textContent = loginByPassword ? 'Перевіряю…' : 'Перевіряю у Feed…';
  try {
    // the Feed password goes to the dashboard server and on to Feed only
    const res = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginByPassword ? { password: input.value } : { login: user.value.trim(), password: input.value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Не вдалося увійти');
    input.value = '';
    applyRole(await api('/api/session'));
    showApp();
    await bootstrap();
    watchFeedAuto();
  } catch (e) {
    errorEl.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Увійти';
  }
}

// Sync on login (see maybe_start_feed_auto): the server refreshes the
// current quarter from Feed in the background; show that it's running and
// reload the open tab once it's done.
let feedAutoTimer = null;
async function watchFeedAuto(wasRunning = false) {
  clearTimeout(feedAutoTimer);
  const el = document.getElementById('feed-auto-note');
  let st;
  try { st = await api('/api/feed-auto'); } catch { el.hidden = true; return; }
  el.classList.toggle('running', !!st.running);
  if (st.running) {
    el.textContent = 'Оновлюю дані з Feed…';
    el.title = 'Звіти за поточний квартал оновлюються у фоні, можна працювати';
    el.hidden = false;
    feedAutoTimer = setTimeout(() => watchFeedAuto(true), 15000);
    return;
  }
  el.hidden = true; // the time of the last update is shown in «Востаннє оновлено» on each tab
  if (wasRunning) {
    await loadPositionsConfig();
    await loadStreams();
    renderPositionSwitch();
    state.selectedPeriodId = null;
    if (state.trainees) state.trainees.data = null;
    await refreshAll();
    showToast(st.lastSaved ? 'Дані з Feed оновлено' : 'Не вдалося оновити дані з Feed, показано попередні');
  }
}

async function doLogout() {
  clearTimeout(feedAutoTimer);
  await api('/api/logout', { method: 'POST' });
  showLogin();
}

/* ===================== bootstrap ===================== */

async function bootstrap() {
  await Promise.all([loadStreams(), loadPositionsConfig()]);
  renderPositionSwitch();
  await refreshAll();
}

async function loadStreams() {
  const data = await api('/api/streams');
  state.streams = data.streams;
  // Attestation opens on "Усі посади" — every position's report merged
  // (see _resolve_scope on the server); a single position is picked from
  // the "Посада" filter.
  if (!state.attestationPosition) state.attestationPosition = ATTESTATION_ALL;
  state.projects = data.projects || [];
  if (!state.selectedProject || !state.projects.includes(state.selectedProject)) {
    state.selectedProject = state.projects[0] || null;
  }
  state.aepAvailable = !!data.aepAvailable;
  state.aepLastUpdated = data.aepLastUpdated || null;
  if (state.selectedProjectKind === 'aep' && !state.aepAvailable) {
    state.selectedProjectKind = 'project';
  }
  if (state.selectedProjectKind === 'project' && !state.selectedProject && state.aepAvailable) {
    state.selectedProjectKind = 'aep';
  }
}

async function loadPositionsConfig() {
  const data = await api('/api/config');
  state.positionsConfig = data.positions;
}

function currentStream() {
  if (state.tab === 'overall') return { streamType: 'overall', streamKey: 'overall' };
  if (state.tab === 'project') {
    if (state.selectedProjectKind === 'aep') return { streamType: 'aep', streamKey: 'aep' };
    return { streamType: 'project', streamKey: state.selectedProject };
  }
  return { streamType: 'attestation', streamKey: state.attestationPosition };
}

function isProjectStream() {
  return state.tab === 'project' && state.selectedProjectKind === 'project';
}

function isAepStream() {
  return state.tab === 'project' && state.selectedProjectKind === 'aep';
}

// "Продавець" attestation data was pulled from an LMS report that only ever
// gives a final score — assigned/completed/progress are all faked as 1/1/100%
// to fit the shared schema, so progress-based UI would just show a flat,
// meaningless 100% for every single person. Score is the only real number.
function isProdavetsAttestation() {
  return state.tab === 'attestation' && state.attestationPosition === 'Продавець';
}

function streamHasData(streamType, streamKey) {
  return state.streams.some((s) => s.streamType === streamType && s.streamKey === streamKey);
}

/* ===================== tabs / position switch ===================== */

function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderPositionSwitch();
      resetFilters();
      await refreshAll();
    });
  });
}

function renderPositionSwitch() {
  const el = document.getElementById('position-switch');
  if (state.tab === 'attestation') {
    // position is picked in the filters bar (see #f-att-position)
    el.hidden = true;
    el.innerHTML = '';
    return;
  }

  if (state.tab === 'project') {
    el.hidden = false;
    if (!state.projects.length && !state.aepAvailable) {
      el.innerHTML = '<p class="muted">Ще немає жодного проєкту — завантажте дані.</p>';
      return;
    }
    const projectChips = state.projects.map((name) =>
      `<button class="position-chip ${state.selectedProjectKind === 'project' && name === state.selectedProject ? 'active' : ''}" data-project="${escapeHtml(name)}">${escapeHtml(name)}</button>`
    ).join('');
    const aepChip = state.aepAvailable
      ? `<button class="position-chip ${state.selectedProjectKind === 'aep' ? 'active' : ''}" data-aep="1">AEP</button>`
      : '';
    el.innerHTML = projectChips + aepChip;
    el.querySelectorAll('[data-project]').forEach((chip) => {
      chip.addEventListener('click', async () => {
        state.selectedProjectKind = 'project';
        state.selectedProject = chip.dataset.project;
        renderPositionSwitch();
        resetFilters();
        await refreshAll();
      });
    });
    const aepBtn = el.querySelector('[data-aep]');
    if (aepBtn) {
      aepBtn.addEventListener('click', async () => {
        state.selectedProjectKind = 'aep';
        renderPositionSwitch();
        resetFilters();
        await refreshAll();
      });
    }
    return;
  }

  el.hidden = true; el.innerHTML = '';
}

function resetFilters() {
  state.filters = { region: '', store: '', position: '', topic: '', segment: 'all', firstLine: 'all', search: '' };
  state.sort = { col: isProjectStream() ? 'testsPercent' : 'progress', dir: 'asc' };
  state.selectedPeriodId = null;
  state.aepTierFilter = '';
}

// null selectedPeriodId means "most recently uploaded" — periods come back
// ascending by upload time, so that's simply the last entry.
function resolveSelectedPeriod() {
  if (!state.periods.length) return null;
  if (state.selectedPeriodId != null) {
    const found = state.periods.find((p) => p.id === state.selectedPeriodId);
    if (found) return found;
  }
  return state.periods[state.periods.length - 1];
}

/* ===================== data refresh ===================== */

async function refreshAll() {
  if (state.tab === 'trainees') { await renderTraineesView(); return; }
  if (state.tab === 'kpi') { await renderKpiView(); return; }
  if (state.tab === 'reserve') { await renderReserveView(); return; }
  const { streamType, streamKey } = currentStream();
  const contentArea = document.getElementById('content-area');

  await fetchPeriods();

  if (!state.periods.length) {
    contentArea.innerHTML = emptyStateHtml();
    document.getElementById('btn-upload-empty') && (document.getElementById('btn-upload-empty').onclick = openUploadModal);
    return;
  }

  contentArea.innerHTML = isAepStream() ? aepShellHtml() : dashboardShellHtml();
  renderTrendChart();
  await refreshFilterOptions();
  renderFiltersBar();
  await (isAepStream() ? refreshSummary() : Promise.all([refreshSummary(), refreshDetails()]));
}

async function refreshFilterOptions() {
  const { streamType, streamKey } = currentStream();
  const periodId = resolveSelectedPeriod()?.id || '';
  const data = await api(`/api/latest?${qs({ streamType, streamKey, periodId })}`);
  state._filterOptions = data.filters || { regions: [], positions: [], storesByRegion: {} };
}

// Region/store/position stay selected when switching period — only cleared if
// the new period genuinely doesn't have that value (e.g. a closed store).
function reconcileFiltersWithOptions() {
  const opts = state._filterOptions || { regions: [], positions: [], storesByRegion: {} };
  const f = state.filters;
  if (f.region && !opts.regions.includes(f.region)) f.region = '';
  if (f.position && !opts.positions.includes(f.position)) f.position = '';
  if (f.topic && !(opts.topics || []).includes(f.topic)) f.topic = '';
  const validStores = f.region ? (opts.storesByRegion[f.region] || []) : Object.values(opts.storesByRegion).flat();
  if (f.store && !validStores.includes(f.store)) f.store = '';
}

async function refreshSummary() {
  const { streamType, streamKey } = currentStream();
  const periodId = resolveSelectedPeriod()?.id || '';
  const fp = filterParams();
  const data = await api(`/api/summary?${qs({ streamType, streamKey, periodId, ...fp })}`);
  state.summary = data;
  // a region (or store) is picked: the «за регіонами» charts still show every
  // region for comparison (same other filters), the picked one highlighted
  state.regionCompare = null;
  if (!isAepStream() && (fp.region || fp.store)) {
    const all = await api(`/api/summary?${qs({ streamType, streamKey, periodId, ...fp, region: '', store: '' })}`);
    const byStore = state._filterOptions && state._filterOptions.storesByRegion;
    const hl = fp.region || (byStore ? Object.keys(byStore).find((r) => (byStore[r] || []).includes(fp.store)) : '') || '';
    state.regionCompare = { byRegion: all.byRegion || {}, highlight: hl };
    // stores of the region: when a store is picked too, all of the region's
    // stores (the picked one highlighted)
    state.storeCompare = !hl ? null : fp.store
      ? { region: hl, byStore: (await api(`/api/summary?${qs({ streamType, streamKey, periodId, ...fp, region: hl, store: '' })}`)).byStore || {}, highlight: fp.store }
      : { region: hl, byStore: data.byStore || {}, highlight: '' };
  } else {
    state.storeCompare = null;
  }
  if (isAepStream()) {
    state.aepGoal = data.aepGoal || 100;
    renderKPIs();
    renderAepTopicsTable();
    await refreshAepAttendance();
    return;
  }
  renderKPIs();
  renderPositionChart();
  renderRegionChart();
  renderPositionScoreChart();
  renderRegionScoreChart();
  if (isProjectStream()) {
    renderPositionEngagementChart();
    renderRegionEngagementChart();
  }
  renderDistributionChart();
  renderStoreCharts();
  renderStoresTable();
  await refreshTopicsTable();
}

async function fetchPeriods() {
  const { streamType, streamKey } = currentStream();
  const data = await api(`/api/periods?${qs({ streamType, streamKey })}`);
  state.periods = data.periods;
}

async function refreshDetails() {
  if (!document.getElementById('employees-table')) return; // AEP has no per-session table
  const { streamType, streamKey } = currentStream();
  const periodId = resolveSelectedPeriod()?.id || '';
  const data = await api(`/api/details?${qs({
    streamType, streamKey, periodId, ...filterParams(),
    search: state.filters.search, sort: state.sort.col, dir: state.sort.dir, limit: 400,
  })}`);
  state.details = data;
  resetPageState('employees');
  renderEmployeesTable();
}

async function refreshCurrentPeriodView() {
  await refreshFilterOptions();
  reconcileFiltersWithOptions();
  renderFiltersBar();
  await (isAepStream() ? refreshSummary() : Promise.all([refreshSummary(), refreshDetails()]));
}

function filterParams() {
  const f = state.filters;
  return {
    region: f.region, store: f.store, position: f.position, topic: f.topic,
    segment: f.segment !== 'all' ? f.segment : '',
    firstLine: f.firstLine !== 'all' ? f.firstLine : '',
  };
}

/* ===================== shell / empty state ===================== */

function emptyStateHtml() {
  let label = 'загальні дані';
  if (state.tab === 'attestation') label = `дані з атестації (${state.attestationPosition === ATTESTATION_ALL ? 'усі посади' : state.attestationPosition})`;
  if (state.tab === 'project') {
    label = isAepStream() ? 'AEP' : (state.selectedProject ? `проєкт «${state.selectedProject}»` : 'проєкти');
  }
  return `<div class="empty-state">
    <h2>Ще немає даних</h2>
    <p>Для цього розрізу (${escapeHtml(label)}) ще не завантажено жодного звіту.</p>
    <button class="btn btn-primary" id="btn-upload-empty">Завантажити дані</button>
  </div>`;
}

function aepShellHtml() {
  // No per-session table — with only a handful of topics per quarter, the
  // topic+slot-count rollup below is the whole picture; per-session detail
  // (and who trained it) doesn't add anything at this scale.
  return `
    <div class="last-updated-note" id="last-updated-note"></div>
    <div class="filters" id="filters-bar"></div>
    <div class="kpi-grid" id="kpi-grid"></div>
    <div class="kpi-grid" id="aep-tier-kpi-grid" hidden></div>
    <div class="card">
      <h3>Теми цього кварталу</h3>
      <div class="table-scroll"><table class="data-table" id="aep-topics-table"></table></div>
    </div>
    <div class="card" id="aep-attendance-session-card" hidden>
      <h3>Відвідуваність по тренінгу</h3>
      <div class="field-group" style="max-width:480px;">
        <label>Тренінг</label>
        <select id="aep-session-select"></select>
      </div>
      <div class="table-scroll"><table class="data-table" id="aep-session-attendees-table"></table></div>
      <div id="aep-session-attendees-pagination"></div>
    </div>
    <div class="card" id="aep-no-shows-card" hidden>
      <h3>Систематично не відвідують <span id="aep-no-shows-subtitle" class="muted"></span></h3>
      <p class="field-hint">Чемпіони й резервісти, скільки з усіх тренінгів цього кварталу вони реально відвідали (включно з тими, на які навіть не записались).</p>
      <div class="position-switch" id="aep-no-shows-tier-switch"></div>
      <div class="table-scroll"><table class="data-table" id="aep-no-shows-table"></table></div>
      <div id="aep-no-shows-pagination"></div>
    </div>
    <div class="card" id="aep-name-suggestions-card" hidden>
      <h3>Можливі збіги імен</h3>
      <p class="field-hint">Ці записи з журналу відвідуваності не знайшлись у ростері автоматично (одрук чи скорочений підпис) — перевірте та об'єднайте, якщо це та сама людина.</p>
      <div id="aep-name-suggestions-list"></div>
    </div>
    <div class="card">
      <h3>Динаміка по кварталах</h3>
      <div class="chart-wrap"><canvas id="chart-trend" height="220"></canvas></div>
    </div>
  `;
}

function dashboardShellHtml() {
  const p = isProjectStream();
  const isSparseProject = p && SPARSE_PROJECTS.includes(state.selectedProject);
  const hidePositionCharts = isSparseProject;
  const hideProgress = !p && isProdavetsAttestation();
  const t1 = p ? 'Середній результат тестів за посадами' : 'Прогрес за посадами';
  const t2 = p ? 'Середній результат тестів за регіонами' : 'Прогрес за регіонами';
  const t3 = p ? 'Середній результат ДЗ за посадами' : 'Середня оцінка за посадами';
  const t4 = p ? 'Середній результат ДЗ за регіонами' : 'Середня оцінка за регіонами';
  const t5 = p ? 'Розподіл за результатом тестів' : 'Розподіл за прогресом';
  const t6 = p ? 'Магазини (від найгіршого результату: тести + ДЗ, 50/50)' : 'Магазини (від найгіршого прогресу)';
  const regionOnlyCard = (title, canvasId, wrapId) => `<div class="card"><h3>${title}</h3><div class="chart-wrap"${wrapId ? ` id="${wrapId}"` : ''}><canvas id="${canvasId}" height="220"></canvas></div></div>`;
  return `
    <div class="last-updated-note" id="last-updated-note"></div>
    <div class="filters" id="filters-bar"></div>
    <div class="kpi-grid" id="kpi-grid"></div>
    ${p && !hidePositionCharts ? `
    <div class="grid-2">
      <div class="card"><h3>% залученості за посадами</h3><div class="chart-wrap"><canvas id="chart-position-engagement" height="220"></canvas></div></div>
      <div class="card"><h3>% залученості за регіонами</h3><div class="chart-wrap"><canvas id="chart-region-engagement" height="220"></canvas></div></div>
    </div>` : ''}
    ${hidePositionCharts ? `
    <div class="grid-2">
      ${regionOnlyCard('% залученості за регіонами', 'chart-region-engagement')}
      ${regionOnlyCard(t2, 'chart-region')}
    </div>
    <div class="grid-2">
      ${regionOnlyCard(t4, 'chart-region-score')}
      ${regionOnlyCard(t5, 'chart-distribution', 'chart-distribution-wrap')}
    </div>` : hideProgress ? `
    <div class="grid-2">
      <div class="card"><h3>${t3}</h3><div class="chart-wrap"><canvas id="chart-position-score" height="220"></canvas></div></div>
      <div class="card"><h3>${t4}</h3><div class="chart-wrap"><canvas id="chart-region-score" height="220"></canvas></div></div>
    </div>
    <div class="card"><h3>Динаміка по періодах</h3><div class="chart-wrap"><canvas id="chart-trend" height="220"></canvas></div></div>` : `
    <div class="grid-2">
      <div class="card"><h3>${t1}</h3><div class="chart-wrap"><canvas id="chart-position" height="220"></canvas></div></div>
      <div class="card"><h3>${t2}</h3><div class="chart-wrap"><canvas id="chart-region" height="220"></canvas></div></div>
    </div>
    <div class="grid-2">
      <div class="card"><h3>${t3}</h3><div class="chart-wrap"><canvas id="chart-position-score" height="220"></canvas></div></div>
      <div class="card"><h3>${t4}</h3><div class="chart-wrap"><canvas id="chart-region-score" height="220"></canvas></div></div>
    </div>
    <div class="grid-2">
      <div class="card"><h3>${t5}</h3><div class="chart-wrap" id="chart-distribution-wrap"><canvas id="chart-distribution" height="220"></canvas></div></div>
      <div class="card"><h3>Динаміка по періодах</h3><div class="chart-wrap"><canvas id="chart-trend" height="220"></canvas></div></div>
    </div>`}
    <div class="grid-2" id="store-charts" hidden>
      <div class="card" id="store-progress-card"><h3 id="store-progress-title"></h3><div class="chart-wrap" id="store-progress-wrap"><canvas id="chart-store"></canvas></div></div>
      <div class="card" id="store-score-card"><h3 id="store-score-title"></h3><div class="chart-wrap" id="store-score-wrap"><canvas id="chart-store-score"></canvas></div></div>
    </div>
    ${p || hideProgress ? '' : `
    <div class="card" id="topics-card" hidden>
      <h3>Результати по темах</h3>
      <div class="table-scroll"><table class="data-table" id="topics-table"></table></div>
      <div class="table-note">Натисніть на тему, щоб відфільтрувати по ній увесь дашборд.</div>
    </div>`}
    ${isSparseProject ? '' : `
    <div class="card">
      <h3>${hideProgress ? 'Магазини (від найгіршої оцінки)' : t6}</h3>
      <div class="table-scroll"><table class="data-table" id="stores-table"></table></div>
    </div>`}
    <div class="card" id="employees-card">
      <div class="table-toolbar">
        <h3 class="mt-0">Співробітники</h3>
        <div class="filter-field" style="min-width:260px;"><label for="employee-search">ПІБ працівника</label><input type="text" class="search-input" id="employee-search" placeholder="Пошук за ПІБ…"></div>
      </div>
      <div class="table-scroll"><table class="data-table" id="employees-table"></table></div>
      <div class="table-note" id="employees-note"></div>
      <div id="employees-pagination"></div>
    </div>
  `;
}

/* ===================== filters bar ===================== */

function renderFiltersBar() {
  const el = document.getElementById('filters-bar');
  // state.periods already arrives in the correct chronological order from
  // the backend (by period_year/quarter for AEP, by uploaded_at otherwise) —
  // just reverse it for "most recent first" instead of re-sorting client-side
  // (parsing ISO timestamps with microsecond precision is unreliable in JS
  // Date, and ties from same-transaction inserts made re-sorting unstable).
  const sortedPeriods = [...state.periods].reverse();
  const selected = resolveSelectedPeriod();

  const periodFieldHtml = `
    <div class="filter-field">
      <label>Період</label>
      <select id="f-period">${sortedPeriods.map((p) => `<option value="${p.id}" ${selected && p.id === selected.id ? 'selected' : ''}>${escapeHtml(p.label)}${periodIsCurrentQuarter(p) ? ' (поточний)' : ''}</option>`).join('')}</select>
    </div>
  `;

  const f = state.filters;
  const aep = isAepStream();
  const isSparseProject = isProjectStream() && SPARSE_PROJECTS.includes(state.selectedProject);
  const opts = state._filterOptions || { regions: [], positions: [], storesByRegion: {} };
  // For AEP, "Рівень" no longer drives state.filters.region (see below), so
  // it can't scope "Тип заходу" options the way Регіон scopes Магазин for
  // the other streams — always show every event type.
  const stores = !aep && f.region ? (opts.storesByRegion[f.region] || []) : Object.values(opts.storesByRegion).flat();

  const regionLabel = aep ? 'Рівень' : 'Регіон';
  const regionAllLabel = aep ? 'Усі рівні' : 'Усі регіони';
  const storeLabel = aep ? 'Тип заходу' : 'Магазин';
  const storeAllLabel = aep ? 'Усі типи' : 'Усі магазини';
  const positionLabel = aep ? 'Тема' : 'Посада';
  const positionAllLabel = aep ? 'Усі теми' : 'Усі посади';
  // For AEP this is the REAL per-person tier (from the roster, matched
  // against actual attendance) — not the session's "Цільова аудиторія" tag,
  // which is a single value per training and can't tell champions from
  // reservists. It drives the attendance widgets (which have per-person
  // data); the topics table's План/Факт stay whole-audience numbers, since
  // the source file never splits a session's plan by tier.
  const regionOptionsHtml = aep
    ? AEP_TIER_ORDER.map((t) => `<option value="${escapeHtml(t)}" ${t === state.aepTierFilter ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')
    : opts.regions.map((r) => `<option value="${escapeHtml(r)}" ${r === f.region ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('');

  el.innerHTML = `
    ${periodFieldHtml}
    <div class="filter-field">
      <label>${regionLabel}</label>
      <select id="f-region"><option value="">${regionAllLabel}</option>${regionOptionsHtml}</select>
    </div>
    <div class="filter-field">
      <label>${storeLabel}</label>
      <select id="f-store"><option value="">${storeAllLabel}</option>${[...new Set(stores)].sort().map((s) => `<option value="${escapeHtml(s)}" ${s === f.store ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}</select>
    </div>
    ${state.tab === 'attestation' ? `
    <div class="filter-field">
      <label>Посада</label>
      <select id="f-att-position"><option value="">Усі посади</option>${ATTESTATION_STREAMS.filter((p) => streamHasData('attestation', p)).map((p) => `<option value="${escapeHtml(p)}" ${p === state.attestationPosition ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}</select>
    </div>` : `
    <div class="filter-field">
      <label>${positionLabel}</label>
      <select id="f-position"><option value="">${positionAllLabel}</option>${opts.positions.map((p) => `<option value="${escapeHtml(p)}" ${p === f.position ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}</select>
    </div>`}
    ${aep || isProjectStream() || !(opts.topics || []).length ? '' : `
    <div class="filter-field filter-wide">
      <label>Тема</label>
      <select id="f-topic"><option value="">Усі теми</option>${opts.topics.map((t) => `<option value="${escapeHtml(t)}" ${t === f.topic ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select>
    </div>`}
    ${(aep || isSparseProject) ? '' : `
    <div class="filter-field">
      <label>Сегмент</label>
      <select id="f-segment">
        <option value="all" ${f.segment === 'all' ? 'selected' : ''}>Усі</option>
        <option value="front" ${f.segment === 'front' ? 'selected' : ''}>Фронт</option>
        <option value="back" ${f.segment === 'back' ? 'selected' : ''}>Бек</option>
      </select>
    </div>
    <div class="filter-field">
      <label>Перша лінія</label>
      <select id="f-firstline">
        <option value="all" ${f.firstLine === 'all' ? 'selected' : ''}>Усі</option>
        <option value="only" ${f.firstLine === 'only' ? 'selected' : ''}>Тільки перша лінія</option>
        <option value="exclude" ${f.firstLine === 'exclude' ? 'selected' : ''}>Без керівництва</option>
      </select>
    </div>`}
    <button class="btn btn-secondary btn-sm filter-reset" id="f-reset">Скинути фільтри</button>
  `;

  const noteEl = document.getElementById('last-updated-note');
  if (noteEl) {
    const { streamType, streamKey } = currentStream();
    const d = lastUpdatedFor(streamType, streamKey);
    noteEl.textContent = d ? `Востаннє оновлено: ${d}` : '';
  }

  document.getElementById('f-period').addEventListener('change', async (e) => {
    state.selectedPeriodId = Number(e.target.value);
    await refreshCurrentPeriodView();
  });
  document.getElementById('f-region').addEventListener('change', async (e) => {
    if (aep) {
      // Real per-person tier — filters the attendance widgets only, not the
      // topics table (see the comment where regionOptionsHtml is built).
      state.aepTierFilter = e.target.value;
      await refreshAepSessionAndNoShows();
      return;
    }
    state.filters.region = e.target.value; state.filters.store = '';
    await refreshSummary(); await refreshDetails(); renderFiltersBar();
  });
  document.getElementById('f-store').addEventListener('change', async (e) => {
    state.filters.store = e.target.value; await refreshSummary(); await refreshDetails();
  });
  document.getElementById('f-position')?.addEventListener('change', async (e) => {
    state.filters.position = e.target.value; await refreshSummary(); await refreshDetails();
  });
  document.getElementById('f-att-position')?.addEventListener('change', async (e) => {
    // Each position is its own stream (own period ids) — switch stream but
    // stay on the same quarter and keep region / store.
    const label = resolveSelectedPeriod()?.label;
    const { region, store } = state.filters;
    state.attestationPosition = e.target.value || ATTESTATION_ALL;
    resetFilters();
    Object.assign(state.filters, { region, store });
    await fetchPeriods();
    state.selectedPeriodId = state.periods.find((p) => p.label === label)?.id ?? null;
    await refreshAll();
  });
  document.getElementById('f-topic')?.addEventListener('change', async (e) => {
    state.filters.topic = e.target.value; await refreshSummary(); await refreshDetails();
  });
  document.getElementById('f-segment')?.addEventListener('change', async (e) => {
    state.filters.segment = e.target.value; await refreshSummary(); await refreshDetails();
  });
  document.getElementById('f-firstline')?.addEventListener('change', async (e) => {
    state.filters.firstLine = e.target.value; await refreshSummary(); await refreshDetails();
  });
  document.getElementById('f-reset').addEventListener('click', async () => {
    const keepPeriod = state.selectedPeriodId;
    resetFilters(); state.selectedPeriodId = keepPeriod;
    renderFiltersBar(); await refreshSummary(); await refreshDetails();
    const searchEl = document.getElementById('employee-search');
    if (searchEl) searchEl.value = '';
  });

  const searchInput = document.getElementById('employee-search');
  if (searchInput) {
    searchInput.value = f.search;
    searchInput.addEventListener('input', debounce(async (e) => {
      state.filters.search = e.target.value;
      await refreshDetails();
    }, 300));
  }
}

/* ===================== KPI ===================== */

function renderKPIs() {
  const t = state.summary.totals;
  let tiles;
  if (isAepStream()) {
    const topics = Object.values(state.summary.byPosition);
    // "Held" = actual attendance was reported for the slot — a slot whose date
    // has passed but has no факт data entered yet doesn't count as held.
    const heldSessions = topics.reduce((s, b) => s + (b.sessions || []).filter((se) => se.held).length, 0);
    // Average attendance per session that already happened, extrapolated across
    // ALL planned sessions this quarter (not just the held ones). t.completed
    // already only reflects held sessions (a not-yet-held slot's факт is
    // always blank -> 0). Measured against план — but only the план that
    // belongs to sessions that already happened, not the whole quarter's plan.
    // План is merged across a topic's slot rows (only the first slot carries
    // the real value), so it's prorated per topic by its held-slot fraction
    // (e.g. 1 of 4 slots held -> 1/4 of that topic's план counts) before
    // totalling across topics.
    const avgPerSession = heldSessions > 0 ? t.completed / heldSessions : null;
    const projectedTotal = avgPerSession !== null ? avgPerSession * t.count : null;
    const plannedForHeld = topics.reduce((s, b) => {
      const heldCount = (b.sessions || []).filter((se) => se.held).length;
      return s + (b.count ? b.assigned * (heldCount / b.count) : 0);
    }, 0);
    const projectedEngagement = projectedTotal !== null && plannedForHeld > 0
      ? fmtPct((projectedTotal / plannedForHeld) * 100)
      : fmtPct(null);
    tiles = [
      { label: 'Загальна залученість', value: fmtPct(avg(t.completed * 100, t.assigned)), accent: 'green' },
      { label: 'Прогнозована залученість', value: projectedEngagement, accent: 'green' },
      { label: 'Заплановано сесій', value: fmtNum(t.count), accent: '' },
      { label: 'Проведено сесій', value: fmtNum(heldSessions), accent: '' },
    ];
  } else if (isProjectStream()) {
    const notActive = t.count - t.active;
    tiles = [
      { label: 'Залучено', value: fmtNum(t.count), accent: '' },
      { label: 'Фактично бере участь', value: fmtNum(t.active), accent: 'green' },
      { label: '% хоч раз взяли участь', value: fmtPct(avg(t.active * 100, t.count)), accent: 'green' },
      { label: 'Ще не розпочали', value: fmtNum(notActive), accent: 'red' },
      { label: '% проходження тестів', value: fmtPct(avg(t.testsCompletedSum * 100, t.testsAssignedSum)), accent: 'green' },
      { label: 'Складено тестів', value: `${fmtNum(t.testsCompletedSum)} з ${fmtNum(t.testsAssignedSum)}`, accent: '' },
      { label: 'Середній % тестів', value: fmtPct(avg(t.testsSum, t.count)), accent: '' },
      { label: 'Середній % ДЗ', value: fmtPct(avg(t.homeworkPercentSum, t.count)), accent: '' },
    ];
  } else if (isProdavetsAttestation()) {
    // No real assigned/completed/progress data for this stream (see
    // isProdavetsAttestation) — score is the only honest number here.
    // "Not started" here = no attestation mark yet this quarter (see
    // fetch_sellers_report) — so engagement is the share that has one.
    const totalPeople = t.count + t.noAssignment + (t.scoreOnly || 0);
    tiles = [
      { label: 'Середня оцінка', value: fmtPct(avg(t.scoreSum, t.scoreCount)), accent: 'green' },
      { label: 'Залученість', value: fmtPct(avg((t.count - t.notStarted) * 100, t.count)), accent: 'green' },
      { label: 'Співробітників у вибірці', value: fmtNum(totalPeople), accent: '' },
      { label: 'Ще не розпочали', value: fmtNum(t.notStarted), accent: 'red' },
    ];
  } else {
    const totalPeople = t.count + t.noAssignment + (t.scoreOnly || 0);
    tiles = [
      { label: 'Середній прогрес', value: fmtPct(avg(t.progressSum, t.count)), accent: 'green' },
      { label: 'Середня оцінка', value: fmtPct(avg(t.scoreSum, t.scoreCount)), accent: 'green' },
      { label: 'Співробітників у вибірці', value: fmtNum(totalPeople), accent: '' },
      { label: 'Ще не розпочали', value: fmtNum(t.notStarted), accent: 'red' },
      { label: 'Без призначеного навчання', value: fmtNum(t.noAssignment), accent: 'muted' },
      { label: 'Призначено занять', value: fmtNum(t.assigned), accent: '' },
      { label: 'Пройдено занять', value: fmtNum(t.completed), accent: '' },
    ];
  }
  const grid = document.getElementById('kpi-grid');
  grid.innerHTML = tiles.map((tl) => `
    <div class="kpi-tile ${tl.accent ? `accent-${tl.accent}` : ''}">
      <div class="kpi-value">${tl.value}</div>
      <div class="kpi-label">${escapeHtml(tl.label)}</div>
    </div>`).join('');
  // Up to 7 tiles fit comfortably in a single row (one exact column per
  // tile); beyond that (the 8-tile project view) falls back to the default
  // 4-per-row wrap from .kpi-grid — one long row of 8 skinny tiles reads
  // worse than two balanced rows of 4. Skipped on narrow screens so the
  // mobile 2-per-row fallback (see the @media rule) still applies.
  const isNarrow = window.matchMedia('(max-width: 860px)').matches;
  grid.style.gridTemplateColumns = (!isNarrow && tiles.length <= 7) ? `repeat(${tiles.length}, 1fr)` : '';
}

/* ===================== charts ===================== */

function destroyChart(key) {
  if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; }
}

function barChartColors(values) {
  return values.map((v) => STATUS_COLORS[statusBucket(v)] || '#c7cad1');
}

function renderBucketBarChart(chartKey, canvasId, bucket, sumField, countField = 'count', highlight = '') {
  destroyChart(chartKey);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return; // e.g. the "за посадами" card is hidden for this project
  const entries = Object.entries(bucket)
    .map(([k, b]) => [k, avg(b[sumField], b[countField])])
    .filter(([, v]) => v !== null)
    .sort((a, b) => a[1] - b[1]);
  state.charts[chartKey] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: entries.map((e) => e[0]),
      datasets: [{ data: entries.map((e) => Math.round(e[1] * 10) / 10), backgroundColor: highlightColors(entries, highlight), borderRadius: 6 }],
    },
    options: chartBarOptions(entries.map((e) => e[0]), highlight),
  });
}

function renderPositionChart() {
  const field = isProjectStream() ? 'testsSum' : 'progressSum';
  renderBucketBarChart('position', 'chart-position', state.summary.byPosition, field);
}

// «за магазинами регіону»: shown only when a region (or a store) is picked
function renderStoreCharts() {
  const box = document.getElementById('store-charts');
  if (!box) return;
  destroyChart('store'); destroyChart('storeScore');
  const sc = state.storeCompare;
  box.hidden = !sc;
  if (!sc) return;
  const project = isProjectStream(), scoreOnly = !project && isProdavetsAttestation();
  const n = Object.keys(sc.byStore).length;
  const h = `${Math.max(220, n * 26 + 50)}px`;
  ['store-progress-wrap', 'store-score-wrap'].forEach((id) => { document.getElementById(id).style.height = h; });
  document.getElementById('store-progress-title').textContent = `${project ? 'Середній результат тестів' : 'Прогрес'} за магазинами · ${sc.region}`;
  document.getElementById('store-score-title').textContent = `${project ? 'Середній результат ДЗ' : 'Середня оцінка'} за магазинами · ${sc.region}`;
  document.getElementById('store-progress-card').hidden = scoreOnly;
  if (!scoreOnly) renderBucketBarChart('store', 'chart-store', sc.byStore, project ? 'testsSum' : 'progressSum', 'count', sc.highlight);
  renderBucketBarChart('storeScore', 'chart-store-score', sc.byStore, project ? 'homeworkPercentSum' : 'scoreSum', project ? 'count' : 'scoreCount', sc.highlight);
}

const regionBucket = () => (state.regionCompare ? state.regionCompare.byRegion : state.summary.byRegion);
const regionHighlight = () => (state.regionCompare ? state.regionCompare.highlight : '');

function renderRegionChart() {
  const field = isProjectStream() ? 'testsSum' : 'progressSum';
  renderBucketBarChart('region', 'chart-region', regionBucket(), field, 'count', regionHighlight());
}

function renderPositionScoreChart() {
  const field = isProjectStream() ? 'homeworkPercentSum' : 'scoreSum';
  const countField = isProjectStream() ? 'count' : 'scoreCount';
  renderBucketBarChart('positionScore', 'chart-position-score', state.summary.byPosition, field, countField);
}

function renderRegionScoreChart() {
  const field = isProjectStream() ? 'homeworkPercentSum' : 'scoreSum';
  const countField = isProjectStream() ? 'count' : 'scoreCount';
  renderBucketBarChart('regionScore', 'chart-region-score', regionBucket(), field, countField, regionHighlight());
}

// Engagement (% actually participating vs. enrolled) is a ratio of two
// counts, not a sum-of-percentages average, so it gets its own chart function.
function renderEngagementChart(chartKey, canvasId, bucket, highlight = '') {
  destroyChart(chartKey);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return; // e.g. the "за посадами" card is hidden for this project
  const entries = Object.entries(bucket)
    .map(([k, b]) => [k, b.testsAssignedSum > 0 ? (b.testsCompletedSum / b.testsAssignedSum) * 100 : null])
    .filter(([, v]) => v !== null)
    .sort((a, b) => a[1] - b[1]);
  state.charts[chartKey] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: entries.map((e) => e[0]),
      datasets: [{ data: entries.map((e) => Math.round(e[1] * 10) / 10), backgroundColor: highlightColors(entries, highlight), borderRadius: 6 }],
    },
    options: chartBarOptions(entries.map((e) => e[0]), highlight),
  });
}

function renderPositionEngagementChart() {
  renderEngagementChart('positionEngagement', 'chart-position-engagement', state.summary.byPosition);
}

function renderRegionEngagementChart() {
  renderEngagementChart('regionEngagement', 'chart-region-engagement', regionBucket(), regionHighlight());
}

// the picked region stays in full colour with a bold ▶ label; the rest fade
function highlightColors(entries, highlight) {
  const colors = barChartColors(entries.map((e) => e[1]));
  return highlight ? colors.map((c, i) => (entries[i][0] === highlight ? c : `${c}40`)) : colors;
}

function chartBarOptions(labels = [], highlight = '') {
  const y = highlight ? {
    ticks: {
      callback: (v, i) => (labels[i] === highlight ? `▶ ${labels[i]}` : labels[i]),
      font: (c) => ({ weight: labels[c.index] === highlight ? 'bold' : 'normal' }),
      color: (c) => (labels[c.index] === highlight ? '#1f2228' : '#9a9da5'),
    },
  } : {};
  return {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.parsed.x}%` } } },
    scales: { x: { min: 0, max: 100, ticks: { callback: (v) => `${v}%` } }, y },
  };
}

function renderDistributionChart() {
  destroyChart('distribution');
  const wrap = document.getElementById('chart-distribution-wrap');
  if (!wrap) return; // hidden — e.g. progress-based distribution is meaningless for Продавець
  const d = state.summary.distribution;
  if (!d) {
    wrap.innerHTML = '<p class="muted" style="padding:24px 0; text-align:center;">Розподіл недоступний для цього періоду (завантажений до появи цього графіка).</p>';
    return;
  }
  wrap.innerHTML = '<canvas id="chart-distribution" height="220"></canvas>';
  const ctx = document.getElementById('chart-distribution');
  state.charts.distribution = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(d).map((k) => DISTRIBUTION_LABELS[k]),
      datasets: [{
        data: Object.values(d),
        backgroundColor: [STATUS_COLORS.red, STATUS_COLORS.orange, STATUS_COLORS.yellow, STATUS_COLORS.good],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
    },
  });
}

function renderTrendChart() {
  destroyChart('trend');
  const ctx = document.getElementById('chart-trend');
  if (!ctx) return; // hidden for sparse projects (e.g. Leader Hub, still on one period)
  if (!state.periods.length) {
    ctx.getContext('2d').clearRect(0, 0, ctx.width, ctx.height);
    return;
  }
  const primaryLabel = state.periods[0]?.primaryLabel || 'Середній прогрес, %';
  const secondaryLabel = state.periods[0]?.secondaryLabel || 'Середня оцінка, %';
  state.charts.trend = new Chart(ctx, {
    type: 'line',
    data: {
      labels: state.periods.map((p) => p.label),
      datasets: [
        { label: primaryLabel, data: state.periods.map((p) => p.avgPrimary), borderColor: STATUS_COLORS.good, backgroundColor: STATUS_COLORS.good, tension: 0.25 },
        { label: secondaryLabel, data: state.periods.map((p) => p.avgSecondary), borderColor: '#4a7dfc', backgroundColor: '#4a7dfc', tension: 0.25 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { min: 0, max: 100, ticks: { callback: (v) => `${v}%` } } },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
    },
  });
}

/* ===================== stores table ===================== */

function renderStoresTable() {
  if (!document.getElementById('stores-table')) return; // hidden for sparse projects (e.g. Leader Hub)
  const project = isProjectStream();
  const scoreOnly = !project && isProdavetsAttestation();
  const primaryField = project ? 'testsSum' : (scoreOnly ? 'scoreSum' : 'progressSum');
  const primaryCountField = scoreOnly ? 'scoreCount' : 'count';
  const secondaryField = project ? 'homeworkPercentSum' : 'scoreSum';
  const secondaryCountField = project ? 'count' : 'scoreCount';
  const rows = Object.entries(state.summary.byStore).map(([store, b]) => ({
    store, region: b.region, primary: avg(b[primaryField], b[primaryCountField]), secondary: avg(b[secondaryField], b[secondaryCountField]),
    count: b.count,
  })).filter((r) => r.primary !== null);
  // Projects rank stores by a 50/50 blend of tests + homework, not tests
  // alone — a store that aced tests but skipped homework shouldn't look
  // better than one doing solidly on both. Missing homework counts as 0
  // for ranking (not shown as 0 — the cell itself still reads "—").
  const rank = (r) => (project ? ((r.primary ?? 0) + (r.secondary ?? 0)) / 2 : r.primary);
  rows.sort((a, b) => rank(a) - rank(b));

  const primaryLabel = project ? '% тестів' : (scoreOnly ? 'Оцінка' : 'Прогрес');
  const secondaryLabel = project ? '% ДЗ' : 'Оцінка';
  const peopleLabel = project ? 'Залучено' : 'Осіб';

  const table = document.getElementById('stores-table');
  table.innerHTML = `
    <thead><tr><th>Магазин</th><th>Регіон</th><th>${primaryLabel}</th>${scoreOnly ? '' : `<th>${secondaryLabel}</th>`}<th>${peopleLabel}</th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr>
        <td>${escapeHtml(r.store)}</td>
        <td>${escapeHtml(r.region)}</td>
        <td>${progressCellHtml(r.primary)}</td>
        ${scoreOnly ? '' : `<td>${badgeHtml(r.secondary)}</td>`}
        <td>${r.count}</td>
      </tr>`).join('') || `<tr><td colspan="${scoreOnly ? 4 : 5}" class="muted">Немає даних для обраних фільтрів</td></tr>`}</tbody>
  `;
}

// "Результати по темах" — per-topic totals for Feed-synced periods (see
// /api/topics), under every filter except the topic itself; clicking a row
// toggles the topic filter for the whole dashboard.
async function refreshTopicsTable() {
  const card = document.getElementById('topics-card');
  if (!card) return;
  if (!(state._filterOptions?.topics || []).length) { card.hidden = true; return; }
  const { streamType, streamKey } = currentStream();
  const periodId = resolveSelectedPeriod()?.id || '';
  const { topic, ...params } = filterParams();
  const data = await api(`/api/topics?${qs({ streamType, streamKey, periodId, ...params })}`);
  card.hidden = !data.topics.length;
  const table = document.getElementById('topics-table');
  table.innerHTML = `
    <thead><tr><th>Тема</th><th>Призначено</th><th>Пройшли</th><th>% проходження</th><th>Середня оцінка</th></tr></thead>
    <tbody>${data.topics.map((t) => `
      <tr class="clickable-row${t.topic === state.filters.topic ? ' selected-row' : ''}" data-topic="${escapeHtml(t.topic)}">
        <td>${escapeHtml(t.topic)}</td>
        <td>${fmtNum(t.assigned)}</td>
        <td>${fmtNum(t.completed)}</td>
        <td>${progressCellHtml(t.completionPct)}</td>
        <td>${t.avgScore !== null ? badgeHtml(t.avgScore) : '<span class="muted">без тесту</span>'}</td>
      </tr>`).join('')}</tbody>
  `;
  table.querySelectorAll('tr[data-topic]').forEach((tr) => {
    tr.addEventListener('click', async () => {
      state.filters.topic = state.filters.topic === tr.dataset.topic ? '' : tr.dataset.topic;
      renderFiltersBar();
      await refreshSummary(); await refreshDetails();
    });
  });
}

function fmtAepDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
}

function renderAepTopicsTable() {
  const rows = Object.entries(state.summary.byPosition).map(([topic, b]) => {
    const sessions = b.sessions || [];
    const dates = sessions.map((s) => s.date);
    return {
      topic, slots: b.count, planned: b.assigned, actual: b.completed,
      pct: b.assigned ? (b.completed / b.assigned) * 100 : null,
      dates, lastDate: dates.length ? dates[dates.length - 1] : '',
    };
  });
  // Newest/current trainings first, already-finished topics at the bottom.
  rows.sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''));

  const table = document.getElementById('aep-topics-table');
  table.innerHTML = `
    <thead><tr><th>Тема</th><th>Дата</th><th>Слотів</th><th>План</th><th>Факт</th><th>% від плану</th><th>Статус</th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr>
        <td>${escapeHtml(r.topic)}</td>
        <td>${r.dates.map(fmtAepDate).join(', ')}</td>
        <td>${r.slots}</td>
        <td>${fmtNum(r.planned)}</td>
        <td>${fmtNum(r.actual)}</td>
        <td>${progressCellHtml(r.pct)}</td>
        <td>${r.actual >= r.planned ? '<span class="badge status-good">Досягнуто</span>' : '<span class="badge status-red">Не досягнуто</span>'}</td>
      </tr>`).join('') || `<tr><td colspan="7" class="muted">Немає даних для обраних фільтрів</td></tr>`}</tbody>
  `;
}

/* Real per-attendee attendance, from the "Apple_Certified_-_Attendance"
   sheet bundled in the same training file — cross-referenced by name against
   the champions/reservists roster (uploaded separately, see "AEP — ростер").
   Both are best-effort: name matching between the two source files isn't
   perfect, and the roster/attendance data may not exist yet for old quarters
   uploaded before this feature — the three cards below hide themselves when
   there's nothing to show, rather than showing empty tables. */
async function refreshAepAttendance() {
  const period = resolveSelectedPeriod();
  const tierKpiGrid = document.getElementById('aep-tier-kpi-grid');
  const sessionCard = document.getElementById('aep-attendance-session-card');
  const noShowsCard = document.getElementById('aep-no-shows-card');
  if (!period || !period.year || !period.quarter) {
    tierKpiGrid.hidden = true; sessionCard.hidden = true; noShowsCard.hidden = true;
    return;
  }
  state._aepPeriodParams = { year: period.year, quarter: period.quarter };

  const [tierData, sessionsData] = await Promise.all([
    api(`/api/aep-attendance-summary?${qs(state._aepPeriodParams)}`),
    api(`/api/aep-attendance-sessions?${qs(state._aepPeriodParams)}`),
  ]);

  state._aepTiersData = tierData.tiers || {};
  const hasTierData = Object.keys(state._aepTiersData).length > 0;
  tierKpiGrid.hidden = !hasTierData;
  if (hasTierData) renderAepTierKpis(state._aepTiersData);

  const hasSessions = (sessionsData.sessions || []).length > 0;
  sessionCard.hidden = !hasSessions;
  state._aepSessions = hasSessions ? sessionsData.sessions : [];
  if (hasSessions) renderAepSessionPicker(sessionsData.sessions);

  await refreshAepSessionAndNoShows();
  await refreshAepNameSuggestions();
}

// Attendance names the automatic matcher couldn't resolve to any roster
// entry — scoped across all quarters (not the one currently viewed), since
// a merge decision here should apply everywhere.
async function refreshAepNameSuggestions() {
  const card = document.getElementById('aep-name-suggestions-card');
  if (!card) return;
  const [suggData, aliasData, dismissData, dupData, dupDismissData] = await Promise.all([
    api('/api/aep-name-suggestions'),
    api('/api/aep-name-aliases'),
    api('/api/aep-name-dismissals'),
    api('/api/aep-roster-duplicates'),
    api('/api/aep-roster-dup-dismissals'),
  ]);
  const suggestions = suggData.suggestions || [];
  const aliases = aliasData.aliases || [];
  const dismissals = dismissData.dismissals || [];
  const dupPairs = dupData.duplicates || [];
  const dupDismissals = dupDismissData.dismissals || [];
  card.hidden = suggestions.length === 0 && aliases.length === 0 && dismissals.length === 0
    && dupPairs.length === 0 && dupDismissals.length === 0;
  if (!card.hidden) renderAepNameSuggestions(suggestions, aliases, dismissals, dupPairs, dupDismissals);
}

function renderAepNameSuggestions(suggestions, aliases, dismissals, dupPairs, dupDismissals) {
  const list = document.getElementById('aep-name-suggestions-list');
  const suggHtml = suggestions.length ? suggestions.map((s) => `
    <div class="suggestion-row" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 0; border-bottom:1px solid var(--color-border);">
      <strong>${escapeHtml(s.name)}</strong>
      <span class="muted">схоже на:</span>
      ${s.candidates.map((c) => `
        <button class="btn btn-secondary btn-sm aep-merge-btn" data-raw="${escapeHtml(s.nameNorm)}" data-target="${c.rosterId}">
          Об'єднати з «${escapeHtml(c.rosterName)}» (${c.similarity}%)
        </button>
      `).join('')}
      <button class="btn btn-secondary btn-sm aep-dismiss-btn" data-raw="${escapeHtml(s.nameNorm)}">Не об'єднувати</button>
    </div>
  `).join('') : '<p class="muted">Нових збігів не знайдено.</p>';

  const dupHtml = dupPairs.length ? `
    <div style="margin-top:16px;">
      <p class="field-hint"><strong>Дублікати в самому ростері</strong> — схоже, одна й та сама людина завантажена двічі (одрук чи інший порядок імені/прізвища):</p>
      ${dupPairs.map((p) => `
        <div class="suggestion-row" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 0; border-bottom:1px solid var(--color-border);">
          <span>${escapeHtml(p.a.name)} <span class="muted">/</span> ${escapeHtml(p.b.name)}</span>
          <button class="btn btn-secondary btn-sm aep-dedupe-btn" data-keep="${p.a.id}" data-remove="${p.b.id}">Залишити «${escapeHtml(p.a.name)}»</button>
          <button class="btn btn-secondary btn-sm aep-dedupe-btn" data-keep="${p.b.id}" data-remove="${p.a.id}">Залишити «${escapeHtml(p.b.name)}»</button>
          <button class="btn btn-secondary btn-sm aep-dup-dismiss-btn"
            data-name-a="${escapeHtml(p.a.name)}" data-norm-a="${escapeHtml(p.a.nameNorm)}"
            data-name-b="${escapeHtml(p.b.name)}" data-norm-b="${escapeHtml(p.b.nameNorm)}">Це різні люди</button>
        </div>
      `).join('')}
    </div>
  ` : '';

  const historyRows = [
    ...aliases.map((a) => ({
      text: `${a.rawName} → ${a.targetName}`,
      btnClass: 'aep-unmerge-btn', btnLabel: 'Скасувати', id: a.id,
    })),
    ...dismissals.map((d) => ({
      text: `${d.rawName} — позначено «не та сама людина»`,
      btnClass: 'aep-undismiss-btn', btnLabel: 'Скасувати', id: d.id,
    })),
    ...dupDismissals.map((d) => ({
      text: `${d.nameA} / ${d.nameB} — позначено «різні люди»`,
      btnClass: 'aep-undup-dismiss-btn', btnLabel: 'Скасувати', id: d.id,
    })),
  ];
  const historyHtml = historyRows.length ? `
    <div style="margin-top:12px;">
      <p class="field-hint">Опрацьовані раніше:</p>
      ${historyRows.map((r) => `
        <div class="suggestion-row" style="display:flex; align-items:center; gap:8px; padding:4px 0;">
          <span class="muted">${escapeHtml(r.text)}</span>
          <button class="btn btn-secondary btn-sm ${r.btnClass}" data-id="${r.id}">${r.btnLabel}</button>
        </div>
      `).join('')}
    </div>
  ` : '';

  list.innerHTML = suggHtml + dupHtml + historyHtml;
  wireAepSuggestionButtons(list);
}

// Every action here removes its own row from the DOM the instant the
// request succeeds (optimistic — don't wait for a full re-fetch/re-render
// round trip, which the tier chart + no-shows table refresh underneath
// makes noticeably slow) and only then kicks off the heavier background
// refresh so the rest of the page (charts, no-shows ranking) catches up.
function wireAepSuggestionButtons(list) {
  const removeRow = (btn) => btn.closest('.suggestion-row')?.remove();

  list.querySelectorAll('.aep-merge-btn').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api('/api/aep-name-alias', {
          method: 'POST',
          body: JSON.stringify({ rawNameNorm: btn.dataset.raw, targetRosterId: Number(btn.dataset.target) }),
        });
        showToast('Об’єднано.');
        removeRow(btn);
        refreshAepAttendance().catch(() => {});
      } catch (e) {
        showToast(e.message, true);
        btn.disabled = false;
      }
    };
  });
  list.querySelectorAll('.aep-dismiss-btn').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api('/api/aep-name-dismiss', {
          method: 'POST',
          body: JSON.stringify({ rawNameNorm: btn.dataset.raw }),
        });
        showToast('Позначено — більше не пропонуватиметься.');
        removeRow(btn);
        refreshAepNameSuggestions().catch(() => {});
      } catch (e) {
        showToast(e.message, true);
        btn.disabled = false;
      }
    };
  });
  list.querySelectorAll('.aep-dedupe-btn').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api('/api/aep-roster-dedupe', {
          method: 'POST',
          body: JSON.stringify({ keepId: Number(btn.dataset.keep), removeId: Number(btn.dataset.remove) }),
        });
        showToast('Дублікат видалено з ростера.');
        removeRow(btn);
        refreshAepAttendance().catch(() => {});
      } catch (e) {
        showToast(e.message, true);
        btn.disabled = false;
      }
    };
  });
  list.querySelectorAll('.aep-dup-dismiss-btn').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api('/api/aep-roster-dup-dismiss', {
          method: 'POST',
          body: JSON.stringify({
            nameA: btn.dataset.nameA, nameNormA: btn.dataset.normA,
            nameB: btn.dataset.nameB, nameNormB: btn.dataset.normB,
          }),
        });
        showToast('Позначено — більше не пропонуватиметься.');
        removeRow(btn);
        refreshAepNameSuggestions().catch(() => {});
      } catch (e) {
        showToast(e.message, true);
        btn.disabled = false;
      }
    };
  });
  list.querySelectorAll('.aep-unmerge-btn').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api(`/api/aep-name-alias/${btn.dataset.id}`, { method: 'DELETE' });
        showToast('Скасовано.');
        removeRow(btn);
        refreshAepAttendance().catch(() => {});
      } catch (e) {
        showToast(e.message, true);
        btn.disabled = false;
      }
    };
  });
  list.querySelectorAll('.aep-undismiss-btn').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api(`/api/aep-name-dismiss/${btn.dataset.id}`, { method: 'DELETE' });
        showToast('Скасовано.');
        removeRow(btn);
        refreshAepNameSuggestions().catch(() => {});
      } catch (e) {
        showToast(e.message, true);
        btn.disabled = false;
      }
    };
  });
  list.querySelectorAll('.aep-undup-dismiss-btn').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api(`/api/aep-roster-dup-dismiss/${btn.dataset.id}`, { method: 'DELETE' });
        showToast('Скасовано.');
        removeRow(btn);
        refreshAepNameSuggestions().catch(() => {});
      } catch (e) {
        showToast(e.message, true);
        btn.disabled = false;
      }
    };
  });
}

// Re-fetches just the tier-filterable pieces (session attendee list + the
// no-shows ranking) — split out from refreshAepAttendance so picking a
// different real tier doesn't have to re-fetch the session list/dropdown.
async function refreshAepSessionAndNoShows() {
  const noShowsCard = document.getElementById('aep-no-shows-card');
  const tierParam = state.aepTierFilter ? { tier: state.aepTierFilter } : {};

  if (state._aepSessions && state._aepSessions.length) {
    const select = document.getElementById('aep-session-select');
    const current = state._aepSessions[Number(select.value)] || state._aepSessions[state._aepSessions.length - 1];
    await refreshAepSessionAttendees(current);
  }

  const noShowsData = await api(`/api/aep-no-shows?${qs({ ...state._aepPeriodParams, ...tierParam })}`);
  const hasNoShows = (noShowsData.people || []).length > 0;
  noShowsCard.hidden = !hasNoShows;
  if (hasNoShows) {
    document.getElementById('aep-no-shows-subtitle').textContent = `(з ${noShowsData.totalSessions} тренінгів кварталу)`;
    renderAepNoShows(noShowsData.people);
  }
}

const AEP_TIER_ORDER = ['Apple чемпіон', 'Резервіст', 'Інші учасники'];

function renderAepTierKpis(tiers) {
  const uniquePeople = (t) => tiers[t]?.uniquePeople || 0;
  const total = Object.values(tiers).reduce((s, b) => s + b.uniquePeople, 0);
  const tiles = [
    { label: 'Учасників всього', value: fmtNum(total), accent: '' },
    { label: 'Чемпіони', value: fmtNum(uniquePeople('Apple чемпіон')), accent: 'green' },
    { label: 'Резервісти', value: fmtNum(uniquePeople('Резервіст')), accent: 'yellow' },
    { label: 'Інші (не програмні)', value: fmtNum(uniquePeople('Інші учасники')), accent: '' },
  ];
  document.getElementById('aep-tier-kpi-grid').innerHTML = tiles.map((tl) => `
    <div class="kpi-tile ${tl.accent ? `accent-${tl.accent}` : ''}">
      <div class="kpi-value">${tl.value}</div>
      <div class="kpi-label">${escapeHtml(tl.label)}</div>
    </div>`).join('');
}

const AEP_STATUS_LABELS = {
  CHECKED_IN: 'Прийшов', REGISTERED: 'Зареєстрований, не прийшов',
  NO_SHOW: 'Не прийшов', CANCELLED: 'Скасував', INVITED: 'Запрошений',
};

function renderAepSessionPicker(sessions) {
  const select = document.getElementById('aep-session-select');
  select.innerHTML = sessions.map((s, i) => `
    <option value="${i}">${escapeHtml(fmtAepDate(s.date))} — ${escapeHtml(s.eventName)} (${s.checkedIn}/${s.total})</option>
  `).join('');
  select.value = String(sessions.length - 1);
  select.onchange = () => {
    const s = state._aepSessions[Number(select.value)];
    refreshAepSessionAttendees(s);
  };
  // Attendee list for the default (most recent) session is fetched by the
  // caller (refreshAepAttendance -> refreshAepSessionAndNoShows), which
  // knows the current tier filter — avoids fetching it twice on first load.
}

async function refreshAepSessionAttendees(session) {
  const tierParam = state.aepTierFilter ? { tier: state.aepTierFilter } : {};
  const data = await api(`/api/aep-attendance-detail?${qs({ eventName: session.eventName, date: session.date, ...tierParam })}`);
  state._aepSessionAttendeesRows = [...data.attendees].sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name, 'uk'));
  resetPageState('aep-session-attendees');
  renderAepSessionAttendeesTable();
}

function renderAepSessionAttendeesTable() {
  const table = document.getElementById('aep-session-attendees-table');
  const rows = state._aepSessionAttendeesRows || [];
  const pageRows = pageSlice('aep-session-attendees', rows);
  table.innerHTML = `
    <thead><tr><th>ПІБ</th><th>Магазин</th><th>Рівень</th><th>Статус</th></tr></thead>
    <tbody>${pageRows.map((a) => `
      <tr>
        <td>${escapeHtml(a.name)}</td>
        <td>${escapeHtml(a.store)}</td>
        <td>${escapeHtml(a.tier)}</td>
        <td>${a.status === 'CHECKED_IN'
          ? `<span class="badge status-good">${escapeHtml(AEP_STATUS_LABELS[a.status] || a.status)}</span>`
          : `<span class="badge status-red">${escapeHtml(AEP_STATUS_LABELS[a.status] || a.status)}</span>`}</td>
      </tr>`).join('') || `<tr><td colspan="4" class="muted">Немає учасників</td></tr>`}</tbody>
  `;
  const pager = document.getElementById('aep-session-attendees-pagination');
  pager.innerHTML = paginationBarHtml('aep-session-attendees', rows.length);
  wirePagination(pager, 'aep-session-attendees', renderAepSessionAttendeesTable);
}

function renderAepNoShows(people) {
  state._aepNoShowsRows = people;
  resetPageState('aep-no-shows');
  renderAepNoShowsTable();
}

// Same underlying state as the "Рівень" filter up top (state.aepTierFilter)
// — just a more discoverable, locally-scoped control right on the table it
// affects, since "Рівень" also drives "Відвідуваність по тренінгу" and its
// "Інші учасники" option doesn't even apply here (no-shows is always
// roster-scoped to champions/reservists). The two stay in sync either way.
function renderAepNoShowsTierSwitch() {
  const el = document.getElementById('aep-no-shows-tier-switch');
  if (!el) return;
  const options = [
    { value: '', label: 'Усі' },
    { value: 'Apple чемпіон', label: 'Apple чемпіони' },
    { value: 'Резервіст', label: 'Резервісти' },
  ];
  el.innerHTML = options.map((o) => `
    <button class="position-chip ${state.aepTierFilter === o.value ? 'active' : ''}" data-tier="${escapeHtml(o.value)}">${escapeHtml(o.label)}</button>
  `).join('');
  el.querySelectorAll('[data-tier]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.aepTierFilter = btn.dataset.tier;
      const regionSelect = document.getElementById('f-region');
      if (regionSelect) regionSelect.value = state.aepTierFilter;
      await refreshAepSessionAndNoShows();
    });
  });
}

function renderAepNoShowsTable() {
  renderAepNoShowsTierSwitch();
  const table = document.getElementById('aep-no-shows-table');
  const rows = state._aepNoShowsRows || [];
  const pageRows = pageSlice('aep-no-shows', rows);
  table.innerHTML = `
    <thead><tr><th>ПІБ</th><th>Магазин</th><th>Рівень</th><th>Відвідано тренінгів</th><th>% відвідуваності</th></tr></thead>
    <tbody>${pageRows.map((p) => `
      <tr>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.store)}</td>
        <td>${escapeHtml(p.tier)}</td>
        <td>${fmtNum(p.checkedIn)} з ${fmtNum(p.total)}</td>
        <td>${progressCellHtml(p.rate)}</td>
      </tr>`).join('') || `<tr><td colspan="5" class="muted">Немає даних</td></tr>`}</tbody>
  `;
  const pager = document.getElementById('aep-no-shows-pagination');
  pager.innerHTML = paginationBarHtml('aep-no-shows', rows.length);
  wirePagination(pager, 'aep-no-shows', renderAepNoShowsTable);
}

function progressCellHtml(value) {
  const bucket = statusBucket(value) || 'red';
  const pct = Math.max(0, Math.min(100, value || 0));
  return `<div class="progress-cell">
    <div class="progress-bar-track"><div class="progress-bar-fill fill-${bucket}" style="width:${pct}%"></div></div>
    <div class="value">${fmtPct(value)}</div>
  </div>`;
}

function badgeHtml(value) {
  const bucket = statusBucket(value) || 'red';
  return `<span class="badge status-${bucket}">${fmtPct(value)}</span>`;
}

/* ===================== employees table ===================== */

const EMPLOYEE_COLUMNS = [
  { key: 'region', label: 'Регіон' },
  { key: 'store', label: 'Магазин' },
  { key: 'position', label: 'Посада' },
  { key: 'name', label: 'ПІБ' },
  { key: 'assigned', label: 'Призначено' },
  { key: 'completed', label: 'Пройдено' },
  { key: 'progress', label: 'Прогрес' },
  { key: 'score', label: 'Оцінка' },
];

const PROJECT_EMPLOYEE_COLUMNS = [
  { key: 'region', label: 'Регіон' },
  { key: 'store', label: 'Магазин' },
  { key: 'position', label: 'Посада' },
  { key: 'name', label: 'ПІБ' },
  { key: 'testsCompletedCount', label: 'Тестів складено' },
  { key: 'testsPercent', label: '% тестів' },
  { key: 'homeworkPercent', label: '% ДЗ' },
];

// With a topic selected (see /api/details?topic=): one row per person for
// that topic — passed or not, its mark, and when.
const TOPIC_EMPLOYEE_COLUMNS = [
  { key: 'region', label: 'Регіон' },
  { key: 'store', label: 'Магазин' },
  { key: 'position', label: 'Посада' },
  { key: 'name', label: 'ПІБ' },
  { key: 'completed', label: 'Пройдено' },
  { key: 'score', label: 'Оцінка' },
  { key: 'doneAt', label: 'Дата проходження' },
];

function fmtFeedDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

const ATTESTATION_SCORE_ONLY_COLUMNS = [
  { key: 'region', label: 'Регіон' },
  { key: 'store', label: 'Магазин' },
  { key: 'position', label: 'Посада' },
  { key: 'name', label: 'ПІБ' },
  { key: 'score', label: 'Оцінка' },
];

function renderEmployeesTable() {
  const table = document.getElementById('employees-table');
  const { rows, total, shown } = state.details;
  const project = isProjectStream();
  const scoreOnly = !project && isProdavetsAttestation();
  const byTopic = !project && !scoreOnly && !!state.filters.topic;
  const columns = project ? PROJECT_EMPLOYEE_COLUMNS
    : scoreOnly ? ATTESTATION_SCORE_ONLY_COLUMNS
    : byTopic ? TOPIC_EMPLOYEE_COLUMNS : EMPLOYEE_COLUMNS;
  const pageRows = pageSlice('employees', rows);

  const bodyHtml = byTopic
    ? pageRows.map((r) => `
      <tr>
        <td>${escapeHtml(r.region)}</td>
        <td>${escapeHtml(r.store)}</td>
        <td>${escapeHtml(r.position)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${r.completed > 0 ? 'Так' : '<span class="muted">Ні</span>'}</td>
        <td>${r.score !== null && r.score !== undefined ? badgeHtml(r.score) : '<span class="muted">—</span>'}</td>
        <td>${fmtFeedDate(r.doneAt) || '<span class="muted">—</span>'}</td>
      </tr>`).join('')
    : project
    ? pageRows.map((r) => `
      <tr>
        <td>${escapeHtml(r.region)}</td>
        <td>${escapeHtml(r.store)}</td>
        <td>${escapeHtml(r.position)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${fmtNum(r.testsCompletedCount)} з ${fmtNum(r.testsAssignedCount)}</td>
        <td>${progressCellHtml(r.testsPercent)}</td>
        <td>${badgeHtml(r.homeworkPercent)}</td>
      </tr>`).join('')
    : scoreOnly
    ? pageRows.map((r) => `
      <tr>
        <td>${escapeHtml(r.region)}</td>
        <td>${escapeHtml(r.store)}</td>
        <td>${escapeHtml(r.position)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${badgeHtml(r.score)}</td>
      </tr>`).join('')
    : pageRows.map((r) => `
      <tr>
        <td>${escapeHtml(r.region)}</td>
        <td>${escapeHtml(r.store)}</td>
        <td>${escapeHtml(r.position)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${r.scoreOnly ? '<span class="muted">—</span>' : fmtNum(r.assigned)}</td>
        <td>${r.scoreOnly ? '<span class="muted">—</span>' : fmtNum(r.completed)}</td>
        <td>${progressCellHtml(r.assigned > 0 && !r.scoreOnly ? r.progress : null)}</td>
        <td>${r.scoreOnly ? (r.progress > 0 ? badgeHtml(r.score) : '<span class="muted">—</span>') : r.assigned > 0 ? badgeHtml(r.score) : '<span class="muted">—</span>'}</td>
      </tr>`).join('');

  const emptyLabel = 'Немає співробітників для обраних фільтрів';
  table.innerHTML = `
    <thead><tr>${columns.map((c) => `<th data-col="${c.key}" class="${state.sort.col === c.key ? 'sorted' : ''}">${escapeHtml(c.label)}${state.sort.col === c.key ? (state.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
    <tbody>${bodyHtml || `<tr><td colspan="${columns.length}" class="muted">${emptyLabel}</td></tr>`}</tbody>
  `;
  table.querySelectorAll('th[data-col]').forEach((th) => {
    th.addEventListener('click', async () => {
      const col = th.dataset.col;
      if (state.sort.col === col) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      else { state.sort.col = col; state.sort.dir = 'asc'; }
      await refreshDetails();
    });
  });

  const note = document.getElementById('employees-note');
  const peopleLabel = project ? 'учасників' : 'співробітників';
  note.textContent = total > shown
    ? `Показано перші ${shown} з ${total} ${peopleLabel} — уточніть фільтри або пошук, щоб звузити список.`
    : `Показано ${shown} з ${total} ${peopleLabel}.`;

  const pager = document.getElementById('employees-pagination');
  pager.innerHTML = paginationBarHtml('employees', rows.length);
  wirePagination(pager, 'employees', renderEmployeesTable);
}

/* ===================== upload modal ===================== */

function fmtUploadedAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const date = d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
  // a full timestamp also gets the time («Востаннє оновлено: 25.11.2026, 15:58»)
  return String(iso).length > 10 ? `${date}, ${d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}` : date;
}

function lastUpdatedFor(streamType, streamKey) {
  if (streamType === 'attestation' && streamKey === ATTESTATION_ALL) {
    // "Усі посади": the most recent update across every position
    const latest = state.streams.filter((x) => x.streamType === 'attestation')
      .map((x) => x.lastUpdated).filter(Boolean).sort().pop();
    return latest ? fmtUploadedAt(latest) : null;
  }
  const s = state.streams.find((x) => x.streamType === streamType && x.streamKey === streamKey);
  return s ? fmtUploadedAt(s.lastUpdated) : null;
}

function lastUpdatedHintHtml(streamType, streamKey) {
  const d = lastUpdatedFor(streamType, streamKey);
  return `<div class="field-hint">${d ? `Востаннє оновлено: ${d}` : 'Ще не завантажувалось'}</div>`;
}

function openUploadModal() {
  const root = document.getElementById('modal-root');
  const now = new Date();
  const currentQuarter = Math.floor(now.getMonth() / 3) + 1;
  const currentYear = now.getFullYear();
  root.innerHTML = `
    <div class="modal-backdrop" id="upload-backdrop">
      <div class="modal">
        <button class="modal-close" id="upload-close">✕</button>
        <h2>Завантажити дані</h2>
        <p class="modal-subtitle">Оберіть Excel-файли (.xls), вивантажені з LMS, і виберіть період.</p>

        <div class="field-group">
          <label>Період</label>
          <div style="display:flex; gap:8px;">
            <select id="up-quarter">
              ${[1, 2, 3, 4].map((q) => `<option value="${q}" ${q === currentQuarter ? 'selected' : ''}>${q} квартал</option>`).join('')}
            </select>
            <input type="number" id="up-year" value="${currentYear}" style="width:100px;">
          </div>
          <div class="field-hint">Завантаження за той самий квартал ЗАМІНЮЄ попередні дані цього кварталу (не створює дублікат) — можна вивантажувати оновлений файл посеред кварталу скільки завгодно разів.</div>
        </div>
        <div class="field-group">
          <label>Загальний звіт (усі посади)</label>
          <input type="file" id="up-overall" accept=".xls,.xlsx">
          ${lastUpdatedHintHtml('overall', 'overall')}
        </div>
        <div class="field-group">
          <label>Атестаційні звіти (до ${ATTESTATION_STREAMS.length} файлів — ${ATTESTATION_STREAMS.join(', ')})</label>
          <input type="file" id="up-attestation" accept=".xls,.xlsx" multiple>
          <div class="field-hint">Посада визначається автоматично з вмісту файлу — вказувати вручну не потрібно.</div>
          <div class="field-hint">${ATTESTATION_STREAMS.map((p) => `${escapeHtml(p)}: ${lastUpdatedFor('attestation', p) || 'немає даних'}`).join(' · ')}</div>
        </div>
        <div class="field-group">
          <label>Проєкт</label>
          <select id="up-project-select">
            <option value="">— Оберіть проєкт —</option>
            ${state.projects.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}
            <option value="__aep__">AEP (Apple Excellence Program)</option>
            <option value="__new__">+ Новий проєкт…</option>
          </select>
          <div class="field-hint" id="up-project-last-updated"></div>
          <input type="text" id="up-project-name-new" placeholder="Назва нового проєкту" style="margin-top:8px; display:none;">

          <div id="up-project-files" style="margin-top:8px;">
            <input type="file" id="up-project" accept=".xls,.xlsx" multiple>
            <div class="field-hint">Файли курсу — по одному на групу/посаду, група визначається автоматично з колонки «Посада».</div>
          </div>

          <div id="up-aep-files" style="margin-top:8px; display:none;">
            <label>Графік тренінгів</label>
            <input type="file" id="up-aep" accept=".xls,.xlsx,.ods">
            <div class="field-hint">Увесь файл «Графік тренінгів Apple» (вкладки Training_Planning + Apple_Certified_-_Attendance) — період і квартали визначаються автоматично з дат сесій, окремо оновлюється кожен квартал, знайдений у файлі.</div>
            <label style="margin-top:8px; display:block;">Ростер чемпіонів і резервістів</label>
            <input type="file" id="up-aep-roster" accept=".xls,.xlsx">
            <div class="field-hint">Файл «Apple Excellence Program» (вкладка «Резервісти та чемпіони») — поточний список, повністю замінює попередній при кожному завантаженні.</div>
          </div>

          <div class="field-hint" style="margin-top:8px;">Обери проєкт зі списку (щоб не створити дублікат через одрук), AEP, або «+ Новий проєкт», якщо його ще немає.</div>
        </div>

        <div class="field-group">
          <label>Кадровий резерв (Leader Hub)</label>
          <input type="file" id="up-reserve" accept=".xls,.xlsx" multiple>
          <div class="field-hint">Файл учасників Leader Hub (аркуші «Учасники» і, за бажанням, «Магазини») та/або «Історія працівника» з BI «Аналітика. Роздріб». Тип файлу визначається автоматично. Учасники замінюють лише ті потоки, що є у файлі; історія замінюється повністю.</div>
          <button type="button" class="btn btn-secondary btn-sm" id="up-reserve-go" style="margin-top:6px;">Завантажити для кадрового резерву</button>
          <div class="field-hint" id="up-reserve-status"></div>
        </div>

        <div id="upload-preview"></div>
        <div id="upload-error" class="error-text"></div>

        <div class="modal-actions">
          <button class="btn btn-secondary" id="up-cancel">Скасувати</button>
          <button class="btn btn-primary" id="up-parse">Перевірити файли</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('upload-close').onclick = closeModal;
  document.getElementById('up-cancel').onclick = closeModal;
  document.getElementById('upload-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'upload-backdrop') closeModal();
  });
  document.getElementById('up-project-select').addEventListener('change', (e) => {
    const v = e.target.value;
    document.getElementById('up-project-name-new').style.display = v === '__new__' ? '' : 'none';
    document.getElementById('up-aep-files').style.display = v === '__aep__' ? '' : 'none';
    document.getElementById('up-project-files').style.display = v === '__aep__' ? 'none' : '';
    updateProjectLastUpdatedHint(v);
  });
  document.getElementById('up-parse').onclick = handleParseFiles;
  document.getElementById('up-reserve-go').onclick = handleReserveUpload;
}

/* ---- Кадровий резерв uploads: participants file / BI employee history ---- */

// Excel serial or "YYYY-MM-DD…" text -> "YYYY-MM-DD"
function excelIsoDate(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/) || s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return '';
  return m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`;
}

function sheetRowsByHeader(sheet, required) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  const hi = rows.findIndex((r) => r && required.every((h) => r.map((c) => String(c ?? '').trim()).includes(h)));
  if (hi < 0) return null;
  const cols = rows[hi].map((c) => String(c ?? '').trim());
  return { idx: (h) => cols.indexOf(h), rows: rows.slice(hi + 1).filter((r) => r && r.length) };
}

async function handleReserveUpload() {
  const files = Array.from(document.getElementById('up-reserve').files || []);
  const statusEl = document.getElementById('up-reserve-status');
  const btn = document.getElementById('up-reserve-go');
  if (!files.length) { statusEl.textContent = 'Оберіть файл.'; return; }
  btn.disabled = true;
  try {
    for (const file of files) {
      statusEl.textContent = `Читаю «${file.name}»…`;
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const history = sheetRowsByHeader(wb.Sheets[wb.SheetNames[0]], ['Таб номер', 'ПІБ', 'Посада', 'Магазин', 'Дата початку', 'Дата кінця']);
      const partSheet = wb.Sheets['Учасники'] || wb.Sheets[wb.SheetNames[0]];
      const parts = sheetRowsByHeader(partSheet, ['Програма', 'Потік', 'ПІБ', 'Статус']);
      if (history) {
        const i = history.idx;
        const rows = history.rows.filter((r) => r[i('Таб номер')] !== undefined && r[i('Таб номер')] !== '').map((r) => [
          String(r[i('Таб номер')]).trim(), r[i('ПІБ')], r[i('Посада')], r[i('Магазин')], r[i('Статус')],
          excelIsoDate(r[i('Дата початку')]), excelIsoDate(r[i('Дата кінця')]),
        ]);
        const size = 4000;
        const total = Math.ceil(rows.length / size);
        for (let p = 0; p < total; p++) {
          statusEl.textContent = `Історія працівника: ${Math.round((p / total) * 100)}%…`;
          await api('/api/upload-employee-history', { method: 'POST', body: JSON.stringify({ rows: rows.slice(p * size, (p + 1) * size), part: p, parts: total }) });
        }
        showToast(`Історію працівника завантажено: ${fmtNum(rows.length)} рядків.`);
      } else if (parts) {
        const i = parts.idx;
        const participants = parts.rows.filter((r) => r[i('ПІБ')]).map((r) => ({
          program: r[i('Програма')], year: r[i('Потік')], tab: r[i('Таб. номер')], name: r[i('ПІБ')],
          region: r[i('Регіон')], store: r[i('Магазин')], position: r[i('Стартова посада')],
          test: r[i('Тест %')], dz: r[i('ДЗ %')], status: r[i('Статус')], passed1: r[i('Пройшов 1 етап')],
        }));
        const st = wb.Sheets['Магазини'] ? sheetRowsByHeader(wb.Sheets['Магазини'], ['Регіон', 'Магазин']) : null;
        const stores = st ? st.rows.map((r) => [r[st.idx('Регіон')], r[st.idx('Магазин')]]) : [];
        // optional sheet «Потоки»: Програма, Потік, Старт, Завершення
        const sp = wb.Sheets['Потоки'] ? sheetRowsByHeader(wb.Sheets['Потоки'], ['Програма', 'Потік']) : null;
        const streams = sp ? sp.rows.filter((r) => r[sp.idx('Потік')]).map((r) => ({
          program: r[sp.idx('Програма')], year: r[sp.idx('Потік')], dateStart: excelIsoDate(r[sp.idx('Старт')]), dateEnd: excelIsoDate(r[sp.idx('Завершення')]),
        })) : [];
        const resp = await api('/api/upload-lh-participants', { method: 'POST', body: JSON.stringify({ participants, stores, streams }) });
        showToast(`Учасників Leader Hub завантажено: ${resp.participants}${resp.stores ? `, магазинів: ${resp.stores}` : ''}.`);
      } else {
        throw new Error(`«${file.name}»: не схожий ні на файл учасників Leader Hub, ні на «Історію працівника».`);
      }
    }
    statusEl.textContent = 'Готово.';
    if (state.reserve) state.reserve.data = null;
    if (state.tab === 'reserve') await refreshAll();
  } catch (e) {
    statusEl.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function updateProjectLastUpdatedHint(value) {
  const hintEl = document.getElementById('up-project-last-updated');
  if (!hintEl) return;
  if (!value || value === '__new__') {
    hintEl.textContent = '';
  } else if (value === '__aep__') {
    const d = fmtUploadedAt(state.aepLastUpdated);
    hintEl.textContent = d ? `Востаннє оновлено: ${d}` : 'Ще не завантажувалось';
  } else {
    const d = lastUpdatedFor('project', value);
    hintEl.textContent = d ? `Востаннє оновлено: ${d}` : 'Ще не завантажувалось';
  }
}

function isAepSelected() {
  return document.getElementById('up-project-select')?.value === '__aep__';
}

function selectedProjectName() {
  const select = document.getElementById('up-project-select');
  if (!select || select.value === '__aep__') return '';
  return select.value === '__new__'
    ? document.getElementById('up-project-name-new').value.trim()
    : select.value;
}

function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

async function handleParseFiles() {
  const errorEl = document.getElementById('upload-error');
  errorEl.textContent = '';
  const upQuarter = document.getElementById('up-quarter').value;
  const upYear = document.getElementById('up-year').value.trim();
  const label = upQuarter && upYear ? `${upQuarter} квартал ${upYear}` : '';
  const overallFile = document.getElementById('up-overall').files[0];
  const attFiles = Array.from(document.getElementById('up-attestation').files || []);
  const projectName = selectedProjectName();
  const projectFiles = Array.from(document.getElementById('up-project').files || []);
  const aepFile = document.getElementById('up-aep').files[0];
  const aepRosterFileEarly = document.getElementById('up-aep-roster')?.files[0];

  if (!overallFile && !attFiles.length && !projectFiles.length && !aepFile && !aepRosterFileEarly) { errorEl.textContent = 'Оберіть хоча б один файл.'; return; }
  if ((overallFile || attFiles.length || projectFiles.length) && !label) { errorEl.textContent = 'Вкажіть період.'; return; }
  if (projectFiles.length && !projectName) { errorEl.textContent = 'Вкажіть назву проєкту.'; return; }

  const pending = [];
  try {
    if (overallFile) {
      const rows = await readWorkbookRows(overallFile);
      pending.push({ kind: 'overall', streamKey: 'overall', fileName: overallFile.name, rows });
    }
    for (const file of attFiles) {
      const rows = await readWorkbookRows(file);
      const { canonical, raw } = detectAttestationPositionClient(rows);
      pending.push({ kind: 'attestation', streamKey: canonical, detectedRaw: raw, fileName: file.name, rows, error: canonical ? null : `Не вдалося розпізнати посаду (зустрілось «${raw || '—'}»)` });
    }
    if (projectFiles.length) {
      const fileSummaries = [];
      const allRows = [];
      for (const file of projectFiles) {
        const rows = await readProjectWorkbookRows(file);
        const position = detectProjectPositionClient(rows);
        fileSummaries.push({ fileName: file.name, rowCount: rows.length, position });
        allRows.push(...rows);
      }
      // One project = one merged period (all groups/positions together), so
      // "Посада" works as a normal filter and the unfiltered view is the
      // overall summary across every position — same model as "Все навчання".
      pending.push({ kind: 'project', projectName, fileSummaries, rows: allRows });
    }
    if (aepFile) {
      const { rows, attendance } = await readAepWorkbookRows(aepFile);
      const byQuarter = {};
      rows.forEach((r) => {
        const key = `${r.year} Q${r.quarter}`;
        byQuarter[key] = (byQuarter[key] || 0) + 1;
      });
      const quarterSummaries = Object.entries(byQuarter)
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => a.key.localeCompare(b.key));
      pending.push({ kind: 'aep', fileName: aepFile.name, rows, attendance, quarterSummaries });
    }
    const aepRosterFile = document.getElementById('up-aep-roster')?.files[0];
    if (aepRosterFile) {
      const rosterRows = await readAepRosterWorkbookRows(aepRosterFile);
      pending.push({ kind: 'aep-roster', fileName: aepRosterFile.name, rosterRows });
    }
  } catch (e) {
    errorEl.textContent = `Помилка читання файлу: ${e.message}`;
    return;
  }

  state._pendingUpload = { label, pending };
  renderUploadPreview();
}

function renderUploadPreview() {
  const { pending } = state._pendingUpload;
  const knownPositions = new Set(state.positionsConfig.filter((p) => !p.needs_classification).map((p) => p.position));
  const allPositions = new Set();
  // AEP rows carry training TOPICS in the "position" slot (reused field), not
  // job positions — they (and the roster file, which has no "position" field
  // at all) must never feed the position-classification flow.
  pending.filter((p) => p.kind !== 'aep' && p.kind !== 'aep-roster').forEach((p) => p.rows.forEach((r) => { if (r.position) allPositions.add(r.position); }));
  const unclassified = [...allPositions].filter((p) => !knownPositions.has(p));
  state._pendingUpload.unclassified = unclassified;

  const filesHtml = pending.map((p) => {
    if (p.kind === 'overall') {
      return `<div class="upload-summary">Загальний звіт «${escapeHtml(p.fileName)}»: ${p.rows.length} рядків.</div>`;
    }
    if (p.kind === 'project') {
      const lines = p.fileSummaries.map((f) => f.position
        ? `«${escapeHtml(f.fileName)}»: посада <b>${escapeHtml(f.position)}</b>, ${f.rowCount} рядків`
        : `«${escapeHtml(f.fileName)}»: <span style="color:var(--color-red)">не вдалося визначити посаду</span>`).join('<br>');
      return `<div class="upload-summary">Проєкт «${escapeHtml(p.projectName)}» — усього ${p.rows.length} рядків:<br>${lines}</div>`;
    }
    if (p.kind === 'aep') {
      if (p.fromQuarterKey === undefined) p.fromQuarterKey = Number(p.quarterSummaries[0]?.key.match(/(\d+) Q(\d)/).slice(1).reverse().join('')) || 0;
      const lines = p.quarterSummaries.map((q) => `${escapeHtml(q.key)}: ${q.count} сесій`).join('<br>');
      // A 0-record result usually means the "Apple_Certified_-_Attendance" sheet
      // wasn't found (e.g. a renamed tab) — flag it instead of saving silently
      // with no attendance data, which is very easy to miss otherwise.
      const attLine = p.attendance.length
        ? `<br>Відвідуваність: ${p.attendance.length} записів учасників.`
        : `<br><span style="color:var(--color-red)">Відвідуваність: 0 записів — лист «Apple_Certified_-_Attendance» не знайдено у файлі чи він порожній. Дані відвідуваності НЕ оновляться.</span>`;
      const quarterOptions = p.quarterSummaries.map((q) => {
        const m = q.key.match(/(\d+) Q(\d)/);
        const key = Number(`${m[1]}${m[2]}`);
        return `<option value="${key}" ${key === p.fromQuarterKey ? 'selected' : ''}>${escapeHtml(q.key)}</option>`;
      }).join('');
      return `<div class="upload-summary">AEP «${escapeHtml(p.fileName)}» — усього ${p.rows.length} сесій, буде оновлено квартали:<br>${lines}${attLine}
        <div class="field-group" style="margin-top:10px;">
          <label>Завантажити починаючи з кварталу</label>
          <select id="aep-from-quarter">${quarterOptions}</select>
          <div class="field-hint" id="aep-cutoff-summary"></div>
        </div>
      </div>`;
    }
    if (p.kind === 'aep-roster') {
      const champions = p.rosterRows.filter((r) => /чемпіон/i.test(r.status) && !/^не /i.test(r.status.trim())).length;
      const reservists = p.rosterRows.filter((r) => /резерв/i.test(r.status)).length;
      return `<div class="upload-summary">Ростер AEP «${escapeHtml(p.fileName)}» — ${p.rosterRows.length} записів (~${champions} чемпіонів, ~${reservists} резервістів). Повністю замінить поточний ростер.</div>`;
    }
    if (p.error) {
      return `<div class="upload-summary error">Файл «${escapeHtml(p.fileName)}»: ${escapeHtml(p.error)}. Цей файл не буде збережено.</div>`;
    }
    return `<div class="upload-summary">Атестація «${escapeHtml(p.fileName)}»: розпізнано посаду <b>${escapeHtml(p.streamKey)}</b>, ${p.rows.length} рядків.</div>`;
  }).join('');

  const classifyHtml = unclassified.length ? `
    <h3 style="margin-top:16px;">Нові посади — потребують класифікації</h3>
    <p class="field-hint">Ці посади ще не класифіковані як «Фронт»/«Бек». Перевірте перед збереженням (типове значення можна змінити пізніше у «Класифікація посад»).</p>
    <div class="classify-list">
      ${unclassified.map((pos) => `
        <div class="classify-row" data-pos="${escapeHtml(pos)}">
          <div class="pos-name">${escapeHtml(pos)}</div>
          <select class="cls-segment">
            <option value="back" selected>Бек</option>
            <option value="front">Фронт</option>
          </select>
          <label class="inline"><input type="checkbox" class="cls-firstline"> Перша лінія</label>
        </div>
      `).join('')}
    </div>
  ` : '';

  const hasSavable = pending.some((p) => !p.error);

  document.getElementById('upload-preview').innerHTML = `
    ${filesHtml}
    ${classifyHtml}
  `;
  const aepPending = pending.find((p) => p.kind === 'aep' && !p.error);
  const aepSelect = document.getElementById('aep-from-quarter');
  if (aepSelect) {
    const updateCutoffSummary = () => {
      const cutoff = Number(aepSelect.value);
      aepPending.fromQuarterKey = cutoff;
      const sessionsKept = aepPending.rows.filter((r) => r.year * 10 + r.quarter >= cutoff).length;
      const attendanceKept = aepPending.attendance.filter((r) => r.year * 10 + r.quarter >= cutoff).length;
      document.getElementById('aep-cutoff-summary').textContent =
        cutoff === Number(`${aepPending.quarterSummaries[0].key.match(/(\d+) Q(\d)/)[1]}${aepPending.quarterSummaries[0].key.match(/(\d+) Q(\d)/)[2]}`)
          ? `Буде завантажено все: ${sessionsKept} сесій, ${attendanceKept} записів відвідуваності.`
          : `Буде завантажено ${sessionsKept} з ${aepPending.rows.length} сесій, ${attendanceKept} з ${aepPending.attendance.length} записів відвідуваності.`;
    };
    aepSelect.addEventListener('change', updateCutoffSummary);
    updateCutoffSummary();
  }
  const actions = document.querySelector('#upload-backdrop .modal-actions');
  actions.innerHTML = `
    <button class="btn btn-secondary" id="up-cancel2">Скасувати</button>
    <button class="btn btn-primary" id="up-save" ${hasSavable ? '' : 'disabled'}>Зберегти</button>
  `;
  document.getElementById('up-cancel2').onclick = closeModal;
  document.getElementById('up-save').onclick = handleSaveUpload;
}

async function handleSaveUpload() {
  const btn = document.getElementById('up-save');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Збереження…';
  const errorEl = document.getElementById('upload-error');
  errorEl.textContent = '';

  try {
    const rowsEls = document.querySelectorAll('.classify-row');
    for (const row of rowsEls) {
      const position = row.dataset.pos;
      const segment = row.querySelector('.cls-segment').value;
      const firstLine = row.querySelector('.cls-firstline').checked;
      await api('/api/config/position', { method: 'POST', body: JSON.stringify({ position, segment, firstLine }) });
    }

    const { label, pending } = state._pendingUpload;
    let savedCount = 0;
    let aepQuartersMsg = '';
    for (const p of pending) {
      if (p.error) continue;
      if (p.kind === 'aep') {
        const cutoff = p.fromQuarterKey || 0;
        const rows = p.rows.filter((r) => r.year * 10 + r.quarter >= cutoff);
        const attendance = p.attendance.filter((r) => r.year * 10 + r.quarter >= cutoff);
        const resp = await api('/api/upload-aep', { method: 'POST', body: JSON.stringify({ rows, attendance }) });
        savedCount += resp.quarters.length;
        aepQuartersMsg = ` AEP: ${resp.quarters.map((q) => q.label).join(', ')}.`;
        continue;
      }
      if (p.kind === 'aep-roster') {
        const resp = await api('/api/upload-aep-roster', { method: 'POST', body: JSON.stringify({ rows: p.rosterRows }) });
        savedCount++;
        aepQuartersMsg += ` Ростер: ${resp.champions} чемпіонів, ${resp.reservists} резервістів.`;
        state._aepRosterDuplicates = resp.duplicates || [];
        continue;
      }
      const body = { streamType: p.kind, label, rows: p.rows };
      if (p.kind === 'project') body.projectName = p.projectName;
      await api('/api/upload', { method: 'POST', body: JSON.stringify(body) });
      savedCount++;
    }

    await loadPositionsConfig();
    await loadStreams();
    closeModal();
    showToast(`Збережено: ${savedCount} звіт(ів)${label ? ` за період «${label}».` : '.'}${aepQuartersMsg}`);
    if (state._aepRosterDuplicates && state._aepRosterDuplicates.length) {
      const list = state._aepRosterDuplicates.map((d) => `«${d.a}» / «${d.b}»`).join(', ');
      // Toast already faded/will fade — this is a separate, slower-dismissing
      // notice so a real data issue in the roster file doesn't go unnoticed.
      setTimeout(() => showToast(
        `Схожі записи в ростері (можливо, одна й та сама людина двічі): ${list}. Варто прибрати дублікат у файлі перед наступним завантаженням.`,
        true, 9000,
      ), 4200);
      state._aepRosterDuplicates = null;
    }
    renderPositionSwitch();
    state.selectedPeriodId = null;
    await refreshAll();
  } catch (e) {
    errorEl.textContent = e.message;
    btn.disabled = false;
    btn.textContent = 'Зберегти';
  }
}

/* ===================== Feed sync modal ===================== */

// Pulls attestation / "Все навчання" reports straight from Comfy Feed with the operator's own
// Feed login (see /api/feed-sync). The password goes to our server for that
// one request only — nothing here stores it (no localStorage, no state).
const FEED_ATT_TYPE_LABELS = {
  dir: 'Директори', tv: 'Товарознавці', klad: 'Комірники', kass: 'Касири', sm: 'Сервіс-менеджери', prod: 'Продавці', sellers: 'Продавці',
};

function openFeedSyncModal() {
  const root = document.getElementById('modal-root');
  const now = new Date();
  const currentQuarter = Math.floor(now.getMonth() / 3) + 1;
  const currentYear = now.getFullYear();
  root.innerHTML = `
    <div class="modal-backdrop" id="feed-backdrop">
      <div class="modal" style="max-width:480px;">
        <button class="modal-close" id="feed-close">✕</button>
        <h2>Оновити з Feed</h2>
        <p class="modal-subtitle">Звіти підтягнуться напряму з Feed — ті самі дані, що й «Звіт по заняттях» в Excel. Пароль використовується лише для цього оновлення й ніде не зберігається.</p>
        <form id="feed-form" autocomplete="on">
          <div class="field-group">
            <label for="feed-login">Логін Feed</label>
            <input type="text" id="feed-login" name="username" autocomplete="username" required>
          </div>
          <div class="field-group">
            <label for="feed-password">Пароль Feed</label>
            <input type="password" id="feed-password" name="password" autocomplete="current-password" required>
          </div>
          <div class="field-group">
            <label>Що оновити</label>
            <label style="display:flex; gap:8px; align-items:center; font-weight:normal;"><input type="checkbox" id="feed-r-attestation" checked> Атестація (директори, товарознавці, комірники, касири, СМ)</label>
            <label style="display:flex; gap:8px; align-items:center; font-weight:normal;"><input type="checkbox" id="feed-r-sellers" checked> Атестація продавців («Звіт з АТТ»)</label>
            <label style="display:flex; gap:8px; align-items:center; font-weight:normal;"><input type="checkbox" id="feed-r-overall" checked> Все навчання</label>
            <label style="display:flex; gap:8px; align-items:center; font-weight:normal;"><input type="checkbox" id="feed-r-trainees"> Стажери («Премія за наставництво», 3 місяці кварталу)</label>
            <div class="field-hint">«Все навчання» й продавців Feed віддає лише за поточний або попередній квартал. Все навчання: ${lastUpdatedFor('overall', 'overall') || 'немає даних'}.</div>
          </div>
          <div class="field-group">
            <label>Період</label>
            <div style="display:flex; gap:8px;">
              <select id="feed-quarter">
                ${[1, 2, 3, 4].map((q) => `<option value="${q}" ${q === currentQuarter ? 'selected' : ''}>${q} квартал</option>`).join('')}
              </select>
              <input type="number" id="feed-year" value="${currentYear}" style="width:100px;">
            </div>
            <div class="field-hint">Дані за цей квартал ЗАМІНЯТЬ уже завантажені (як і при ручному завантаженні). Атестація — ${ATTESTATION_STREAMS.map((p) => `${escapeHtml(p)}: ${lastUpdatedFor('attestation', p) || 'немає даних'}`).join(' · ')}</div>
          </div>
          <div id="feed-result"></div>
          <div id="feed-error" class="error-text"></div>
          <div class="modal-actions">
            <button type="button" class="btn btn-secondary" id="feed-cancel">Скасувати</button>
            <button type="submit" class="btn btn-primary" id="feed-submit">Оновити</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('feed-close').onclick = closeModal;
  document.getElementById('feed-cancel').onclick = closeModal;
  document.getElementById('feed-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'feed-backdrop') closeModal();
  });
  document.getElementById('feed-form').addEventListener('submit', (e) => { e.preventDefault(); handleFeedSync(); });
  document.getElementById('feed-login').focus();
}

async function handleFeedSync() {
  const btn = document.getElementById('feed-submit');
  const errorEl = document.getElementById('feed-error');
  const resultEl = document.getElementById('feed-result');
  const passwordEl = document.getElementById('feed-password');
  errorEl.textContent = '';
  resultEl.innerHTML = '';
  const login = document.getElementById('feed-login').value.trim();
  const year = document.getElementById('feed-year').value.trim();
  const quarter = document.getElementById('feed-quarter').value;
  if (!login || !passwordEl.value) { errorEl.textContent = 'Вкажіть логін і пароль Feed.'; return; }
  if (!/^\d{4}$/.test(year)) { errorEl.textContent = 'Вкажіть рік.'; return; }
  const reports = [
    document.getElementById('feed-r-attestation').checked && 'attestation',
    document.getElementById('feed-r-sellers').checked && 'sellers',
    document.getElementById('feed-r-overall').checked && 'overall',
    document.getElementById('feed-r-trainees').checked && 'trainees',
  ].filter(Boolean);
  if (!reports.length) { errorEl.textContent = 'Оберіть, які звіти оновити.'; return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Завантаження з Feed…';
  try {
    const resp = await api('/api/feed-sync', {
      method: 'POST',
      body: JSON.stringify({ login, password: passwordEl.value, attPeriod: `${year}-${quarter}`, reports }),
    });
    passwordEl.value = '';
    await loadPositionsConfig();
    await loadStreams();
    renderPositionSwitch();
    state.selectedPeriodId = null;
    if (state.trainees) state.trainees.data = null;
    await refreshAll();
    const reportName = (s) => (s.streamType === 'overall' ? 'Все навчання' : s.streamType === 'trainees' ? 'Стажери' : `Атестація: ${s.streamKey || FEED_ATT_TYPE_LABELS[s.attType] || s.attType}`);
    const savedHtml = resp.saved.map((s) => `<li>${escapeHtml(reportName(s))} — ${fmtNum(s.rowsCount)} співробітників</li>`).join('');
    const skippedHtml = resp.skipped.map((s) => `<li class="error-text">${escapeHtml(reportName(s))}: ${escapeHtml(s.reason)}</li>`).join('');
    const unclassified = [...new Set(resp.saved.flatMap((s) => s.unclassifiedPositions))];
    resultEl.innerHTML = `
      <div class="field-hint" style="margin-bottom:8px;">Оновлено «${escapeHtml(resp.label)}»:</div>
      <ul style="margin:0 0 8px 18px;">${savedHtml}${skippedHtml}</ul>
      ${unclassified.length ? `<div class="field-hint">Нові посади для класифікації: ${unclassified.map(escapeHtml).join(', ')} — перевірте «Класифікацію посад».</div>` : ''}
    `;
    btn.disabled = false;
    btn.textContent = 'Оновити ще раз';
    document.getElementById('feed-cancel').textContent = 'Закрити';
    showToast(`Оновлено з Feed: ${resp.saved.length} звіт(ів) за «${resp.label}».`);
  } catch (e) {
    errorEl.textContent = e.message;
    btn.disabled = false;
    btn.textContent = 'Оновити';
  }
}

/* ===================== trainees ("Стажери") ===================== */

// Internship success from Feed's "Премія за наставництво" (see /api/trainees
// and feed_sync.trainee_success): sellers — met both sales-per-hour norms in
// their main shop; back-office — Feed's verdict on that position's criteria.
// Trainees dismissed during the internship, and ones still mid-internship,
// are shown but kept out of the success rate.
const TRAINEE_MONTHS = ['Січ', 'Лют', 'Бер', 'Кві', 'Тра', 'Чер', 'Лип', 'Сер', 'Вер', 'Жов', 'Лис', 'Гру'];
const TRAINEE_STATUS = {
  success: { label: 'Успішно', cls: 'success' },
  fail: { label: 'Неуспішно', cls: 'fail' },
  pending: { label: 'Ще стажується', cls: 'pending' },
  dismissed: { label: 'Звільнений під час стажування', cls: 'dismissed' },
};

function traineePeriodOptions(rows) {
  const months = [...new Set(rows.map((r) => r.year * 100 + r.month))].sort((a, b) => b - a);
  const years = [...new Set(months.map((m) => Math.floor(m / 100)))];
  const opts = [];
  years.forEach((y) => {
    const ym = months.filter((m) => Math.floor(m / 100) === y).map((m) => m % 100);
    [4, 3, 2, 1].forEach((q) => {
      if (ym.some((m) => Math.ceil(m / 3) === q)) opts.push({ value: `${y}-Q${q}`, label: `${q} квартал ${y}` });
    });
    ym.forEach((m) => opts.push({ value: `${y}-M${m}`, label: `${TRAINEE_MONTHS[m - 1]} ${y}` }));
  });
  return opts;
}

function traineeInPeriod(r, period) {
  const [y, p] = period.split('-');
  if (r.year !== Number(y)) return false;
  const n = Number(p.slice(1));
  if (p[0] === 'Q') return Math.ceil(r.month / 3) === n;
  return r.month === n;
}

// Default: the latest quarter whose every month is already over — an
// in-progress quarter would read low (internships not judged yet).
function defaultTraineePeriod(rows) {
  const now = new Date();
  const curKey = now.getFullYear() * 10 + Math.ceil((now.getMonth() + 1) / 3);
  const quarters = [...new Set(rows.map((r) => r.year * 10 + Math.ceil(r.month / 3)))].sort((a, b) => b - a);
  const done = quarters.find((q) => q < curKey) ?? quarters[0];
  return done ? `${Math.floor(done / 10)}-Q${done % 10}` : '';
}

function traineeRate(rows) {
  const judged = rows.filter((r) => r.status === 'success' || r.status === 'fail');
  const ok = judged.filter((r) => r.status === 'success').length;
  return { ok, judged: judged.length, pct: judged.length ? (ok * 100) / judged.length : null };
}

function traineeRateCell(rate) {
  return rate.judged ? `${badgeHtml(rate.pct)} <span class="muted">${rate.ok} з ${rate.judged}</span>` : '<span class="muted">—</span>';
}

async function renderTraineesView() {
  const area = document.getElementById('content-area');
  const tr = state.trainees || (state.trainees = { period: '', region: '', store: '', position: '', status: '', search: '' });
  if (!tr.data) {
    area.innerHTML = '<div class="card"><span class="spinner"></span> Завантаження…</div>';
    tr.data = await api('/api/trainees');
  }
  // "nodata" (internship over, 0 hours worked in the evaluation period —
  // nothing to judge) is left out of the view entirely
  const rows = tr.data.trainees.filter((r) => r.status !== 'nodata');
  if (!rows.length) {
    area.innerHTML = `
      <div class="empty-state">
        <h2>Ще немає даних</h2>
        <p>Стажери підтягуються з Feed: «Оновити з Feed» → галочка «Стажери».</p>
      </div>`;
    return;
  }
  const periods = traineePeriodOptions(rows);
  if (!tr.period || !periods.some((p) => p.value === tr.period)) tr.period = defaultTraineePeriod(rows);
  const inPeriod = rows.filter((r) => traineeInPeriod(r, tr.period));
  const regions = [...new Set(inPeriod.map((r) => r.region).filter(Boolean))].sort();
  const stores = [...new Set(inPeriod.filter((r) => !tr.region || r.region === tr.region).map((r) => r.store).filter(Boolean))].sort();
  const sel = (id, label, options, value, allLabel) => `
    <div class="filter-field">
      <label>${label}</label>
      <select id="${id}">${allLabel !== null ? `<option value="">${allLabel}</option>` : ''}${options.map((o) => `<option value="${escapeHtml(o.value)}" ${o.value === value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>
    </div>`;
  const positionOptions = [
    { value: 'prod', label: 'Продавці' }, { value: 'back', label: 'Бек-посади (усі)' },
    ...['kass', 'klad', 'sm', 'tv'].map((t) => ({ value: t, label: { kass: 'Касир', klad: 'Комірник', sm: 'Сервіс менеджер', tv: 'Товарознавець' }[t] })),
  ];

  area.innerHTML = `
    <div class="last-updated-note">Дані з Feed «Премія за наставництво»${tr.data.syncedAt ? `, оновлено: ${fmtUploadedAt(tr.data.syncedAt)}` : ''}</div>
    <div class="filters">
      ${sel('tr-period', 'Період (планове завершення)', periods, tr.period, null)}
      ${sel('tr-region', 'Регіон', regions.map((r) => ({ value: r, label: r })), tr.region, 'Усі регіони')}
      ${sel('tr-store', 'Магазин', stores.map((r) => ({ value: r, label: r })), tr.store, 'Усі магазини')}
      ${sel('tr-position', 'Посада', positionOptions, tr.position, 'Усі посади')}
      <button class="btn btn-secondary btn-sm filter-reset" id="tr-reset">Скинути фільтри</button>
    </div>
    <div class="table-note" style="margin:-4px 0 12px;">Продавець успішний, якщо в основному магазині виконав обидві норми: товарообіг/год і асс + сервіси/год (норма 2-ї кат. −20%). Бек-посади — за критеріями посади у Feed (іспит, CSI, помилки, швидкість збору…). Звільнені під час стажування й ті, хто ще стажується, в успішність не входять; стажери без жодної години роботи за період оцінки не показуються.</div>
    <div class="kpi-grid" id="tr-kpis"></div>
    <div class="grid-2">
      <div class="card"><h3>Успішність по місяцях</h3><div class="chart-wrap"><canvas id="chart-trainees-months" height="220"></canvas></div></div>
      <div class="card"><h3>За посадами</h3><div class="table-scroll"><table class="data-table" id="tr-positions"></table></div></div>
    </div>
    <div class="grid-2">
      <div class="card"><h3>За регіонами</h3><div class="table-scroll"><table class="data-table" id="tr-regions"></table></div></div>
      <div class="card"><h3>Магазини (від найгіршої успішності)</h3><div class="table-scroll"><table class="data-table" id="tr-stores"></table></div></div>
    </div>
    <div class="card">
      <div class="table-toolbar">
        <h3 class="mt-0">Стажери</h3>
        <div class="filters-inline" style="margin:0;">
          <div class="filter-field"><label for="tr-status">Результат</label><select id="tr-status">
            <option value="">Усі результати</option>
            ${Object.entries(TRAINEE_STATUS).map(([k, v]) => `<option value="${k}" ${k === tr.status ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select></div>
          <div class="filter-field wide"><label for="tr-search">ПІБ або наставник</label><input type="text" class="search-input" id="tr-search" placeholder="Пошук за ПІБ або наставником…" value="${escapeHtml(tr.search)}"></div>
        </div>
      </div>
      <div class="table-scroll"><table class="data-table" id="tr-list"></table></div>
      <div class="table-note" id="tr-list-note"></div>
    </div>
  `;

  const rerender = async () => { await renderTraineesView(); };
  document.getElementById('tr-period').onchange = (e) => { tr.period = e.target.value; tr.store = ''; rerender(); };
  document.getElementById('tr-region').onchange = (e) => { tr.region = e.target.value; tr.store = ''; rerender(); };
  document.getElementById('tr-store').onchange = (e) => { tr.store = e.target.value; rerender(); };
  document.getElementById('tr-position').onchange = (e) => { tr.position = e.target.value; rerender(); };
  document.getElementById('tr-status').onchange = (e) => { tr.status = e.target.value; renderTraineeList(scoped); };
  document.getElementById('tr-search').addEventListener('input', debounce((e) => { tr.search = e.target.value; renderTraineeList(scoped); }, 250));
  document.getElementById('tr-reset').onclick = () => { Object.assign(tr, { region: '', store: '', position: '', status: '', search: '' }); rerender(); };

  const matchPosition = (r) => !tr.position || (tr.position === 'back' ? r.type !== 'prod' : r.type === tr.position);
  const scoped = inPeriod.filter((r) => (!tr.region || r.region === tr.region) && (!tr.store || r.store === tr.store) && matchPosition(r));

  // KPI tiles
  const all = traineeRate(scoped);
  const sellers = traineeRate(scoped.filter((r) => r.type === 'prod'));
  const back = traineeRate(scoped.filter((r) => r.type !== 'prod'));
  const tiles = [
    { label: 'Успішність стажування', value: fmtPct(all.pct), accent: 'green' },
    { label: 'Продавці', value: fmtPct(sellers.pct), accent: '' },
    { label: 'Бек-посади', value: fmtPct(back.pct), accent: '' },
    { label: 'Завершили стажування', value: fmtNum(all.judged), accent: '' },
    { label: 'Звільнились під час стажування', value: fmtNum(scoped.filter((r) => r.status === 'dismissed').length), accent: 'muted' },
    { label: 'Ще стажуються', value: fmtNum(scoped.filter((r) => r.status === 'pending').length), accent: 'muted' },
  ];
  const kpiGrid = document.getElementById('tr-kpis');
  kpiGrid.innerHTML = tiles.map((tl) => `
    <div class="kpi-tile ${tl.accent ? `accent-${tl.accent}` : ''}">
      <div class="kpi-value">${tl.value}</div>
      <div class="kpi-label">${escapeHtml(tl.label)}</div>
    </div>`).join('');
  // one row, like renderKPIs (narrow screens keep the 2-per-row fallback)
  kpiGrid.style.gridTemplateColumns = window.matchMedia('(max-width: 860px)').matches ? '' : `repeat(${tiles.length}, 1fr)`;

  // by month chart
  const monthKeys = [...new Set(scoped.map((r) => r.year * 100 + r.month))].sort((a, b) => a - b);
  destroyChart('traineesMonths');
  const rateFor = (key, pred) => traineeRate(scoped.filter((r) => r.year * 100 + r.month === key && pred(r))).pct;
  state.charts.traineesMonths = new Chart(document.getElementById('chart-trainees-months'), {
    type: 'bar',
    data: {
      labels: monthKeys.map((k) => `${TRAINEE_MONTHS[(k % 100) - 1]} ${Math.floor(k / 100)}`),
      datasets: [
        { label: 'Продавці', data: monthKeys.map((k) => rateFor(k, (r) => r.type === 'prod')), backgroundColor: STATUS_COLORS.good },
        { label: 'Бек-посади', data: monthKeys.map((k) => rateFor(k, (r) => r.type !== 'prod')), backgroundColor: '#4a7dfc' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { y: { min: 0, max: 100, ticks: { callback: (v) => `${v}%` } } },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw === null ? '—' : `${Math.round(c.raw * 10) / 10}%`}` } },
      },
    },
  });

  // group tables
  const groupTable = (id, keyFn, label, sortWorst) => {
    const groups = {};
    scoped.forEach((r) => { const k = keyFn(r); if (k) (groups[k] = groups[k] || []).push(r); });
    let list = Object.entries(groups).map(([k, rs]) => ({ k, rate: traineeRate(rs), region: rs[0].region }));
    list = sortWorst
      ? list.filter((g) => g.rate.judged).sort((a, b) => a.rate.pct - b.rate.pct || b.rate.judged - a.rate.judged)
      : list.sort((a, b) => b.rate.judged - a.rate.judged);
    document.getElementById(id).innerHTML = `
      <thead><tr><th>${label}</th>${id === 'tr-stores' ? '<th>Регіон</th>' : ''}<th>Успішність</th></tr></thead>
      <tbody>${list.map((g) => `<tr><td>${escapeHtml(g.k)}</td>${id === 'tr-stores' ? `<td>${escapeHtml(g.region)}</td>` : ''}<td>${traineeRateCell(g.rate)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Немає даних</td></tr>'}</tbody>`;
  };
  groupTable('tr-positions', (r) => r.position, 'Посада', false);
  groupTable('tr-regions', (r) => r.region, 'Регіон', true);
  groupTable('tr-stores', (r) => r.store, 'Магазин', true);

  renderTraineeList(scoped);
}

function renderTraineeList(scoped) {
  const tr = state.trainees;
  const q = tr.search.trim().toLowerCase();
  const order = { fail: 0, success: 1, pending: 2, dismissed: 3 };
  const rows = scoped
    .filter((r) => !tr.status || r.status === tr.status)
    .filter((r) => !q || (r.name || '').toLowerCase().includes(q) || (r.mentor || '').toLowerCase().includes(q))
    .sort((a, b) => order[a.status] - order[b.status] || (a.region || '').localeCompare(b.region || '', 'uk') || (a.name || '').localeCompare(b.name || '', 'uk'));
  const shown = rows.slice(0, 400);
  document.getElementById('tr-list').innerHTML = `
    <thead><tr><th>ПІБ</th><th>Посада</th><th>Магазин</th><th>Наставник</th><th>Стажування</th><th>Результат</th><th>Чого не вистачило</th></tr></thead>
    <tbody>${shown.map((r) => `
      <tr>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.position)}</td>
        <td>${escapeHtml(r.store)}<div class="muted">${escapeHtml(r.region)}</div></td>
        <td>${escapeHtml(r.mentor || '—')}<div class="muted">${escapeHtml(r.mentorPosition || '')}</div></td>
        <td>${fmtFeedDate(r.dateStart)} – ${fmtFeedDate(r.dateEndPlan)}</td>
        <td><span class="status-pill ${TRAINEE_STATUS[r.status].cls}">${TRAINEE_STATUS[r.status].label}</span></td>
        <td>${r.reasons.map(escapeHtml).join('<br>') || '<span class="muted">—</span>'}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">Немає стажерів для обраних фільтрів</td></tr>'}</tbody>`;
  document.getElementById('tr-list-note').textContent = rows.length > shown.length
    ? `Показано перші ${shown.length} з ${rows.length} — уточніть фільтри або пошук.`
    : `Показано ${rows.length}.`;
}

/* ===================== Кадровий резерв (Leader Hub) ===================== */

// The tab itself lives in static/js/reserve.js (LeaderHub.mount — tabs
// Кадровий резерв / Leader Hub 1.0 / 2.0, built on the team's prototype);
// here: loading /api/reserve and the editing actions it calls back into.
const LH_PROGRAMS = { LH1: 'LH 1.0', LH2: 'LH 2.0', TZ: 'LH БЕК' };

async function renderReserveView() {
  const area = document.getElementById('content-area');
  const rs = state.reserve || (state.reserve = { data: null });
  if (!rs.data) {
    area.innerHTML = '<div class="card"><span class="spinner"></span> Завантаження…</div>';
    rs.data = await api('/api/reserve');
  }
  const { uploads } = rs.data;
  if (!uploads.lh_participants && !rs.data.streams.length) {
    area.innerHTML = `
      <div class="empty-state">
        <h2>Ще немає даних</h2>
        <p>«Завантажити дані вручну» → «Кадровий резерв»: файл учасників Leader Hub і «Історія працівника» з BI.</p>
      </div>`;
    return;
  }
  const note = () => {
    const ups = rs.data.uploads;
    // the latest of the two sources (participants file, «Історія працівника»); details on hover
    const latest = ['lh_participants', 'employee_history'].map((k) => ups[k] && ups[k].uploadedAt).filter(Boolean).sort().pop();
    const up = (k) => (ups[k] ? `${fmtNum(ups[k].rows)} · ${fmtUploadedAt(ups[k].uploadedAt)}` : 'не завантажено');
    const title = `Учасники: ${up('lh_participants')}\nІсторія працівника (BI): ${up('employee_history')}`;
    const unmatched = Object.values(rs.data.people).filter((p) => !p.matchedBy).length;
    return `<span title="${escapeHtml(title)}">${latest ? `Востаннє оновлено: ${fmtUploadedAt(latest)}` : 'Дані ще не завантажено'}</span>${unmatched && state.role !== 'hr' ? ` · <span class="error-text">не знайдено в історії: ${unmatched}</span>` : ''}`;
  };
  area.innerHTML = `<div class="last-updated-note" id="lh-note">${note()}</div><div id="lh-mount"></div>`;
  // after an edit: fetch fresh numbers and re-render in place (no spinner,
  // same tab / filters / scroll)
  const reload = async () => {
    rs.data = await api('/api/reserve');
    const n = document.getElementById('lh-note');
    if (n) n.innerHTML = note();
    LeaderHub.update(rs.data);
  };
  LeaderHub.mount(document.getElementById('lh-mount'), rs.data, {
    readOnly: state.role === 'hr', // HR: only the potentials can be changed
    settings: (prog) => openLhSettingsModal(prog, reload),
    newStream: (prog) => openNewStreamModal(prog),
    addParticipant: (prog, year) => openAddParticipantModal(prog, year),
    deleteStream: async (prog, year) => {
      try { await api(`/api/lh-streams/${prog}/${year}`, { method: 'DELETE' }); await reload(); } catch (err) { showToast(err.message, true); }
    },
    setStatus: async (part, status) => {
      try { await api(`/api/lh-participants/${part.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); showToast('Статус змінено'); await reload(); } catch (err) { showToast(err.message, true); }
    },
    setReserveStatus: async (entry, status, note) => {
      try {
        await api('/api/reserve-status', { method: 'PUT', body: JSON.stringify({ pid: entry.pid, program: entry.prog, status, note }) });
        showToast(status ? 'Статус резерву збережено' : 'Повернуто автостатус');
        await reload();
      } catch (err) { showToast(err.message, true); }
    },
    setAdminNote: async (part, note) => {
      try {
        await api('/api/admin-note', { method: 'PUT', body: JSON.stringify({ pid: part.pid, program: part.prog, year: part.year, note }) });
        showToast(note ? 'Коментар збережено' : 'Коментар видалено');
        await reload();
      } catch (err) { showToast(err.message, true); }
    },
    setReserveNote: async (entry, note) => {
      try {
        await api('/api/reserve-note', { method: 'PUT', body: JSON.stringify({ pid: entry.pid, program: entry.prog, note }) });
        showToast(note ? 'Коментар збережено' : 'Коментар видалено');
        await reload();
      } catch (err) { showToast(err.message, true); }
    },
    addPotential: (prog) => openAddPotentialModal(prog, reload),
    removeParticipant: async (part, name) => {
      if (!confirm(`Прибрати ${name} з потоку ${LH_PROGRAMS[part.prog]} · ${part.year}?`)) return;
      try { await api(`/api/lh-participants/${part.id}`, { method: 'DELETE' }); await reload(); } catch (err) { showToast(err.message, true); }
    },
  });
}

// ⚙️ Налаштування Leader Hub: pick the project (LH 1.0 / 2.0), then its
// streams — dates, participants (add / remove), new stream, delete empty
function openLhSettingsModal(program, reload, sel = {}) {
  const st = { program: sel.program || program || 'LH1', year: sel.year || null, q: '', changed: !!sel.changed };
  const root = document.getElementById('modal-root');
  const refresh = async () => { state.reserve.data = await api('/api/reserve'); st.changed = true; draw(); };
  const done = async () => { closeModal(); if (st.changed) await reload(); };
  const reopen = (changed) => openLhSettingsModal(program, reload, { program: st.program, year: st.year, changed: st.changed || changed });
  function draw() {
    const data = state.reserve.data;
    const parts = data.parts.filter((x) => x.prog === st.program);
    const count = {};
    parts.forEach((x) => { count[x.year] = (count[x.year] || 0) + 1; });
    const streams = data.streams.filter((s) => s.program === st.program).sort((a, b) => b.year - a.year);
    if (st.year && !streams.some((s) => s.year === st.year)) st.year = null;
    if (!st.year && streams.length) st.year = streams[0].year;
    const people = parts.filter((x) => x.year === st.year)
      .map((x) => Object.assign({}, x, { name: (data.people[x.pid] || {}).name || '', tab: (data.people[x.pid] || {}).tab || '' }))
      .filter((x) => !st.q || x.name.toLowerCase().includes(st.q.toLowerCase()) || x.tab === st.q)
      .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
    const progBtn = (p, label) => `<button class="tab-btn ${st.program === p ? 'active' : ''}" data-prog="${p}">${label}</button>`;
    root.innerHTML = `
      <div class="modal-backdrop" id="ls-backdrop"><div class="modal" style="max-width:900px;">
        <button class="modal-close" id="ls-close">✕</button>
        <h2>⚙️ Налаштування Leader Hub</h2>
        <div class="field-group"><label>1. Проєкт</label>
          <div class="tabs small" id="ls-prog">${progBtn('LH1', 'Leader Hub 1.0 · резерв на Заступника')}${progBtn('LH2', 'Leader Hub 2.0 · резерв на Директора')}${progBtn('TZ', 'Leader Hub БЕК · резерв на Товарознавця')}</div></div>
        <div class="field-group"><label>2. Потоки й період проведення</label>
          <p class="modal-subtitle" style="margin:0 0 8px;">Від дати старту рахуються призначення й «Швидкість виходу на посаду». Оберіть потік, щоб керувати учасниками.</p>
          <div class="table-scroll"><table class="data-table">
            <thead><tr><th>Потік</th><th>Старт</th><th>Завершення</th><th class="num">Учасників</th><th></th></tr></thead>
            <tbody>${streams.map((s) => `
              <tr data-year="${s.year}" class="row-clickable ${s.year === st.year ? 'ls-active' : ''}">
                <td><b>${s.year}</b></td>
                <td><input type="date" class="ls-start" value="${s.date_start || ''}"></td>
                <td><input type="date" class="ls-end" value="${s.date_end || ''}"></td>
                <td class="num">${count[s.year] || 0}</td>
                <td style="white-space:nowrap; text-align:right;">${s.year === st.year ? '<span class="muted">обрано ▾</span>' : '<button class="btn btn-secondary btn-sm ls-pick">Учасники</button>'}
                  ${count[s.year] ? '' : '<button class="btn btn-secondary btn-sm ls-del">Видалити</button>'}</td></tr>`).join('')
              || '<tr><td colspan="5" class="muted">Потоків ще немає</td></tr>'}</tbody>
          </table></div>
          <button class="btn btn-secondary btn-sm" id="ls-new" style="margin-top:8px;">+ Новий потік ${LH_PROGRAMS[st.program]}</button>
        </div>
        ${st.year ? `
        <div class="field-group"><label>3. Учасники потоку ${LH_PROGRAMS[st.program]} · ${st.year} — ${count[st.year] || 0}</label>
          <div style="display:flex; gap:10px; align-items:center; margin-bottom:8px;">
            <input type="search" class="search-input" id="ls-q" placeholder="ПІБ або таб. номер" value="${escapeHtml(st.q)}" style="flex:1;">
            <button class="btn btn-primary btn-sm" id="ls-add">+ Додати учасників</button></div>
          <div class="table-scroll" style="max-height:320px;"><table class="data-table">
            <thead><tr><th>ПІБ</th><th>Таб. №</th><th>Стартова посада</th><th>Магазин</th><th>Статус</th><th></th></tr></thead>
            <tbody>${people.map((x) => `<tr data-id="${x.id}" data-name="${escapeHtml(x.name)}">
              <td>${escapeHtml(x.name)}</td><td>${escapeHtml(x.tab || '—')}</td><td>${escapeHtml(x.pos_in || '')}</td>
              <td>${escapeHtml(x.store || '')}</td><td>${escapeHtml(x.status)}</td>
              <td><button class="btn btn-secondary btn-sm ls-rm" title="Прибрати з потоку">✕</button></td></tr>`).join('')
              || `<tr><td colspan="6" class="muted">${st.q ? 'Нікого не знайдено' : 'Учасників ще немає — «+ Додати учасників»'}</td></tr>`}</tbody>
          </table></div>
        </div>` : ''}
        <div id="ls-error" class="error-text"></div>
        <div class="modal-actions"><button class="btn btn-secondary" id="ls-done">Готово</button></div>
      </div></div>`;
    const $id = (id) => document.getElementById(id);
    const err = (e) => { $id('ls-error').textContent = e.message; };
    $id('ls-close').onclick = done;
    $id('ls-done').onclick = done;
    root.querySelectorAll('#ls-prog .tab-btn').forEach((b) => b.addEventListener('click', () => { st.program = b.dataset.prog; st.year = null; st.q = ''; draw(); }));
    $id('ls-new').onclick = () => openNewStreamModal(st.program);
    root.querySelectorAll('tbody tr[data-year]').forEach((tr) => {
      const year = Number(tr.dataset.year);
      const save = async () => {
        try {
          await api('/api/lh-streams', { method: 'POST', body: JSON.stringify({ program: st.program, year, dateStart: tr.querySelector('.ls-start').value, dateEnd: tr.querySelector('.ls-end').value }) });
          showToast(`Дати потоку ${LH_PROGRAMS[st.program]} · ${year} збережено`);
          const keep = $id('ls-q') ? $id('ls-q').value : '';
          st.q = keep; await refresh();
        } catch (e) { err(e); }
      };
      tr.querySelector('.ls-start').addEventListener('change', save);
      tr.querySelector('.ls-end').addEventListener('change', save);
      tr.querySelectorAll('input').forEach((i) => i.addEventListener('click', (e) => e.stopPropagation()));
      tr.addEventListener('click', (e) => { if (e.target.closest('.ls-del')) return; st.year = year; st.q = ''; draw(); });
      const del = tr.querySelector('.ls-del');
      if (del) del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Видалити порожній потік ${LH_PROGRAMS[st.program]} · ${year}?`)) return;
        try { await api(`/api/lh-streams/${st.program}/${year}`, { method: 'DELETE' }); showToast('Потік видалено'); await refresh(); } catch (e2) { err(e2); }
      };
    });
    if (!st.year) return;
    const q = $id('ls-q');
    q.addEventListener('input', debounce(() => { st.q = q.value.trim(); draw(); const n = $id('ls-q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250));
    $id('ls-add').onclick = () => openAddParticipantModal(st.program, st.year, reopen);
    root.querySelectorAll('.ls-rm').forEach((b) => b.addEventListener('click', async () => {
      const tr = b.closest('tr');
      if (!confirm(`Прибрати ${tr.dataset.name} з потоку ${LH_PROGRAMS[st.program]} · ${st.year}?`)) return;
      try { await api(`/api/lh-participants/${tr.dataset.id}`, { method: 'DELETE' }); showToast('Прибрано з потоку'); await refresh(); } catch (e) { err(e); }
    }));
  }
  draw();
}

function openNewStreamModal(program = 'LH1') {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" id="ns-backdrop"><div class="modal" style="max-width:720px;">
      <button class="modal-close" id="ns-close">✕</button>
      <h2>Новий потік Leader Hub</h2>
      <div style="display:flex; gap:16px; flex-wrap:wrap;">
        <div class="field-group"><label>Програма</label>
          <select id="ns-program"><option value="LH1" ${program === 'LH1' ? 'selected' : ''}>LH 1.0 — резерв на заступника</option><option value="LH2" ${program === 'LH2' ? 'selected' : ''}>LH 2.0 — резерв на директора</option><option value="TZ" ${program === 'TZ' ? 'selected' : ''}>LH БЕК — резерв на товарознавця</option></select></div>
        <div class="field-group"><label>Рік потоку</label><input type="number" id="ns-year" value="${new Date().getFullYear()}" style="width:110px;"></div>
        <div class="field-group"><label>Дати (необов'язково)</label>
          <div style="display:flex; gap:8px;"><input type="date" id="ns-start"><input type="date" id="ns-end"></div></div>
      </div>
      <div class="field-group"><label>Учасники <span class="muted" id="ns-count"></span></label>
        <div id="ns-selected" class="ns-selected"></div>
        <div class="tabs small" role="group" id="ns-mode" style="margin-bottom:8px;">
          <button type="button" class="tab-btn active" data-m="search" aria-pressed="true">🔍 Пошук</button>
          <button type="button" class="tab-btn" data-m="pot" aria-pressed="false">🌱 Додати з потенційних <span id="ns-pot-n"></span></button>
        </div>
        <input type="text" class="search-input" id="ns-q" placeholder="Пошук в «Історії працівника»: прізвище або таб. номер…" style="width:100%;">
        <div id="ns-pot-tools" class="pp-find" hidden><div class="filter-field"><label for="ns-pot-reg">Регіон</label><select id="ns-pot-reg"></select></div><button type="button" class="btn btn-secondary btn-sm" id="ns-pot-all">Обрати всіх у списку</button></div>
        <div class="table-scroll" style="margin-top:10px; max-height:300px;"><table class="data-table" id="ns-results"></table></div>
      </div>
      <div id="ns-error" class="error-text"></div>
      <div class="modal-actions"><button class="btn btn-secondary" id="ns-cancel">Скасувати</button><button class="btn btn-primary" id="ns-save">Створити</button></div>
    </div></div>`;
  const $id = (id) => document.getElementById(id);
  const picked = new Map(); // tab -> employee
  let found = [], mode = 'search', searched = [];
  // «Додати з потенційних»: people marked as potentials toward this programme
  const potList = () => LeaderHub.potentials($id('ns-program').value);
  const showPot = () => {
    const all = potList(), reg = $id('ns-pot-reg').value;
    found = reg ? all.filter((e) => e.region === reg) : all;
    renderFound();
  };
  const fillPotRegions = () => {
    const all = potList(), cur = $id('ns-pot-reg').value;
    $id('ns-pot-n').textContent = `· ${all.length}`;
    const regs = [...new Set(all.map((e) => e.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
    $id('ns-pot-reg').innerHTML = `<option value="">Усі регіони · ${all.length}</option>` + regs.map((r) => `<option value="${escapeHtml(r)}" ${r === cur ? 'selected' : ''}>${escapeHtml(r)} · ${all.filter((e) => e.region === r).length}</option>`).join('');
  };
  const setMode = (m) => {
    mode = m;
    $id('ns-mode').querySelectorAll('.tab-btn').forEach((b) => { const on = b.dataset.m === m; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    $id('ns-q').hidden = m !== 'search';
    $id('ns-pot-tools').hidden = m !== 'pot';
    if (m === 'pot') { fillPotRegions(); showPot(); } else { found = searched; renderFound(); }
  };
  const empLine = (e) => `${escapeHtml(e.position)}<div class="muted">${escapeHtml(e.store || '')}${e.region ? ` · ${escapeHtml(e.region)}` : ''}</div>`;
  const renderPicked = () => {
    $id('ns-count').textContent = picked.size ? `· обрано ${picked.size}` : '';
    $id('ns-save').textContent = picked.size ? `Створити потік і додати ${picked.size}` : 'Створити';
    $id('ns-selected').innerHTML = [...picked.values()].map((e) => `
      <span class="ns-chip">${escapeHtml(e.name)} <span class="muted">${escapeHtml(e.position)}</span>
      <button type="button" class="ns-chip-x" data-tab="${escapeHtml(e.tab)}" title="Прибрати">✕</button></span>`).join('');
    $id('ns-selected').querySelectorAll('.ns-chip-x').forEach((b) => b.addEventListener('click', () => { picked.delete(b.dataset.tab); renderPicked(); renderFound(); }));
  };
  const renderFound = () => {
    const q = $id('ns-q').value.trim();
    const t = $id('ns-results');
    t.innerHTML = found.map((e) => {
      const on = picked.has(e.tab);
      return `<tr><td>${escapeHtml(e.name)}<div class="muted">таб. ${escapeHtml(e.tab)}</div></td>
        <td>${empLine(e)}</td>
        <td>${e.why ? `<span class="muted">${escapeHtml(e.why)}</span>` : e.working ? '' : '<span class="muted">не працює</span>'}</td>
        <td><button class="btn ${on ? 'btn-primary' : 'btn-secondary'} btn-sm ns-pick" data-tab="${escapeHtml(e.tab)}">${on ? 'Обрано ✓' : 'Обрати'}</button></td></tr>`;
    }).join('') || (mode === 'pot' ? '<tr><td class="muted">Потенційних на цю програму немає</td></tr>' : q.length >= 2 ? '<tr><td class="muted">Нікого не знайдено</td></tr>' : '');
    t.querySelectorAll('.ns-pick').forEach((b) => b.addEventListener('click', () => {
      const e = found.find((x) => x.tab === b.dataset.tab);
      if (picked.has(e.tab)) picked.delete(e.tab); else picked.set(e.tab, e);
      renderPicked(); renderFound();
    }));
  };
  $id('ns-close').onclick = closeModal;
  $id('ns-cancel').onclick = closeModal;
  $id('ns-q').addEventListener('input', debounce(async () => {
    const q = $id('ns-q').value.trim();
    searched = q.length >= 2 ? (await api(`/api/employees/search?${qs({ q })}`)).employees : [];
    if (mode === 'search') { found = searched; renderFound(); }
  }, 300));
  $id('ns-mode').addEventListener('click', (ev) => { const b = ev.target.closest('.tab-btn'); if (b) setMode(b.dataset.m); });
  $id('ns-pot-reg').addEventListener('change', showPot);
  $id('ns-pot-all').addEventListener('click', () => { found.forEach((e) => picked.set(e.tab, e)); renderPicked(); renderFound(); });
  $id('ns-program').addEventListener('change', () => { if (mode === 'pot') { fillPotRegions(); showPot(); } else fillPotRegions(); });
  fillPotRegions();
  renderPicked();
  $id('ns-save').onclick = async () => {
    const program = $id('ns-program').value;
    const year = $id('ns-year').value;
    const btn = $id('ns-save');
    btn.disabled = true;
    try {
      await api('/api/lh-streams', { method: 'POST', body: JSON.stringify({ program, year, dateStart: $id('ns-start').value, dateEnd: $id('ns-end').value }) });
      const failed = [];
      for (const e of picked.values()) {
        try { await api('/api/lh-participants', { method: 'POST', body: JSON.stringify({ program, year, tab: e.tab }) }); }
        catch (err) { failed.push(`${e.name}: ${err.message}`); }
      }
      closeModal();
      LeaderHub.setYear(year);
      state.reserve.data = null;
      await renderReserveView();
      const ok = picked.size - failed.length;
      showToast(failed.length ? `Потік створено, додано ${ok}; не додано: ${failed.join('; ')}` : ok ? `Потік створено, додано учасників: ${ok}` : 'Потік створено — додайте учасників', failed.length > 0);
    } catch (e) { $id('ns-error').textContent = e.message; btn.disabled = false; }
  };
}

// «Статуси резерву» → mark someone (in or outside the programmes) as
// «Потенційний» — who could be brought into the programme
function openAddPotentialModal(program, reload) {
  const root = document.getElementById('modal-root');
  const data = (state.reserve && state.reserve.data) || {};
  // stores grouped by region, for picking a store's team
  const byReg = {};
  (data.stores || []).forEach(([r, st]) => { (byReg[r || '—'] = byReg[r || '—'] || []).push(st); });
  const storeOpts = Object.keys(byReg).sort((a, b) => a.localeCompare(b, 'uk')).map((r) =>
    `<optgroup label="${escapeHtml(r)}">${byReg[r].map((st) => `<option value="${escapeHtml(st)}">${escapeHtml(st)}</option>`).join('')}</optgroup>`).join('');
  root.innerHTML = `
    <div class="modal-backdrop" id="pp-backdrop"><div class="modal" style="max-width:680px;">
      <button class="modal-close" id="pp-close">✕</button>
      <h2>Додати потенційного</h2>
      <p class="modal-subtitle">Кого можна залучити в програму. Оберіть магазин, щоб побачити всіх, хто там працює, або знайдіть людину за ПІБ / таб. номером (за «Історією працівника»).</p>
      <div class="field-group"><label>Потенційний на</label>
        <select id="pp-program"><option value="TZ" ${program === 'TZ' ? 'selected' : ''}>Товарознавця (LH БЕК)</option><option value="LH1" ${program === 'LH1' ? 'selected' : ''}>Заступника (LH 1.0)</option><option value="LH2" ${program === 'LH2' ? 'selected' : ''}>Директора (LH 2.0)</option></select></div>
      <div class="pp-find">
        <div class="filter-field"><label for="pp-store">Магазин</label><select id="pp-store"><option value="">Усі магазини</option>${storeOpts}</select></div>
        <div class="filter-field"><label for="pp-q">ПІБ працівника</label><input type="text" class="search-input" id="pp-q" placeholder="Прізвище або таб. номер…"></div>
      </div>
      <div class="muted" id="pp-count" style="margin-top:8px;"></div>
      <div class="table-scroll" style="margin-top:6px; max-height:340px;"><table class="data-table" id="pp-results"></table></div>
      <div id="pp-error" class="error-text"></div>
      <div class="modal-actions"><button class="btn btn-secondary" id="pp-done">Готово</button></div>
    </div></div>`;
  const $id = (id) => document.getElementById(id);
  let added = false;
  const done = async () => { closeModal(); if (added) await reload(); };
  $id('pp-close').onclick = done;
  $id('pp-done').onclick = done;
  // only these posts are considered toward each post (the server filters the same way)
  const POT_FROM = { TZ: 'вантажник, комірник, касир, сервіс менеджер, продавець', LH1: 'продавець, ІТ-спеціаліст, товарознавець', LH2: 'заступники, товарознавець' };
  // ІПР / Сертифікований in a programme are potentials automatically
  const auto = new Set((data.parts || []).filter((x) => x.status === 'ІПР' || x.status === 'Сертифікований').map((x) => `${x.pid}|${x.prog}`));
  // marked by hand (this window keeps it in sync: add / remove)
  const manual = new Set(Object.entries(data.rstatus || {}).filter(([, v]) => v.status === 'Потенційний').map(([k]) => k));
  const key = (tab) => `${tab}|${$id('pp-program').value}`;
  const cell = (tab) => (manual.has(key(tab))
    ? `<span class="pp-added">Додано ✓</span> <button class="btn btn-secondary btn-sm pp-del" data-tab="${escapeHtml(tab)}" title="Прибрати з потенційних">Прибрати</button>`
    : auto.has(key(tab)) ? '<span class="muted" title="ІПР / Сертифікований у програмі">вже потенційний</span>'
    : `<button class="btn btn-secondary btn-sm ns-pick" data-tab="${escapeHtml(tab)}">Додати</button>`);
  const search = async () => {
    const q = $id('pp-q').value.trim(), store = $id('pp-store').value;
    const t = $id('pp-results');
    if (q.length < 2 && !store) { t.innerHTML = ''; $id('pp-count').textContent = ''; return; }
    const res = await api(`/api/employees/search?${qs({ q, store, potential: $id('pp-program').value })}`);
    $id('pp-count').textContent = store ? `${store}: можна залучити ${res.employees.length} (${POT_FROM[$id('pp-program').value]})` : '';
    t.innerHTML = res.employees.map((e) => `
      <tr data-name="${escapeHtml(e.name)}"><td>${escapeHtml(e.name)}<div class="muted">таб. ${escapeHtml(e.tab)}</div></td>
      <td>${escapeHtml(e.position)}<div class="muted">${escapeHtml(e.store || '')}${e.region ? ` · ${escapeHtml(e.region)}` : ''}</div></td>
      <td class="pp-act" style="text-align:right; white-space:nowrap;">${cell(e.tab)}</td></tr>`).join('')
      || '<tr><td class="muted">Нікого не знайдено</td></tr>';
  };
  // «Додати» asks for an optional comment in a small window on top
  const askNote = (name) => new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'pp-ask-backdrop';
    box.innerHTML = `<div class="pp-ask" role="dialog" aria-modal="true" aria-label="Додати в потенційні">
      <h3>Додати в потенційні</h3>
      <p class="modal-subtitle">${escapeHtml(name)} · на ${escapeHtml($id('pp-program').selectedOptions[0].textContent)}</p>
      <div class="field-group"><label for="pp-note">Коментар (необов'язково)</label><input type="text" id="pp-note" style="width:100%;" placeholder="напр., рекомендація регіону"></div>
      <div class="modal-actions"><button class="btn btn-secondary" data-a="no">Скасувати</button><button class="btn btn-primary" data-a="ok">Додати</button></div></div>`;
    const finish = (v) => { box.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } else if (e.key === 'Enter') { e.preventDefault(); finish(box.querySelector('#pp-note').value.trim()); } };
    box.addEventListener('click', (e) => { const a = e.target.dataset.a; if (a === 'ok') finish(box.querySelector('#pp-note').value.trim()); else if (a === 'no' || e.target === box) finish(null); });
    document.addEventListener('keydown', onKey, true);
    document.getElementById('modal-root').append(box);
    box.querySelector('#pp-note').focus();
  });
  // add / remove (a slip of the hand can be undone right here)
  $id('pp-results').addEventListener('click', async (ev) => {
    const b = ev.target.closest('.ns-pick, .pp-del');
    if (!b) return;
    const tab = b.dataset.tab, k = key(tab), add = b.classList.contains('ns-pick');
    const note = add ? await askNote(b.closest('tr').dataset.name) : '';
    if (note === null) return;
    b.disabled = true;
    try {
      await api('/api/reserve-status', { method: 'PUT', body: JSON.stringify({ pid: tab, program: $id('pp-program').value, status: add ? 'Потенційний' : '', note, check: add }) });
      if (add) manual.add(k); else manual.delete(k);
      added = true; $id('pp-error').textContent = '';
      b.closest('.pp-act').innerHTML = cell(tab);
    } catch (err) { $id('pp-error').textContent = err.message; b.disabled = false; }
  });
  $id('pp-store').addEventListener('change', search);
  $id('pp-program').addEventListener('change', search);
  $id('pp-q').addEventListener('input', debounce(search, 300));
  $id('pp-store').focus();
}

function openAddParticipantModal(program, year, onDone) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" id="ap-backdrop"><div class="modal" style="max-width:640px;">
      <button class="modal-close" id="ap-close">✕</button>
      <h2>Додати учасника · ${LH_PROGRAMS[program]} · ${year}</h2>
      <p class="modal-subtitle">Пошук у «Історії працівника» за ПІБ або табельним номером. Стартові посада й магазин — поточні.</p>
      <input type="text" class="search-input" id="ap-q" placeholder="Прізвище або таб. номер…" style="width:100%;">
      <div class="table-scroll" style="margin-top:10px;"><table class="data-table" id="ap-results"></table></div>
      <div id="ap-error" class="error-text"></div>
      <div class="modal-actions"><button class="btn btn-secondary" id="ap-done">Готово</button></div>
    </div></div>`;
  let added = false;
  const done = async () => {
    if (onDone) { if (added) state.reserve.data = await api('/api/reserve'); onDone(added); return; } // back to ⚙️ Налаштування
    closeModal(); if (added) { state.reserve.data = null; await renderReserveView(); }
  };
  document.getElementById('ap-close').onclick = done;
  document.getElementById('ap-done').onclick = done;
  const input = document.getElementById('ap-q');
  input.focus();
  input.addEventListener('input', debounce(async () => {
    const data = await api(`/api/employees/search?${qs({ q: input.value.trim() })}`);
    const t = document.getElementById('ap-results');
    t.innerHTML = data.employees.map((e) => `
      <tr><td>${escapeHtml(e.name)}<div class="muted">таб. ${escapeHtml(e.tab)}</div></td>
      <td>${escapeHtml(e.position)}<div class="muted">${escapeHtml(e.store || '')}${e.region ? ` · ${escapeHtml(e.region)}` : ''}</div></td>
      <td>${e.working ? '' : '<span class="muted">не працює</span>'}</td>
      <td><button class="btn btn-secondary btn-sm ap-add" data-tab="${escapeHtml(e.tab)}">Додати</button></td></tr>`).join('')
      || (input.value.trim().length >= 2 ? '<tr><td class="muted">Нікого не знайдено</td></tr>' : '');
    t.querySelectorAll('.ap-add').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api('/api/lh-participants', { method: 'POST', body: JSON.stringify({ program, year, tab: b.dataset.tab }) });
        added = true; b.disabled = true; b.textContent = 'Додано';
      } catch (err) { document.getElementById('ap-error').textContent = err.message; }
    }));
  }, 300));
}

/* ===================== KPI 2027 ===================== */

// "KPI відділу навчання Роздрібу 2027": per-role KPIs computed on the
// server (kpi.py) from attestation / "Все навчання" / trainees / AEP, plus
// manual values for KPIs with no source yet, and the bonus index.
const KPI_OWN_STORAGE_KEY = 'kpi-own-positions';

// KPI are measured per quarter
function kpiPeriodOptions() {
  const now = new Date();
  const opts = [];
  [now.getFullYear() + 1, now.getFullYear()].forEach((y) => {
    [4, 3, 2, 1].forEach((q) => opts.push({ value: `${y}-Q${q}`, label: `${q} квартал ${y}` }));
  });
  return opts;
}

function fmtKpiValue(v, unit) {
  if (v === null || v === undefined) return '<span class="muted">—</span>';
  const n = (Math.round(v * 10) / 10).toLocaleString('uk-UA');
  return unit === '%' ? `${n}%` : n;
}

function kpiAchievementHtml(a) {
  if (a === null || a === undefined) return '<span class="muted">—</span>';
  const pct = a * 100;
  const cls = pct >= 100 ? 'good' : pct >= 95 ? 'yellow' : 'red';
  return `<span class="badge status-${cls}">${Math.round(pct * 10) / 10}%</span>`;
}

async function renderKpiView() {
  const area = document.getElementById('content-area');
  const k = state.kpi || (state.kpi = { period: '', own: null });
  const periods = kpiPeriodOptions();
  if (!k.period) {
    const now = new Date();
    k.period = `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
  }
  if (k.own === null) {
    try { k.own = JSON.parse(localStorage.getItem(KPI_OWN_STORAGE_KEY) || '[]'); } catch { k.own = []; }
  }
  area.innerHTML = '<div class="card"><span class="spinner"></span> Розрахунок KPI…</div>';
  const data = await api(`/api/kpi?${qs({ period: k.period, own: k.own.join(',') })}`);

  const roleCard = (role) => {
    const verdict = role.index === null
      ? '<span class="status-pill pending">Немає даних</span>'
      : role.complete
        ? `<span class="status-pill ${role.bonus ? 'success' : 'fail'}">${role.bonus ? 'Премія є' : 'Премії немає'}</span>`
        : `<span class="status-pill pending">Неповні дані: ${role.measured} з ${role.kpis.length} KPI</span>`;
    const ownPicker = role.ownPositions ? `
      <div class="kpi-own">Закріплені посади:
        ${data.backPositions.map((p) => `<label><input type="checkbox" class="kpi-own-cb" value="${escapeHtml(p)}" ${k.own.includes(p) ? 'checked' : ''}> ${escapeHtml(p)}</label>`).join('')}
      </div>` : '';
    const rows = role.kpis.map((kp) => {
      const factCell = kp.manual
        ? `<div class="kpi-manual" data-kpi="${kp.key}">
            ${kp.manual.map((m) => `<label>${escapeHtml(m.label)}<input type="text" inputmode="decimal" data-input="${m.key}" value="${m.value ?? ''}"></label>`).join('')}
            <button class="btn btn-secondary btn-sm kpi-save">Зберегти</button>
            ${kp.fact !== null && (kp.manual.length > 1 || kp.factNote) ? `<div class="muted">= ${fmtKpiValue(kp.fact, kp.unit)}${kp.factNote ? ` (${escapeHtml(kp.factNote)}; поля вище — щоб перевизначити)` : ''}</div>` : ''}
          </div>`
        : fmtKpiValue(kp.fact, kp.unit);
      return `
        <tr>
          <td><strong>${escapeHtml(kp.name)}</strong><div class="muted">${escapeHtml(kp.how)}</div></td>
          <td>${Math.round(kp.weight * 100)}%</td>
          <td>${fmtKpiValue(kp.base, kp.unit)}<div class="muted">${escapeHtml(kp.baseNote)}</div></td>
          <td>${fmtKpiValue(kp.target, kp.unit)}</td>
          <td>${factCell}</td>
          <td>${kpiAchievementHtml(kp.achievement)}</td>
        </tr>`;
    }).join('');
    return `
      <div class="card">
        <div class="kpi-role-head">
          <h3 class="mt-0">${escapeHtml(role.name)}</h3>
          <div class="kpi-role-index">${role.index !== null ? `Індекс <strong>${Math.round(role.index * 1000) / 10}%</strong>` : ''} ${verdict}</div>
        </div>
        ${ownPicker}
        <div class="table-scroll"><table class="data-table kpi-table">
          <thead><tr><th>KPI</th><th>Вага</th><th>База 2026</th><th>Ціль</th><th>Факт</th><th>Виконання</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`;
  };

  area.innerHTML = `
    <div class="filters">
      <div class="filter-field">
        <label>Період</label>
        <select id="kpi-period">${periods.map((p) => `<option value="${p.value}" ${p.value === k.period ? 'selected' : ''}>${p.label}</option>`).join('')}</select>
      </div>
    </div>
    <div class="table-note" style="margin:-4px 0 12px;">Ціль = база × 1,04 (якщо в документі KPI не вказана інша). Виконання = факт / ціль, не більше ${Math.round(data.cap * 100)}%. Індекс — зважене виконання за вагами ролі; премія є, якщо індекс ≥ ${Math.round(data.bonusThreshold * 100)}%. Поля для KPI без джерела даних заповнюються вручну за обраний період.</div>
    ${data.roles.map(roleCard).join('')}
  `;

  document.getElementById('kpi-period').onchange = (e) => { k.period = e.target.value; renderKpiView(); };
  area.querySelectorAll('.kpi-own-cb').forEach((cb) => cb.addEventListener('change', () => {
    k.own = [...area.querySelectorAll('.kpi-own-cb:checked')].map((x) => x.value);
    try { localStorage.setItem(KPI_OWN_STORAGE_KEY, JSON.stringify(k.own)); } catch { /* per-viewer convenience only */ }
    renderKpiView();
  }));
  area.querySelectorAll('.kpi-manual').forEach((box) => {
    box.querySelector('.kpi-save').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const values = {};
      box.querySelectorAll('input[data-input]').forEach((inp) => { values[inp.dataset.input] = inp.value.trim(); });
      btn.disabled = true;
      try {
        await api('/api/kpi-manual', { method: 'POST', body: JSON.stringify({ period: k.period, kpi: box.dataset.kpi, values }) });
        showToast('Збережено');
        await renderKpiView();
      } catch (err) {
        showToast(err.message, true);
        btn.disabled = false;
      }
    });
  });
}

/* ===================== position classification modal ===================== */

function openClassifyModal() {
  const root = document.getElementById('modal-root');
  const positions = [...state.positionsConfig].sort((a, b) => {
    if (a.needs_classification !== b.needs_classification) return b.needs_classification - a.needs_classification;
    return a.position.localeCompare(b.position, 'uk');
  });
  root.innerHTML = `
    <div class="modal-backdrop" id="classify-backdrop">
      <div class="modal" style="max-width:640px;">
        <button class="modal-close" id="classify-close">✕</button>
        <h2>Класифікація посад</h2>
        <p class="modal-subtitle">Фронт/Бек і «Перша лінія» використовуються для фільтрів дашборда.</p>
        <div class="classify-list" id="classify-full-list" style="max-height:60vh; overflow-y:auto;">
          ${positions.map((p) => `
            <div class="classify-row" data-pos="${escapeHtml(p.position)}">
              <div class="pos-name">${escapeHtml(p.position)} ${p.needs_classification ? '<span class="badge status-orange">нова</span>' : ''}</div>
              <select class="cls-segment">
                <option value="back" ${p.segment === 'back' ? 'selected' : ''}>Бек</option>
                <option value="front" ${p.segment === 'front' ? 'selected' : ''}>Фронт</option>
              </select>
              <label class="inline"><input type="checkbox" class="cls-firstline" ${p.first_line ? 'checked' : ''}> Перша лінія</label>
            </div>
          `).join('') || '<p class="muted">Ще немає жодної посади — завантажте дані.</p>'}
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="classify-cancel">Закрити</button>
          <button class="btn btn-primary" id="classify-save">Зберегти зміни</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('classify-close').onclick = closeModal;
  document.getElementById('classify-cancel').onclick = closeModal;
  document.getElementById('classify-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'classify-backdrop') closeModal();
  });
  document.getElementById('classify-save').onclick = async () => {
    const btn = document.getElementById('classify-save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Збереження…';
    const rows = document.querySelectorAll('#classify-full-list .classify-row');
    for (const row of rows) {
      const position = row.dataset.pos;
      const segment = row.querySelector('.cls-segment').value;
      const firstLine = row.querySelector('.cls-firstline').checked;
      await api('/api/config/position', { method: 'POST', body: JSON.stringify({ position, segment, firstLine }) });
    }
    await loadPositionsConfig();
    closeModal();
    showToast('Класифікацію посад оновлено.');
    await refreshAll();
  };
}

/* ===================== file helpers (inline assets for downloaded HTML) ===================== */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function fetchAsDataUrl(path) {
  try {
    const blob = await fetch(path.replace(/^\//, '')).then((r) => r.blob());
    return await blobToDataUrl(blob);
  } catch {
    return '';
  }
}


/* ===================== tab snapshot ("Завантажити HTML") =====================
   Saves what the current tab shows (with its filters) as one self-contained
   HTML file: site CSS with the fonts and logo inlined, charts turned into
   images, form controls into plain text. It's a snapshot — sorting,
   tooltips and drill-down windows don't work in the file. */
async function downloadTabSnapshot() {
  const btn = document.getElementById('btn-snapshot');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Готую файл…';
  try {
    const tabName = (document.querySelector('.tabs .tab-btn.active') || {}).textContent || 'Дашборд';
    const [css, logo, comfySemiBold, ptRegular, ptMedium, ptBold] = await Promise.all([
      fetch('static/css/style.css').then((r) => r.text()).catch(() => ''),
      fetchAsDataUrl('/static/assets/logo_green.png'),
      fetchAsDataUrl('/static/fonts/ComfySemiBold/Comfy-Semi-Bold.woff2'),
      fetchAsDataUrl('/static/fonts/PTRootUI/PT-Root-UI-Regular.woff2'),
      fetchAsDataUrl('/static/fonts/PTRootUI/PT-Root-UI-Medium.woff2'),
      fetchAsDataUrl('/static/fonts/PTRootUI/PT-Root-UI-Bold.woff2'),
    ]);
    const fontCss = `
@font-face { font-family: 'Comfy Semi-Bold'; src: url('${comfySemiBold}') format('woff2'); font-weight: 600; font-style: normal; }
@font-face { font-family: 'PT Root UI'; src: url('${ptRegular}') format('woff2'); font-weight: 400; font-style: normal; }
@font-face { font-family: 'PT Root UI'; src: url('${ptMedium}') format('woff2'); font-weight: 500; font-style: normal; }
@font-face { font-family: 'PT Root UI'; src: url('${ptBold}') format('woff2'); font-weight: 700; font-style: normal; }`;
    const siteCss = fontCss + css.replace(/@font-face\s*\{[^}]*\}/g, '');

    const parts = ['position-switch', 'content-area'].map((id) => document.getElementById(id)).filter((n) => n && !n.hidden);
    const out = document.createElement('div');
    parts.forEach((src) => {
      const copy = src.cloneNode(true);
      // charts: canvas pixels don't survive cloning
      const srcCanvases = src.querySelectorAll('canvas');
      copy.querySelectorAll('canvas').forEach((c, i) => {
        const o = srcCanvases[i];
        const img = document.createElement('img');
        try { img.src = o.toDataURL('image/png'); } catch { return; }
        img.style.width = `${o.clientWidth}px`; img.style.maxWidth = '100%'; img.style.height = 'auto';
        c.replaceWith(img);
      });
      // selects -> the chosen value as text; inputs keep what was typed
      const srcSelects = src.querySelectorAll('select');
      copy.querySelectorAll('select').forEach((sel, i) => {
        const o = srcSelects[i];
        const chip = document.createElement('span');
        chip.className = 'snap-chip';
        chip.textContent = o.selectedOptions[0] ? o.selectedOptions[0].textContent : '';
        sel.replaceWith(chip);
      });
      const srcInputs = src.querySelectorAll('input');
      copy.querySelectorAll('input').forEach((inp, i) => {
        const o = srcInputs[i];
        if (o.type === 'checkbox' || o.type === 'radio') { if (o.checked) inp.setAttribute('checked', ''); else inp.removeAttribute('checked'); inp.disabled = true; return; }
        if (o.type === 'file' || !o.value) { inp.remove(); return; }
        const chip = document.createElement('span');
        chip.className = 'snap-chip';
        chip.textContent = o.value;
        inp.replaceWith(chip);
      });
      // actions don't work in a file: keep only the switches that show the current view
      copy.querySelectorAll('button').forEach((b) => {
        if (b.classList.contains('active') || b.getAttribute('aria-pressed') === 'true' || b.classList.contains('kpi-half')) b.disabled = true;
        else if (b.closest('.tabs, [role="group"]')) b.disabled = true;
        else b.remove();
      });
      copy.querySelectorAll('[hidden]').forEach((n) => n.remove());
      copy.removeAttribute('id');
      out.append(copy);
    });
    const now = new Date();
    const stamp = now.toLocaleDateString('uk-UA');
    const html = `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`Навчання COMFY — ${tabName} — ${stamp}`)}</title>
<style>${siteCss}
body { background: var(--color-bg); }
.snap-wrap { max-width: 1400px; margin: 0 auto; padding: 24px 16px; }
.snap-chip { display: inline-block; padding: 6px 12px; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-card); font-size: 13px; }
.table-scroll, .lh-root .table-scroll.tall { max-height: none !important; }
button:disabled { cursor: default; }
.row-clickable, [style*="cursor: pointer"] { cursor: default !important; }
</style>
</head><body><div class="snap-wrap">
<div class="top-bar" style="margin-bottom:20px;">
  <div class="brand">
    ${logo ? `<img class="logo" src="${logo}" alt="COMFY">` : ''}
    <div><div class="brand-title">Навчання COMFY · ${escapeHtml(tabName)}</div>
    <div class="brand-subtitle">Знято ${escapeHtml(stamp)} ${escapeHtml(now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }))} · знімок сторінки: сортування й деталізація не працюють</div></div>
  </div>
</div>
${out.innerHTML.replace(/<script/gi, '&lt;script')}
</div></body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Навчання COMFY - ${tabName} - ${stamp}.html`.replace(/[\\/:*?"<>|]/g, '_');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    showToast(`Не вдалося зберегти файл: ${e.message}`, true);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

/* ===================== category analysis ("Аналіз категорій") =====================
   Separate full-screen view for per-position quarterly categorization/
   attestation reports (category 1 = meets every condition, category 2 =
   misses at least one). Like lesson reports, each upload is its own
   permanent snapshot (keyed by position+quarter) switchable from a
   selector — but on top of the usual network/region breakdown, people
   who landed in category 2 get checked against that position's
   configured thresholds so "По регіонах" can surface WHICH condition is
   actually blocking people in a given region, not just that fewer of
   them reached category 1. */

async function openCategoryAnalysisView() {
  document.getElementById('app').hidden = true;
  const view = document.getElementById('category-analysis-view');
  view.hidden = false;
  renderCategoryAnalysisShell();
  await loadCategoryReports();
}

function closeCategoryAnalysisView() {
  document.getElementById('category-analysis-view').hidden = true;
  document.getElementById('app').hidden = false;
}

function renderCategoryAnalysisShell() {
  const view = document.getElementById('category-analysis-view');
  view.innerHTML = `
    <div class="top-bar">
      <div class="brand">
        <img class="logo" src="static/assets/logo_green.png" alt="COMFY">
        <div>
          <div class="brand-title">Аналіз категорій</div>
          <div class="brand-subtitle">Атестація та категоризація по посадах</div>
        </div>
      </div>
      <div class="top-actions">
        <button class="btn btn-secondary btn-sm" id="ca-download-html">Завантажити HTML</button>
        <button class="btn btn-primary btn-sm" id="ca-upload">Завантажити звіт</button>
        <button class="btn btn-secondary btn-sm" id="ca-back">← Назад у систему</button>
      </div>
    </div>
    <div id="ca-content-area">
      <!-- filled dynamically -->
    </div>
  `;
  document.getElementById('ca-back').onclick = closeCategoryAnalysisView;
  document.getElementById('ca-upload').onclick = openCategoryReportUploadModal;
  document.getElementById('ca-download-html').onclick = downloadCategoryAnalysisHtml;
}

function openCategoryReportUploadModal() {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" id="ca-upload-backdrop">
      <div class="modal">
        <button class="modal-close" id="ca-upload-close">✕</button>
        <h2>Завантажити звіт по посаді</h2>
        <p class="modal-subtitle">Один файл — одна посада за один квартал («Аттестация YYYY квартал N Посада» в першому рядку). Повторне завантаження того самого періоду для цієї посади замінює його повністю.</p>
        <div class="field-group">
          <label>Файл</label>
          <input type="file" id="ca-upload-file" accept=".xls,.xlsx">
        </div>
        <div id="ca-upload-preview"></div>
        <div id="ca-upload-error" class="error-text"></div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="ca-upload-cancel">Скасувати</button>
          <button class="btn btn-primary" id="ca-upload-parse">Перевірити файл</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('ca-upload-close').onclick = closeModal;
  document.getElementById('ca-upload-cancel').onclick = closeModal;
  document.getElementById('ca-upload-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'ca-upload-backdrop') closeModal();
  });
  document.getElementById('ca-upload-parse').onclick = handleCategoryReportParse;
}

async function handleCategoryReportParse() {
  const errorEl = document.getElementById('ca-upload-error');
  errorEl.textContent = '';
  const file = document.getElementById('ca-upload-file').files[0];
  if (!file) { errorEl.textContent = 'Оберіть файл.'; return; }

  let parsed;
  try {
    parsed = await readCategoryReportWorkbookRows(file);
  } catch (e) {
    errorEl.textContent = `Помилка читання файлу: ${e.message}`;
    return;
  }
  if (!parsed.rows.length) {
    errorEl.textContent = 'Не знайдено жодного рядка співробітників у файлі.';
    return;
  }

  const existing = state.categoryAnalysis.reports.find(
    (r) => r.position === parsed.position && r.periodLabel === parsed.periodLabel
  );
  document.getElementById('ca-upload-preview').innerHTML = `
    <div class="upload-summary">${escapeHtml(parsed.position)}, ${escapeHtml(parsed.periodLabel)} — ${parsed.rows.length} співробітників.${existing ? ' Цей звіт вже є в базі — буде повністю оновлено.' : ' Новий звіт.'}</div>
  `;
  const actions = document.querySelector('#ca-upload-backdrop .modal-actions');
  actions.innerHTML = `
    <button class="btn btn-secondary" id="ca-upload-cancel2">Скасувати</button>
    <button class="btn btn-primary" id="ca-upload-save">Зберегти</button>
  `;
  document.getElementById('ca-upload-cancel2').onclick = closeModal;
  document.getElementById('ca-upload-save').onclick = async () => {
    const btn = document.getElementById('ca-upload-save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Збереження…';
    try {
      const resp = await api('/api/upload-category-report', {
        method: 'POST',
        body: JSON.stringify({ position: parsed.position, periodLabel: parsed.periodLabel, rows: parsed.rows }),
      });
      closeModal();
      showToast(`Звіт «${parsed.position}, ${parsed.periodLabel}» збережено: ${resp.rowsCount} співробітників.`);
      await loadCategoryReports(resp.categoryReportId);
    } catch (e) {
      document.getElementById('ca-upload-error').textContent = e.message;
      btn.disabled = false;
      btn.textContent = 'Зберегти';
    }
  };
}

async function loadCategoryReports(selectId) {
  const data = await api('/api/category-reports');
  state.categoryAnalysis.reports = data.reports || [];
  if (!state.categoryAnalysis.reports.length) {
    document.getElementById('ca-content-area').innerHTML = `
      <div class="empty-state">
        <h2>Ще немає звітів</h2>
        <p>Натисніть «Завантажити звіт» вгорі, щоб додати перший звіт по посаді.</p>
      </div>`;
    return;
  }
  const latest = state.categoryAnalysis.reports[state.categoryAnalysis.reports.length - 1];
  const wanted = selectId || state.categoryAnalysis.categoryReportId;
  state.categoryAnalysis.categoryReportId = state.categoryAnalysis.reports.some((r) => r.id === wanted)
    ? wanted
    : latest.id;
  renderCategoryAnalysisContent();
  await refreshCategoryAnalysisData();
}

function renderCategoryAnalysisContent() {
  const { reports, categoryReportId, withApprovals } = state.categoryAnalysis;
  const el = document.getElementById('ca-content-area');
  const sortedReports = [...reports].reverse();
  const mostRecentId = reports[reports.length - 1]?.id;
  el.innerHTML = `
    <div class="filters" id="ca-filters">
      <div class="filter-field" style="min-width:280px;">
        <label>Звіт</label>
        <select id="ca-report">
          ${sortedReports.map((r) => `<option value="${r.id}" ${r.id === categoryReportId ? 'selected' : ''}>${escapeHtml(r.position)} — ${escapeHtml(r.periodLabel)}${r.id === mostRecentId ? ' (останній)' : ''}</option>`).join('')}
        </select>
      </div>
      <div class="filter-field">
        <label>Регіон</label>
        <select id="ca-region"><option value="">Уся мережа</option></select>
      </div>
      <div class="filter-field" style="min-width:260px;">
        <label>Категорія</label>
        <select id="ca-approvals">
          <option value="0" ${!withApprovals ? 'selected' : ''}>Розрахована (без погоджень РК)</option>
          <option value="1" ${withApprovals ? 'selected' : ''}>Фінальна (з погодженими побажаннями РК)</option>
        </select>
      </div>
    </div>
    <div class="grid-2">
      <div class="card" id="ca-criteria-card"></div>
      <div class="card" id="ca-bottlenecks-card"></div>
    </div>
    <div class="kpi-grid" id="ca-kpi-grid"></div>
    <div class="card">
      <h3>По регіонах</h3>
      <p class="field-hint">Завжди всі регіони, незалежно від фільтра вище. "Проблемні зони" — за якою саме умовою найчастіше не вистачає до 1 категорії серед тих, хто її не отримав за розрахунком (незалежно від погоджень). Клік по регіону — розбивка по магазинах.</p>
      <div class="table-scroll"><table class="data-table" id="ca-regions-table"></table></div>
    </div>
    <div class="card">
      <h3>Співробітники</h3>
      <p class="field-hint" id="ca-count-hint"></p>
      <div class="table-scroll"><table class="data-table" id="ca-people-table"></table></div>
      <div id="ca-people-pagination"></div>
    </div>
  `;
  document.getElementById('ca-report').addEventListener('change', async (e) => {
    state.categoryAnalysis.categoryReportId = Number(e.target.value);
    state.categoryAnalysis.region = '';
    renderCategoryAnalysisContent();
    await refreshCategoryAnalysisData();
  });
  document.getElementById('ca-region').addEventListener('change', async (e) => {
    state.categoryAnalysis.region = e.target.value;
    await refreshCategoryAnalysisData();
  });
  document.getElementById('ca-approvals').addEventListener('change', async (e) => {
    state.categoryAnalysis.withApprovals = e.target.value === '1';
    await refreshCategoryAnalysisData();
  });
}

async function refreshCategoryAnalysisData() {
  const { categoryReportId, region, reports, withApprovals } = state.categoryAnalysis;
  const report = reports.find((r) => r.id === categoryReportId);
  const approvalsParam = withApprovals ? '1' : '0';
  const [filters, summary, byRegion, people, criteriaResp] = await Promise.all([
    api(`/api/category-report-filters?${qs({ categoryReportId })}`),
    api(`/api/category-report-summary?${qs({ categoryReportId, region, withApprovals: approvalsParam })}`),
    api(`/api/category-report-by-region?${qs({ categoryReportId, withApprovals: approvalsParam })}`),
    api(`/api/category-report-people?${qs({ categoryReportId, region, withApprovals: approvalsParam })}`),
    api(`/api/category-criteria?${qs({ position: report.position })}`),
  ]);
  const regionSelect = document.getElementById('ca-region');
  regionSelect.innerHTML = `<option value="">Уся мережа</option>${(filters.regions || []).map((r) => `<option value="${escapeHtml(r)}" ${r === region ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('')}`;

  renderCategoryCriteriaCard(report.position, criteriaResp.criteria);
  renderCategoryAnalysisKpis(summary);
  state._caRegions = byRegion.regions || [];
  state._caHasCriteria = !!criteriaResp.criteria;
  renderCategoryAnalysisByRegion(state._caRegions);
  renderCategoryBottlenecksCard(state._caRegions, region);
  state._caPeople = people.people || [];
  resetPageState('ca-people');
  renderCategoryAnalysisPeopleTable();
}

function renderCategoryBottlenecksCard(regions, selectedRegion) {
  const card = document.getElementById('ca-bottlenecks-card');
  if (!card) return;
  let reasons;
  let scopeLabel;
  if (selectedRegion) {
    const r = regions.find((x) => x.region === selectedRegion);
    reasons = r ? r.failReasons : [];
    scopeLabel = escapeHtml(selectedRegion);
  } else {
    const totals = {};
    regions.forEach((r) => {
      r.failReasons.forEach((f) => { totals[f.reason] = (totals[f.reason] || 0) + f.count; });
    });
    reasons = Object.entries(totals)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);
    scopeLabel = 'уся мережа';
  }
  card.innerHTML = `
    <h3>Вузькі місця — ${scopeLabel}</h3>
    <p class="field-hint">За якою умовою найчастіше не вистачає до 1 категорії (незалежно від погоджень РК).</p>
    ${reasons.length ? `<ul class="bottleneck-list">${reasons.slice(0, 6).map((f) => `
      <li><span>${escapeHtml(f.reason)}</span><strong>${fmtNum(f.count)}</strong></li>`).join('')}</ul>`
      : '<p class="muted">Немає даних — або критерії ще не задані, або всі в межах норми.</p>'}
  `;
}

const RULE_OP_LABELS = {
  '>=': 'не менше',
  '<=': 'не більше',
  '>': 'більше',
  '<': 'менше',
  '==': 'дорівнює',
  flagAbsent: 'немає позначки',
  flagPresent: 'є позначка',
};

function ruleOpText(r) {
  const label = RULE_OP_LABELS[r.op] || r.op;
  return (r.op === 'flagAbsent' || r.op === 'flagPresent') ? label : `${label} ${fmtNum(r.value)}`;
}

function renderRulesTableRows(rules) {
  const out = [];
  (rules || []).forEach((entry) => {
    if (entry.or) {
      entry.or.forEach((r, j) => {
        if (j > 0) out.push('<tr><td colspan="2" class="muted" style="text-align:center;">ЧИ</td></tr>');
        out.push(`<tr><td>${escapeHtml(r.label || r.metric)}</td><td>${ruleOpText(r)}</td></tr>`);
      });
    } else {
      out.push(`<tr><td>${escapeHtml(entry.label || entry.metric)}</td><td>${ruleOpText(entry)}</td></tr>`);
    }
  });
  return out.join('');
}

function renderCategoryCriteriaCard(position, criteria) {
  const card = document.getElementById('ca-criteria-card');
  if (!criteria) {
    card.innerHTML = `
      <h3>Умови категоризації — ${escapeHtml(position)}</h3>
      <p class="field-hint">Критерії ще не задані для цієї посади — без них "проблемні зони" по регіонах не показуватимуть причину.</p>
      <button class="btn btn-secondary btn-sm" id="ca-edit-criteria">Додати критерії</button>
    `;
    document.getElementById('ca-edit-criteria').onclick = () => openCategoryCriteriaModal(position, criteria);
    return;
  }
  const expanded = !!state.categoryAnalysis.criteriaExpanded;
  const rulesRows = renderRulesTableRows(criteria.rules);
  const toggleLabel = expanded ? 'Згорнути' : 'Розгорнути';
  card.innerHTML = `
    <h3 style="display:flex; align-items:center; flex-wrap:wrap; gap:10px;">
      <span>Умови категоризації — ${escapeHtml(position)}</span>
      <button class="btn btn-secondary btn-sm" id="ca-edit-criteria">Редагувати</button>
    </h3>
    <div class="criteria-body${expanded ? '' : ' collapsed'}" id="ca-criteria-body">
      <p style="white-space:pre-wrap; margin:0 0 10px;">${escapeHtml(criteria.criteriaText)}</p>
      ${rulesRows ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Критерій</th><th>Умова</th></tr></thead><tbody>${rulesRows}</tbody></table></div>` : ''}
    </div>
    <button class="btn btn-secondary btn-sm" id="ca-criteria-toggle" style="margin-top:10px;">${toggleLabel}</button>
  `;
  document.getElementById('ca-edit-criteria').onclick = () => openCategoryCriteriaModal(position, criteria);
  document.getElementById('ca-criteria-toggle').onclick = () => {
    state.categoryAnalysis.criteriaExpanded = !expanded;
    renderCategoryCriteriaCard(position, criteria);
  };
}

async function openCategoryCriteriaModal(position, criteria) {
  const root = document.getElementById('modal-root');
  const c = criteria || { criteriaText: '', rules: [] };
  // Flatten saved {or:[...]} groups into a linear row list for the editor —
  // each row after the first in a group is marked rel:'OR', everything
  // else rel:'AND'; re-grouped back on save.
  const workingRules = [];
  (c.rules || []).forEach((entry) => {
    if (entry.or) {
      entry.or.forEach((r, j) => workingRules.push({ ...r, rel: j === 0 ? 'AND' : 'OR' }));
    } else {
      workingRules.push({ ...entry, rel: 'AND' });
    }
  });

  let metricOptions = [];
  try {
    const resp = await api(`/api/category-report-metrics?${qs({ categoryReportId: state.categoryAnalysis.categoryReportId })}`);
    metricOptions = resp.metrics || [];
  } catch (e) { /* non-fatal — metric name still works as free text */ }

  root.innerHTML = `
    <div class="modal-backdrop" id="ca-criteria-backdrop">
      <div class="modal" style="max-width:800px;">
        <button class="modal-close" id="ca-criteria-close">✕</button>
        <h2>Умови категоризації — ${escapeHtml(position)}</h2>
        <p class="modal-subtitle">Текстовий опис показується як підказка на екрані. Умови нижче (не обов'язково всі) живлять автоматичний пошук "проблемних зон": категорія 1 потребує виконання УСІХ умов, а позначені "ЧИ" — альтернативи одна одній (досить виконати одну).</p>
        <div class="field-group">
          <label>Опис умов (підказка на екрані)</label>
          <textarea id="ca-c-text" rows="5" style="width:100%; padding:10px 12px; border:1px solid var(--color-border); border-radius:var(--radius-sm); font-family:inherit;">${escapeHtml(c.criteriaText)}</textarea>
        </div>
        <div class="field-group">
          <label>Умови для автоматичного аналізу причин</label>
          <datalist id="ca-metric-options">${metricOptions.map((m) => `<option value="${escapeHtml(m)}">`).join('')}</datalist>
          <div id="ca-rules-rows"></div>
          <button type="button" class="btn btn-secondary btn-sm" id="ca-rule-add" style="margin-top:8px;">+ Додати умову</button>
        </div>
        <div id="ca-criteria-error" class="error-text"></div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="ca-criteria-cancel">Скасувати</button>
          <button class="btn btn-primary" id="ca-criteria-save">Зберегти</button>
        </div>
      </div>
    </div>
  `;

  function renderRows() {
    const container = document.getElementById('ca-rules-rows');
    container.innerHTML = workingRules.map((r, i) => `
      <div class="rule-row" data-idx="${i}" style="display:flex; gap:8px; align-items:center; margin-top:8px;">
        ${i === 0 ? '<span style="width:52px; flex-shrink:0;"></span>' : `
          <select class="rule-rel" style="width:70px; flex-shrink:0;">
            <option value="AND" ${r.rel === 'AND' ? 'selected' : ''}>І</option>
            <option value="OR" ${r.rel === 'OR' ? 'selected' : ''}>ЧИ</option>
          </select>`}
        <input class="rule-label" placeholder="Назва (підпис)" value="${escapeHtml(r.label || '')}" style="flex:1; min-width:120px;">
        <input class="rule-metric" list="ca-metric-options" placeholder="Колонка у файлі" value="${escapeHtml(r.metric || '')}" style="flex:1; min-width:120px;">
        <select class="rule-op" style="width:150px; flex-shrink:0;">
          ${Object.entries(RULE_OP_LABELS).map(([op, lbl]) => `<option value="${op}" ${r.op === op ? 'selected' : ''}>${lbl}</option>`).join('')}
        </select>
        <input class="rule-value" type="number" value="${r.value ?? ''}" placeholder="значення" style="width:90px; flex-shrink:0; ${r.op === 'flagAbsent' || r.op === 'flagPresent' ? 'visibility:hidden;' : ''}">
        <button type="button" class="btn btn-secondary btn-sm rule-remove" style="flex-shrink:0;">✕</button>
      </div>
    `).join('') || '<p class="muted" style="margin-top:8px;">Умов ще немає.</p>';

    container.querySelectorAll('.rule-row').forEach((rowEl) => {
      const i = Number(rowEl.dataset.idx);
      const relSel = rowEl.querySelector('.rule-rel');
      if (relSel) relSel.addEventListener('change', (e) => { workingRules[i].rel = e.target.value; });
      rowEl.querySelector('.rule-label').addEventListener('input', (e) => { workingRules[i].label = e.target.value; });
      rowEl.querySelector('.rule-metric').addEventListener('input', (e) => { workingRules[i].metric = e.target.value; });
      const valueInput = rowEl.querySelector('.rule-value');
      rowEl.querySelector('.rule-op').addEventListener('change', (e) => {
        workingRules[i].op = e.target.value;
        valueInput.style.visibility = (e.target.value === 'flagAbsent' || e.target.value === 'flagPresent') ? 'hidden' : 'visible';
      });
      valueInput.addEventListener('input', (e) => { workingRules[i].value = e.target.value; });
      rowEl.querySelector('.rule-remove').addEventListener('click', () => {
        workingRules.splice(i, 1);
        if (workingRules.length && workingRules[0].rel === 'OR') workingRules[0].rel = 'AND';
        renderRows();
      });
    });
  }
  renderRows();

  document.getElementById('ca-rule-add').onclick = () => {
    workingRules.push({ label: '', metric: '', op: '>=', value: '', rel: 'AND' });
    renderRows();
  };

  document.getElementById('ca-criteria-close').onclick = closeModal;
  document.getElementById('ca-criteria-cancel').onclick = closeModal;
  document.getElementById('ca-criteria-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'ca-criteria-backdrop') closeModal();
  });
  document.getElementById('ca-criteria-save').onclick = async () => {
    const btn = document.getElementById('ca-criteria-save');
    btn.disabled = true;
    try {
      // Re-group the linear row list back into {or:[...]} groups using the rel markers.
      const rules = [];
      workingRules.forEach((r) => {
        if (!r.metric || !r.op) return;
        const cleaned = { metric: r.metric.trim(), op: r.op, label: (r.label || '').trim() || r.metric.trim() };
        if (r.op !== 'flagAbsent' && r.op !== 'flagPresent') cleaned.value = Number(r.value);
        if (r.rel === 'OR' && rules.length) {
          const last = rules[rules.length - 1];
          if (last.or) last.or.push(cleaned);
          else rules[rules.length - 1] = { or: [last, cleaned] };
        } else {
          rules.push(cleaned);
        }
      });
      await api('/api/category-criteria', {
        method: 'POST',
        body: JSON.stringify({
          position,
          criteriaText: document.getElementById('ca-c-text').value,
          rules,
        }),
      });
      closeModal();
      showToast('Критерії збережено.');
      await refreshCategoryAnalysisData();
    } catch (e) {
      document.getElementById('ca-criteria-error').textContent = e.message;
      btn.disabled = false;
    }
  };
}

function renderCategoryAnalysisKpis(summary) {
  const cat1Pct = summary.total ? Math.round((summary.category1 / summary.total) * 1000) / 10 : null;
  const cat2Pct = summary.total ? Math.round((summary.category2 / summary.total) * 1000) / 10 : null;
  const tiles = [
    { label: 'Усього співробітників', value: fmtNum(summary.total), accent: '' },
    { label: 'Категорія 1', value: `${fmtNum(summary.category1)} (${fmtPct(cat1Pct)})`, accent: 'green' },
    { label: 'Категорія 2', value: `${fmtNum(summary.category2)} (${fmtPct(cat2Pct)})`, accent: 'red' },
    { label: 'Середній бал тестів', value: fmtPct(summary.avgTests), accent: '' },
    { label: 'Новачки цього кварталу', value: `${fmtNum(summary.newcomers)} (${fmtPct(summary.newcomersPct)})`, accent: 'yellow' },
  ];
  document.getElementById('ca-kpi-grid').innerHTML = tiles.map((tl) => `
    <div class="kpi-tile ${tl.accent ? `accent-${tl.accent}` : ''}">
      <div class="kpi-value">${tl.value}</div>
      <div class="kpi-label">${escapeHtml(tl.label)}</div>
    </div>`).join('');
}

// Two different reasons a category-2 person can show no fail reason:
// the position has no criteria configured at all ("критерії не
// задані", literally true), or criteria ARE configured but none of
// them are formally violated for these specific people — the real
// cause (a subjective RC call, something outside the tracked columns)
// just isn't one of the conditions we check. Conflating the two used to
// say "критерії не задані" even for positions with criteria filled in,
// which misled you into thinking nothing was set up.
function categoryReasonsText(hasCriteria, category2, failReasons) {
  if (failReasons.length) return failReasons.map((f) => `${escapeHtml(f.reason)} — ${f.count}`).join(', ');
  if (!category2) return '<span class="muted">—</span>';
  return hasCriteria
    ? '<span class="muted" title="Критерії для цієї посади задані, але формально жодну з них не порушено — причина поза списком умов (напр. рішення керівника).">не за заданими критеріями</span>'
    : '<span class="muted">критерії не задані</span>';
}

function renderCategoryAnalysisByRegion(regions) {
  const table = document.getElementById('ca-regions-table');
  const hasCriteria = !!state._caHasCriteria;
  table.innerHTML = `
    <thead><tr><th>Регіон</th><th>Усього</th><th>Категорія 1</th><th>Середній тест</th><th>Проблемні зони (категорія 2)</th></tr></thead>
    <tbody>${regions.map((r, i) => {
      const cat1Pct = r.total ? Math.round((r.category1 / r.total) * 1000) / 10 : null;
      const reasons = categoryReasonsText(hasCriteria, r.category2, r.failReasons);
      return `
      <tr class="row-clickable" data-idx="${i}">
        <td>${escapeHtml(r.region)}</td>
        <td>${fmtNum(r.total)}</td>
        <td>${progressCellHtml(cat1Pct)}</td>
        <td>${progressCellHtml(r.avgTests)}</td>
        <td>${reasons}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="5" class="muted">Немає даних</td></tr>`}</tbody>
  `;
  table.querySelectorAll('tbody tr[data-idx]').forEach((tr) => {
    const r = regions[Number(tr.dataset.idx)];
    tr.addEventListener('click', () => openCategoryRegionStoresModal(r));
  });
}

async function openCategoryRegionStoresModal(region) {
  const { categoryReportId, withApprovals } = state.categoryAnalysis;
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" id="ca-stores-backdrop">
      <div class="modal" style="max-width:1040px;">
        <button class="modal-close" id="ca-stores-close">✕</button>
        <h2>${escapeHtml(region.region)}</h2>
        <p class="modal-subtitle">Усього ${fmtNum(region.total)} · Категорія 1 — ${fmtPct(region.total ? Math.round((region.category1 / region.total) * 1000) / 10 : null)}</p>
        <div class="table-scroll"><table class="data-table" id="ca-stores-table">
          <tbody><tr><td class="muted">Завантаження…</td></tr></tbody>
        </table></div>
      </div>
    </div>
  `;
  document.getElementById('ca-stores-close').onclick = closeModal;
  document.getElementById('ca-stores-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'ca-stores-backdrop') closeModal();
  });
  const data = await api(`/api/category-report-by-store?${qs({ categoryReportId, region: region.region, withApprovals: withApprovals ? '1' : '0' })}`);
  const stores = data.stores || [];
  const table = document.getElementById('ca-stores-table');
  if (table) {
    table.innerHTML = `
      <thead><tr>
        <th>Магазин</th><th>Усього</th><th>Категорія 1</th><th>Категорія 2</th><th>Середній тест</th>
        <th>Проблемні зони</th>
      </tr></thead>
      <tbody>${stores.map((s) => {
        const cat1Pct = s.total ? Math.round((s.category1 / s.total) * 1000) / 10 : null;
        const reasons = categoryReasonsText(!!state._caHasCriteria, s.category2, s.failReasons);
        return `
        <tr>
          <td>${escapeHtml(s.store)}</td>
          <td>${fmtNum(s.total)}</td>
          <td>${progressCellHtml(cat1Pct)}</td>
          <td>${fmtNum(s.category2)}</td>
          <td>${progressCellHtml(s.avgTests)}</td>
          <td>${reasons}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="6" class="muted">Немає даних</td></tr>`}</tbody>
    `;
  }
}

function renderCategoryAnalysisPeopleTable() {
  const rows = state._caPeople || [];
  const key = 'ca-people';
  const table = document.getElementById('ca-people-table');
  const pageRows = pageSlice(key, rows);
  table.innerHTML = `
    <thead><tr><th>ПІБ</th><th>Регіон</th><th>Магазин</th><th>Розрахована</th><th>Побажання РК</th><th>Погоджено</th><th>Фінальна</th><th>Тести</th><th>Чому не 1 категорія (розрахунок)</th></tr></thead>
    <tbody>${pageRows.map((p) => {
      const confirmedBadge = p.confirmed === 'Так'
        ? '<span class="badge status-good">Так</span>'
        : (p.rkWish ? '<span class="badge status-orange">Ні</span>' : '—');
      const changed = p.effectiveCategory !== p.potentialCategory;
      const newcomerBadge = p.isNewcomer
        ? ` <span class="badge status-yellow" title="${p.hireDate ? `Прийнятий ${escapeHtml(p.hireDate)}` : 'Новачок цього кварталу'}">новачок</span>`
        : '';
      return `
      <tr>
        <td>${escapeHtml(p.name)}${newcomerBadge}</td>
        <td>${escapeHtml(p.region)}</td>
        <td>${escapeHtml(p.store)}</td>
        <td>${fmtNum(p.potentialCategory)}</td>
        <td>${p.rkWish ? escapeHtml(p.rkWish) + (p.rkComment ? ` <span class="muted" title="${escapeHtml(p.rkComment)}">(коментар)</span>` : '') : '—'}</td>
        <td>${confirmedBadge}</td>
        <td>${changed ? `<strong>${fmtNum(p.effectiveCategory)}</strong>` : fmtNum(p.effectiveCategory)}</td>
        <td>${progressCellHtml(p.tests)}</td>
        <td>${p.failedCriteria.length ? p.failedCriteria.map((f) => `<span class="badge status-orange">${escapeHtml(f)}</span>`).join(' ') : '—'}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="9" class="muted">Немає даних за цим фільтром</td></tr>`}</tbody>
  `;
  const hint = document.getElementById('ca-count-hint');
  if (hint) hint.textContent = `Показано ${rows.length} співробітників.`;
  const pager = document.getElementById('ca-people-pagination');
  pager.innerHTML = paginationBarHtml(key, rows.length);
  wirePagination(pager, key, renderCategoryAnalysisPeopleTable);
}

// Same self-contained export pattern as the director/lesson reports, but
// this one also bakes in the position's criteria rules and every raw
// metric per person, plus a JS port of the fail-reason engine — so the
// region filter AND the "з/без погоджень" toggle both keep working fully
// offline, not just a frozen snapshot of today's view.
async function downloadCategoryAnalysisHtml() {
  const { categoryReportId, reports } = state.categoryAnalysis;
  const report = reports.find((r) => r.id === categoryReportId);
  if (!report) return;
  const btn = document.getElementById('ca-download-html');
  if (btn) { btn.disabled = true; btn.textContent = 'Готую файл…'; }
  try {
    const [raw, css, logoDataUrl, comfySemiBold, ptRegular, ptMedium, ptBold] = await Promise.all([
      api(`/api/category-report-raw?${qs({ categoryReportId })}`),
      fetch('static/css/style.css').then((r) => r.text()).catch(() => ''),
      fetchAsDataUrl('/static/assets/logo_green.png'),
      fetchAsDataUrl('/static/fonts/ComfySemiBold/Comfy-Semi-Bold.woff2'),
      fetchAsDataUrl('/static/fonts/PTRootUI/PT-Root-UI-Regular.woff2'),
      fetchAsDataUrl('/static/fonts/PTRootUI/PT-Root-UI-Medium.woff2'),
      fetchAsDataUrl('/static/fonts/PTRootUI/PT-Root-UI-Bold.woff2'),
    ]);
    const fontCss = `
@font-face { font-family: 'Comfy Semi-Bold'; src: url('${comfySemiBold}') format('woff2'); font-weight: 600; font-style: normal; }
@font-face { font-family: 'PT Root UI'; src: url('${ptRegular}') format('woff2'); font-weight: 400; font-style: normal; }
@font-face { font-family: 'PT Root UI'; src: url('${ptMedium}') format('woff2'); font-weight: 500; font-style: normal; }
@font-face { font-family: 'PT Root UI'; src: url('${ptBold}') format('woff2'); font-weight: 700; font-style: normal; }
`;
    const inlinedCss = fontCss + css.replace(/@font-face\s*\{[^}]*\}/g, '');
    const title = `Аналіз категорій — ${report.position}, ${report.periodLabel}`;
    const dataJson = JSON.stringify(raw).replace(/<\/script/gi, '<\\/script');
    const html = buildCategoryAnalysisExportHtml({ title, css: inlinedCss, logoDataUrl, dataJson });
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Аналіз категорій - ${report.position} (${report.periodLabel}).html`.replace(/[\\/:*?"<>|]/g, '_');
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast(`Не вдалося згенерувати файл: ${e.message}`, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Завантажити HTML'; }
  }
}

function buildCategoryAnalysisExportHtml({ title, css, logoDataUrl, dataJson }) {
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${css}
body { background: var(--color-bg); padding: 24px; }
</style>
</head><body>
<noscript><p style="padding:20px;background:#fff2f0;color:#b42318;border-radius:8px;">Цей файл показує дані лише з увімкненим JavaScript — відкрийте його у звичайному браузері (Chrome, Edge, Safari) з дозволеним виконанням скриптів.</p></noscript>
<div class="top-bar" style="margin-bottom:20px;">
  <div class="brand">
    ${logoDataUrl ? `<img class="logo" src="${logoDataUrl}" alt="COMFY">` : ''}
    <div>
      <div class="brand-title">${escapeHtml(title)}</div>
      <div class="brand-subtitle">Знято ${new Date().toLocaleDateString('uk-UA')} · офлайн-знімок, фільтри працюють без інтернету</div>
    </div>
  </div>
</div>
<div class="filters" id="x-filters">
  <div class="filter-field">
    <label>Регіон</label>
    <select id="x-region"><option value="">Уся мережа</option></select>
  </div>
  <div class="filter-field" style="min-width:260px;">
    <label>Категорія</label>
    <select id="x-approvals">
      <option value="0" selected>Розрахована (без погоджень РК)</option>
      <option value="1">Фінальна (з погодженими побажаннями РК)</option>
    </select>
  </div>
</div>
<div class="grid-2">
  <div class="card" id="x-criteria-card"></div>
  <div class="card" id="x-bottlenecks-card"></div>
</div>
<div class="kpi-grid" id="x-kpi"></div>
<div class="card">
  <h3>По регіонах</h3>
  <p class="field-hint">Завжди всі регіони, незалежно від фільтра вище. Клік по регіону — розбивка по магазинах.</p>
  <div class="table-scroll"><table class="data-table" id="x-regions"></table></div>
</div>
<div class="card">
  <h3>Співробітники</h3>
  <p class="field-hint" id="x-count-hint"></p>
  <div class="table-scroll"><table class="data-table" id="x-people"></table></div>
</div>
<div id="x-modal-root"></div>
<script>
'use strict';
const DATA = ${dataJson};
const PEOPLE = DATA.people;
const RULES = DATA.rules || [];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtNum(v) { return v === null || v === undefined || Number.isNaN(v) ? '—' : String(v); }
function fmtPct(v) { return v === null || v === undefined || Number.isNaN(v) ? '—' : (Math.round(v * 10) / 10) + '%'; }
function bucket(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'red';
  if (v >= 90) return 'good'; if (v >= 70) return 'yellow'; if (v >= 40) return 'orange'; return 'red';
}
function progressCell(v) {
  const pct = Math.max(0, Math.min(100, v || 0));
  return '<div class="progress-cell"><div class="progress-bar-track"><div class="progress-bar-fill fill-' + bucket(v) + '" style="width:' + pct + '%"></div></div><div class="value">' + fmtPct(v) + '</div></div>';
}

const RULE_OP_LABELS = { '>=': 'не менше', '<=': 'не більше', '>': 'більше', '<': 'менше', '==': 'дорівнює', flagAbsent: 'немає позначки', flagPresent: 'є позначка' };
function ruleOpText(r) {
  const label = RULE_OP_LABELS[r.op] || r.op;
  return (r.op === 'flagAbsent' || r.op === 'flagPresent') ? label : label + ' ' + r.value;
}
function ruleLabel(r) { return r.label || r.metric || ''; }
function categoryReasonsText(category2, failReasons) {
  if (failReasons.length) return failReasons.map((f) => esc(f.reason) + ' \\u2014 ' + f.count).join(', ');
  if (!category2) return '<span class="muted">\\u2014</span>';
  return RULES.length
    ? '<span class="muted" title="Критерії для цієї посади задані, але формально жодну з них не порушено \\u2014 причина поза списком умов (напр. рішення керівника).">не за заданими критеріями</span>'
    : '<span class="muted">критерії не задані</span>';
}

function metricOf(person, metricKey) {
  if (metricKey === 'Тести') return { raw: person.tests == null ? '' : String(person.tests), value: person.tests };
  return (person.metrics && person.metrics[metricKey]) || { raw: '', value: null };
}
function rulePasses(rule, person) {
  const m = metricOf(person, rule.metric);
  if (rule.op === 'flagAbsent' || rule.op === 'flagPresent') {
    const present = (m.value !== null && m.value !== undefined) ? (m.value !== 0) : !!m.raw;
    return rule.op === 'flagAbsent' ? !present : present;
  }
  const val = m.value;
  if (val === null || val === undefined) return true;
  const t = rule.value;
  switch (rule.op) {
    case '>=': return val >= t;
    case '<=': return val <= t;
    case '>': return val > t;
    case '<': return val < t;
    case '==': return val === t;
    default: return true;
  }
}
function failedCriteria(person) {
  const failed = [];
  RULES.forEach((entry) => {
    if (entry.or) {
      if (!entry.or.some((r) => rulePasses(r, person))) failed.push(entry.or.map(ruleLabel).join(' ЧИ '));
    } else if (!rulePasses(entry, person)) {
      failed.push(ruleLabel(entry));
    }
  });
  return failed;
}
function effectiveCategory(person, withApprovals) {
  if (withApprovals && person.confirmed === 'Так' && person.rkWish) {
    const n = parseFloat(person.rkWish);
    if (!Number.isNaN(n)) return n;
  }
  return person.potentialCategory;
}

function renderCriteriaCard() {
  const el = document.getElementById('x-criteria-card');
  const rulesRows = [];
  RULES.forEach((entry) => {
    if (entry.or) {
      entry.or.forEach((r, j) => {
        if (j > 0) rulesRows.push('<tr><td colspan="2" class="muted" style="text-align:center;">ЧИ</td></tr>');
        rulesRows.push('<tr><td>' + esc(ruleLabel(r)) + '</td><td>' + esc(ruleOpText(r)) + '</td></tr>');
      });
    } else {
      rulesRows.push('<tr><td>' + esc(ruleLabel(entry)) + '</td><td>' + esc(ruleOpText(entry)) + '</td></tr>');
    }
  });
  el.innerHTML =
    '<h3>Умови категоризації — ' + esc(DATA.position) + '</h3>' +
    '<p style="white-space:pre-wrap; margin:0;">' + esc(DATA.criteriaText) + '</p>' +
    (rulesRows.length ? '<div class="table-scroll"><table class="data-table" style="margin-top:12px;"><thead><tr><th>Критерій</th><th>Умова</th></tr></thead><tbody>' + rulesRows.join('') + '</tbody></table></div>' : '');
}

function regionStats(rows, withApprovals) {
  const map = {};
  rows.forEach((p) => {
    if (!p.region) return;
    const b = map[p.region] || (map[p.region] = { region: p.region, total: 0, category1: 0, category2: 0, testsSum: 0, testsCount: 0, failReasons: {} });
    b.total++;
    const eff = effectiveCategory(p, withApprovals);
    if (eff === 1) b.category1++; else if (eff === 2) b.category2++;
    b.testsSum += (p.tests || 0); b.testsCount++;
    if (p.potentialCategory === 2) {
      failedCriteria(p).forEach((reason) => { b.failReasons[reason] = (b.failReasons[reason] || 0) + 1; });
    }
  });
  return Object.values(map).map((b) => ({
    region: b.region, total: b.total, category1: b.category1, category2: b.category2,
    avgTests: b.testsCount ? Math.round(b.testsSum / b.testsCount * 10) / 10 : null,
    failReasons: Object.entries(b.failReasons).map(([reason, count]) => ({ reason, count })).sort((a, b2) => b2.count - a.count),
  })).sort((a, b) => (b.total ? b.category2 / b.total : 0) - (a.total ? a.category2 / a.total : 0));
}

function storeStats(region, withApprovals) {
  const map = {};
  PEOPLE.filter((p) => p.region === region && p.store).forEach((p) => {
    const b = map[p.store] || (map[p.store] = { store: p.store, total: 0, category1: 0, category2: 0, testsSum: 0, testsCount: 0, failReasons: {} });
    b.total++;
    const eff = effectiveCategory(p, withApprovals);
    if (eff === 1) b.category1++; else if (eff === 2) b.category2++;
    b.testsSum += (p.tests || 0); b.testsCount++;
    if (p.potentialCategory === 2) {
      failedCriteria(p).forEach((reason) => { b.failReasons[reason] = (b.failReasons[reason] || 0) + 1; });
    }
  });
  return Object.values(map).map((b) => ({
    store: b.store, total: b.total, category1: b.category1, category2: b.category2,
    avgTests: b.testsCount ? Math.round(b.testsSum / b.testsCount * 10) / 10 : null,
    failReasons: Object.entries(b.failReasons).map(([reason, count]) => ({ reason, count })).sort((a, b2) => b2.count - a.count),
  })).sort((a, b) => (b.total ? b.category2 / b.total : 0) - (a.total ? a.category2 / a.total : 0));
}

function closeXModal() { document.getElementById('x-modal-root').innerHTML = ''; }
function openStoreModal(regionRow, withApprovals) {
  const stores = storeStats(regionRow.region, withApprovals);
  const cat1Pct = regionRow.total ? Math.round(regionRow.category1 / regionRow.total * 1000) / 10 : null;
  document.getElementById('x-modal-root').innerHTML =
    '<div class="modal-backdrop" id="x-store-backdrop"><div class="modal" style="max-width:860px;">' +
    '<button class="modal-close" id="x-store-close">\\u2715</button>' +
    '<h2>' + esc(regionRow.region) + '</h2>' +
    '<p class="modal-subtitle">Усього ' + fmtNum(regionRow.total) + ' \\u00b7 Категорія 1 \\u2014 ' + fmtPct(cat1Pct) + '</p>' +
    '<div class="table-scroll"><table class="data-table"><thead><tr><th>Магазин</th><th>Усього</th><th>Категорія 1</th><th>Категорія 2</th><th>Середній тест</th><th>Проблемні зони</th></tr></thead><tbody>' +
    (stores.map((s) => {
      const p1 = s.total ? Math.round(s.category1 / s.total * 1000) / 10 : null;
      const reasons = categoryReasonsText(s.category2, s.failReasons);
      return '<tr><td>' + esc(s.store) + '</td><td>' + fmtNum(s.total) + '</td><td>' + progressCell(p1) + '</td><td>' + fmtNum(s.category2) + '</td><td>' + progressCell(s.avgTests) + '</td><td>' + reasons + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="muted">Немає даних</td></tr>') +
    '</tbody></table></div></div></div>';
  document.getElementById('x-store-close').onclick = closeXModal;
  document.getElementById('x-store-backdrop').addEventListener('click', (e) => { if (e.target.id === 'x-store-backdrop') closeXModal(); });
}

function renderBottlenecks(regions, selectedRegion) {
  const el = document.getElementById('x-bottlenecks-card');
  let reasons, scopeLabel;
  if (selectedRegion) {
    const r = regions.find((x) => x.region === selectedRegion);
    reasons = r ? r.failReasons : [];
    scopeLabel = esc(selectedRegion);
  } else {
    const totals = {};
    regions.forEach((r) => { r.failReasons.forEach((f) => { totals[f.reason] = (totals[f.reason] || 0) + f.count; }); });
    reasons = Object.entries(totals).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
    scopeLabel = 'уся мережа';
  }
  el.innerHTML = '<h3>Вузькі місця \\u2014 ' + scopeLabel + '</h3>' +
    '<p class="field-hint">За якою умовою найчастіше не вистачає до 1 категорії (незалежно від погоджень РК).</p>' +
    (reasons.length ? '<ul class="bottleneck-list">' + reasons.slice(0, 6).map((f) => '<li><span>' + esc(f.reason) + '</span><strong>' + fmtNum(f.count) + '</strong></li>').join('') + '</ul>'
      : '<p class="muted">Немає даних.</p>');
}

function renderRegions(regions, withApprovals) {
  document.getElementById('x-regions').innerHTML =
    '<thead><tr><th>Регіон</th><th>Усього</th><th>Категорія 1</th><th>Середній тест</th><th>Проблемні зони (категорія 2)</th></tr></thead><tbody>' +
    (regions.map((r, i) => {
      const cat1Pct = r.total ? Math.round(r.category1 / r.total * 1000) / 10 : null;
      const reasonsText = categoryReasonsText(r.category2, r.failReasons);
      return '<tr class="row-clickable" data-idx="' + i + '"><td>' + esc(r.region) + '</td><td>' + fmtNum(r.total) + '</td><td>' + progressCell(cat1Pct) + '</td><td>' + progressCell(r.avgTests) + '</td><td>' + reasonsText + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="muted">Немає даних</td></tr>') + '</tbody>';
  document.querySelectorAll('#x-regions tbody tr[data-idx]').forEach((tr) => {
    const r = regions[Number(tr.dataset.idx)];
    tr.addEventListener('click', () => openStoreModal(r, withApprovals));
  });
}

function renderPeople(rows) {
  const sorted = [...rows].sort((a, b) => (b.potentialCategory - a.potentialCategory) || ((a.tests || 0) - (b.tests || 0)));
  document.getElementById('x-people').innerHTML =
    '<thead><tr><th>ПІБ</th><th>Регіон</th><th>Магазин</th><th>Розрахована</th><th>Побажання РК</th><th>Погоджено</th><th>Фінальна</th><th>Тести</th><th>Чому не 1 категорія (розрахунок)</th></tr></thead><tbody>' +
    (sorted.map((p) => {
      const confirmedBadge = p.confirmed === 'Так' ? '<span class="badge status-good">Так</span>' : (p.rkWish ? '<span class="badge status-orange">Ні</span>' : '\\u2014');
      const changed = p._eff !== p.potentialCategory;
      const newcomerBadge = p.isNewcomer ? ' <span class="badge status-yellow" title="' + (p.hireDate ? 'Прийнятий ' + esc(p.hireDate) : 'Новачок цього кварталу') + '">новачок</span>' : '';
      const reasons = p._failed.length ? p._failed.map((f) => '<span class="badge status-orange">' + esc(f) + '</span>').join(' ') : '\\u2014';
      return '<tr><td>' + esc(p.name) + newcomerBadge + '</td><td>' + esc(p.region) + '</td><td>' + esc(p.store) + '</td><td>' + fmtNum(p.potentialCategory) + '</td>' +
        '<td>' + (p.rkWish ? esc(p.rkWish) + (p.rkComment ? ' <span class="muted" title="' + esc(p.rkComment) + '">(коментар)</span>' : '') : '\\u2014') + '</td>' +
        '<td>' + confirmedBadge + '</td><td>' + (changed ? '<strong>' + fmtNum(p._eff) + '</strong>' : fmtNum(p._eff)) + '</td>' +
        '<td>' + progressCell(p.tests) + '</td><td>' + reasons + '</td></tr>';
    }).join('') || '<tr><td colspan="9" class="muted">Немає даних за цим фільтром</td></tr>') + '</tbody>';
  document.getElementById('x-count-hint').textContent = 'Показано ' + sorted.length + ' співробітників.';
}

function renderKpi(rows, withApprovals) {
  const total = rows.length;
  const cat1 = rows.filter((p) => p._eff === 1).length;
  const cat2 = rows.filter((p) => p._eff === 2).length;
  const testsArr = rows.map((p) => p.tests).filter((v) => v !== null && v !== undefined);
  const avgTests = testsArr.length ? testsArr.reduce((a, b) => a + b, 0) / testsArr.length : null;
  const newcomers = rows.filter((p) => p.isNewcomer).length;
  const cat1Pct = total ? Math.round(cat1 / total * 1000) / 10 : null;
  const cat2Pct = total ? Math.round(cat2 / total * 1000) / 10 : null;
  const newcomersPct = total ? Math.round(newcomers / total * 1000) / 10 : null;
  const tiles = [
    ['Усього співробітників', fmtNum(total), ''],
    ['Категорія 1', fmtNum(cat1) + ' (' + fmtPct(cat1Pct) + ')', 'accent-green'],
    ['Категорія 2', fmtNum(cat2) + ' (' + fmtPct(cat2Pct) + ')', 'accent-red'],
    ['Середній бал тестів', fmtPct(avgTests), ''],
    ['Новачки цього кварталу', fmtNum(newcomers) + ' (' + fmtPct(newcomersPct) + ')', 'accent-yellow'],
  ];
  document.getElementById('x-kpi').innerHTML = tiles.map((t) =>
    '<div class="kpi-tile ' + t[2] + '"><div class="kpi-value">' + t[1] + '</div><div class="kpi-label">' + esc(t[0]) + '</div></div>'
  ).join('');
}

function render() {
  const region = document.getElementById('x-region').value;
  const withApprovals = document.getElementById('x-approvals').value === '1';
  PEOPLE.forEach((p) => { p._eff = effectiveCategory(p, withApprovals); p._failed = p.potentialCategory === 2 ? failedCriteria(p) : []; });
  const filtered = region ? PEOPLE.filter((p) => p.region === region) : PEOPLE;
  const regions = regionStats(PEOPLE, withApprovals);
  renderKpi(filtered, withApprovals);
  renderBottlenecks(regions, region);
  renderRegions(regions, withApprovals);
  renderPeople(filtered);
  closeXModal();
}

function populateFilters() {
  const regionSelect = document.getElementById('x-region');
  const regions = [...new Set(PEOPLE.map((p) => p.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
  regionSelect.innerHTML = '<option value="">Уся мережа</option>' + regions.map((r) => '<option value="' + esc(r) + '">' + esc(r) + '</option>').join('');
  regionSelect.addEventListener('change', render);
  document.getElementById('x-approvals').addEventListener('change', render);
}

renderCriteriaCard();
populateFilters();
render();
</script>
</body></html>`;
}

/* ===================== «Доступ»: who gets in through Feed ===================== */
const ACCESS_FIELDS = { mag: 'Відділ', reg: 'Управління', position: 'Посада', tab: 'Таб. №', login: 'Логін Feed' };
const ACCESS_ROLES = { admin: 'Адмін', hr: 'Регіональна команда', none: 'Без доступу' }; // 'hr' — the role code
// «Журнал» (see AUDIT in app.py): every change on the dashboard, filterable
// by person, section and period.
let accessTab = 'rules';
const auditFilter = { who: '', section: '', days: '30' };
async function renderAuditLog() {
  const box = document.getElementById('ac-pane-log');
  if (!box) return;
  const q = new URLSearchParams(Object.entries(auditFilter).filter(([, v]) => v));
  let data;
  try { data = await api(`/api/access-audit?${q}`); } catch (e) { box.innerHTML = `<div class="error-text">${escapeHtml(e.message)}</div>`; return; }
  const fmtAt = (v) => new Date(v).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const sel = (id, label, opts) => `<div class="filter-field"><label for="${id}">${label}</label><select id="${id}">${opts}</select></div>`;
  const o = (v, t, cur) => `<option value="${escapeHtml(v)}" ${v === cur ? 'selected' : ''}>${escapeHtml(t)}</option>`;
  box.innerHTML = `
    <div class="filters" style="margin:0 0 12px;">
      ${sel('au-who', 'Співробітник', o('', 'Усі', auditFilter.who) + data.people.map((p) => o(p.key, `${p.fio || p.key}${p.position ? ' · ' + p.position : ''} (${p.n})`, auditFilter.who)).join(''))}
      ${sel('au-section', 'Розділ', o('', 'Усі', auditFilter.section) + data.sections.map((x) => o(x, x, auditFilter.section)).join(''))}
      ${sel('au-days', 'Період', [['1', 'Сьогодні'], ['7', '7 днів'], ['30', '30 днів'], ['', 'Усе']].map(([v, t]) => o(v, t, auditFilter.days)).join(''))}
    </div>
    <div class="table-scroll" style="max-height:460px;"><table class="data-table"><thead><tr><th>Коли</th><th>Хто</th><th>Розділ</th><th>Дія</th><th>Деталі</th></tr></thead>
      <tbody>${data.rows.map((r) => `<tr><td style="white-space:nowrap;">${fmtAt(r.at)}</td>
        <td>${escapeHtml(r.fio || r.login || '')}<div class="muted">${escapeHtml(r.position || '')}</div></td>
        <td>${escapeHtml(r.section)}</td>
        <td class="${/Немає доступу|Невдала/.test(r.action) ? 'error-text' : ''}"><b>${escapeHtml(r.action)}</b></td>
        <td>${escapeHtml(r.details || '')}</td></tr>`).join('') || '<tr><td class="muted" colspan="5">За цими фільтрами записів немає</td></tr>'}</tbody></table></div>
    <div class="field-hint">Показано ${data.rows.length}${data.rows.length >= 500 ? ' останніх' : ''} записів. Записуються лише зміни: входи, оновлення з Feed, завантаження, резерв і потенційні, налаштування LH, доступ.</div>`;
  [['au-who', 'who'], ['au-section', 'section'], ['au-days', 'days']].forEach(([id, k]) => {
    document.getElementById(id).onchange = (e) => { auditFilter[k] = e.target.value; renderAuditLog(); };
  });
}

async function openAccessModal() {
  const root = document.getElementById('modal-root');
  let data;
  try { data = await api('/api/access'); } catch (e) { showToast(e.message, true); return; }
  const fmtAt = (s) => (s ? new Date(s).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const opt = (dict, cur) => Object.entries(dict).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${v}</option>`).join('');
  const ruleRow = (r) => `<tr data-id="${r.id || ''}">
      <td><select class="ac-role">${opt(ACCESS_ROLES, r.role || 'hr')}</select></td>
      <td><select class="ac-field">${opt(ACCESS_FIELDS, r.field || 'position')}</select></td>
      <td><select class="ac-op"><option value="contains" ${r.op !== 'equals' ? 'selected' : ''}>містить</option><option value="equals" ${r.op === 'equals' ? 'selected' : ''}>дорівнює</option></select></td>
      <td><input type="text" class="ac-val" value="${escapeHtml(r.value || '')}" style="width:100%;"></td>
      <td><input type="text" class="ac-label" value="${escapeHtml(r.label || '')}" placeholder="підпис" style="width:100%;"></td>
      <td style="white-space:nowrap;"><button class="btn btn-primary btn-sm ac-save">Зберегти</button> ${r.id ? '<button class="btn btn-secondary btn-sm ac-del" title="Видалити правило">✕</button>' : ''}</td></tr>`;
  root.innerHTML = `
    <div class="modal-backdrop"><div class="modal" style="max-width:1100px;">
      <button class="modal-close" id="ac-close">✕</button>
      <h2>👥 Доступ</h2>
      <div class="position-switch" id="ac-tabs">
        <button class="position-chip ${accessTab === 'rules' ? 'active' : ''}" data-pane="rules">Правила</button>
        <button class="position-chip ${accessTab === 'log' ? 'active' : ''}" data-pane="log">Журнал</button>
      </div>
      <div id="ac-pane-rules">
      <p class="modal-subtitle">Вхід — логіном і паролем Feed. Роль визначають правила за профілем Feed: відділ, управління, посада, таб. № або логін. Якщо людина підходить під кілька правил: «Без доступу» сильніше за все (так можна закрити вхід окремій людині за таб. №), далі Адмін, далі Регіональна команда. Не підійшло жодне — доступу немає. Правила перевіряються при кожному вході.</p>
      <h3>Правила</h3>
      <div class="table-scroll"><table class="data-table" id="ac-rules"><thead><tr><th>Роль</th><th>Поле Feed</th><th>Умова</th><th>Значення</th><th>Підпис</th><th></th></tr></thead>
        <tbody>${data.rules.map(ruleRow).join('')}${ruleRow({})}</tbody></table></div>
      <div id="ac-error" class="error-text"></div>
      </div>
      <div id="ac-pane-log" hidden></div>
    </div></div>`;
  document.getElementById('ac-close').onclick = closeModal;
  const showPane = (pane) => {
    accessTab = pane;
    document.querySelectorAll('#ac-tabs .position-chip').forEach((b) => b.classList.toggle('active', b.dataset.pane === pane));
    document.getElementById('ac-pane-rules').hidden = pane !== 'rules';
    document.getElementById('ac-pane-log').hidden = pane !== 'log';
    if (pane === 'log') renderAuditLog();
  };
  document.getElementById('ac-tabs').onclick = (e) => { const b = e.target.closest('[data-pane]'); if (b) showPane(b.dataset.pane); };
  showPane(accessTab);
  document.getElementById('ac-rules').addEventListener('click', async (ev) => {
    const tr = ev.target.closest('tr');
    try {
      if (ev.target.closest('.ac-save')) {
        await api('/api/access-rules', { method: 'POST', body: JSON.stringify({ id: tr.dataset.id || null,
          role: tr.querySelector('.ac-role').value, field: tr.querySelector('.ac-field').value, op: tr.querySelector('.ac-op').value,
          value: tr.querySelector('.ac-val').value, label: tr.querySelector('.ac-label').value }) });
        showToast('Правило збережено'); await openAccessModal();
      } else if (ev.target.closest('.ac-del')) {
        if (!confirm('Видалити правило?')) return;
        await api(`/api/access-rules/${tr.dataset.id}`, { method: 'DELETE' });
        await openAccessModal();
      }
    } catch (e) { document.getElementById('ac-error').textContent = e.message; }
  });
}

/* ===================== init ===================== */

function bindTopActions() {
  document.getElementById('login-submit').addEventListener('click', doLogin);
  document.getElementById('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('login-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('login-password').focus(); });
  document.getElementById('login-mode').addEventListener('click', toggleLoginMode);
  document.getElementById('btn-access').addEventListener('click', openAccessModal);
  document.getElementById('btn-logout').addEventListener('click', doLogout);
  document.getElementById('btn-upload').addEventListener('click', openUploadModal);
  document.getElementById('btn-feed-sync').addEventListener('click', openFeedSyncModal);
  document.getElementById('btn-classify').addEventListener('click', openClassifyModal);
  document.getElementById('btn-snapshot').addEventListener('click', downloadTabSnapshot);
  document.getElementById('btn-category-analysis').addEventListener('click', openCategoryAnalysisView);
}

bindTabs();
bindTopActions();
checkSession();
