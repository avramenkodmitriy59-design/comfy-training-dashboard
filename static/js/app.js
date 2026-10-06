'use strict';

/* ===================== constants ===================== */

const ATTESTATION_STREAMS = ['Директор', 'Товарознавець', 'Комірник', 'Касир', 'Сервіс менеджер', 'Продавець'];

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
  directorReport: { year: null, quarter: null, region: '', store: '', periods: [] },
};

/* ===================== utils ===================== */

async function api(path, opts) {
  const res = await fetch(path, {
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

// "Звіт для РК" source — "Деталізація" sheet: one row per topic per
// director per quarter (Період | Тема | begin | end | Тест | Регіон |
// Магазин | Посада | Співробітник | Тип навчання). year/quarter are
// resolved from `begin` client-side, same as AEP — the sheet's own
// "Період" text column (Q1/Q2/Q3) is just a label, not reparsed.
function stripDirectorTopicPrefix(topic) {
  // "6. 📅 Управління кредитом (Керівники)" -> "Управління кредитом (Керівники)"
  return String(topic).replace(/^\s*\d+\.\s*/, '').replace(/^\s*📅\s*/u, '').trim();
}

function extractDirectorReportRows(sheetRows) {
  if (!sheetRows || sheetRows.length < 2) return [];
  const cols = (sheetRows[0] || []).map((c) => String(c || '').trim());
  const idx = {
    topic: cols.indexOf('Тема'),
    begin: cols.indexOf('begin'),
    score: cols.indexOf('Тест'),
    region: cols.indexOf('Регіон'),
    store: cols.indexOf('Магазин'),
    position: cols.indexOf('Посада'),
    name: cols.indexOf('Співробітник'),
    type: cols.indexOf('Тип навчання'),
  };
  if (idx.topic === -1 || idx.begin === -1 || idx.score === -1 || idx.type === -1) {
    throw new Error('Не знайдено потрібні колонки на аркуші «Деталізація» (Тема, begin, Тест, Тип навчання)');
  }
  const rows = [];
  for (let i = 1; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    if (!row || !row[idx.topic]) continue;
    const d = parseAepDate(row[idx.begin]);
    if (!d) continue;
    rows.push({
      topic: stripDirectorTopicPrefix(row[idx.topic]),
      trainingType: String(row[idx.type] || '').trim(),
      region: String(row[idx.region] || '').trim(),
      store: String(row[idx.store] || '').trim(),
      position: String(row[idx.position] || '').trim(),
      name: String(row[idx.name] || '').trim(),
      score: parseNum(row[idx.score]),
      year: d.getFullYear(),
      quarter: aepQuarterOf(d),
    });
  }
  return rows;
}

async function readDirectorReportWorkbookRows(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const sheet = findSheet(wb, 'Деталізація') || wb.Sheets[wb.SheetNames[0]];
  const sheetRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  return extractDirectorReportRows(sheetRows);
}

function detectAttestationPositionClient(rows) {
  const counts = {};
  rows.forEach((r) => { if (r.position) counts[r.position] = (counts[r.position] || 0) + 1; });
  const entries = Object.entries(counts);
  if (!entries.length) return { canonical: null, raw: null };
  entries.sort((a, b) => b[1] - a[1]);
  const dominant = entries[0][0];
  const lower = dominant.toLowerCase();
  // Director titles matched via startsWith (not includes) so "Заступник керуючого
  // магазином з ..." (a deputy) doesn't false-match on "керуюч".
  const directorPrefixes = ['керуючий магазином', 'в/о керуючого магазином'];
  if (directorPrefixes.some((p) => lower.startsWith(p))) return { canonical: 'Директор', raw: dominant };
  const rules = [
    ['Товарознавець', ['товарознав']],
    ['Комірник', ['прийому і видачі товару', 'комірник']],
    ['Касир', ['касир']],
    ['Сервіс менеджер', ['роздрібній торгівлі побутовими товарами', 'сервіс менеджер', 'сервіс-менеджер']],
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

async function checkSession() {
  const data = await api('/api/session');
  if (data.authenticated) {
    showApp();
    await bootstrap();
  } else {
    showLogin();
  }
}

async function doLogin() {
  const input = document.getElementById('login-password');
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: input.value }) });
    input.value = '';
    showApp();
    await bootstrap();
  } catch (e) {
    errorEl.textContent = 'Невірний пароль';
  }
}

async function doLogout() {
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
  if (!state.attestationPosition) {
    const available = ATTESTATION_STREAMS.filter((p) =>
      state.streams.some((s) => s.streamType === 'attestation' && s.streamKey === p));
    state.attestationPosition = available[0] || ATTESTATION_STREAMS[0];
  }
  state.projects = data.projects || [];
  if (!state.selectedProject || !state.projects.includes(state.selectedProject)) {
    state.selectedProject = state.projects[0] || null;
  }
  state.aepAvailable = !!data.aepAvailable;
  state.aepLastUpdated = data.aepLastUpdated || null;
  const drData = await api('/api/director-report-last-updated');
  state.directorReportLastUpdated = drData.lastUpdated || null;
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
  const reportBtn = document.getElementById('btn-director-report');
  if (reportBtn) reportBtn.hidden = state.tab !== 'overall';
  const el = document.getElementById('position-switch');
  if (state.tab === 'attestation') {
    el.hidden = false;
    el.innerHTML = ATTESTATION_STREAMS.map((p) => {
      const has = streamHasData('attestation', p);
      return `<button class="position-chip ${p === state.attestationPosition ? 'active' : ''}" data-pos="${escapeHtml(p)}" ${has ? '' : 'style="opacity:.45"'}>${escapeHtml(p)}${has ? '' : ' · немає даних'}</button>`;
    }).join('');
    el.querySelectorAll('.position-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        state.attestationPosition = chip.dataset.pos;
        renderPositionSwitch();
        resetFilters();
        await refreshAll();
      });
    });
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
  state.filters = { region: '', store: '', position: '', segment: 'all', firstLine: 'all', search: '' };
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
  const validStores = f.region ? (opts.storesByRegion[f.region] || []) : Object.values(opts.storesByRegion).flat();
  if (f.store && !validStores.includes(f.store)) f.store = '';
}

async function refreshSummary() {
  const { streamType, streamKey } = currentStream();
  const periodId = resolveSelectedPeriod()?.id || '';
  const data = await api(`/api/summary?${qs({ streamType, streamKey, periodId, ...filterParams() })}`);
  state.summary = data;
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
  renderStoresTable();
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
    region: f.region, store: f.store, position: f.position,
    segment: f.segment !== 'all' ? f.segment : '',
    firstLine: f.firstLine !== 'all' ? f.firstLine : '',
  };
}

/* ===================== shell / empty state ===================== */

