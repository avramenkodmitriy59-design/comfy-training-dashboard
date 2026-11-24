/* «Кадровий резерв» (Leader Hub) — built on the prototype by the training
   team (tabs Кадровий резерв / Leader Hub 1.0 / Leader Hub 2.0, its charts
   and metrics), fed by /api/reserve (reserve.lh_dataset: participants file
   + BI «Історія працівника») and extended with stream / participant editing
   and the «покриття плинності кадровим резервом» metric.
   Mounted by renderReserveView() in app.js: LeaderHub.mount(el, data, hooks). */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k === 'tip') n._tip = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};
const svgEl = (tag, attrs = {}) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) if (k === 'tip') n._tip = v; else n.setAttribute(k, v); return n; };
const fmtPct = (v) => v == null || isNaN(v) ? '—' : (Math.round(v * 1000) / 10).toFixed(1).replace('.', ',') + '%';
const fmtDate = (s) => s ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : '';
const ratio = (a, b) => b ? a / b : null;
const cmpUk = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'uk', { numeric: true });
const uniqSorted = (arr) => [...new Set(arr.filter((v) => v != null && v !== ''))].sort(cmpUk);

let D, PEOPLE, ROOT, HOOKS;
const TABS = ['reserve', 'lh1', 'lh2', 'pot'];
const state = { tab: 'reserve', year: '', reg: '', store: '', pos: '', prog: '', status: '', q: '', rstat: '', rq: '', rview: '', stView: 'now', workOnly: true, resTo: 'Заступник', apTo: 'Заступник' };
let END = {}, START = {}; // stream dates: programme + year -> ISO date
const PROG = { LH1: 'LH 1.0', LH2: 'LH 2.0', TZ: 'Товарознавець' };

// ---------- vocab: statuses, colours, descriptions
const C = { green: 'var(--color-green)', yellow: 'var(--color-yellow)', orange: 'var(--color-orange)', red: 'var(--color-red)', graph: 'var(--color-graphite-dark)', grey: '#b9bcc3', mid: '#8a8d95', blue: '#3b5bdb', violet: '#9c36b5', mob: '#6f8fb3' };
const PSTAT = {
  'Сертифікований': { c: '#12b886', cls: 'st-cert', d: 'Лише LH 2.0: пройшов сертифікацію; перед кадровим резервом може бути ще співбесіда на посаду Директора. Входить у «Завершили успішно», але не в доступний кадровий резерв.' },
  'Кадровий резерв': { c: C.green, cls: 'st-kr', d: 'Успішно сертифікований, готовий до призначення на цільову посаду. У LH 2.0 — усі сертифіковані до результатів співбесід.' },
  'ІПР': { c: C.yellow, cls: 'st-ipr', d: 'Завершив навчання, перед призначенням потрібен індивідуальний план розвитку. Входить у кадровий резерв.' },
  'Призначення': { c: C.blue, cls: 'st-app', d: 'Отримав цільову посаду під час навчання або одразу після (LH 1.0 — Заступник, LH 2.0 — Директор).' },
  'Не сертифікований': { c: C.grey, cls: 'st-nc', d: 'Пройшов навчання, але не пройшов сертифікацію.' },
  'Не пройшов навчання': { c: C.red, cls: 'st-fail', d: 'Відрахований під час навчання: бали за тести чи ДЗ, дедлайни, рішення регіону.' },
  'Відмова': { c: C.mid, cls: 'st-ref', d: 'Сам відмовився продовжувати навчання або сертифікацію.' },
  'Мобілізація': { c: C.mob, cls: 'st-mob', d: 'Вибув із програми через мобілізацію.' },
  'Звільнення': { c: '#111', cls: 'st-dis', d: 'Звільнився під час програми.' },
  'Навчається': { c: '#4a7dfc', cls: 'st-app', d: 'Потік ще триває — фінального статусу поки немає.' },
};
const PSTAT_ORDER = Object.keys(PSTAT);
// participant's status NOW: the history (dismissed / on the target post / demoted) over the programme status
const ASTAT = {
  'Навчається': PSTAT['Навчається'], 'Сертифікований': PSTAT['Сертифікований'], 'Кадровий резерв': PSTAT['Кадровий резерв'], 'ІПР': PSTAT['ІПР'],
  'Призначення': { c: C.blue, cls: 'st-app', d: 'Зараз працює на цільовій посаді (LH 1.0 — Заступник або вище, LH 2.0 — Директор).' },
  'Пониження': { c: '#9b2c2c', cls: 'st-fail', d: 'Був призначений на цільову посаду, а зараз працює нижче.' },
  'Не сертифікований': PSTAT['Не сертифікований'], 'Не пройшов навчання': PSTAT['Не пройшов навчання'], 'Відмова': PSTAT['Відмова'], 'Мобілізація': PSTAT['Мобілізація'],
  'Звільнення': { c: '#111', cls: 'st-dis', d: 'Зараз не працює в компанії (за «Історією працівника»).' },
};
function actualStatus(x) {
  const p = person(x.pid);
  if (p.work === false) return x.status === 'Мобілізація' ? 'Мобілізація' : 'Звільнення';
  if (p.work && (p.cur_rank || 0) >= tgtRank(x.prog)) return 'Призначення';
  if (p.work && p.demoted && (x.appointed || x.status === 'Призначення')) return 'Пониження';
  return x.status;
}
// current outcome of a graduate (Кадровий резерв tab)
const OSTAT = {
  'Кадровий резерв': { c: C.green, cls: 'st-kr', d: 'Випускник (статус у програмі «Кадровий резерв», «ІПР» або «Призначення»), працює і ще не на цільовій посаді — або відмічено вручну.' },
  'Сертифікований': { c: '#12b886', cls: 'st-cert', d: 'LH 2.0: пройшов сертифікацію, попереду може бути співбесіда на посаду Директора. У доступний резерв не входить, доки статус у програмі не зміниться на «Кадровий резерв».' },
  'Потенційний': { c: C.yellow, cls: 'st-ipr', d: 'Відмічено вручну: кого можна залучити в програму. У доступний резерв і покриття вакансій не входить.' },
  'Навчається': { c: '#4a7dfc', cls: 'st-app', d: 'Потік ще триває.' },
  'Призначення Товарознавець': { c: C.blue, cls: 'st-app', d: 'Потенційний на Товарознавця вже працює Товарознавцем або вище.' },
  'Призначення Заступник': { c: C.blue, cls: 'st-app', d: 'Зараз працює на посаді Заступника з ТП або з ІТ-сервісів.' },
  'Призначення Директор': { c: C.violet, cls: 'st-dir', d: 'Зараз працює на посаді Директора.' },
  'Пониження': { c: C.red, cls: 'st-fail', d: 'Отримав посаду Заступника/Директора, а зараз працює на нижчій посаді. До резерву не входить.' },
  'Не в резерві': { c: C.grey, cls: 'st-nc', d: 'Не завершив програму успішно (не пройшов, не сертифікований, відмова, мобілізація) — або відмічено вручну.' },
  'Звільнення': { c: '#111', cls: 'st-dis', d: 'За «Історією працівника» зараз не працює в компанії.' },
  'Інша програма': { c: C.mid, cls: 'st-ref', d: 'Людина пізніше брала участь в іншій програмі / потоці — статус рахується за останньою.' },
  'Немає в історії': { c: C.grey, cls: 'st-nc', d: 'Учасника не знайдено в «Історії працівника» (немає таб. номера, а ПІБ не збігся однозначно).' },
};
const OSTAT_ORDER = Object.keys(OSTAT);
const MET = {
  cert: ['Успішність сертифікації (Certification Success Rate)', '(Сертифікований + Кадровий резерв + ІПР + Призначення) / Пройшли 1 етап', 'Яка частка тих, хто дійшов до сертифікації, завершила програму успішно.'],
  prog: ['Успішність програми (Program Success Rate)', '(Сертифікований + Кадровий резерв + ІПР + Призначення) / Учасники, що пройшли відбір', 'Яка частка всіх учасників завершила програму успішно.'],
  conv: ['Конверсія в цільову посаду (Talent Pool Conversion)', 'Призначені на цільову посаду / Успішно завершили', 'Цільова посада: LH 1.0 — Заступник або вище, LH 2.0 — Директор. Статус «Призначення» + призначення за «Історією працівника» від дати старту потоку.'],
  ret: ['Утримання випускників (Post-Program Retention)', 'Працюють зараз / Успішно завершили', '«Працює» — за «Історією працівника» з BI (пошук за таб. номером, без нього — за повним збігом ПІБ).'],
  bench: ['Покриття магазинів резервом (Bench Coverage)', 'Магазини, де є ≥1 людина в доступному резерві / Усі магазини довідника «Магазини»', 'Доступний резерв — статус резерву «Кадровий резерв» (випускники з «Кадровий резерв» / «ІПР», які працюють і ще не на цільовій посаді, з урахуванням ручних змін на «Статуси резерву»). Магазин — поточний.'],
  avail: ['Доступний кадровий резерв (Available Talent Pool)', 'Статус резерву «Кадровий резерв»: працюють і ще не на цільовій посаді', 'Випускники зі статусом «Кадровий резерв» або «ІПР» + ручні зміни на «Статуси резерву». Понижені й потенційні не входять.'],
  ihr: ['Внутрішній потенціал (Internal Hire Rate)', '(Внутрішні призначення + Leader Hub) / Усі призначення на посаду', 'Частка посад, закритих власними співробітниками. Leader Hub — випускники програми (LH 1.0 для Заступника, LH 2.0 для Директора), призначені від старту свого потоку.'],
  lhs: ['Частка з кадрового резерву (Internal Successor Rate)', 'Призначення випускників Leader Hub / Усі призначення на посаду', 'Яку частку призначень закрила програма кадрового резерву.'],
  p1: ['Пройшли 1 етап', 'Учасники − «Не пройшов навчання»', 'У потоці 2024 — за колонкою «Статус 1 етап» (без відмов і мобілізації на 1 етапі).'],
  turnover: ['Покриття вакансій кадровим резервом', 'Доступний резерв на посаду / Вакансії, що відкрились на посаді за останні 12 місяців', 'Вакансія відкривається, коли Заступник чи Директор звільняється, отримує пониження (зокрема кінець тимчасового переведення) або підвищення (Заступник → Директор). Ротація на ту саму посаду в інший магазин не рахується. 100% — резервом можна закрити всі вакансії року. Це не плинність у розумінні BI (там лише звільнення).'],
  nograd: ['Призначені без успішного завершення', 'Учасники зі статусом «Не сертифікований», «Не пройшов навчання», «Відмова» тощо, призначені на цільову посаду після старту потоку / Усі такі учасники', 'Не входять у конверсію й «Частку з кадрового резерву» — це призначення повз резерв. Варто розібратися з регіоном, чому так.'],
  speed: ['Швидкість виходу на посаду (Time to Appointment)', 'Медіана днів від старту потоку до першого призначення на цільову посаду — серед призначених протягом 12 місяців від старту', 'Цільова посада: LH 1.0 — Заступник або вище, LH 2.0 — Директор (за «Історією працівника»). Пізніші призначення в медіану не входять — так старі потоки не «пливуть» і їх можна порівнювати з новими.'],
  speed6: ['Призначені протягом 6 місяців (Appointed within 6 months)', 'Випускники, призначені на цільову посаду протягом 6 місяців від старту потоку / Усі випускники', 'Не рахуються ті, хто був на цільовій посаді ще до старту. Для потоку, який стартував менше ніж 6 місяців тому, показник ще не остаточний (позначено *).'],
  donor: ['Донор призначень', 'Внутрішні призначення на посаду вище, згруповані за магазином/регіоном до призначення', 'Для першого призначення Заступником — стартовий магазин, для подальшого призначення Директором — магазин, з якого людина переходить.'],
};
const metTip = (k) => () => { const m = MET[k]; return [el('b', { text: m[0] }), el('div', { class: 'tip-f', text: m[1] }), el('div', { text: m[2] })]; };
const statusTip = (dict, s, extra) => () => [el('b', { text: s }), el('div', { text: dict[s] ? dict[s].d : '' }), extra ? el('div', { class: 'tip-f', text: extra }) : null];
const pill = (dict, s, extra) => el('span', { class: 'pill ' + (dict[s] ? dict[s].cls : 'st-nc'), text: s, tip: statusTip(dict, s, extra) });

// ---------- hover card
const tipBox = () => $('#tip');
let tipTarget = null;
document.addEventListener('mouseover', (e) => {
  let n = e.target; while (n && n !== document && !n._tip) n = n.parentNode;
  if (!n || n === document) { if (tipTarget) { tipBox().hidden = true; tipTarget = null; } return; }
  if (n === tipTarget) return;
  tipTarget = n; const t = tipBox(); const c = n._tip(); t.replaceChildren(...[].concat(c).filter(Boolean)); t.hidden = false;
});
document.addEventListener('mousemove', (e) => {
  if (!tipTarget) return; const t = tipBox();
  const w = t.offsetWidth, h = t.offsetHeight; let x = e.clientX + 14, y = e.clientY + 16;
  if (x + w > innerWidth - 8) x = Math.max(8, e.clientX - w - 14); if (y + h > innerHeight - 8) y = Math.max(8, e.clientY - h - 12);
  t.style.left = x + 'px'; t.style.top = y + 'px';
});
const namesList = (names, max = 18) => { const u = [...new Set(names)]; return el('div', { class: 'tip-names' }, u.slice(0, max).map((n) => el('div', { text: n })), u.length > max ? el('div', { class: 'muted', text: `… ще ${u.length - max}` }) : null); };