function emptyStateHtml() {
  let label = 'загальні дані';
  if (state.tab === 'attestation') label = `дані з атестації (${state.attestationPosition})`;
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
  const t6 = p ? 'Магазини (від найгіршого результату тестів)' : 'Магазини (від найгіршого прогресу)';
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
    ${isSparseProject ? '' : `
    <div class="card">
      <h3>${hideProgress ? 'Магазини (від найгіршої оцінки)' : t6}</h3>
      <div class="table-scroll"><table class="data-table" id="stores-table"></table></div>
    </div>`}
    <div class="card" id="employees-card">
      <div class="table-toolbar">
        <h3 class="mt-0">Співробітники</h3>
        <input type="text" class="search-input" id="employee-search" placeholder="Пошук за ПІБ…">
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
  const mostRecentId = state.periods[state.periods.length - 1]?.id;

  const periodFieldHtml = `
    <div class="filter-field">
      <label>Період</label>
      <select id="f-period">${sortedPeriods.map((p) => `<option value="${p.id}" ${selected && p.id === selected.id ? 'selected' : ''}>${escapeHtml(p.label)}${p.id === mostRecentId ? ' (поточний)' : ''}</option>`).join('')}</select>
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
    <div class="filter-field">
      <label>${positionLabel}</label>
      <select id="f-position"><option value="">${positionAllLabel}</option>${opts.positions.map((p) => `<option value="${escapeHtml(p)}" ${p === f.position ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}</select>
    </div>
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
  document.getElementById('f-position').addEventListener('change', async (e) => {
    state.filters.position = e.target.value; await refreshSummary(); await refreshDetails();
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
    const totalPeople = t.count + t.noAssignment;
    tiles = [
      { label: 'Середня оцінка', value: fmtPct(avg(t.scoreSum, t.scoreCount)), accent: 'green' },
      { label: 'Співробітників у вибірці', value: fmtNum(totalPeople), accent: '' },
    ];
  } else {
    const totalPeople = t.count + t.noAssignment;
    tiles = [
      { label: 'Середній прогрес', value: fmtPct(avg(t.progressSum, t.count)), accent: 'green' },
      { label: 'Середня оцінка', value: fmtPct(avg(t.scoreSum, t.scoreCount)), accent: 'green' },
      { label: 'Співробітників у вибірці', value: fmtNum(totalPeople), accent: '' },
      { label: 'Ще не розпочали', value: fmtNum(t.notStarted), accent: 'red' },
      { label: 'Без призначеного навчання', value: fmtNum(t.noAssignment), accent: 'muted' },
      { label: 'Призначено курсів', value: fmtNum(t.assigned), accent: '' },
      { label: 'Пройдено курсів', value: fmtNum(t.completed), accent: '' },
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

function renderBucketBarChart(chartKey, canvasId, bucket, sumField, countField = 'count') {
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
      datasets: [{ data: entries.map((e) => Math.round(e[1] * 10) / 10), backgroundColor: barChartColors(entries.map((e) => e[1])), borderRadius: 6 }],
    },
    options: chartBarOptions(),
  });
}

function renderPositionChart() {
  const field = isProjectStream() ? 'testsSum' : 'progressSum';
  renderBucketBarChart('position', 'chart-position', state.summary.byPosition, field);
}

function renderRegionChart() {
  const field = isProjectStream() ? 'testsSum' : 'progressSum';
  renderBucketBarChart('region', 'chart-region', state.summary.byRegion, field);
}

function renderPositionScoreChart() {
  const field = isProjectStream() ? 'homeworkPercentSum' : 'scoreSum';
  const countField = isProjectStream() ? 'count' : 'scoreCount';
  renderBucketBarChart('positionScore', 'chart-position-score', state.summary.byPosition, field, countField);
}

function renderRegionScoreChart() {
  const field = isProjectStream() ? 'homeworkPercentSum' : 'scoreSum';
  const countField = isProjectStream() ? 'count' : 'scoreCount';
  renderBucketBarChart('regionScore', 'chart-region-score', state.summary.byRegion, field, countField);
}

// Engagement (% actually participating vs. enrolled) is a ratio of two
// counts, not a sum-of-percentages average, so it gets its own chart function.
function renderEngagementChart(chartKey, canvasId, bucket) {
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
      datasets: [{ data: entries.map((e) => Math.round(e[1] * 10) / 10), backgroundColor: barChartColors(entries.map((e) => e[1])), borderRadius: 6 }],
    },
    options: chartBarOptions(),
  });
}

function renderPositionEngagementChart() {
  renderEngagementChart('positionEngagement', 'chart-position-engagement', state.summary.byPosition);
}

function renderRegionEngagementChart() {
  renderEngagementChart('regionEngagement', 'chart-region-engagement', state.summary.byRegion);
}