// ---------- table: header sort only
// sort state survives re-renders (e.g. after a status change) — keyed by the table's columns
const SORTS = new Map();
function makeTable(container, cols, rows, opts = {}) {
  const sk = cols.map((c) => c.key).join('|');
  const st = container._ts || (container._ts = SORTS.get(sk) || { sort: opts.sort || null, dir: opts.dir || 1 });
  SORTS.set(sk, st);
  container.replaceChildren();
  const head = el('tr');
  cols.forEach((c) => {
    const lab = el('span', { text: c.label, class: c.tip ? 'has-tip' : null, tip: c.tip ? metTip(c.tip) : null });
    const th = el('th', { class: 'sortable' + (st.sort === c.key ? ' sorted' : '') + (c.num ? ' num' : ''), 'aria-sort': st.sort === c.key ? (st.dir > 0 ? 'ascending' : 'descending') : null },
      lab, st.sort === c.key ? el('span', { class: 'arr', text: st.dir > 0 ? ' ▲' : ' ▼' }) : null);
    th.addEventListener('click', () => { if (st.sort === c.key) st.dir = -st.dir; else { st.sort = c.key; st.dir = c.num ? -1 : 1; } makeTable(container, cols, rows, opts); });
    head.append(th);
  });
  let rs = rows;
  if (st.sort) {
    const c = cols.find((x) => x.key === st.sort);
    if (c) rs = rows.slice().sort((a, b) => {
      const va = c.sortv ? c.sortv(a) : c.text(a), vb = c.sortv ? c.sortv(b) : c.text(b);
      const ea = va == null || va === '', eb = vb == null || vb === '';
      if (ea && eb) return 0; if (ea) return 1; if (eb) return -1;
      return (typeof va === 'number' && typeof vb === 'number' ? va - vb : cmpUk(va, vb)) * st.dir;
    });
  }
  const tb = el('tbody');
  rs.forEach((r) => {
    const tr = el('tr', { class: opts.onRow ? 'row-clickable' : null });
    cols.forEach((c) => { const td = el('td', { class: [c.num ? 'num' : '', c.wrap ? 'wrap' : ''].join(' ').trim() || null }); const v = c.cell ? c.cell(r) : c.text(r); td.append(v == null ? '' : v); tr.append(td); });
    if (opts.onRow) tr.addEventListener('click', () => opts.onRow(r));
    tb.append(tr);
  });
  let foot = null;
  if (opts.total && rs.length > 1) { const t = opts.total(rs); foot = el('tfoot', {}, el('tr', {}, cols.map((c) => el('td', { class: c.num ? 'num' : null }, t[c.key] ?? '')))); }
  if (!rs.length) tb.append(el('tr', {}, el('td', { colspan: cols.length, class: 'empty', text: 'Немає даних за вибраними фільтрами' })));
  container.append(el('div', { class: 'table-count', text: `Рядків: ${rs.length}` }),
    el('div', { class: 'table-scroll' + (opts.tall ? ' tall' : '') }, el('table', { class: 'data-table' }, el('thead', {}, head), tb, foot)));
}
const T = (key, label, text, extra = {}) => Object.assign({ key, label, text: (r) => { const v = text(r); return v == null ? '' : String(v); } }, extra);

// ---------- small UI pieces
function tile(value, label, sub, cls, tipKey) {
  return el('div', { class: 'kpi-tile' }, el('div', { class: 'kpi-value ' + (cls || ''), text: value }),
    el('div', { class: 'kpi-label' + (tipKey ? ' has-tip' : ''), text: label, tip: tipKey ? metTip(tipKey) : null }), sub ? el('div', { class: 'kpi-sub', text: sub }) : null);
}
const rateCls = (v) => v == null ? '' : v >= 0.7 ? 'v-good' : v >= 0.5 ? 'v-yellow' : v >= 0.3 ? 'v-orange' : 'v-red';
const cellCls = (v) => v == null ? 'c-none' : v >= 0.7 ? 'c-good' : v >= 0.5 ? 'c-yellow' : v >= 0.3 ? 'c-orange' : 'c-red';
const rateCell = (v) => el('span', { class: 'cell ' + cellCls(v), text: fmtPct(v) });
const seg = (opts, cur, set) => el('div', { class: 'tabs small', role: 'group' }, opts.map(([v, l]) => el('button', { class: 'tab-btn' + (cur === v ? ' active' : ''), 'aria-pressed': String(cur === v), text: l, onclick: () => { set(v); render(); } })));
const legend = (dict, keys) => el('div', { class: 'legend' }, keys.map((k) => el('span', { tip: statusTip(dict, k) }, el('i', { style: `background:${dict[k].c}` }), k)));
const card = (id, title, hint, ...kids) => el('div', { class: 'card', id }, el('h3', {}, ...[].concat(title)), hint ? el('p', { class: 'field-hint', text: hint }) : null, ...kids);

// horizontal stacked bars: rows [{label, segs:{key:[names]} }]
function stackBars(rows, dict, keys, opts = {}) {
  const totals = rows.map((r) => keys.reduce((a, k) => a + (r.segs[k] || []).length, 0));
  const max = opts.max || Math.max(1, ...totals);
  const box = el('div', { class: 'hbars' });
  rows.forEach((r, i) => {
    const tot = totals[i];
    const track = el('div', { class: 'hb-track' });
    keys.forEach((k) => {
      const arr = r.segs[k] || []; if (!arr.length) return;
      const w = arr.length / max * 100;
      track.append(el('div', { class: 'hb-seg', style: `width:${w}%;background:${dict[k].c};color:${['#111', C.graph, C.blue, C.violet, C.red, C.mob, C.mid].includes(dict[k].c) ? '#fff' : '#1f2228'}`,
        tip: () => [el('b', { text: `${r.label} · ${k}: ${arr.length}` }), opts.noNames || !arr.some(Boolean) ? null : namesList(arr.filter(Boolean))] }, w >= 4 ? String(arr.length) : ''));
    });
    box.append(el('div', { class: 'hb-row' + (r.sub ? ' hb-sub' : '') }, el('div', { class: 'hb-label', text: r.label }), track, el('div', { class: 'hb-tot', text: tot ? String(tot) : '—' })));
  });
  if (!rows.length) box.append(el('div', { class: 'empty', text: 'Немає даних за вибраними фільтрами' }));
  return box;
}
function donut(parts, center, sub) {
  const tot = parts.reduce((a, p) => a + p.n, 0), R = 86, r = 54, cx = 90, cy = 90;
  const svg = svgEl('svg', { viewBox: '0 0 180 180', width: '100%', role: 'img', 'aria-label': center });
  let a0 = -Math.PI / 2;
  parts.forEach((p) => {
    if (!p.n) return;
    const a1 = a0 + p.n / tot * Math.PI * 2 - (p.n === tot ? 0.0001 : 0);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const pt = (rad, a) => `${cx + rad * Math.cos(a)} ${cy + rad * Math.sin(a)}`;
    const d = `M ${pt(R, a0)} A ${R} ${R} 0 ${large} 1 ${pt(R, a1)} L ${pt(r, a1)} A ${r} ${r} 0 ${large} 0 ${pt(r, a0)} Z`;
    svg.append(svgEl('path', { d, fill: p.c, stroke: '#fff', 'stroke-width': 2, tip: () => [el('b', { text: `${p.k}: ${p.n} (${fmtPct(p.n / tot)})` }), p.names ? namesList(p.names) : null] }));
    const mid = (a0 + a1) / 2;
    if (p.n / tot >= 0.07) { const t = svgEl('text', { x: cx + (R + r) / 2 * Math.cos(mid), y: cy + (R + r) / 2 * Math.sin(mid) + 4, 'text-anchor': 'middle', class: 'dn-lbl', fill: p.ink || '#fff' }); t.textContent = fmtPct(p.n / tot).replace(',0%', '%'); svg.append(t); }
    a0 = a1;
  });
  const t1 = svgEl('text', { x: cx, y: cy + (sub && sub.includes(' ') ? -2 : 4), 'text-anchor': 'middle', class: 'dn-c' }); t1.textContent = center; svg.append(t1);
  if (sub) sub.split(' ').forEach((w, i) => { const t2 = svgEl('text', { x: cx, y: cy + 17 + i * 11, 'text-anchor': 'middle', class: 'dn-s' }); t2.textContent = w; svg.append(t2); });
  return el('div', { class: 'donut' }, svg);
}

// ---------- domain helpers
const person = (pid) => PEOPLE[pid];
const tgtRank = (prog) => (prog === 'TZ' ? 2 : prog === 'LH1' ? 3 : 4);
// reserve status of a person: computed from the employee history + the
// status in their LAST programme (latest stream; LH 2.0 before LH 1.0 in the
// same year) — can be overridden by hand on «Статуси резерву», except
// dismissal / appointment (history wins)
const RKEY = (pid, prog) => `${pid}|${prog}`;
const HISTORY_WINS = new Set(['Звільнення', 'Призначення Товарознавець', 'Призначення Заступник', 'Призначення Директор']);
const lastFirst = (a, b) => b.year - a.year || (b.prog === 'LH2') - (a.prog === 'LH2');
function autoReserve(pid, prog, last) {
  const p = person(pid);
  if (p.work === null) return 'Немає в історії';
  if (!p.work) return 'Звільнення';
  const rk = p.cur_rank || 0;
  if (rk >= 4) return 'Призначення Директор';
  if (rk >= 3 && rk >= tgtRank(prog)) return 'Призначення Заступник';
  if (rk >= tgtRank(prog)) return 'Призначення Товарознавець';
  if (p.demoted) return 'Пониження';
  if (last && last.status === 'Сертифікований') return 'Сертифікований'; // LH 2.0: interview still ahead
  if (last && last.grad) return 'Кадровий резерв';
  if (last && last.status === 'Навчається') return 'Навчається';
  return 'Не в резерві';
}
let RES = null; // pid -> entry
function resEntries() {
  if (RES) return RES;
  RES = new Map();
  D.parts.forEach((x) => { if (!RES.has(x.pid)) RES.set(x.pid, { pid: x.pid, rows: [] }); RES.get(x.pid).rows.push(x); });
  // marked by hand outside the programmes (latest mark wins)
  Object.entries(D.rstatus || {}).sort((a, b) => a[1].at.localeCompare(b[1].at)).forEach(([k]) => {
    const [pid, prog] = k.split('|');
    if (PEOPLE[pid] && (!RES.has(pid) || !RES.get(pid).rows.length)) RES.set(pid, { pid, rows: [], prog });
  });
  RES.forEach((e) => {
    e.rows.sort(lastFirst);
    e.last = e.rows[0] || null;
    if (e.last) e.prog = e.last.prog;
    e.key = RKEY(e.pid, e.prog);
    e.auto = autoReserve(e.pid, e.prog, e.last);
    e.manual = (D.rstatus || {})[e.key] || null;
    e.locked = HISTORY_WINS.has(e.auto);
    e.final = e.manual && !e.locked ? e.manual.status : e.auto;
  });
  return RES;
}
// status counts only for the person's last programme row (no double counting
// across programmes / streams)
function resStatus(x) {
  const e = resEntries().get(x.pid);
  if (!e) return undefined;
  if (!x.extra && e.last && (x.prog !== e.last.prog || x.year !== e.last.year)) {
    const h = autoReserve(x.pid, x.prog, x); // an earlier programme: only what the history says
    return HISTORY_WINS.has(h) ? h : 'Інша програма';
  }
  return e.final;
}
function outcome(x) { return resStatus(x); }
function availKind(x) { // 'КР' | null — available reserve toward the programme target
  return person(x.pid).work && resStatus(x) === 'Кадровий резерв' ? 'КР' : null;
}
const grads = () => D.parts.filter((x) => x.grad);
const curReg = (x) => { const p = person(x.pid); return p.work ? p.cur_reg : x.reg; };
const curStore = (x) => { const p = person(x.pid); return p.work ? p.cur_store : x.store; };
const qOk = (name) => !state.q || name.toLowerCase().includes(state.q.toLowerCase());

function personTip(x) {
  return () => {
    const p = person(x.pid); const all = D.parts.filter((y) => y.pid === x.pid);
    return [el('b', { text: p.name }),
      el('div', { class: 'muted', text: p.work === null ? 'Немає в «Історії працівника»' : p.work ? `${p.cur_pos} · ${p.cur_store}` : 'Не працює в компанії' }),
      ...all.map((y) => el('div', { class: 'tip-prog' }, el('span', { text: `${PROG[y.prog]} · ${y.year}: ${y.status}` }),
        el('div', { class: 'tip-f', text: `Тест: ${y.test != null ? fmtPct(y.test / 100) : '—'} · ДЗ: ${y.dz || '—'}` }))),
      el('div', { class: 'muted', text: `Старт: ${x.pos_in || '—'}, ${x.store || '—'}` }),
      el('div', { class: 'muted', text: 'Натисніть, щоб відкрити історію' })];
  };
}
const nameCell = (x) => el('span', { class: 'link', text: person(x.pid).name, tip: personTip(x) });