function chartBarOptions() {
  return {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.parsed.x}%` } } },
    scales: { x: { min: 0, max: 100, ticks: { callback: (v) => `${v}%` } } },
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
    count: b.count, engagement: project && b.testsAssignedSum > 0 ? (b.testsCompletedSum / b.testsAssignedSum) * 100 : null,
  })).filter((r) => r.primary !== null);
  rows.sort((a, b) => a.primary - b.primary);

  const primaryLabel = project ? '% тестів' : (scoreOnly ? 'Оцінка' : 'Прогрес');
  const secondaryLabel = project ? '% ДЗ' : 'Оцінка';
  const peopleLabel = project ? 'Залучено' : 'Осіб';

  const table = document.getElementById('stores-table');
  table.innerHTML = `
    <thead><tr><th>Магазин</th><th>Регіон</th><th>${primaryLabel}</th>${scoreOnly ? '' : `<th>${secondaryLabel}</th>`}${project ? '<th>% залученості</th>' : ''}<th>${peopleLabel}</th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr>
        <td>${escapeHtml(r.store)}</td>
        <td>${escapeHtml(r.region)}</td>
        <td>${progressCellHtml(r.primary)}</td>
        ${scoreOnly ? '' : `<td>${badgeHtml(r.secondary)}</td>`}
        ${project ? `<td>${progressCellHtml(r.engagement)}</td>` : ''}
        <td>${r.count}</td>
      </tr>`).join('') || `<tr><td colspan="${project ? 6 : (scoreOnly ? 4 : 5)}" class="muted">Немає даних для обраних фільтрів</td></tr>`}</tbody>
  `;
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
  const columns = project ? PROJECT_EMPLOYEE_COLUMNS : (scoreOnly ? ATTESTATION_SCORE_ONLY_COLUMNS : EMPLOYEE_COLUMNS);
  const pageRows = pageSlice('employees', rows);

  const bodyHtml = project
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
        <td>${fmtNum(r.assigned)}</td>
        <td>${fmtNum(r.completed)}</td>
        <td>${progressCellHtml(r.assigned > 0 ? r.progress : null)}</td>
        <td>${r.assigned > 0 ? badgeHtml(r.score) : '<span class="muted">—</span>'}</td>
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
  return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function lastUpdatedFor(streamType, streamKey) {
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
      const lines = p.quarterSummaries.map((q) => `${escapeHtml(q.key)}: ${q.count} сесій`).join('<br>');
      // A 0-record result usually means the "Apple_Certified_-_Attendance" sheet
      // wasn't found (e.g. a renamed tab) — flag it instead of saving silently
      // with no attendance data, which is very easy to miss otherwise.
      const attLine = p.attendance.length
        ? `<br>Відвідуваність: ${p.attendance.length} записів учасників.`
        : `<br><span style="color:var(--color-red)">Відвідуваність: 0 записів — лист «Apple_Certified_-_Attendance» не знайдено у файлі чи він порожній. Дані відвідуваності НЕ оновляться.</span>`;
      return `<div class="upload-summary">AEP «${escapeHtml(p.fileName)}» — усього ${p.rows.length} сесій, буде оновлено квартали:<br>${lines}${attLine}</div>`;
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
        const resp = await api('/api/upload-aep', { method: 'POST', body: JSON.stringify({ rows: p.rows, attendance: p.attendance }) });
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

/* ===================== director report ("Звіт для РК") =====================
   Separate full-screen view (not one of the three main tabs) — combines
   per-topic АТТ + "Додаткове навчання" rows (director_report_details,
   loaded from the "Деталізація" sheet) into one shareable summary: result
   per type, overall result, per-topic breakdown, and two antitop
   (worst-engagement) lists. See /api/director-report-* in app.py. */

async function openDirectorReportView() {
  document.getElementById('app').hidden = true;
  const view = document.getElementById('director-report-view');
  view.hidden = false;
  renderDirectorReportShell();
  await loadDirectorReportPeriods();
}

function closeDirectorReportView() {
  document.getElementById('director-report-view').hidden = true;
  document.getElementById('app').hidden = false;
}

function renderDirectorReportShell() {
  const view = document.getElementById('director-report-view');
  view.innerHTML = `
    <div class="top-bar">
      <div class="brand">
        <img class="logo" src="/static/assets/logo_green.png" alt="COMFY">
        <div>
          <div class="brand-title">Звіт для РК</div>
          <div class="brand-subtitle">АТТ і додаткове навчання директорів</div>
        </div>
      </div>
      <div class="top-actions">
        <button class="btn btn-primary btn-sm" id="dr-upload">Завантажити файл</button>
        <button class="btn btn-secondary btn-sm" id="dr-download-html">Завантажити HTML</button>
        <button class="btn btn-secondary btn-sm" id="dr-back">← Назад у систему</button>
      </div>
    </div>
    <div class="tabs">
      <button class="tab-btn active" data-dr-tab="directors">Директори</button>
    </div>
    <div id="dr-content-area">
      <!-- filled dynamically -->
    </div>
  `;
  document.getElementById('dr-back').onclick = closeDirectorReportView;
  document.getElementById('dr-download-html').onclick = downloadDirectorReportHtml;
  document.getElementById('dr-upload').onclick = openDirectorReportUploadModal;
}

function openDirectorReportUploadModal() {
  const root = document.getElementById('modal-root');
  const lastUpdated = fmtUploadedAt(state.directorReportLastUpdated);
  root.innerHTML = `
    <div class="modal-backdrop" id="dr-upload-backdrop">
      <div class="modal">
        <button class="modal-close" id="dr-upload-close">✕</button>
        <h2>Завантажити звіт для РК</h2>
        <p class="modal-subtitle">Весь файл з аркушем «Деталізація» — квартал визначається автоматично з дати, оновлюється лише знайдений квартал.</p>
        <div class="field-group">
          <label>Файл</label>
          <input type="file" id="dr-upload-file" accept=".xls,.xlsx">
          <div class="field-hint">${lastUpdated ? `Востаннє оновлено: ${lastUpdated}` : 'Ще не завантажувалось'}</div>
        </div>
        <div id="dr-upload-preview"></div>
        <div id="dr-upload-error" class="error-text"></div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="dr-upload-cancel">Скасувати</button>
          <button class="btn btn-primary" id="dr-upload-parse">Перевірити файл</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('dr-upload-close').onclick = closeModal;
  document.getElementById('dr-upload-cancel').onclick = closeModal;
  document.getElementById('dr-upload-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'dr-upload-backdrop') closeModal();
  });
  document.getElementById('dr-upload-parse').onclick = handleDirectorReportParse;
}

async function handleDirectorReportParse() {
  const errorEl = document.getElementById('dr-upload-error');
  errorEl.textContent = '';
  const file = document.getElementById('dr-upload-file').files[0];
  if (!file) { errorEl.textContent = 'Оберіть файл.'; return; }

  let rows;
  try {
    rows = await readDirectorReportWorkbookRows(file);
  } catch (e) {
    errorEl.textContent = `Помилка читання файлу: ${e.message}`;
    return;
  }
  if (!rows.length) {
    errorEl.textContent = 'Не знайдено жодного рядка на аркуші «Деталізація».';
    return;
  }

  const byQuarter = {};
  rows.forEach((r) => {
    const key = `${r.year} Q${r.quarter}`;
    byQuarter[key] = (byQuarter[key] || 0) + 1;
  });
  const quarterSummaries = Object.entries(byQuarter)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));

  document.getElementById('dr-upload-preview').innerHTML = `
    <div class="upload-summary">«${escapeHtml(file.name)}» — усього ${rows.length} рядків, буде оновлено квартали:<br>${quarterSummaries.map((q) => `${escapeHtml(q.key)}: ${q.count} рядків`).join('<br>')}</div>
  `;
  const actions = document.querySelector('#dr-upload-backdrop .modal-actions');
  actions.innerHTML = `
    <button class="btn btn-secondary" id="dr-upload-cancel2">Скасувати</button>
    <button class="btn btn-primary" id="dr-upload-save">Зберегти</button>
  `;
  document.getElementById('dr-upload-cancel2').onclick = closeModal;
  document.getElementById('dr-upload-save').onclick = async () => {
    const btn = document.getElementById('dr-upload-save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Збереження…';
    try {
      const resp = await api('/api/upload-director-report', { method: 'POST', body: JSON.stringify({ rows }) });
      closeModal();
      showToast(`Звіт для РК збережено: ${resp.quarters.map((q) => q.label).join(', ')}.`);
      const drData = await api('/api/director-report-last-updated');
      state.directorReportLastUpdated = drData.lastUpdated || null;
      await loadDirectorReportPeriods();
    } catch (e) {
      document.getElementById('dr-upload-error').textContent = e.message;
      btn.disabled = false;
      btn.textContent = 'Зберегти';
    }
  };
}

async function loadDirectorReportPeriods() {
  const data = await api('/api/director-report-periods');
  state.directorReport.periods = data.periods || [];
  if (!state.directorReport.periods.length) {
    document.getElementById('dr-content-area').innerHTML = `
      <div class="empty-state">
        <h2>Ще немає даних</h2>
        <p>Завантажте аркуш «Деталізація» через звичайну модалку «Завантажити дані» на головному сайті (пункт «Звіт для РК» у списку проєктів).</p>
      </div>`;
    return;
  }
  const latest = state.directorReport.periods[state.directorReport.periods.length - 1];
  if (!state.directorReport.year || !state.directorReport.periods.some(
    (p) => p.year === state.directorReport.year && p.quarter === state.directorReport.quarter
  )) {
    state.directorReport.year = latest.year;
    state.directorReport.quarter = latest.quarter;
  }
  renderDirectorReportContent();
  await refreshDirectorReportFilters();
  await refreshDirectorReportData();
}

function renderDirectorReportContent() {
  const { periods, year, quarter, region, store } = state.directorReport;
  const el = document.getElementById('dr-content-area');
  const sortedPeriods = [...periods].reverse();
  const mostRecent = periods[periods.length - 1];
  el.innerHTML = `
    <div class="filters" id="dr-filters">
      <div class="filter-field">
        <label>Період</label>
        <select id="dr-period">
          ${sortedPeriods.map((p) => `<option value="${p.year}-${p.quarter}" ${p.year === year && p.quarter === quarter ? 'selected' : ''}>${escapeHtml(p.label)}${p.year === mostRecent.year && p.quarter === mostRecent.quarter ? ' (поточний)' : ''}</option>`).join('')}
        </select>
      </div>
      <div class="filter-field">
        <label>Регіон</label>
        <select id="dr-region"><option value="">Усі регіони</option></select>
      </div>
      <div class="filter-field">
        <label>Магазин</label>
        <select id="dr-store"><option value="">Усі магазини</option></select>
      </div>
    </div>
    <div class="kpi-grid" id="dr-kpi-grid"></div>
    <div class="card" id="dr-regions-card">
      <h3>По регіонах</h3>
      <p class="field-hint">Завжди всі регіони, незалежно від фільтра вище — для огляду по мережі одразу.</p>
      <div class="table-scroll"><table class="data-table" id="dr-regions-table"></table></div>
    </div>
    <div class="card" id="dr-employees-card" hidden>
      <h3>По співробітниках</h3>
      <p class="field-hint">Натисни на рядок для деталізації по темах.</p>
      <div class="table-scroll"><table class="data-table" id="dr-employees-table"></table></div>
      <div id="dr-employees-pagination"></div>
    </div>
    <div class="card">
      <h3>Результат по темам</h3>
      <div class="table-scroll"><table class="data-table" id="dr-topics-table"></table></div>
    </div>
    <div class="card">
      <h3>Низькі результати — історично</h3>
      <p class="field-hint">Середній результат нижче 70% за всі квартали (мінімум 2 квартали в базі) — ті, на кого варто звернути увагу першочергово. Натисни на рядок для динаміки по кварталах.</p>
      <div class="table-scroll"><table class="data-table" id="dr-historical-low-table"></table></div>
      <div id="dr-historical-low-pagination"></div>
    </div>
    <div class="card">
      <h3>ТОП <span class="muted">(за середньоарифметичним АТТ і Додаткового навчання)</span></h3>
      <div class="table-scroll"><table class="data-table" id="dr-top-table"></table></div>
      <div id="dr-top-pagination"></div>
    </div>
  `;
  document.getElementById('dr-period').addEventListener('change', async (e) => {
    const [y, q] = e.target.value.split('-').map(Number);
    state.directorReport.year = y;
    state.directorReport.quarter = q;
    state.directorReport.region = '';
    state.directorReport.store = '';
    await refreshDirectorReportFilters();
    await refreshDirectorReportData();
  });
  document.getElementById('dr-region').addEventListener('change', async (e) => {
    state.directorReport.region = e.target.value;
    state.directorReport.store = '';
    await refreshDirectorReportFilters();
    await refreshDirectorReportData();
  });
  document.getElementById('dr-store').addEventListener('change', async (e) => {
    state.directorReport.store = e.target.value;
    await refreshDirectorReportData();
  });
}

async function refreshDirectorReportFilters() {
  const { year, quarter, region, store } = state.directorReport;
  const data = await api(`/api/director-report-filters?${qs({ year, quarter, region })}`);
  const regionSelect = document.getElementById('dr-region');
  const storeSelect = document.getElementById('dr-store');
  regionSelect.innerHTML = `<option value="">Усі регіони</option>${(data.regions || []).map((r) => `<option value="${escapeHtml(r)}" ${r === region ? 'selected' : ''}>${escapeHtml(r)}</option>`).join('')}`;
  storeSelect.innerHTML = `<option value="">Усі магазини</option>${(data.stores || []).map((s) => `<option value="${escapeHtml(s)}" ${s === store ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}`;
}

async function refreshDirectorReportData() {
  const { year, quarter, region, store } = state.directorReport;
  const params = { year, quarter, region, store };
  const [summary, topics, top, historicalLow] = await Promise.all([
    api(`/api/director-report-summary?${qs(params)}`),
    api(`/api/director-report-topics?${qs(params)}`),
    api(`/api/director-report-top?${qs(params)}`),
    api(`/api/director-report-historical-low?${qs({ region, store })}`),
  ]);
  renderDirectorReportKpis(summary);
  state._drHistoricalLow = historicalLow.people || [];
  resetPageState('dr-historical-low');
  renderDirectorReportHistoricalLow();
  document.getElementById('dr-regions-card').hidden = !!region;
  document.getElementById('dr-employees-card').hidden = !region;
  if (region) {
    const byEmployee = await api(`/api/director-report-by-employee?${qs(params)}`);
    state._drEmployees = byEmployee.employees || [];
    resetPageState('dr-employees');
    renderDirectorReportEmployees();
  } else {
    const byRegion = await api(`/api/director-report-by-region?${qs({ year, quarter })}`);
    renderDirectorReportByRegion(byRegion.regions || []);
  }
  renderDirectorReportTopics(topics.topics || []);
  state._drTop = top.people || [];
  resetPageState('dr-top');
  renderDirectorReportTopTable();
}

function renderDirectorReportByRegion(regions) {
  const table = document.getElementById('dr-regions-table');
  table.innerHTML = `
    <thead><tr><th>Регіон</th><th>Загальний результат</th><th>АТТ</th><th>Додаткове навчання</th></tr></thead>
    <tbody>${regions.map((r) => `
      <tr>
        <td>${escapeHtml(r.region)}</td>
        <td>${progressCellHtml(r.overall)}</td>
        <td>${progressCellHtml(r.att)}</td>
        <td>${progressCellHtml(r.additional)}</td>
      </tr>`).join('') || `<tr><td colspan="4" class="muted">Немає даних</td></tr>`}</tbody>
  `;
}

function renderDirectorReportEmployees() {
  const rows = state._drEmployees || [];
  const key = 'dr-employees';
  const table = document.getElementById('dr-employees-table');
  const pageRows = pageSlice(key, rows);
  table.innerHTML = `
    <thead><tr><th>ПІБ</th><th>Магазин</th><th>Загальний результат</th><th>АТТ</th><th>Додаткове навчання</th></tr></thead>
    <tbody>${pageRows.map((e, i) => `
      <tr class="row-clickable" data-idx="${i}">
        <td>${escapeHtml(e.name)}</td>
        <td>${escapeHtml(e.store)}</td>
        <td>${progressCellHtml(e.overall)}</td>
        <td>${progressCellHtml(e.att)}</td>
        <td>${progressCellHtml(e.additional)}</td>
      </tr>`).join('') || `<tr><td colspan="5" class="muted">Немає даних</td></tr>`}</tbody>
  `;
  table.querySelectorAll('tbody tr[data-idx]').forEach((tr) => {
    const e = pageRows[Number(tr.dataset.idx)];
    tr.addEventListener('click', () => openDirectorEmployeeModal(e));
  });
  const pager = document.getElementById('dr-employees-pagination');
  pager.innerHTML = paginationBarHtml(key, rows.length);
  wirePagination(pager, key, renderDirectorReportEmployees);
}

async function openDirectorEmployeeModal(employee) {
  const { year, quarter } = state.directorReport;
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" id="dr-employee-backdrop">
      <div class="modal" style="max-width:680px;">
        <button class="modal-close" id="dr-employee-close">✕</button>
        <h2>${escapeHtml(employee.name)}</h2>
        <p class="modal-subtitle">${escapeHtml(employee.store)} · Загальний результат ${fmtPct(employee.overall)}</p>
        <div class="table-scroll"><table class="data-table" id="dr-employee-topics-table">
          <tbody><tr><td class="muted">Завантаження…</td></tr></tbody>
        </table></div>
      </div>
    </div>
  `;
  document.getElementById('dr-employee-close').onclick = closeModal;
  document.getElementById('dr-employee-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'dr-employee-backdrop') closeModal();
  });
  const params = { year, quarter, store: employee.store, name: employee.name };
  const data = await api(`/api/director-report-employee-topics?${qs(params)}`);
  const topics = data.topics || [];
  const table = document.getElementById('dr-employee-topics-table');
  if (table) {
    table.innerHTML = `
      <thead><tr><th>Тема</th><th>Тип</th><th>Бал</th></tr></thead>
      <tbody>${topics.map((t) => `
        <tr>
          <td>${escapeHtml(t.topic)}</td>
          <td>${escapeHtml(t.trainingType)}</td>
          <td>${progressCellHtml(t.score)}</td>
        </tr>`).join('') || `<tr><td colspan="3" class="muted">Немає даних</td></tr>`}</tbody>
    `;
  }
}

function renderDirectorReportHistoricalLow() {
  const rows = state._drHistoricalLow || [];
  const key = 'dr-historical-low';
  const table = document.getElementById('dr-historical-low-table');
  const pageRows = pageSlice(key, rows);
  table.innerHTML = `
    <thead><tr><th>ПІБ</th><th>Регіон</th><th>Магазин</th><th>Кварталів</th><th>Загальний результат</th><th>АТТ</th><th>Додаткове навчання</th></tr></thead>
    <tbody>${pageRows.map((p, i) => `
      <tr class="row-clickable" data-idx="${i}">
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.region)}</td>
        <td>${escapeHtml(p.store)}</td>
        <td>${fmtNum(p.quarterCount)}</td>
        <td>${progressCellHtml(p.overall)}</td>
        <td>${progressCellHtml(p.att)}</td>
        <td>${progressCellHtml(p.additional)}</td>
      </tr>`).join('') || `<tr><td colspan="7" class="muted">Немає — усі в нормі (≥70% за весь час)</td></tr>`}</tbody>
  `;
  table.querySelectorAll('tbody tr[data-idx]').forEach((tr) => {
    const p = pageRows[Number(tr.dataset.idx)];
    tr.addEventListener('click', () => openDirectorHistoricalTrendModal(p));
  });
  const pager = document.getElementById('dr-historical-low-pagination');
  pager.innerHTML = paginationBarHtml(key, rows.length);
  wirePagination(pager, key, renderDirectorReportHistoricalLow);
}

async function openDirectorHistoricalTrendModal(person) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" id="dr-trend-backdrop">
      <div class="modal" style="max-width:680px;">
        <button class="modal-close" id="dr-trend-close">✕</button>
        <h2>${escapeHtml(person.name)}</h2>
        <p class="modal-subtitle">${escapeHtml(person.store)} · Середній за весь час ${fmtPct(person.overall)} (${fmtNum(person.quarterCount)} квартали)</p>
        <div class="table-scroll"><table class="data-table" id="dr-trend-table">
          <tbody><tr><td class="muted">Завантаження…</td></tr></tbody>
        </table></div>
      </div>
    </div>
  `;
  document.getElementById('dr-trend-close').onclick = closeModal;
  document.getElementById('dr-trend-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'dr-trend-backdrop') closeModal();
  });
  const data = await api(`/api/director-report-historical-trend?${qs({ name: person.name })}`);
  const quarters = data.quarters || [];
  const table = document.getElementById('dr-trend-table');
  if (table) {
    table.innerHTML = `
      <thead><tr><th>Квартал</th><th>Загальний результат</th><th>АТТ</th><th>Додаткове навчання</th></tr></thead>
      <tbody>${quarters.map((q) => `
        <tr>
          <td>Q${q.quarter} ${q.year}</td>
          <td>${progressCellHtml(q.overall)}</td>
          <td>${progressCellHtml(q.att)}</td>
          <td>${progressCellHtml(q.additional)}</td>
        </tr>`).join('') || `<tr><td colspan="4" class="muted">Немає даних</td></tr>`}</tbody>
    `;
  }
}

function renderDirectorReportKpis(summary) {
  const tiles = [
    { label: 'Результат АТТ', value: fmtPct(summary.att), accent: 'green' },
    { label: 'Результат додаткового навчання', value: fmtPct(summary.additional), accent: 'green' },
    { label: 'Загальний результат', value: fmtPct(summary.overall), accent: '' },
  ];
  document.getElementById('dr-kpi-grid').innerHTML = tiles.map((tl) => `
    <div class="kpi-tile ${tl.accent ? `accent-${tl.accent}` : ''}">
      <div class="kpi-value">${tl.value}</div>
      <div class="kpi-label">${escapeHtml(tl.label)}</div>
    </div>`).join('');
}

function renderDirectorReportTopics(topics) {
  const table = document.getElementById('dr-topics-table');
  table.innerHTML = `
    <thead><tr><th>Тема</th><th>Тип</th><th>Середній бал</th></tr></thead>
    <tbody>${topics.map((t) => `
      <tr>
        <td>${escapeHtml(t.topic)}</td>
        <td>${escapeHtml(t.trainingType)}</td>
        <td>${progressCellHtml(t.avg)}</td>
      </tr>`).join('') || `<tr><td colspan="3" class="muted">Немає даних</td></tr>`}</tbody>
  `;
}

function renderDirectorReportTopTable() {
  const rows = state._drTop || [];
  const key = 'dr-top';
  const table = document.getElementById('dr-top-table');
  const pageRows = pageSlice(key, rows);
  table.innerHTML = `
    <thead><tr><th>ПІБ</th><th>Регіон</th><th>Магазин</th><th>АТТ</th><th>Додаткове навчання</th><th>Середнє</th></tr></thead>
    <tbody>${pageRows.map((p) => `
      <tr>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.region)}</td>
        <td>${escapeHtml(p.store)}</td>
        <td>${progressCellHtml(p.att)}</td>
        <td>${progressCellHtml(p.additional)}</td>
        <td>${progressCellHtml(p.rankScore)}</td>
      </tr>`).join('') || `<tr><td colspan="6" class="muted">Немає даних</td></tr>`}</tbody>
  `;
  const pager = document.getElementById('dr-top-pagination');
  pager.innerHTML = paginationBarHtml(key, rows.length);
  wirePagination(pager, key, renderDirectorReportTopTable);
}

// Fully client-side snapshot: clone the currently-filtered report, inline
// the stylesheet, and trigger a download — so it can be opened/forwarded
// without access to the site at all (the original ask behind this whole
// feature). No server round trip, no extra route.
// Unlike the old "photograph the current screen" approach, this bakes ALL
// of the quarter's raw rows into the file and ships a small self-contained
// script that redoes the same aggregation the backend does — so region/
// store filtering (and the full antitop lists, not just the visible
// pagination page) keep working offline, with zero server round trips,
// once the file has left the browser.
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
    const blob = await fetch(path).then((r) => r.blob());
    return await blobToDataUrl(blob);
  } catch {
    return '';
  }
}