// ---------- person card
function openPerson(pid) {
  const p = PEOPLE[pid]; if (!p) return;
  const parts = D.parts.filter((x) => x.pid === pid).sort((a, b) => a.year - b.year);
  const ev = [];
  if (p.hire) ev.push({ d: p.hire, icon: '🟢', t: 'Дата прийому (остання, за «Історією працівника»)' });
  (p.ev || []).forEach((e) => {
    if (e.mv === 'up') ev.push({ d: e.d, icon: '⬆️', t: `${e.frm} → ${e.to}`, s: [e.store_fr, e.store_to].filter(Boolean).join(' → ') });
    else if (e.mv === 'down') ev.push({ d: e.d, icon: '⬇️', t: `Пониження: ${e.frm} → ${e.to}`, s: [e.store_fr, e.store_to].filter(Boolean).join(' → ') });
    else if (e.mv === 'ext') ev.push({ d: e.d, icon: '🔁', t: `Прийом на посаду ${e.to}`, s: e.store_to || '' });
  });
  parts.forEach((x) => ev.push({ d: END[x.prog + x.year] || `${x.year}-12-31`, icon: '🎓', prog: true, t: `${x.prog === 'LH1' ? 'Leader Hub 1.0' : 'Leader Hub 2.0'} · потік ${x.year}: ${x.status}`,
    s: `Тест: ${x.test != null ? fmtPct(x.test / 100) : '—'} · ДЗ: ${x.dz || '—'} · старт: ${x.pos_in || '—'}, ${x.store || '—'}` }));
  if (p.work && p.demoted) ev.push({ d: '9999', icon: '⬇️', t: `Зараз: ${p.cur_pos} — нижче за отриману раніше посаду`, s: '' });
  ev.sort((a, b) => a.d.localeCompare(b.d));
  const root = $('#modal-root');
  const close = () => { root.replaceChildren(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': p.name },
    el('button', { class: 'modal-close', 'aria-label': 'Закрити', text: '✕', onclick: close }),
    el('h2', { text: '👤 ' + p.name }),
    el('p', { class: 'modal-subtitle', text: `Таб. ${p.tab || '—'} · ` + (p.work === null ? 'немає в «Історії працівника»' : p.work ? `${p.cur_pos}, ${p.cur_store} (${p.cur_reg || '—'})` : 'Не працює в компанії') + (p.matchedBy === 'name' ? ' · знайдено за ПІБ' : p.matchedBy === 'name~' ? ' · знайдено за схожим ПІБ' : '') }),
    el('div', { class: 'chips' }, p.work === null ? el('span', { class: 'pill st-nc', text: '❔ Немає в історії' }) : p.work ? el('span', { class: 'pill st-kr', text: '✅ Працює' }) : el('span', { class: 'pill st-dis', text: '❌ Не працює' })),
    el('h3', { class: 'mt', text: '🗂 Історія' }),
    el('ol', { class: 'timeline' }, ev.map((e) => el('li', {}, el('span', { class: 'tl-ico', text: e.icon }),
      el('div', {}, el('div', { class: 'tl-date', text: e.prog ? 'Програма розвитку · завершення ' + fmtDate(e.d) : e.d === '9999' ? 'Зараз' : fmtDate(e.d) }), el('div', { class: 'tl-text', text: e.t }), e.s ? el('div', { class: 'tl-sub', text: e.s }) : null)))),
    el('p', { class: 'footnote', text: 'Події — з «Історії працівника» (BI): призначення на посаду вище та пониження.' }));
  root.replaceChildren(el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === e.currentTarget) close(); } }, modal));
  modal.querySelector('.modal-close').focus();
}

// ================= TAB: Кадровий резерв =================
function reserveBase() { // graduate rows with derived fields, filtered by everything except status/work toggle
  const rows = grads().filter((x) => x.prog === 'LH1' || ['Сертифікований', 'Кадровий резерв', 'Призначення'].includes(x.status));
  const have = new Set(rows.map((x) => x.pid));
  // set to «Кадровий резерв» by hand, not a graduate: counts in the reserve, not in conversion / retention
  resEntries().forEach((e) => {
    if (have.has(e.pid) || e.final !== 'Кадровий резерв') return;
    const p = person(e.pid), x = e.last;
    rows.push(Object.assign({ pid: e.pid, prog: e.prog, year: null, reg: p.cur_reg, store: p.cur_store, pos_in: p.cur_pos, status: '—', grad: false, appointed: false }, x || {}, { extra: true }));
  });
  return rows.map((x) => Object.assign({}, x, { o: outcome(x), av: availKind(x), fReg: curReg(x), fStore: curStore(x) }))
    .filter((x) => (!state.year || String(x.year) === state.year) && (!state.prog || x.prog === state.prog) && (!state.reg || x.fReg === state.reg) && (!state.store || x.fStore === state.store) && (!state.pos || x.pos_in === state.pos) && qOk(person(x.pid).name));
}
function renderReserve(root) {
  const base = reserveBase();
  const avail = (prog) => base.filter((x) => x.prog === prog && x.av);
  const a1 = avail('LH1'), a2 = avail('LH2');
  const potential = (prog) => [...resEntries().values()].filter((e) => e.prog === prog && e.final === 'Потенційний' && person(e.pid).work && (!state.reg || person(e.pid).cur_reg === state.reg)).length;
  const gb = base.filter((x) => !x.extra);
  const hit = gb.filter((x) => x.appointed), work = gb.filter((x) => person(x.pid).work);
  root.append(el('div', { class: 'kpi-grid k6' },
    ...[['Заступник', a1, '🟢'], ['Директор', a2, '🟣']].map(([grp, a, ico]) => clickTile(
      tile(String(a.length), `${ico} Доступний резерв на ${grp === 'Заступник' ? 'Заступника' : 'Директора'}`, `Потенційних: ${potential(grp === 'Заступник' ? 'LH1' : 'LH2')} · натисніть для переліку`, null, 'avail'),
      () => openAvailable(grp, a))),
    ...forecastRows(base).map((r) => clickTile(tile(r.need != null ? String(Math.round(r.need)) : '—', `📈 Потреба в ${r.grp === 'Заступник' ? 'заступниках' : 'директорах'} на рік`, `ціль ${fmtPct(r.share)} призначень з резерву · натисніть для розрахунку`), () => openForecast(base, r.grp))),
    clickTile(tile(fmtPct(ratio(hit.length, gb.length)), '🚀 Конверсія в цільову посаду', `${hit.length} з ${gb.length} випускників · натисніть для переліку`, rateCls(ratio(hit.length, gb.length)), 'conv'), () => openAppointed(hit)),
    clickTile(tile(fmtPct(ratio(work.length, gb.length)), '🤝 Утримання випускників', `${work.length} з ${gb.length} працюють зараз · натисніть, щоб побачити звільнених`, rateCls(ratio(work.length, gb.length)), 'ret'), () => openDismissed(gb.filter((x) => !person(x.pid).work)))));

  // available reserve by region + internal appointments
  root.append(renderTurnover(base));
  const grid = el('div', { class: 'grid-2' });
  const aRows = (state.resTo === 'Заступник' ? a1 : a2);
  const byReg = !state.reg;
  const keys = uniqSorted(aRows.map((x) => byReg ? x.fReg : x.fStore));
  const AV = { 'Кадровий резерв': { c: C.green } };
  const avChart = stackBars(keys.map((k) => { const g = aRows.filter((x) => (byReg ? x.fReg : x.fStore) === k); return { label: k, segs: { 'Кадровий резерв': g.map((x) => person(x.pid).name) } }; })
    .sort((a, b) => b.segs['Кадровий резерв'].length - a.segs['Кадровий резерв'].length), AV, Object.keys(AV));
  grid.append(card('available', ['🧩 ', el('span', { class: 'has-tip', text: 'Доступний кадровий резерв', tip: metTip('avail') })],
    `Хто працює зараз і готовий до посади ${state.resTo === 'Заступник' ? 'Заступника (LH 1.0)' : 'Директора (LH 2.0)'}. ${byReg ? 'По регіонах' : 'По магазинах регіону'}, за поточним місцем роботи. Наведіть на смугу, щоб побачити ПІБ.`,
    el('div', { class: 'seg-row' }, seg([['Заступник', 'Заступник'], ['Директор', 'Директор']], state.resTo, (v) => state.resTo = v)),
    el('div', { class: 'legend' }, Object.keys(AV).map((k) => el('span', {}, el('i', { style: `background:${AV[k].c}` }), k))), avChart));
  grid.append(renderInternal());
  root.append(grid);
  root.append(renderInternalRegions());

  root.append(renderBench(base));
  root.append(...renderDonors());
  root.append(renderStatusTable(statusEntries()));
}

// coverage table rows (region / store level): reserve vs vacancies per post
function coverageRow(k, lv, people) {
  const o = (grp) => lv.filter((l) => l.grp === grp).length;
  const a = (prog) => people.filter((x) => x.prog === prog && x.av).length;
  return { k, od: o('Заступник'), ad: a('LH1'), or: o('Директор'), ar: a('LH2') };
}
function coverageCols(label) {
  const covCell = (a, o) => (r) => rateCell(ratio(r[a], r[o]));
  return [
    T('k', label, (r) => r.k || '—'),
    T('ad', 'Резерв на заст.', (r) => r.ad, { num: true, sortv: (r) => r.ad }),
    T('od', 'Вакансій заст.', (r) => r.od, { num: true, sortv: (r) => r.od }),
    T('cd', 'Покриття (заст.)', (r) => fmtPct(ratio(r.ad, r.od)), { num: true, sortv: (r) => ratio(r.ad, r.od), cell: covCell('ad', 'od'), tip: 'turnover' }),
    T('ar', 'Резерв на дир.', (r) => r.ar, { num: true, sortv: (r) => r.ar }),
    T('or', 'Вакансій дир.', (r) => r.or, { num: true, sortv: (r) => r.or }),
    T('cr', 'Покриття (дир.)', (r) => fmtPct(ratio(r.ar, r.or)), { num: true, sortv: (r) => ratio(r.ar, r.or), cell: covCell('ar', 'or'), tip: 'turnover' }),
  ];
}
// region -> its stores; store -> the people in the available reserve there
function openRegionStores(reg, lv, people) {
  const stores = uniqSorted(D.stores.filter(([r]) => r === reg).map(([, st]) => st).concat(lv.map((l) => l.s), people.filter((x) => x.av).map((x) => x.fStore)));
  const box = el('div');
  makeTable(box, coverageCols('Магазин'), stores.map((st) => coverageRow(st, lv.filter((l) => l.s === st), people.filter((x) => x.fStore === st))),
    { sort: 'cd', dir: 1, tall: true, onRow: (row) => openStoreReserve(reg, row.k, people.filter((x) => x.av && x.fStore === row.k), lv.filter((l) => l.s === row.k)) });
  openModal(`📉 ${reg}: покриття вакансій по магазинах`, 'Вакансії за останні 12 місяців — за магазином, де відкрилась вакансія; резерв — за поточним магазином. Натисніть на магазин, щоб побачити людей у резерві.', box);
}
function openStoreReserve(reg, store, people, lv) {
  const AVL = { 'КР': 'Кадровий резерв' };
  const box = el('div');
  makeTable(box, [
    T('name', 'ПІБ', (r) => person(r.pid).name, { cell: (r) => el('span', { class: 'link', text: person(r.pid).name, tip: personTip(r) }) }),
    T('to', 'Резерв на', (r) => (r.prog === 'LH1' ? 'Заступника' : 'Директора')),
    T('av', 'Тип', (r) => AVL[r.av], { cell: (r) => pill(OSTAT, AVL[r.av]), sortv: (r) => (r.av === 'КР' ? 0 : 1) }),
    T('prog', 'Програма · потік', (r) => `${PROG[r.prog]} · ${r.year}`),
    T('pos', 'Посада зараз', (r) => person(r.pid).cur_pos || '—'),
  ], people, { onRow: (r) => openPerson(r.pid), sort: 'av', dir: 1 });
  const vac = ['Заступник', 'Директор'].map((g) => `${g}: ${lv.filter((l) => l.grp === g).length}`).join(' · ');
  openModal(`🏪 ${store} · резерв ${people.length}`, `${reg}. Вакансій за 12 міс — ${vac}. Натисніть на рядок, щоб відкрити історію.`, box);
}

// «Прогноз потреби в резерві»: yearly vacancies = average of the last two
// years; the reserve should close RESERVE_TARGET of them (agreed target);
// participants needed = graduates to appoint / the programme's participant ->
// target-post yield. Headcount is assumed flat.
const RESERVE_TARGET = 0.5;
const clickTile = (t, onClick) => { t.style.cursor = 'pointer'; t.addEventListener('click', onClick); return t; };

function openModal(title, subtitle, ...kids) {
  const root = $('#modal-root');
  const close = () => { root.replaceChildren(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  const modal = el('div', { class: 'modal lh-root', role: 'dialog', 'aria-modal': 'true', style: 'max-width:980px' },
    el('button', { class: 'modal-close', 'aria-label': 'Закрити', text: '✕', onclick: close }),
    el('h2', { text: title }), subtitle ? el('p', { class: 'modal-subtitle', text: subtitle }) : null, ...kids);
  root.replaceChildren(el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === e.currentTarget) close(); } }, modal));
}

// list behind the «Доступний резерв» tiles; a name opens the person card
function openAvailable(grp, rows) {
  const box = el('div');
  const AVL = { 'КР': 'Кадровий резерв' };
  makeTable(box, [
    T('name', 'ПІБ', (r) => person(r.pid).name, { cell: (r) => el('span', { class: 'link', text: person(r.pid).name, tip: personTip(r) }) }),
    T('av', 'Резерв', (r) => AVL[r.av], { cell: (r) => pill(OSTAT, AVL[r.av]), sortv: (r) => (r.av === 'КР' ? 0 : 1) }),
    T('prog', 'Програма · потік', (r) => `${PROG[r.prog]} · ${r.year}`),
    T('pos', 'Посада зараз', (r) => person(r.pid).cur_pos || '—'),
    T('store', 'Магазин', (r) => r.fStore || ''),
    T('reg', 'Регіон', (r) => r.fReg || ''),
  ], rows, { onRow: (r) => openPerson(r.pid), sort: 'av', dir: 1, tall: true });
  openModal(`🧩 Доступний резерв на ${grp === 'Заступник' ? 'Заступника' : 'Директора'} · ${rows.length}`,
    `Випускники ${grp === 'Заступник' ? 'LH 1.0' : 'LH 2.0'}, які працюють і ще не на посаді ${grp === 'Заступник' ? 'Заступника' : 'Директора'}${state.reg ? ` · регіон ${state.reg}` : ''}. Натисніть на рядок, щоб відкрити історію.`, box);
}

// «Швидкість виходу на посаду»: days from the stream start to the first
// appointment to the target post; bucket — when, relative to the stream end
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const SPEED = {
  'Під час навчання': { c: C.green }, 'До 3 міс після': { c: '#12b886' }, '3–6 міс': { c: C.yellow }, '6–12 міс': { c: C.orange }, 'Понад 12 міс': { c: C.red },
  'Ще не призначені': { c: C.grey }, 'Звільнились без призначення': { c: '#111' }, 'На посаді ще до старту': { c: C.mid }, 'Без дати в історії': { c: C.mob },
};
function speedRows(grads) {
  return grads.map((x) => {
    const st = START[x.prog + x.year] || `${x.year}-01-01`, end = END[x.prog + x.year] || `${x.year}-12-31`;
    const e = targetAppointment(x), p = person(x.pid);
    let bucket;
    if (e) { const d = daysBetween(end, e.d); bucket = d <= 0 ? 'Під час навчання' : d <= 91 ? 'До 3 міс після' : d <= 183 ? '3–6 міс' : d <= 365 ? '6–12 міс' : 'Понад 12 міс'; }
    else if (p.work && (p.cur_rank || 0) >= tgtRank(x.prog)) bucket = 'На посаді ще до старту';
    else if (p.work === false) bucket = 'Звільнились без призначення';
    else if (x.status === 'Призначення') bucket = 'Без дати в історії';
    else bucket = 'Ще не призначені';
    return Object.assign({}, x, { st, end, ap: e, days: e ? daysBetween(st, e.d) : null, bucket });
  });
}
const SPEED_WINDOW = 365, SPEED_SHARE = 183; // days from the stream start
const speedMedian = (rows) => median(rows.filter((r) => r.days != null && r.days <= SPEED_WINDOW).map((r) => r.days));
// share of graduates appointed within 6 months; open = some stream is younger than 6 months
function speedShare(rows) {
  const base = rows.filter((r) => r.bucket !== 'На посаді ще до старту');
  const n = base.filter((r) => r.days != null && r.days <= SPEED_SHARE).length;
  const open = base.some((r) => daysBetween(r.st, D.today) < SPEED_SHARE);
  return { v: base.length ? n / base.length : null, n, of: base.length, open };
}
const fmtShare = (sh) => (sh.v == null ? '—' : fmtPct(sh.v) + (sh.open ? '*' : ''));
function openSpeed(rows, title) {
  const keys = Object.keys(SPEED).filter((k) => rows.some((r) => r.bucket === k));
  const years = uniqSorted(rows.map((r) => `${PROG[r.prog]} · ${r.year}`));
  const bars = stackBars(years.map((y) => { const g = rows.filter((r) => `${PROG[r.prog]} · ${r.year}` === y); const segs = {}; keys.forEach((k) => segs[k] = g.filter((r) => r.bucket === k).map((r) => person(r.pid).name)); const md = speedMedian(g); return { label: `${y}${md != null ? ` · медіана ${md} дн.` : ''}`, segs }; }), SPEED, keys);
  const box = el('div');
  makeTable(box, [
    T('name', 'ПІБ', (r) => person(r.pid).name, { cell: (r) => el('span', { class: 'link', text: person(r.pid).name, tip: personTip(r) }) }),
    T('prog', 'Потік', (r) => `${PROG[r.prog]} · ${r.year}`),
    T('st', 'Старт потоку', (r) => fmtDate(r.st), { sortv: (r) => r.st }),
    T('ap', 'Призначення', (r) => (r.ap ? `${fmtDate(r.ap.d)} · ${r.ap.to}` : ''), { sortv: (r) => (r.ap ? r.ap.d : '') }),
    T('days', 'Днів від старту', (r) => r.days, { num: true, sortv: (r) => r.days }),
    T('bucket', 'Коли', (r) => r.bucket, { cell: (r) => el('span', { class: 'pill', style: `background:${SPEED[r.bucket].c};color:${[C.green, '#12b886', C.yellow, C.grey].includes(SPEED[r.bucket].c) ? '#1f2228' : '#fff'}`, text: r.bucket }), sortv: (r) => Object.keys(SPEED).indexOf(r.bucket) }),
    T('now', 'Зараз', (r) => { const p = person(r.pid); return p.work === null ? 'немає в історії' : p.work ? `${p.cur_pos} · ${p.cur_store}` : 'не працює'; }),
  ], rows, { onRow: (r) => openPerson(r.pid), sort: 'days', dir: 1, tall: true });
  const md = speedMedian(rows), n = rows.filter((r) => r.days != null && r.days <= SPEED_WINDOW).length, sh = speedShare(rows);
  openModal(`⏱ ${title} · медіана ${md != null ? md + ' дн.' : '—'} · за 6 міс ${fmtShare(sh)}`,
    `Медіана — по ${n} призначених протягом 12 міс від старту. Призначені протягом 6 міс: ${sh.n} з ${sh.of} випускників${sh.open ? ' (* потік ще не досяг 6 міс)' : ''}. «Коли» — відносно дати завершення потоку. Натисніть на рядок, щоб відкрити історію.`,
    el('div', { class: 'legend' }, keys.map((k) => el('span', {}, el('i', { style: `background:${SPEED[k].c}` }), k))), bars, box);
}

// first promotion to the programme's target post after the stream started
function targetAppointment(x) {
  const ev = (person(x.pid).ev || []).filter((e) => (e.mv === 'up' || e.mv === 'ext') && e.rank_to >= tgtRank(x.prog) && e.d >= (START[x.prog + x.year] || `${x.year}-01-01`));
  return ev[0] || null;
}
function openAppointed(rows) {
  const box = el('div');
  makeTable(box, [
    T('name', 'ПІБ', (r) => person(r.pid).name, { cell: (r) => el('span', { class: 'link', text: person(r.pid).name, tip: personTip(r) }) }),
    T('prog', 'Програма · потік', (r) => `${PROG[r.prog]} · ${r.year}`),
    T('d', 'Дата', (r) => { const e = targetAppointment(r); return e ? fmtDate(e.d) : ''; }, { sortv: (r) => (targetAppointment(r) || {}).d || '' }),
    T('from', 'Звідки', (r) => { const e = targetAppointment(r); return e ? [e.frm || 'прийом ззовні', e.store_fr].filter(Boolean).join(' · ') : `${r.pos_in || '—'} · ${r.store || '—'} (старт)`; }),
    T('to', 'Куди', (r) => { const e = targetAppointment(r); return e ? [e.to, e.store_to].filter(Boolean).join(' · ') : 'статус «Призначення» у програмі'; }),
    T('now', 'Зараз', (r) => { const p = person(r.pid); return p.work === null ? 'немає в історії' : p.work ? `${p.cur_pos} · ${p.cur_store}` : 'не працює'; }),
  ], rows, { onRow: (r) => openPerson(r.pid), sort: 'd', dir: -1, tall: true });
  openModal(`🚀 Призначені на цільову посаду · ${rows.length}`,
    `Випускники, які отримали цільову посаду (LH 1.0 — Заступник або вище, LH 2.0 — Директор) від старту свого потоку${state.reg ? ` · регіон ${state.reg}` : ''}. «Звідки / Куди» — перше таке призначення за «Історією працівника».`, box);
}
function openNoGrad(rows, target) {
  const box = el('div');
  makeTable(box, [
    T('name', 'ПІБ', (r) => person(r.pid).name, { cell: (r) => el('span', { class: 'link', text: person(r.pid).name, tip: personTip(r) }) }),
    T('prog', 'Потік', (r) => `${PROG[r.prog]} · ${r.year}`),
    T('status', 'Статус у програмі', (r) => r.status, { cell: (r) => pill(PSTAT, r.status), sortv: (r) => PSTAT_ORDER.indexOf(r.status) }),
    T('d', 'Призначення', (r) => fmtDate(targetAppointment(r).d), { sortv: (r) => targetAppointment(r).d }),
    T('to', 'Куди', (r) => { const e = targetAppointment(r); return [e.to, e.store_to].filter(Boolean).join(' · '); }),
    T('reg', 'Регіон', (r) => curReg(r) || ''),
    T('now', 'Зараз', (r) => { const p = person(r.pid); return p.work === null ? 'немає в історії' : p.work ? `${p.cur_pos} · ${p.cur_store}` : 'не працює'; }),
  ], rows, { onRow: (r) => openPerson(r.pid), sort: 'd', dir: -1, tall: true });
  openModal(`🔀 Призначені на посаду ${target} без успішного завершення · ${rows.length}`,
    'Учасники, які не завершили програму успішно, але отримали цільову посаду після старту потоку (за «Історією працівника»). У конверсію не входять. Натисніть на рядок, щоб відкрити історію.', box);
}
function openDismissed(rows) {
  const box = el('div');
  makeTable(box, [
    T('name', 'ПІБ', (r) => person(r.pid).name, { cell: (r) => el('span', { class: 'link', text: person(r.pid).name, tip: personTip(r) }) }),
    T('prog', 'Програма · потік', (r) => `${PROG[r.prog]} · ${r.year}`),
    T('status', 'Статус у програмі', (r) => r.status, { cell: (r) => pill(PSTAT, r.status) }),
    T('pos', 'Остання посада', (r) => person(r.pid).last_pos || '—'),
    T('store', 'Магазин', (r) => person(r.pid).last_store || ''),
    T('d', 'Звільнення', (r) => { const p = person(r.pid); return p.work === null ? 'немає в історії' : fmtDate(p.dismissed); }, { sortv: (r) => person(r.pid).dismissed || '' }),
  ], rows, { onRow: (r) => openPerson(r.pid), sort: 'd', dir: -1, tall: true });
  openModal(`🤝 Звільнені резервісти · ${rows.length}`,
    `Випускники Leader Hub, які зараз не працюють у компанії${state.reg ? ` · регіон ${state.reg}` : ''}. Натисніть на рядок, щоб відкрити історію.`, box);
}

function forecastRows(base) {
  const from = new Date(D.today); from.setFullYear(from.getFullYear() - 2);
  const since = from.toISOString().slice(0, 10);
  const inReg = (x) => (!state.reg || x.r === state.reg) && (!state.store || x.s === state.store);
  const rows = ['Заступник', 'Директор'].map((grp) => {
    const prog = grp === 'Заступник' ? 'LH1' : 'LH2';
    const vac = D.leaves.filter((l) => l.grp === grp && ['Звільнення', 'Пониження', 'Підвищення'].includes(l.kind) && l.d >= since && inReg(l)).length / 2;
    const ap = D.aps.filter((a) => a.grp === grp && a.d >= since && inReg(a));
    const lh = ap.filter((a) => a.cat === 'LH').length;
    const factShare = ratio(lh, ap.length);
    const share = RESERVE_TARGET;
    const done = D.parts.filter((x) => x.prog === prog && x.status !== 'Навчається');
    const yieldRate = ratio(done.filter((x) => x.grad && x.appointed).length, done.length);
    const need = share != null ? vac * share : null;
    const reserve = base.filter((x) => x.prog === prog && x.av).length;
    const lastYear = Math.max(0, ...D.parts.filter((x) => x.prog === prog).map((x) => x.year));
    const lastStream = D.parts.filter((x) => x.prog === prog && x.year === lastYear).length;
    return { grp, prog, vac, ap: ap.length, lh, factShare, share, yieldRate, need, reserve, lastYear, lastStream,
      months: need ? reserve / (need / 12) : null, participants: need != null && yieldRate ? need / yieldRate : null };
  });
  return rows;
}

function openForecast(base, grp) {
  const rows = forecastRows(base).filter((r) => r.grp === grp);
  const box = el('div', { class: 'kpi-grid inner', style: 'grid-template-columns:minmax(0,1fr)' }, rows.map((r) => {
    const line = (label, value, sub) => el('div', { style: 'display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px solid var(--color-border)' },
      el('span', { text: label }), el('span', { style: 'text-align:right' }, el('b', { text: value }), sub ? el('div', { class: 'kpi-sub', style: 'margin-top:0', text: sub }) : null));
    const nf = (v) => v == null ? '—' : String(Math.round(v * 10) / 10).replace('.', ',');
    return el('div', { class: 'kpi-tile' },
      el('div', { class: 'kpi-label', style: 'margin:0 0 8px;font-size:15px', text: `${r.grp} · ${PROG[r.prog]}` }),
      line('Вакансій на рік', nf(r.vac), 'середнє за 2 роки'),
      line('Закривав резерв (факт)', fmtPct(r.factShare), `${r.lh} з ${r.ap} призначень за 2 роки`),
      line('Ціль: закриває резерв', fmtPct(r.share), 'призначень на посаду'),
      line('Потреба з резерву на рік', nf(r.need), 'призначень випускників'),
      line('Доступний резерв зараз', String(r.reserve), r.months != null ? `вистачить ≈ на ${nf(r.months)} міс` : null),
      line('Віддача програми', fmtPct(r.yieldRate), 'учасник → цільова посада'),
      line('Треба учасників на рік', r.participants != null ? String(Math.ceil(r.participants)) : '—', `останній потік ${r.lastYear || '—'}: ${r.lastStream}`));
  }));
  const root = $('#modal-root');
  const close = () => { root.replaceChildren(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  const modal = el('div', { class: 'modal lh-root', role: 'dialog', 'aria-modal': 'true', style: 'max-width:560px' },
    el('button', { class: 'modal-close', 'aria-label': 'Закрити', text: '✕', onclick: close }),
    el('h2', { text: `📈 Потреба в ${grp === 'Заступник' ? 'заступниках' : 'директорах'} на рік` }),
    el('p', { class: 'modal-subtitle', text: `Вакансії — середнє за 2 роки (звільнення, пониження, підвищення), чисельність незмінна. «Закривав резерв» — фактична частка призначень на посаду, що дісталась випускникам Leader Hub; ціль — 50%. Віддача — частина учасників завершених потоків, яка отримала цільову посаду.${state.reg ? ' Вакансії й призначення — по обраному регіону, віддача — по всій мережі.' : ''}` }), box);
  root.replaceChildren(el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === e.currentTarget) close(); } }, modal));
}