// Inlines the site's actual font files and logo as base64 data URLs so the
// downloaded file renders with the real COMFY branding (Comfy Semi-Bold /
// PT Root UI) instead of falling back to a system font — the relative
// "../fonts/..." paths in the site's own stylesheet only resolve from
// /static/css/, not from wherever this file ends up once downloaded.
async function downloadDirectorReportHtml() {
  const { year, quarter } = state.directorReport;
  const btn = document.getElementById('dr-download-html');
  if (btn) { btn.disabled = true; btn.textContent = 'Готую файл…'; }
  try {
    const [rawData, allData, css, logoDataUrl, comfySemiBold, ptRegular, ptMedium, ptBold] = await Promise.all([
      api(`/api/director-report-raw?${qs({ year, quarter })}`),
      api(`/api/director-report-raw-all`),
      fetch('/static/css/style.css').then((r) => r.text()).catch(() => ''),
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
    // Drop the site's own @font-face rules (relative paths that won't
    // resolve) and replace them with the inlined data-URL versions above.
    const inlinedCss = fontCss + css.replace(/@font-face\s*\{[^}]*\}/g, '');
    const periodLabel = `Q${quarter} ${year}`;
    const title = `Звіт для РК — ${periodLabel}`;
    // Guard against a topic/name containing a literal "</script>" breaking
    // out of the embedded data block.
    const rowsJson = JSON.stringify(rawData.rows || []).replace(/<\/script/gi, '<\\/script');
    const allRowsJson = JSON.stringify(allData.rows || []).replace(/<\/script/gi, '<\\/script');
    const html = buildDirectorReportExportHtml({ title, periodLabel, css: inlinedCss, logoDataUrl, rowsJson, allRowsJson });
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Звіт для РК - ${periodLabel}.html`.replace(/[\\/:*?"<>|]/g, '_');
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

function buildDirectorReportExportHtml({ title, periodLabel, css, logoDataUrl, rowsJson, allRowsJson }) {
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${css}
body { background: var(--color-bg); padding: 24px; }
</style>
</head><body>
<div id="x-modal-root"></div>
<div class="top-bar" style="margin-bottom:20px;">
  <div class="brand">
    ${logoDataUrl ? `<img class="logo" src="${logoDataUrl}" alt="COMFY">` : ''}
    <div>
      <div class="brand-title">Звіт для РК</div>
      <div class="brand-subtitle">${escapeHtml(periodLabel)} · Знято ${new Date().toLocaleDateString('uk-UA')}</div>
    </div>
  </div>
</div>
<div class="filters" id="x-filters">
  <div class="filter-field">
    <label>Регіон</label>
    <select id="x-region"><option value="">Усі регіони</option></select>
  </div>
  <div class="filter-field">
    <label>Магазин</label>
    <select id="x-store"><option value="">Усі магазини</option></select>
  </div>
</div>
<div class="kpi-grid" id="x-kpi"></div>
<div class="card" id="x-regions-card">
  <h3>По регіонах</h3>
  <p class="field-hint">Завжди всі регіони, незалежно від фільтра вище.</p>
  <div class="table-scroll"><table class="data-table" id="x-regions"></table></div>
</div>
<div class="card" id="x-employees-card" hidden>
  <h3>По співробітниках</h3>
  <p class="field-hint">Натисни на рядок для деталізації по темах.</p>
  <div class="table-scroll"><table class="data-table" id="x-employees"></table></div>
</div>
<div class="card">
  <h3>Результат по темам</h3>
  <div class="table-scroll"><table class="data-table" id="x-topics"></table></div>
</div>
<div class="card">
  <h3>Низькі результати — історично</h3>
  <p class="field-hint">Середній результат нижче 70% за всі квартали (мінімум 2 квартали в базі) — ті, на кого варто звернути увагу першочергово. Натисни на рядок для динаміки по кварталах.</p>
  <div class="table-scroll"><table class="data-table" id="x-historical-low"></table></div>
</div>
<div class="card">
  <h3>ТОП <span class="muted">(за середньоарифметичним АТТ і Додаткового навчання)</span></h3>
  <div class="table-scroll"><table class="data-table" id="x-top"></table></div>
</div>
<script>
'use strict';
const ROWS = ${rowsJson};
const ALL_ROWS = ${allRowsJson};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtPct(v) { return v === null || v === undefined || Number.isNaN(v) ? '—' : (Math.round(v * 10) / 10) + '%'; }
function bucket(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'red';
  if (v >= 90) return 'good'; if (v >= 70) return 'yellow'; if (v >= 40) return 'orange'; return 'red';
}
function progressCell(v) {
  const pct = Math.max(0, Math.min(100, v || 0));
  return '<div class="progress-cell"><div class="progress-bar-track"><div class="progress-bar-fill fill-' + bucket(v) + '" style="width:' + pct + '%"></div></div><div class="value">' + fmtPct(v) + '</div></div>';
}
function avg(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null; }

function stats(rows) {
  const att = rows.filter((r) => r.trainingType === 'АТТ').map((r) => r.score);
  const additional = rows.filter((r) => r.trainingType === 'Додаткове навчання').map((r) => r.score);
  const all = rows.map((r) => r.score);
  return { att: avg(att), additional: avg(additional), overall: avg(all) };
}
function employeesOf(rows) {
  const groups = {};
  rows.filter((r) => r.name).forEach((r) => {
    const key = r.name + '|' + r.store;
    (groups[key] = groups[key] || { name: r.name, store: r.store, rows: [] }).rows.push(r);
  });
  return Object.values(groups)
    .map((g) => ({ name: g.name, store: g.store, ...stats(g.rows) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
}
function topicsOf(rows) {
  const groups = {};
  rows.forEach((r) => {
    const key = r.topic + '|' + r.trainingType;
    (groups[key] = groups[key] || { topic: r.topic, trainingType: r.trainingType, scores: [] }).scores.push(r.score);
  });
  return Object.values(groups)
    .map((g) => ({ topic: g.topic, trainingType: g.trainingType, avg: avg(g.scores) }))
    .sort((a, b) => a.trainingType.localeCompare(b.trainingType) || a.topic.localeCompare(b.topic, 'uk'));
}
function topOf(rows) {
  const groups = {};
  rows.filter((r) => r.name).forEach((r) => {
    const key = r.name + '|' + r.region + '|' + r.store;
    const g = groups[key] = groups[key] || {
      name: r.name, region: r.region, store: r.store,
      attSum: 0, attCount: 0, addSum: 0, addCount: 0,
    };
    if (r.trainingType === 'АТТ') { g.attSum += r.score; g.attCount += 1; }
    else if (r.trainingType === 'Додаткове навчання') { g.addSum += r.score; g.addCount += 1; }
  });
  return Object.values(groups)
    .map((g) => {
      const att = g.attCount ? g.attSum / g.attCount : null;
      const additional = g.addCount ? g.addSum / g.addCount : null;
      const values = [att, additional].filter((v) => v !== null);
      return values.length ? { name: g.name, region: g.region, store: g.store, att, additional, rankScore: values.reduce((s, v) => s + v, 0) / values.length } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, 100);
}
function byRegionOf(rows) {
  const regions = [...new Set(rows.map((r) => r.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
  return regions.map((region) => ({ region, ...stats(rows.filter((r) => r.region === region)) }));
}

function historicalLowOf(region, store) {
  const scoped = ALL_ROWS.filter((r) => r.name && (!region || r.region === region) && (!store || r.store === store));
  const groups = {};
  scoped.forEach((r) => {
    const g = groups[r.name] = groups[r.name] || {
      name: r.name, region: r.region, store: r.store, latestKey: -1, quarters: new Set(),
      attSum: 0, attCount: 0, addSum: 0, addCount: 0, allSum: 0, allCount: 0,
    };
    const qkey = r.year * 10 + r.quarter;
    g.quarters.add(qkey);
    if (qkey > g.latestKey) { g.latestKey = qkey; g.region = r.region; g.store = r.store; }
    g.allSum += r.score; g.allCount += 1;
    if (r.trainingType === 'АТТ') { g.attSum += r.score; g.attCount += 1; }
    else if (r.trainingType === 'Додаткове навчання') { g.addSum += r.score; g.addCount += 1; }
  });
  return Object.values(groups)
    .filter((g) => g.quarters.size >= 2)
    .map((g) => ({
      name: g.name, region: g.region, store: g.store, quarterCount: g.quarters.size,
      att: g.attCount ? g.attSum / g.attCount : null,
      additional: g.addCount ? g.addSum / g.addCount : null,
      overall: g.allCount ? g.allSum / g.allCount : null,
    }))
    .filter((p) => p.overall !== null && p.overall < 70)
    .sort((a, b) => a.overall - b.overall || b.quarterCount - a.quarterCount)
    .slice(0, 100);
}
function historicalTrendOf(name) {
  const groups = {};
  ALL_ROWS.filter((r) => r.name === name).forEach((r) => {
    const key = r.year + '-' + r.quarter;
    const g = groups[key] = groups[key] || { year: r.year, quarter: r.quarter, attSum: 0, attCount: 0, addSum: 0, addCount: 0, allSum: 0, allCount: 0 };
    g.allSum += r.score; g.allCount += 1;
    if (r.trainingType === 'АТТ') { g.attSum += r.score; g.attCount += 1; }
    else if (r.trainingType === 'Додаткове навчання') { g.addSum += r.score; g.addCount += 1; }
  });
  return Object.values(groups)
    .map((g) => ({
      year: g.year, quarter: g.quarter,
      att: g.attCount ? g.attSum / g.attCount : null,
      additional: g.addCount ? g.addSum / g.addCount : null,
      overall: g.allCount ? g.allSum / g.allCount : null,
    }))
    .sort((a, b) => a.year - b.year || a.quarter - b.quarter);
}

function filteredRows() {
  const region = document.getElementById('x-region').value;
  const store = document.getElementById('x-store').value;
  return ROWS.filter((r) => (!region || r.region === region) && (!store || r.store === store));
}

function renderKpi(s) {
  const tiles = [
    ['Результат АТТ', fmtPct(s.att), 'accent-green'],
    ['Результат додаткового навчання', fmtPct(s.additional), 'accent-green'],
    ['Загальний результат', fmtPct(s.overall), ''],
  ];
  document.getElementById('x-kpi').innerHTML = tiles.map((t) =>
    '<div class="kpi-tile ' + t[2] + '"><div class="kpi-value">' + t[1] + '</div><div class="kpi-label">' + esc(t[0]) + '</div></div>'
  ).join('');
}
function renderRegions(regions) {
  document.getElementById('x-regions').innerHTML =
    '<thead><tr><th>Регіон</th><th>Загальний результат</th><th>АТТ</th><th>Додаткове навчання</th></tr></thead><tbody>' +
    (regions.map((r) => '<tr><td>' + esc(r.region) + '</td><td>' + progressCell(r.overall) + '</td><td>' + progressCell(r.att) + '</td><td>' + progressCell(r.additional) + '</td></tr>').join('')
      || '<tr><td colspan="4" class="muted">Немає даних</td></tr>') + '</tbody>';
}
function renderEmployees(employees) {
  const el = document.getElementById('x-employees');
  el.innerHTML =
    '<thead><tr><th>ПІБ</th><th>Магазин</th><th>Загальний результат</th><th>АТТ</th><th>Додаткове навчання</th></tr></thead><tbody>' +
    (employees.map((e, i) => '<tr class="row-clickable" data-idx="' + i + '"><td>' + esc(e.name) + '</td><td>' + esc(e.store) + '</td><td>' + progressCell(e.overall) + '</td><td>' + progressCell(e.att) + '</td><td>' + progressCell(e.additional) + '</td></tr>').join('')
      || '<tr><td colspan="5" class="muted">Немає даних</td></tr>') + '</tbody>';
  el.querySelectorAll('tbody tr[data-idx]').forEach((tr) => {
    const e = employees[Number(tr.dataset.idx)];
    tr.addEventListener('click', () => openEmployeeModal(e));
  });
}
function closeEmployeeModal() {
  document.getElementById('x-modal-root').innerHTML = '';
}
function openEmployeeModal(employee) {
  const topics = ROWS.filter((r) => r.name === employee.name && r.store === employee.store)
    .map((r) => ({ topic: r.topic, trainingType: r.trainingType, score: r.score }))
    .sort((a, b) => a.trainingType.localeCompare(b.trainingType) || a.topic.localeCompare(b.topic, 'uk'));
  document.getElementById('x-modal-root').innerHTML =
    '<div class="modal-backdrop" id="x-employee-backdrop">' +
      '<div class="modal" style="max-width:680px;">' +
        '<button class="modal-close" id="x-employee-close">✕</button>' +
        '<h2>' + esc(employee.name) + '</h2>' +
        '<p class="modal-subtitle">' + esc(employee.store) + ' · Загальний результат ' + fmtPct(employee.overall) + '</p>' +
        '<div class="table-scroll"><table class="data-table"><thead><tr><th>Тема</th><th>Тип</th><th>Бал</th></tr></thead><tbody>' +
        (topics.map((t) => '<tr><td>' + esc(t.topic) + '</td><td>' + esc(t.trainingType) + '</td><td>' + progressCell(t.score) + '</td></tr>').join('')
          || '<tr><td colspan="3" class="muted">Немає даних</td></tr>') +
        '</tbody></table></div>' +
      '</div>' +
    '</div>';
  document.getElementById('x-employee-close').onclick = closeEmployeeModal;
  document.getElementById('x-employee-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'x-employee-backdrop') closeEmployeeModal();
  });
}
function renderTopics(topics) {
  document.getElementById('x-topics').innerHTML =
    '<thead><tr><th>Тема</th><th>Тип</th><th>Середній бал</th></tr></thead><tbody>' +
    (topics.map((t) => '<tr><td>' + esc(t.topic) + '</td><td>' + esc(t.trainingType) + '</td><td>' + progressCell(t.avg) + '</td></tr>').join('')
      || '<tr><td colspan="3" class="muted">Немає даних</td></tr>') + '</tbody>';
}
function renderTop(people) {
  document.getElementById('x-top').innerHTML =
    '<thead><tr><th>ПІБ</th><th>Регіон</th><th>Магазин</th><th>АТТ</th><th>Додаткове навчання</th><th>Середнє</th></tr></thead><tbody>' +
    (people.map((p) => '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.region) + '</td><td>' + esc(p.store) + '</td><td>' + progressCell(p.att) + '</td><td>' + progressCell(p.additional) + '</td><td>' + progressCell(p.rankScore) + '</td></tr>').join('')
      || '<tr><td colspan="6" class="muted">Немає даних</td></tr>') + '</tbody>';
}
function renderHistoricalLow(people) {
  const el = document.getElementById('x-historical-low');
  el.innerHTML =
    '<thead><tr><th>ПІБ</th><th>Регіон</th><th>Магазин</th><th>Кварталів</th><th>Загальний результат</th><th>АТТ</th><th>Додаткове навчання</th></tr></thead><tbody>' +
    (people.map((p, i) => '<tr class="row-clickable" data-idx="' + i + '"><td>' + esc(p.name) + '</td><td>' + esc(p.region) + '</td><td>' + esc(p.store) + '</td><td>' + p.quarterCount + '</td><td>' + progressCell(p.overall) + '</td><td>' + progressCell(p.att) + '</td><td>' + progressCell(p.additional) + '</td></tr>').join('')
      || '<tr><td colspan="7" class="muted">Немає — усі в нормі (≥70% за весь час)</td></tr>') + '</tbody>';
  el.querySelectorAll('tbody tr[data-idx]').forEach((tr) => {
    const p = people[Number(tr.dataset.idx)];
    tr.addEventListener('click', () => openHistoricalTrendModal(p));
  });
}
function openHistoricalTrendModal(person) {
  const quarters = historicalTrendOf(person.name);
  document.getElementById('x-modal-root').innerHTML =
    '<div class="modal-backdrop" id="x-trend-backdrop">' +
      '<div class="modal" style="max-width:680px;">' +
        '<button class="modal-close" id="x-trend-close">✕</button>' +
        '<h2>' + esc(person.name) + '</h2>' +
        '<p class="modal-subtitle">' + esc(person.store) + ' · Середній за весь час ' + fmtPct(person.overall) + ' (' + person.quarterCount + ' квартали)</p>' +
        '<div class="table-scroll"><table class="data-table"><thead><tr><th>Квартал</th><th>Загальний результат</th><th>АТТ</th><th>Додаткове навчання</th></tr></thead><tbody>' +
        (quarters.map((q) => '<tr><td>Q' + q.quarter + ' ' + q.year + '</td><td>' + progressCell(q.overall) + '</td><td>' + progressCell(q.att) + '</td><td>' + progressCell(q.additional) + '</td></tr>').join('')
          || '<tr><td colspan="4" class="muted">Немає даних</td></tr>') +
        '</tbody></table></div>' +
      '</div>' +
    '</div>';
  document.getElementById('x-trend-close').onclick = closeEmployeeModal;
  document.getElementById('x-trend-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'x-trend-backdrop') closeEmployeeModal();
  });
}

function render() {
  const rows = filteredRows();
  const region = document.getElementById('x-region').value;
  const store = document.getElementById('x-store').value;
  renderKpi(stats(rows));
  document.getElementById('x-regions-card').hidden = !!region;
  document.getElementById('x-employees-card').hidden = !region;
  if (region) {
    renderEmployees(employeesOf(rows));
  } else {
    renderRegions(byRegionOf(ROWS));
  }
  renderTopics(topicsOf(rows));
  renderHistoricalLow(historicalLowOf(region, store));
  renderTop(topOf(rows));
}

function populateFilters() {
  const regionSelect = document.getElementById('x-region');
  const storeSelect = document.getElementById('x-store');
  const regions = [...new Set(ROWS.map((r) => r.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
  regionSelect.innerHTML = '<option value="">Усі регіони</option>' + regions.map((r) => '<option value="' + esc(r) + '">' + esc(r) + '</option>').join('');
  function refreshStoreOptions() {
    const region = regionSelect.value;
    const stores = [...new Set(ROWS.filter((r) => !region || r.region === region).map((r) => r.store).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
    storeSelect.innerHTML = '<option value="">Усі магазини</option>' + stores.map((s) => '<option value="' + esc(s) + '">' + esc(s) + '</option>').join('');
  }
  refreshStoreOptions();
  regionSelect.addEventListener('change', () => { storeSelect.value = ''; refreshStoreOptions(); render(); });
  storeSelect.addEventListener('change', render);
}

populateFilters();
render();
</script>
</body></html>`;
}

/* ===================== init ===================== */

function bindTopActions() {
  document.getElementById('login-submit').addEventListener('click', doLogin);
  document.getElementById('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('btn-logout').addEventListener('click', doLogout);
  document.getElementById('btn-upload').addEventListener('click', openUploadModal);
  document.getElementById('btn-classify').addEventListener('click', openClassifyModal);
  document.getElementById('btn-director-report').addEventListener('click', openDirectorReportView);
}

bindTabs();
bindTopActions();
checkSession();