// «Покриття вакансій кадровим резервом»: available reserve toward a position
// vs. vacancies that opened on it over the last 12 months.
function renderTurnover(base) {
  const from = new Date(D.today); from.setFullYear(from.getFullYear() - 1);
  const since = from.toISOString().slice(0, 10);
  // a vacancy opens on dismissal, demotion or promotion from the post
  const KINDS = { 'Звільнення': { c: '#111' }, 'Пониження': { c: C.red }, 'Підвищення': { c: C.blue } };
  const lv = D.leaves.filter((l) => KINDS[l.kind] && l.d >= since && l.d <= D.today && (!state.reg || l.r === state.reg) && (!state.store || l.s === state.store));
  const one = (grp) => {
    const prog = grp === 'Заступник' ? 'LH1' : 'LH2';
    const res = base.filter((x) => x.prog === prog && x.av);
    const out = lv.filter((l) => l.grp === grp);
    const cov = ratio(res.length, out.length);
    const months = out.length ? res.length / (out.length / 12) : null;
    return el('div', { class: 'kpi-tile' },
      el('div', { class: 'kpi-value ' + rateCls(cov), text: out.length ? fmtPct(cov) : '—' }),
      el('div', { class: 'kpi-label has-tip', text: `Покриття вакансій · ${grp}`, tip: metTip('turnover') }),
      el('div', { class: 'kpi-sub', text: `резерв ${res.length} · вакансій за 12 міс ${out.length}` + (months != null ? ` · ≈ ${Math.round(months * 10) / 10} міс вакансій` : '') }),
      el('div', { class: 'legend', style: 'margin-top:8px' }, Object.keys(KINDS).map((k) => { const n = out.filter((l) => l.kind === k); return n.length ? el('span', { tip: () => [el('b', { text: `${grp} · ${k}: ${n.length}` }), namesList(n.map((l) => l.n))] }, el('i', { style: `background:${KINDS[k].c}` }), `${k} ${n.length}`) : null; })));
  };
  const regs = uniqSorted(lv.map((l) => l.r).concat(base.filter((x) => x.av).map((x) => x.fReg)));
  const box = el('div');
  makeTable(box, coverageCols('Регіон'), regs.map((r) => coverageRow(r, lv.filter((l) => l.r === r), base.filter((x) => x.fReg === r))),
    { sort: 'cd', dir: 1, onRow: (row) => openRegionStores(row.k, lv.filter((l) => l.r === row.k), base.filter((x) => x.fReg === row.k)) });
  return card('turnover', ['📉 ', el('span', { class: 'has-tip', text: 'Покриття вакансій кадровим резервом', tip: metTip('turnover') }), ` · ${fmtDate(since)} – ${fmtDate(D.today)}`],
    'Скільки людей у доступному резерві на кожну вакансію Заступника чи Директора, що відкрилась за останні 12 місяців: звільнення, пониження або підвищення (за регіоном магазину, де відкрилась вакансія). Наведіть на причину, щоб побачити ПІБ.',
    el('div', { class: 'kpi-grid inner k2' }, one('Заступник'), one('Директор')),
    el('details', { class: 'lh-regions' }, el('summary', { text: 'По регіонах' }), box));
}

const apsYears = () => [...new Set(D.aps.map((a) => a.y))].sort();
function apsFiltered(grp, ignoreYear) {
  return D.aps.filter((a) => a.grp === grp && (ignoreYear || !state.year || String(a.y) === state.year) && (!state.reg || a.r === state.reg) && (!state.store || a.s === state.store));
}
const APC = { 'Внутрішнє призначення': { c: C.green }, 'Зовнішнє призначення': { c: C.orange }, 'Leader Hub': { c: C.grey } };
function renderInternal() {
  const grp = state.apTo, prog = grp === 'Заступник' ? 'LH 1.0' : 'LH 2.0';
  const years = state.year ? [Number(state.year)] : apsYears();
  const wrap = el('div', { class: 'donuts' });
  years.forEach((y) => {
    const a = apsFiltered(grp, true).filter((x) => x.y === y);
    const n = { LH: a.filter((x) => x.cat === 'LH'), VP: a.filter((x) => x.cat === 'ВП').length, ZP: a.filter((x) => x.cat === 'ЗП').length };
    const ihr = ratio(n.LH.length + n.VP, a.length);
    wrap.append(el('div', { class: 'donut-col' }, el('div', { class: 'yr-chip', text: String(y) + (y === Number(D.today.slice(0, 4)) ? '*' : '') }),
      a.length ? donut([{ k: 'Внутрішнє призначення', n: n.VP, c: C.green }, { k: 'Зовнішнє призначення', n: n.ZP, c: C.orange }, { k: `Leader Hub (${prog})`, n: n.LH.length, c: C.grey, ink: '#1f2228', names: n.LH.map((x) => x.n) }], fmtPct(ihr), 'внутрішній потенціал') : el('div', { class: 'empty', text: 'Немає призначень' }),
      el('div', { class: 'kpi-sub center', text: `${a.length} призначень · LH ${fmtPct(ratio(n.LH.length, a.length))}` })));
  });
  return card('internal', ['🔄 ', el('span', { class: 'has-tip', text: 'Внутрішні призначення', tip: metTip('ihr') })],
    `Усі призначення на посаду ${grp === 'Заступник' ? 'Заступника (ТП + ІТ)' : 'Директора'}: внутрішні (не навчались у ${prog}), зовнішні та випускники ${prog}. *${D.today.slice(0, 4)} — по ${fmtDate(D.today)}. Регіон і магазин — місце призначення.`,
    el('div', { class: 'seg-row' }, seg([['Заступник', 'Заступник'], ['Директор', 'Директор']], state.apTo, (v) => state.apTo = v)),
    el('div', { class: 'legend' }, Object.keys(APC).map((k) => el('span', { tip: k === 'Leader Hub' ? metTip('lhs') : null }, el('i', { style: `background:${APC[k].c}` }), k === 'Leader Hub' ? `Leader Hub (${prog})` : k))), wrap);
}
function renderInternalRegions() {
  const grp = state.apTo, a = apsFiltered(grp, false);
  const years = state.year ? [Number(state.year)] : apsYears();
  const regs = uniqSorted(a.map((x) => x.r));
  const rows = [];
  regs.forEach((r) => years.forEach((y) => { const g = a.filter((x) => x.r === r && x.y === y); if (!g.length && years.length > 1) { rows.push({ label: `${r} · ${y}`, segs: {} }); return; }
    rows.push({ label: years.length > 1 ? `${r} · ${y}` : r, segs: { 'Внутрішнє призначення': g.filter((x) => x.cat === 'ВП').map(() => ''), 'Зовнішнє призначення': g.filter((x) => x.cat === 'ЗП').map(() => ''), 'Leader Hub': g.filter((x) => x.cat === 'LH').map((x) => x.n) } }); }));
  const ch = stackBars(rows, APC, Object.keys(APC), {});
  const det = el('details', { class: 'card', id: 'internal-regions' }, el('summary', { text: `🗺 Внутрішні призначення на посаду ${grp === 'Заступник' ? 'Заступника' : 'Директора'} по регіонах і роках` }),
    el('p', { class: 'field-hint', text: 'Кількість призначень у регіоні за рік. Наведіть на сіру смугу, щоб побачити випускників Leader Hub.' }),
    el('div', { class: 'legend' }, Object.keys(APC).map((k) => el('span', {}, el('i', { style: `background:${APC[k].c}` }), k))), ch);
  return det;
}

function renderBench(base) {
  const by = new Map(D.stores.filter(([r, s]) => (!state.reg || r === state.reg) && (!state.store || s === state.store)).map(([r, s]) => [s, { reg: r, store: s, Заступник: [], Директор: [] }]));
  base.forEach((x) => { if (!x.av) return; const b = by.get(person(x.pid).cur_store); if (!b) return; b[x.prog === 'LH1' ? 'Заступник' : 'Директор'].push(x); });
  const rows = [...by.values()];
  const covered = rows.filter((b) => b.Заступник.length + b.Директор.length > 0).length;
  const cnt = (k) => (r) => {
    const g = r[k]; if (!g.length) return el('span', { class: 'flag-red', text: '🚩', tip: () => [el('b', { text: `${r.store}: немає резерву на ${k === 'Заступник' ? 'Заступника' : 'Директора'}` })] });
    const kr = g;
    return el('span', { class: 'num-tip', text: String(g.length), tip: () => [el('b', { text: `${r.store} · резерв на ${k === 'Заступник' ? 'Заступника' : 'Директора'}` }),
      kr.length ? el('div', { class: 'tip-f', text: `Кадровий резерв: ${kr.length}` }) : null, kr.length ? namesList(kr.map((x) => person(x.pid).name)) : null,
    ] });
  };
  const box = el('div');
  const c = card('bench', ['🏬 ', el('span', { class: 'has-tip', text: 'Покриття магазинів кадровим резервом', tip: metTip('bench') }), ` · ${covered} з ${rows.length} магазинів (${fmtPct(ratio(covered, rows.length))})`],
    'Кількість людей у доступному кадровому резерві за поточним магазином. Наведіть на число, щоб побачити, хто це; 🚩 — резерву немає.', box);
  makeTable(box, [
    T('reg', 'Регіон', (r) => r.reg),
    T('store', 'Магазин', (r) => r.store),
    T('dep', 'Заступник', (r) => r.Заступник.length, { num: true, sortv: (r) => r.Заступник.length, cell: cnt('Заступник') }),
    T('dir', 'Директор', (r) => r.Директор.length, { num: true, sortv: (r) => r.Директор.length, cell: cnt('Директор') }),
  ], rows, { sort: 'dep', dir: 1, tall: true });
  return c;
}

const donorState = { who: 'grad', to: '' };
function renderDonors() {
  const apps = D.apps.filter((a) => a.rf && (donorState.who === 'all' || a.g) && (!donorState.to || a.to === donorState.to) && (!state.year || String(a.y) === state.year) && (!state.reg || a.rf === state.reg) && (!state.store || a.sf === state.store));
  const agg = (keyF) => {
    const m = new Map();
    apps.forEach((a) => { const k = keyF(a); const o = m.get(k) || { k, reg: a.rf, all: [], same: [], other: [], oreg: [] }; o.all.push(a);
      (a.stt === a.sf ? o.same : a.rt === a.rf ? o.other : o.oreg).push(a); m.set(k, o); });
    return [...m.values()];
  };
  const destTip = (title, arr, byStore) => () => {
    const m = new Map(); arr.forEach((a) => { const k = byStore ? `${a.stt || '—'} (${a.rt || '—'})` : (a.rt || '—'); m.set(k, (m.get(k) || 0) + 1); });
    return [el('b', { text: title }), el('div', { class: 'tip-names' }, [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => el('div', { text: `${k} — ${v}` })))];
  };
  const numCell = (f, title, byStore) => (r) => { const arr = r[f]; return arr.length ? el('span', { class: 'num-tip', text: String(arr.length), tip: destTip(`${r.k} · ${title}`, arr, byStore) }) : el('span', { class: 'muted', text: '0' }); };
  const cols = (first, byStore) => [first,
    T('all', 'Призначень', (r) => r.all.length, { num: true, sortv: (r) => r.all.length, cell: numCell('all', 'куди призначені', byStore), tip: 'donor' }),
    T('same', 'У тому ж магазині', (r) => r.same.length, { num: true, sortv: (r) => r.same.length, cell: numCell('same', 'у тому ж магазині', true) }),
    T('other', 'В інший магазин регіону', (r) => r.other.length, { num: true, sortv: (r) => r.other.length, cell: numCell('other', 'в інші магазини регіону', true) }),
    T('oreg', 'В інший регіон', (r) => r.oreg.length, { num: true, sortv: (r) => r.oreg.length, cell: numCell('oreg', 'в інші регіони', byStore) }),
    T('share', '% в інші регіони', (r) => fmtPct(ratio(r.oreg.length, r.all.length)), { num: true, sortv: (r) => ratio(r.oreg.length, r.all.length) })];
  const b1 = el('div'), b2 = el('div');
  const switches = () => el('div', { class: 'seg-row' }, seg([['grad', '🎓 Випускники програм'], ['all', 'Усі внутрішні']], donorState.who, (v) => donorState.who = v), seg([['', 'Заступник і Директор'], ['Заступник', 'Заступник'], ['Директор', 'Директор']], donorState.to, (v) => donorState.to = v));
  const hint = 'Внутрішні призначення на посаду Заступника або Директора з 2024 року. Наведіть на число, щоб побачити, куди саме призначені люди.';
  const cReg = card('donors-regions', ['🗺 ', el('span', { class: 'has-tip', text: 'Регіони-донори призначень', tip: metTip('donor') }), ` · ${apps.length} призначень`],
    hint + ' «Регіон» — звідки призначено.', switches(), b1);
  const cStore = card('donors-stores', ['🏪 ', el('span', { class: 'has-tip', text: 'Магазини-донори призначень', tip: metTip('donor') }), ` · ${apps.length} призначень`],
    hint + ' «Магазин» — звідки призначено.', switches(), b2);
  makeTable(b1, cols(T('k', 'Регіон-донор', (r) => r.k), false), agg((a) => a.rf), { sort: 'all', dir: -1 });
  const sc = cols(T('k', 'Магазин-донор', (r) => r.k), true); sc.splice(1, 0, T('reg', 'Регіон', (r) => r.reg));
  makeTable(b2, sc, agg((a) => a.sf), { sort: 'all', dir: -1, tall: true });
  return [cReg, cStore];
}

// ================= TABS: programs =================
// status in the programme, editable in place (see /api/lh-participants)
function statusEditCell(r) {
  const s = el('select', { class: 'lh-status st-sel ' + (PSTAT[r.status] ? PSTAT[r.status].cls : 'st-nc'), onclick: (e) => e.stopPropagation(),
    onchange: (e) => HOOKS.setStatus(r, e.target.value) },
  D.statuses.filter((x) => r.prog === 'LH2' || !(D.lh2OnlyStatuses || []).includes(x)).map((x) => { const o = el('option', { value: x, text: x }); if (x === r.status) o.selected = true; return o; }));
  if (!D.statuses.includes(r.status)) s.append(el('option', { value: r.status || '', text: r.status || '—', selected: true }));
  if (!r.statusFile) return s;
  // set automatically: the history shows the target post
  const ap = targetAppointment(r), p = person(r.pid);
  s.title = `Було «${r.statusFile}» — змінено автоматично за «Історією працівника»`;
  return el('span', { class: 'st-auto' }, s, el('span', { class: 'st-auto-mark', text: '🔄', tip: () => [el('b', { text: 'Статус змінено автоматично' }),
    el('div', { text: `У файлі / вручну: «${r.statusFile}»` }),
    el('div', { text: ap ? `За історією: ${ap.to} з ${fmtDate(ap.d)}` : `За історією зараз: ${p.cur_pos}` })] }));
}
function metrics(parts) {
  const n = parts.length, p1 = parts.filter((x) => x.passed1).length, g = parts.filter((x) => x.grad);
  const cnt = {}; PSTAT_ORDER.forEach((s) => cnt[s] = parts.filter((x) => x.status === s).length);
  const app = g.filter((x) => x.appointed).length, work = g.filter((x) => person(x.pid).work).length;
  return { n, p1, g: g.length, cnt, app, work, cert: ratio(g.length, p1), prog: ratio(g.length, n), conv: ratio(app, g.length), ret: ratio(work, g.length) };
}
function renderProgram(root, prog) {
  const isL1 = prog === 'LH1', target = isL1 ? 'Заступника' : 'Директора';
  const all = D.parts.filter((x) => x.prog === prog);
  const base = all.filter((x) => (!state.year || String(x.year) === state.year) && (!state.reg || x.reg === state.reg) && (!state.store || x.store === state.store) && (!state.pos || x.pos_in === state.pos) && qOk(person(x.pid).name));
  const parts = base.filter((x) => !state.status || x.status === state.status);
  const m = metrics(base);
  const stKeys = PSTAT_ORDER.filter((s) => all.some((x) => x.status === s));
  root.append(el('div', { class: 'kpi-grid k3' },
    tile(String(m.n), '👥 Учасників', `пройшли відбір; 1 етап — ${m.p1}`),
    tile(String(m.g), '🎓 Завершили успішно', isL1 ? `КР ${m.cnt['Кадровий резерв']} · ІПР ${m.cnt['ІПР']} · Призн. ${m.cnt['Призначення']}` : `Серт. ${m.cnt['Сертифікований']} · КР ${m.cnt['Кадровий резерв']} · Призн. ${m.cnt['Призначення']}`),
    tile(fmtPct(m.cert), '📜 Успішність сертифікації', `${m.g} з ${m.p1}`, rateCls(m.cert), 'cert'),
    tile(fmtPct(m.prog), '🏁 Успішність програми', `${m.g} з ${m.n}`, rateCls(m.prog), 'prog'),
    tile(fmtPct(m.conv), `🚀 Конверсія в ${target}`, `${m.app} з ${m.g}`, rateCls(m.conv), 'conv'),
    tile(fmtPct(m.ret), '🤝 Утримання випускників', `${m.work} з ${m.g}`, rateCls(m.ret), 'ret'),
    ...(() => { const sr = speedRows(base.filter((x) => x.grad)), md = speedMedian(sr), sh = speedShare(sr), n = sr.filter((r) => r.days != null && r.days <= SPEED_WINDOW).length;
      const open = () => openSpeed(sr, `Швидкість виходу на посаду ${target}`);
      return [clickTile(tile(md != null ? `${md} дн.` : '—', '⏱ Швидкість виходу на посаду', `медіана від старту, ≤ 12 міс · ${n} призначених`, null, 'speed'), open),
        clickTile(tile(fmtShare(sh), '⚡ Призначені за 6 міс', `${sh.n} з ${sh.of} випускників${sh.open ? ' · * потік ще триває' : ''}`, rateCls(sh.v), 'speed6'), open)]; })(),
    (() => { const ng = base.filter((x) => !x.grad && x.status !== 'Навчається'), hit = ng.filter((x) => targetAppointment(x));
      return clickTile(tile(String(hit.length), '🔀 Призначені без успішного завершення', `${hit.length} з ${ng.length} (${fmtPct(ratio(hit.length, ng.length))}) · натисніть для переліку`, null, 'nograd'),
        () => openNoGrad(hit, target)); })()));

  // donut + success by region
  const g1 = el('div', { class: 'grid-2' });
  const dParts = stKeys.map((s) => ({ k: s, n: base.filter((x) => x.status === s).length, c: PSTAT[s].c, ink: [C.yellow, C.grey, C.green].includes(PSTAT[s].c) ? '#1f2228' : '#fff', names: base.filter((x) => x.status === s).map((x) => person(x.pid).name) }));
  g1.append(card(prog + '-summary', '📊 Підсумки ' + (state.year ? `потоку ${state.year}` : 'всіх потоків'), 'Розподіл учасників за фінальним статусом. Наведіть на сектор, щоб побачити ПІБ.',
    el('div', { class: 'donut-wrap' }, donut(dParts, String(m.n), 'учасників'), el('div', { class: 'legend col' }, stKeys.map((s) => el('span', { tip: statusTip(PSTAT, s) }, el('i', { style: `background:${PSTAT[s].c}` }), `${s} — ${m.cnt[s]}`))))));
  const regs = uniqSorted(base.map((x) => x.reg));
  const sr = regs.map((r) => Object.assign({ r }, metrics(base.filter((x) => x.reg === r))));
  const tot = metrics(base);
  const pair = (label, a, b, bold) => el('div', { class: 'pb-row' + (bold ? ' pb-total' : '') }, el('div', { class: 'hb-label', text: label }),
    el('div', { class: 'pb-bars' }, el('div', { class: 'pb-bar', style: `width:${(a || 0) * 100}%;background:var(--color-orange)`, tip: () => [el('b', { text: `${label}: успішність сертифікації ${fmtPct(a)}` })] }, el('span', { text: fmtPct(a) })),
      el('div', { class: 'pb-bar', style: `width:${(b || 0) * 100}%;background:var(--color-graphite-dark)`, tip: () => [el('b', { text: `${label}: успішність програми ${fmtPct(b)}` })] }, el('span', { text: fmtPct(b) }))));
  g1.append(card(prog + '-success', '🏆 Успішність по регіонах', 'Регіон — на момент старту програми.',
    el('div', { class: 'legend' }, el('span', { class: 'has-tip', tip: metTip('cert') }, el('i', { style: 'background:var(--color-orange)' }), 'Успішність сертифікації'), el('span', { class: 'has-tip', tip: metTip('prog') }, el('i', { style: 'background:var(--color-graphite-dark)' }), 'Успішність програми')),
    el('div', { class: 'pbars' }, sr.sort((a, b) => (b.prog || 0) - (a.prog || 0)).map((r) => pair(r.r, r.cert, r.prog)), sr.length > 1 ? pair('Разом', tot.cert, tot.prog, true) : null)));
  root.append(g1);

  // statuses by region
  // switch: programme outcome / status now (from the employee history)
  const now = state.stView !== 'prog';
  const dict = now ? ASTAT : PSTAT, stOf = now ? actualStatus : (x) => x.status;
  const aKeys = Object.keys(dict).filter((k) => parts.some((x) => stOf(x) === k));
  root.append(card(prog + '-regions', '🗺 Статуси учасників по регіонах',
    now ? `Статус зараз, за «Історією працівника» на ${fmtDate(D.today)}: звільнені — «Звільнення», ті, хто на посаді ${target} чи вище — «Призначення», понижені після призначення — «Пониження»; решта — статус у програмі. Регіон — на момент старту. Наведіть на смугу, щоб побачити ПІБ.`
      : 'Скільки учасників кожного регіону з яким фінальним статусом програми. Регіон — на момент старту. Наведіть на смугу, щоб побачити ПІБ.',
    el('div', { class: 'seg-row' }, seg([['now', 'Статус на зараз'], ['prog', 'Статус за підсумками програми']], now ? 'now' : 'prog', (v) => state.stView = v)),
    legend(dict, aKeys), stackBars(regs.map((r) => { const g = parts.filter((x) => x.reg === r); const segs = {}; aKeys.forEach((s) => segs[s] = g.filter((x) => stOf(x) === s).map((x) => person(x.pid).name)); return { label: r, segs }; })
      .sort((a, b) => Object.values(b.segs).flat().length - Object.values(a.segs).flat().length), dict, aKeys)));

  // top stores + graduates outcome
  const g2 = el('div', { class: 'grid-2' });
  const okKeys = isL1 ? ['Кадровий резерв', 'ІПР', 'Призначення'] : ['Сертифікований', 'Кадровий резерв', 'Призначення'];
  const stores = uniqSorted(base.filter((x) => x.grad).map((x) => x.store));
  const sRows = stores.map((s) => { const g = base.filter((x) => x.store === s && x.grad); const segs = {}; okKeys.forEach((k) => segs[k] = g.filter((x) => x.status === k).map((x) => person(x.pid).name)); return { label: s, segs, n: g.length }; })
    .sort((a, b) => b.n - a.n || cmpUk(a.label, b.label)).slice(0, 12);
  g2.append(card(prog + '-stores', '⭐ Топ магазинів за випускниками', 'Магазини на момент старту, де найбільше учасників завершили програму успішно (до 12 магазинів).', legend(PSTAT, okKeys), stackBars(sRows, PSTAT, okKeys)));
  const gr = base.filter((x) => x.grad).map((x) => Object.assign({}, x, { o: outcome(x) }));
  const oKeys = OSTAT_ORDER.filter((k) => gr.some((x) => x.o === k));
  const oRows = uniqSorted(gr.map((x) => x.reg)).map((r) => { const g = gr.filter((x) => x.reg === r); const segs = {}; oKeys.forEach((k) => segs[k] = g.filter((x) => x.o === k).map((x) => person(x.pid).name)); return { label: r, segs, n: g.length }; }).sort((a, b) => b.n - a.n);
  g2.append(card(prog + '-outcome', '🧭 Де випускники зараз', 'Поточний статус тих, хто завершив програму успішно, за регіоном старту.', legend(OSTAT, oKeys), stackBars(oRows, OSTAT, oKeys)));
  root.append(g2);

  // compact region table
  const rbox = el('div');
  root.append(card(prog + '-table', '📋 Показники по регіонах', 'Наведіть на назву показника, щоб побачити формулу.', rbox));
  makeTable(rbox, [
    T('r', 'Регіон', (r) => r.r),
    T('n', 'Учасників', (r) => r.n, { num: true, sortv: (r) => r.n }),
    T('p1', 'Пройшли 1 етап', (r) => r.p1, { num: true, sortv: (r) => r.p1, tip: 'p1' }),
    T('g', 'Завершили успішно', (r) => r.g, { num: true, sortv: (r) => r.g }),
    T('cert', 'Успішність сертифікації', (r) => fmtPct(r.cert), { num: true, sortv: (r) => r.cert, cell: (r) => rateCell(r.cert), tip: 'cert' }),
    T('prog', 'Успішність програми', (r) => fmtPct(r.prog), { num: true, sortv: (r) => r.prog, cell: (r) => rateCell(r.prog), tip: 'prog' }),
    T('conv', 'Конверсія', (r) => fmtPct(r.conv), { num: true, sortv: (r) => r.conv, cell: (r) => rateCell(r.conv), tip: 'conv' }),
    T('ret', 'Утримання', (r) => fmtPct(r.ret), { num: true, sortv: (r) => r.ret, cell: (r) => rateCell(r.ret), tip: 'ret' }),
  ], sr, { sort: 'prog', dir: -1, total: () => ({ r: 'Разом', n: tot.n, p1: tot.p1, g: tot.g, cert: fmtPct(tot.cert), prog: fmtPct(tot.prog), conv: fmtPct(tot.conv), ret: fmtPct(tot.ret) }) });
  if (isL1 && !state.year) {
    const cbox = el('div');
    root.append(card('lh1-cohorts', '📅 Порівняння потоків', null, cbox));
    const cr = [...new Set(base.map((x) => x.year))].sort().map((y) => Object.assign({ y }, metrics(base.filter((x) => x.year === y))));
    makeTable(cbox, [
      T('y', 'Потік', (r) => r.y), T('n', 'Учасників', (r) => r.n, { num: true, sortv: (r) => r.n }), T('g', 'Завершили успішно', (r) => r.g, { num: true, sortv: (r) => r.g }),
      T('cert', 'Успішність сертифікації', (r) => fmtPct(r.cert), { num: true, sortv: (r) => r.cert, cell: (r) => rateCell(r.cert), tip: 'cert' }),
      T('prog', 'Успішність програми', (r) => fmtPct(r.prog), { num: true, sortv: (r) => r.prog, cell: (r) => rateCell(r.prog), tip: 'prog' }),
      T('conv', 'Конверсія', (r) => fmtPct(r.conv), { num: true, sortv: (r) => r.conv, cell: (r) => rateCell(r.conv), tip: 'conv' }),
      T('ret', 'Утримання', (r) => fmtPct(r.ret), { num: true, sortv: (r) => r.ret, cell: (r) => rateCell(r.ret), tip: 'ret' }),
      T('speed', 'Швидкість, дн.', (r) => r.speed, { num: true, sortv: (r) => r.speed, tip: 'speed' }),
      T('sh6', 'Призначені за 6 міс', (r) => fmtShare(r.sh6), { num: true, sortv: (r) => r.sh6.v, cell: (r) => el('span', { class: 'cell ' + cellCls(r.sh6.v), text: fmtShare(r.sh6) }), tip: 'speed6' }),
    ], cr.map((r) => { const sr = speedRows(base.filter((x) => x.year === r.y && x.grad)); return Object.assign(r, { speed: speedMedian(sr), sh6: speedShare(sr) }); }), { sort: 'y', dir: 1 });
  }

  // participants
  const pbox = el('div');
  root.append(card(prog + '-people', '👥 Учасники ' + (isL1 ? 'Leader Hub 1.0' : 'Leader Hub 2.0'), 'Наведіть на ПІБ, щоб побачити, де людина працює зараз; натисніть — щоб відкрити історію. Статус у програмі можна змінити прямо в таблиці. Потоки й учасників — у ⚙️ Налаштуваннях угорі.', pbox));
  makeTable(pbox, [
    T('name', 'ПІБ', (r) => person(r.pid).name, { cell: nameCell }),
    T('year', 'Потік', (r) => r.year),
    T('reg', 'Регіон', (r) => r.reg || ''),
    T('store', 'Магазин', (r) => r.store || ''),
    T('pos', 'Стартова посада', (r) => r.pos_in || ''),
    T('test', 'Тест', (r) => r.test != null ? fmtPct(r.test / 100) : '', { num: true, sortv: (r) => r.test }),
    T('dz', 'ДЗ', (r) => r.dz || '', { num: true, sortv: (r) => r.dzp }),
    T('status', 'Статус', (r) => r.status, { cell: statusEditCell, sortv: (r) => PSTAT_ORDER.indexOf(r.status) }),
    T('del', '', () => '', { cell: (r) => el('button', { class: 'btn btn-secondary btn-sm', text: '✕', title: 'Прибрати з потоку', onclick: (e) => { e.stopPropagation(); HOOKS.removeParticipant(r, person(r.pid).name); } }) }),
  ], parts, { onRow: (r) => openPerson(r.pid), sort: 'status', dir: 1, tall: true });
}

// stores of a region (reference list + wherever potentials work) with their potentials
function storeRows(reg, people) {
  const names = uniqSorted(D.stores.filter(([r]) => r === reg).map(([, st]) => st).concat(people.map((e) => e.store)));
  return names.map((k) => Object.assign({ k }, potBuckets(people.filter((e) => e.store === k))));
}
// potentials split by target post: t — Товарознавець, d — Заступник, r — Директор
const potBuckets = (g) => ({ t: g.filter((e) => e.prog === 'TZ'), d: g.filter((e) => e.prog === 'LH1'), r: g.filter((e) => e.prog === 'LH2'), all: g });
const POT_TO = { t: 'на Товарознавця', d: 'на Заступника', r: 'на Директора', all: 'усього' };
const potTo = (prog) => (prog === 'TZ' ? 'Товарознавця' : prog === 'LH2' ? 'Директора' : 'Заступника');
const progText = (e) => (e.last ? `${PROG[e.prog]} · ${e.last.year}` : `поза програмою · на ${potTo(e.prog)}`);
const potCols = () => [
  T('t', 'На Товарознавця', (r) => r.t.length, { num: true, sortv: (r) => r.t.length, cell: potNum('t') }),
  T('d', 'На Заступника', (r) => r.d.length, { num: true, sortv: (r) => r.d.length, cell: potNum('d') }),
  T('r', 'На Директора', (r) => r.r.length, { num: true, sortv: (r) => r.r.length, cell: potNum('r') }),
  T('all', 'Усього', (r) => r.all.length, { num: true, sortv: (r) => r.all.length, cell: potNum('all') }),
];
const potNum = (key) => (r) => (r[key].length
  ? el('span', { class: 'num-tip', text: String(r[key].length), tip: () => [el('b', { text: `${r.k} · ${POT_TO[key]}: ${r[key].length}` }), namesList(r[key].map((e) => person(e.pid).name))] })
  : el('span', { class: 'muted', text: '—' }));
function openPotentialStores(reg, people) {
  const rows = storeRows(reg, people);
  const box = el('div');
  makeTable(box, [
    T('k', 'Магазин', (r) => r.k, { cell: (r) => el('span', {}, r.d.length ? null : el('span', { class: 'flag-red', text: '🚩 ', title: 'Немає потенційних на Заступника' }), r.k) }),
    ...potCols(),
  ], rows, { sort: 'd', dir: 1, tall: true, onRow: (r) => openPotentialPeople(reg, r.k, r.all, people) });
  const noD = rows.filter((r) => !r.d.length).length;
  openModal(`🌱 ${reg} · потенційні по магазинах`, `Потенційних: ${people.length}. 🚩 — немає потенційного на Заступника: ${noD} з ${rows.length} магазинів. Натисніть на магазин, щоб побачити людей.`, box);
}
function openPotentialPeople(reg, store, rows, regPeople) {
  const box = el('div');
  makeTable(box, [
    T('name', 'ПІБ', (e) => person(e.pid).name, { cell: (e) => el('span', { class: 'link', text: person(e.pid).name }) }),
    T('tab', 'Таб. №', (e) => person(e.pid).tab || '—'),
    T('to', 'Потенційний на', (e) => potTo(e.prog), { sortv: (e) => ({ TZ: 0, LH1: 1, LH2: 2 }[e.prog]) }),
    T('pos', 'Посада зараз', (e) => person(e.pid).cur_pos || '—'),
    T('note', 'Коментар', (e) => (e.manual ? e.manual.note : '')),
    T('at', 'Відмічено', (e) => (e.manual ? fmtDate(e.manual.at.slice(0, 10)) : '')),
  ], rows, { onRow: (e) => openPerson(e.pid), sort: 'to', dir: 1 });
  const back = el('button', { class: 'btn btn-secondary btn-sm', text: '← До магазинів регіону', onclick: () => openPotentialStores(reg, regPeople) });
  openModal(`🏪 ${store} · потенційні ${rows.length}`, rows.length ? `${reg}. Натисніть на людину, щоб відкрити історію.` : `${reg}. Потенційних у магазині немає — додайте через «+ Додати потенційного».`, el('div', { class: 'seg-row' }, back), box);
}

// ================= TAB: Статуси резерву =================
// everyone in the programmes (+ people marked «Потенційний» by hand) with the
// computed reserve status and a manual override
const RES_ORDER = ['Кадровий резерв', 'Сертифікований', 'Потенційний', 'Навчається', 'Пониження', 'Не в резерві', 'Призначення Товарознавець', 'Призначення Заступник', 'Призначення Директор', 'Звільнення', 'Немає в історії'];
// people with their reserve status (current place of work), region filter applied
function statusEntries() {
  return [...resEntries().values()].map((e) => {
    const p = person(e.pid), x = e.last;
    return Object.assign(e, { name: p.name, reg: p.work ? p.cur_reg : (x ? x.reg : p.cur_reg), store: p.work ? p.cur_store : (x ? x.store : p.cur_store) });
  }).filter((e) => !state.reg || e.reg === state.reg);
}
const qMatch = (e) => !state.rq || e.name.toLowerCase().includes(state.rq.toLowerCase()) || e.pid === state.rq;
function searchBox() {
  let t;
  const q = el('input', { type: 'search', class: 'search-input', placeholder: 'ПІБ або таб. номер', value: state.rq || '', 'aria-label': 'Пошук',
    oninput: (e) => { clearTimeout(t); t = setTimeout(() => { state.rq = e.target.value.trim(); render(); const n2 = ROOT.querySelector('#rs-q'); if (n2) { n2.focus(); n2.setSelectionRange(n2.value.length, n2.value.length); } }, 300); } });
  q.id = 'rs-q';
  return q;
}
const noteCell = (e) => (e.manual && !e.locked
  ? el('input', { type: 'text', class: 'rs-note', value: e.manual.note || '', placeholder: 'коментар', onclick: (ev) => ev.stopPropagation(),
    onchange: (ev) => HOOKS.setReserveStatus(e, e.manual.status, ev.target.value) })
  : el('span', { class: 'muted', text: e.manual && e.manual.note ? e.manual.note : '' }));

// «Кадровий резерв» tab: everyone in the programmes, computed status + manual override
function renderStatusTable(all) {
  const entries = all.filter((e) => e.rows.length);
  const shown = entries.filter((e) => (!state.rview || e.prog === state.rview) && (!state.rstat || e.final === state.rstat) && qMatch(e));
  const stSel = el('select', { 'aria-label': 'Статус резерву', onchange: (e) => { state.rstat = e.target.value; render(); } },
    el('option', { value: '', text: 'Усі статуси' }), RES_ORDER.filter((k) => entries.some((e) => e.final === k)).map((k) => el('option', { value: k, text: k, selected: state.rstat === k || null })));
  const tools = el('div', { class: 'seg-row' },
    seg([['', 'Усі програми'], ['LH1', 'LH 1.0 · Заступник'], ['LH2', 'LH 2.0 · Директор']], state.rview, (v) => state.rview = v), stSel, searchBox(),
    el('span', { class: 'muted', style: 'margin-left:auto', text: `✋ змінено вручну: ${entries.filter((e) => e.manual && !e.locked).length}` }));
  const box = el('div');
  const manualCell = (e) => {
    if (e.locked) return el('span', { class: 'muted', text: e.manual ? `з історії (було: ${e.manual.status})` : 'з історії' });
    // «Потенційний» is set on the «Потенційні» tab only
    const opts = D.reserveStatuses.filter((k) => k !== 'Потенційний' || (e.manual && e.manual.status === k));
    return el('select', { class: 'lh-status st-sel ' + (e.manual ? (OSTAT[e.manual.status] || {}).cls || '' : 'st-nc'), onclick: (ev) => ev.stopPropagation(),
      onchange: (ev) => HOOKS.setReserveStatus(e, ev.target.value, e.manual ? e.manual.note : '') },
    el('option', { value: '', text: '— авто —' }), opts.map((k) => el('option', { value: k, text: k, selected: e.manual && e.manual.status === k || null })));
  };
  makeTable(box, [
    T('name', 'ПІБ', (e) => e.name, { cell: (e) => el('span', { class: 'link', text: e.name }) }),
    T('tab', 'Таб. №', (e) => person(e.pid).tab || '—'),
    T('prog', 'Остання програма', (e) => progText(e),
      { cell: (e) => el('span', { text: progText(e), tip: e.rows.length > 1 ? () => [el('b', { text: 'Усі програми' }), ...e.rows.map((x) => el('div', { text: `${PROG[x.prog]} · ${x.year}: ${x.status}` }))] : null }, e.rows.length > 1 ? el('span', { class: 'muted', text: ` +${e.rows.length - 1}` }) : null) }),
    T('pst', 'Статус у програмі', (e) => (e.last ? e.last.status : '—')),
    T('pos', 'Посада зараз', (e) => (person(e.pid).work ? person(e.pid).cur_pos : '—')),
    T('store', 'Магазин', (e) => e.store || ''),
    T('reg', 'Регіон', (e) => e.reg || ''),
    T('auto', 'Автостатус', (e) => e.auto, { cell: (e) => pill(OSTAT, e.auto), sortv: (e) => RES_ORDER.indexOf(e.auto) }),
    T('manual', 'Статус вручну', (e) => (e.manual ? e.manual.status : ''), { cell: manualCell }),
    T('final', 'Підсумок', (e) => e.final, { cell: (e) => el('span', {}, pill(OSTAT, e.final), e.manual && !e.locked ? el('span', { title: `Змінено вручну ${fmtDate(e.manual.at.slice(0, 10))}`, text: ' ✋' }) : null), sortv: (e) => RES_ORDER.indexOf(e.final) }),
    T('note', 'Коментар', (e) => (e.manual ? e.manual.note : ''), { cell: noteCell }),
  ], shown, { onRow: (e) => openPerson(e.pid), sort: 'final', dir: 1, tall: true });
  return card('res-status', '📋 Статуси резерву',
    'Усі учасники програм, статус — за останньою програмою. Автостатус рахується з «Історії працівника» і статусу в програмі; його можна змінити вручну — ручний статус діє, доки людина працює й не отримала цільову посаду (звільнення та призначення з історії завжди мають пріоритет).',
    tools, box);
}

// «Потенційні» tab: who could be brought into a programme (marked by hand)
function renderPotentials(root) {
  const all = statusEntries();
  const potAll = all.filter((e) => e.final === 'Потенційний');
  const pot = potAll.filter((e) => person(e.pid).work);
  const stores = D.stores.filter(([r]) => !state.reg || r === state.reg);
  const regs = uniqSorted(stores.map(([r]) => r).concat(pot.map((e) => e.reg)));
  const rRows = regs.map((k) => {
    const g = pot.filter((e) => e.reg === k), sts = storeRows(k, g);
    return Object.assign({ k }, potBuckets(g), { nst: sts.length, noD: sts.filter((x) => !x.d.length).length });
  });
  const b = potBuckets(pot), noD = rRows.reduce((a, r) => a + r.noD, 0), nst = rRows.reduce((a, r) => a + r.nst, 0);
  root.append(el('div', { class: 'kpi-grid k4' },
    tile(String(b.t.length), '🧺 Потенційні на Товарознавця', 'працюють зараз'),
    tile(String(b.d.length), '🟢 Потенційні на Заступника', 'працюють зараз'),
    tile(String(b.r.length), '🟣 Потенційні на Директора', 'працюють зараз'),
    tile(`${noD} з ${nst}`, '🚩 Магазинів без потенціалу на Заступника', state.reg || 'по мережі')));

  // list + adding
  const shown = potAll.filter(qMatch);
  const box = el('div');
  makeTable(box, [
    T('name', 'ПІБ', (e) => e.name, { cell: (e) => el('span', { class: 'link', text: e.name }) }),
    T('tab', 'Таб. №', (e) => person(e.pid).tab || '—'),
    T('to', 'Потенційний на', (e) => potTo(e.prog), { sortv: (e) => ({ TZ: 0, LH1: 1, LH2: 2 }[e.prog]) }),
    T('pos', 'Посада зараз', (e) => (person(e.pid).work ? person(e.pid).cur_pos : 'не працює')),
    T('store', 'Магазин', (e) => e.store || ''),
    T('reg', 'Регіон', (e) => e.reg || ''),
    T('prog', 'Програми', (e) => (e.rows.length ? e.rows.map((x) => `${PROG[x.prog]} · ${x.year}: ${x.status}`).join('; ') : '—')),
    T('note', 'Коментар', (e) => (e.manual ? e.manual.note : ''), { cell: noteCell }),
    T('at', 'Відмічено', (e) => (e.manual ? fmtDate(e.manual.at.slice(0, 10)) : ''), { sortv: (e) => (e.manual ? e.manual.at : '') }),
    T('del', '', () => '', { cell: (e) => el('button', { class: 'btn btn-secondary btn-sm', text: '✕', title: 'Прибрати з потенційних', onclick: (ev) => { ev.stopPropagation(); HOOKS.setReserveStatus(e, '', ''); } }) }),
  ], shown, { onRow: (e) => openPerson(e.pid), sort: 'to', dir: 1, tall: true });
  root.append(card('pot-list', `🌱 Потенційні · ${potAll.length}`, 'Кого можна залучити в програму (відмічаються вручну). У доступний кадровий резерв не входять. Натисніть на рядок, щоб відкрити історію.',
    el('div', { class: 'seg-row' }, searchBox(),
      el('button', { class: 'btn btn-primary btn-sm', style: 'margin-left:auto', text: '+ Додати потенційного', onclick: () => HOOKS.addPotential('LH1') })),
    box));

  // by region -> stores of the region -> people (current place of work)
  const rbox = el('div');
  root.append(card('pot-regions', `🗺 Потенційні по регіонах · ${pot.length}`,
    'Хто працює зараз, за поточним регіоном. 🚩 — магазини, де немає жодного потенційного на Заступника. Натисніть на регіон, щоб побачити магазини.', rbox));
  makeTable(rbox, [
    T('k', 'Регіон', (r) => r.k || '—'),
    ...potCols(),
    T('noD', 'Магазинів без потенціалу на заст.', (r) => r.noD, { num: true, sortv: (r) => r.noD, cell: (r) => el('span', { class: r.noD ? 'flag-red' : 'muted', text: r.noD ? `🚩 ${r.noD} з ${r.nst}` : `0 з ${r.nst}` }) }),
  ], rRows, { sort: 'noD', dir: -1, onRow: (r) => openPotentialStores(r.k, pot.filter((e) => e.reg === r.k)),
    total: (rs) => ({ k: 'Разом', t: rs.reduce((a, r) => a + r.t.length, 0), d: rs.reduce((a, r) => a + r.d.length, 0), r: rs.reduce((a, r) => a + r.r.length, 0), all: rs.reduce((a, r) => a + r.all.length, 0), noD: `🚩 ${noD} з ${nst}` }) });
}

// ---------- filters UI
function opt(sel, items, allText, cur) {
  sel.replaceChildren(el('option', { value: '', text: allText }), ...items.map((v) => el('option', { value: v, text: v })));
  sel.value = items.includes(cur) ? cur : '';
  return sel.value;
}
function fillFilters() {
  const tabParts = state.tab === 'reserve' ? grads() : D.parts.filter((x) => x.prog === (state.tab === 'lh1' ? 'LH1' : 'LH2'));
  state.year = opt($('#f-year'), uniqSorted(tabParts.map((x) => String(x.year))), 'Усі роки', state.year);
  const regs = uniqSorted(D.stores.map((s) => s[0]).concat(D.parts.map((x) => x.reg)));
  state.reg = opt($('#f-reg'), regs, 'Усі регіони', state.reg);
  const ss = new Set(D.stores.filter((s) => !state.reg || s[0] === state.reg).map((s) => s[1]));
  D.parts.forEach((x) => { if (x.store && (!state.reg || x.reg === state.reg)) ss.add(x.store); });
  state.store = opt($('#f-store'), uniqSorted([...ss]), 'Усі магазини', state.store);
  state.pos = opt($('#f-pos'), uniqSorted(tabParts.map((x) => x.pos_in)), 'Усі посади', state.pos);
  state.prog = opt($('#f-prog'), ['LH1', 'LH2'], 'Усі програми', state.prog);
  [...$('#f-prog').options].forEach((o) => { if (o.value) o.textContent = PROG[o.value]; });
  state.status = opt($('#f-status'), state.tab === 'reserve' ? OSTAT_ORDER : PSTAT_ORDER.filter((s) => tabParts.some((x) => x.status === s)), 'Усі статуси', state.status);
  $('#f-q').value = state.q;
  const side = $('#f-reg-side');
  side.replaceChildren(...[...$('#f-reg').options].map((o) => o.cloneNode(true))); side.value = state.reg;
  const own = state.tab === 'reserve' || state.tab === 'pot'; // tabs without the LH filter bar
  ROOT.querySelector('#ff-reg-side').hidden = !own;
  ROOT.querySelector('#lh-filters').hidden = own;
  ROOT.querySelector('#ff-prog').hidden = state.tab !== 'reserve';
  ROOT.querySelector('#ff-work').hidden = state.tab !== 'reserve';
  document.querySelectorAll('#f-work button').forEach((b) => { const on = (b.dataset.v === 'work') === state.workOnly; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
}
function render() {
  fillFilters();
  ROOT.querySelectorAll('.lh-tabs .tab-btn').forEach((b) => { b.classList.toggle('active', b.dataset.tab === state.tab); b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)); });
  const root = $('#view'); root.replaceChildren(); tipBox().hidden = true; tipTarget = null;
  if (state.tab === 'reserve') renderReserve(root);
  else if (state.tab === 'pot') renderPotentials(root);
  else renderProgram(root, state.tab === 'lh1' ? 'LH1' : 'LH2');
}

const SHELL = `
  <div class="lh-head">
    <div class="tabs lh-tabs" role="tablist">
      <button class="tab-btn" role="tab" data-tab="reserve">🎓 Кадровий резерв</button>
      <button class="tab-btn" role="tab" data-tab="lh1">🧭 Leader Hub 1.0</button>
      <button class="tab-btn" role="tab" data-tab="lh2">🚀 Leader Hub 2.0</button>
      <button class="tab-btn" role="tab" data-tab="pot">🌱 Потенційні</button>
    </div>
    <div class="lh-side">
      <div class="filter-field" id="ff-reg-side"><select id="f-reg-side" aria-label="Регіон"></select></div>
      <button class="btn btn-secondary btn-sm lh-gear" id="lh-settings" type="button" title="Налаштування Leader Hub: потоки, дати, учасники" aria-label="Налаштування Leader Hub">⚙️ Налаштування</button>
    </div>
  </div>
  <div class="filters" id="lh-filters">
    <div class="filter-field"><label for="f-year">Рік (потік)</label><select id="f-year"></select></div>
    <div class="filter-field" id="ff-prog"><label for="f-prog">Програма</label><select id="f-prog"></select></div>
    <div class="filter-field"><label for="f-reg">Регіон</label><select id="f-reg"></select></div>
    <div class="filter-field"><label for="f-store">Магазин</label><select id="f-store"></select></div>
    <div class="filter-field"><label for="f-pos">Стартова посада</label><select id="f-pos"></select></div>
    <div class="filter-field"><label for="f-status">Статус</label><select id="f-status"></select></div>
    <div class="filter-field wide"><label for="f-q">ПІБ працівника</label><input id="f-q" type="search" placeholder="Почніть вводити прізвище"></div>
    <div class="filter-field narrow" id="ff-work"><label>Співробітники</label><div class="tabs small" id="f-work" role="group"><button class="tab-btn" data-v="all">Усі</button><button class="tab-btn active" data-v="work">Працюють</button></div></div>
    <button class="btn btn-secondary btn-sm" id="f-reset">Скинути</button>
  </div>
  <div id="view"></div>`;

// «Кадровий резерв» has only a region filter and always shows people who work
// now; the Leader Hub tabs keep their own filters, restored when coming back.
let lhFilters = null;
const NON_REGION = ['year', 'prog', 'store', 'pos', 'status', 'q', 'workOnly'];
function switchTab(tab) {
  if (tab === state.tab) return;
  const own = (t) => t === 'reserve' || t === 'pot';
  if (own(tab) && own(state.tab)) {
    // region is shared, nothing else to swap
  } else if (own(tab)) {
    lhFilters = Object.fromEntries(NON_REGION.map((k) => [k, state[k]]));
    Object.assign(state, { year: '', prog: '', store: '', pos: '', status: '', q: '', workOnly: true });
  } else if (own(state.tab)) {
    Object.assign(state, lhFilters || { year: '', prog: '', store: '', pos: '', status: '', q: '', workOnly: true });
  } else {
    state.status = ''; state.pos = '';
  }
  state.tab = tab;
  render();
}
function bind() {
  const on = (id, k, reset) => $(id).addEventListener('change', (e) => { state[k] = e.target.value; if (reset) state.store = ''; render(); });
  on('#f-year', 'year'); on('#f-reg', 'reg', true); on('#f-store', 'store'); on('#f-pos', 'pos'); on('#f-prog', 'prog'); on('#f-status', 'status');
  let t; $('#f-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); render(); $('#f-q').focus(); }, 300); });
  document.querySelectorAll('#f-work button').forEach((b) => b.addEventListener('click', () => { state.workOnly = b.dataset.v === 'work'; render(); }));
  $('#f-reset').addEventListener('click', () => { Object.assign(state, { year: '', reg: '', store: '', pos: '', prog: '', status: '', q: '', workOnly: true }); render(); });
  $('#lh-settings').addEventListener('click', () => HOOKS.settings(state.tab === 'lh2' ? 'LH2' : 'LH1'));
  $('#f-reg-side').addEventListener('change', (e) => { state.reg = e.target.value; state.store = ''; render(); });
  ROOT.querySelectorAll('.lh-tabs .tab-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
}

window.LeaderHub = {
  // data: /api/reserve; hooks: { newStream(prog), addParticipant(prog, year), deleteStream(prog, year), setStatus(part, status), removeParticipant(part, name) }
  mount(rootEl, data, hooks) {
    D = data; PEOPLE = data.people; ROOT = rootEl; HOOKS = hooks; RES = null;
    END = {};
    START = {};
    (data.streams || []).forEach((s) => { if (s.date_end) END[s.program + s.year] = s.date_end; if (s.date_start) START[s.program + s.year] = s.date_start; });
    if (!document.getElementById('tip')) document.body.append(el('div', { class: 'tip', id: 'tip', hidden: true, role: 'tooltip' }));
    rootEl.classList.add('lh-root');
    rootEl.innerHTML = SHELL;
    bind();
    render();
  },
  // fresh data after an edit: re-render in place, same tab / filters / scroll
  update(data) {
    D = data; PEOPLE = data.people; RES = null;
    END = {};
    START = {};
    (data.streams || []).forEach((s) => { if (s.date_end) END[s.program + s.year] = s.date_end; if (s.date_start) START[s.program + s.year] = s.date_start; });
    const y = window.scrollY;
    const scrolls = [...ROOT.querySelectorAll('.table-scroll')].map((n) => n.scrollTop);
    render();
    ROOT.querySelectorAll('.table-scroll').forEach((n, i) => { if (scrolls[i]) n.scrollTop = scrolls[i]; });
    window.scrollTo(0, y);
  },
  // keep filters / tab when re-mounting after an edit
  setYear(y) { state.year = String(y); },
};
})();
