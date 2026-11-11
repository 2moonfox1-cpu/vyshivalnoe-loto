'use strict';
// Вышивальное лото — логика игры. Чистые функции над состоянием, без доступа к сети и базе.
// Время: всё считается по Москве (UTC+3, без перехода на летнее время).
const MSK = 3 * 3600 * 1000, DAY = 86400000, WEEK = 7 * DAY;
const ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RANGES = [[1, 9], [10, 19], [20, 29], [30, 39], [40, 49], [50, 59], [60, 69], [70, 79], [80, 90]];
const MAX_TICKETS = 5, TICKETS_IN_SEASON = 100, MAX_WEEKS = 15;

class GameError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new GameError(code, msg); };

// ---------- время ----------
const startMs = s => Date.parse(s.season.startDate + 'T00:00:00Z') - MSK; // вторник 00:00 МСК первого розыгрыша
const dayIndex = (s, now) => Math.floor((now - startMs(s)) / DAY);      // 0 = день старта
const weekOf = (s, now) => { const d = dayIndex(s, now); return d < 0 ? 0 : Math.floor(d / 7) + 1; };
const dowOf = (s, now) => ((dayIndex(s, now) % 7) + 7) % 7;               // 0 = вторник … 6 = понедельник
const canActivate = (s, now) => dayIndex(s, now) <= 0 && dayIndex(s, now) >= -7;

// ---------- генерация ----------
function shuffle(a, rnd) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function genGrid(rnd) {
  let rows, cnt;
  do {
    rows = [0, 1, 2].map(() => shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8], rnd).slice(0, 5));
    cnt = RANGES.map((_, c) => rows.filter(r => r.includes(c)).length);
  } while (Math.min(...cnt) < 1);
  const g = [0, 1, 2].map(() => Array(9).fill(null));
  RANGES.forEach(([a, b], c) => {
    const pool = shuffle(Array.from({ length: b - a + 1 }, (_, i) => a + i), rnd).slice(0, cnt[c]).sort((x, y) => x - y);
    let k = 0; for (let r = 0; r < 3; r++) if (rows[r].includes(c)) g[r][c] = pool[k++];
  });
  return g;
}
function genCode(len, used, rnd) { let c; do { c = Array.from({ length: len }, () => ALPH[Math.floor(rnd() * ALPH.length)]).join(''); } while (used.has(c)); used.add(c); return c; }

function newSeason(old, { name, startDate, norm, prizes }, rnd) {
  if (new Date(startDate + 'T00:00:00Z').getUTCDay() !== 2) fail('BAD_DATE', 'Дата старта должна быть вторником');
  const used = new Set(), seen = new Set(), tickets = {};
  for (let n = 1; n <= TICKETS_IN_SEASON;) {
    const grid = genGrid(rnd), key = grid.flat().filter(Boolean).sort((a, b) => a - b).join(',');
    if (seen.has(key)) continue; seen.add(key);
    tickets[n] = { n, code: genCode(6, used, rnd), grid, active: false, closed: [], pending: [], debt: [], fix: null, fixSentWeek: -1, burned: false, burnedWeek: 0, stitched: 0 };
    n++;
  }
  return {
    v: 1, season: { name, startDate, norm: norm || 200, prizes: prizes || [] },
    tickets, drawn: [], draws: [], processedWeek: 0, reports: [], seq: 0,
    keys: (old && old.keys) || [], sched: (old && old.sched) || [], posts: [], mail: [], wk: {}, winner: null, over: false,
  };
}

// ---------- помощники по билету ----------
const nums = t => t.grid.flat().filter(Boolean);
const matched = (s, t) => nums(t).filter(x => s.drawn.includes(x));
const owed = (s, t) => matched(s, t).filter(x => !t.closed.includes(x) && !t.pending.includes(x));
const cost = (s, t, x) => (t.debt.includes(x) ? 2 : 1) * s.season.norm;
const byCode = (s, code) => Object.values(s.tickets).find(t => t.code === String(code || '').trim().toUpperCase());
const mail = (s, t, text, now) => s.mail.push({ t, text, at: now, id: ++s.seq });
const post = (s, text, now) => s.posts.push({ text, at: now, id: ++s.seq });
const remove = (arr, xs) => arr.filter(x => !xs.includes(x));
function addStitched(s, t, week, n) { t.stitched += n; const k = s.wk[week] || (s.wk[week] = { all: 0, by: {} }); k.all += n; k.by[t.n] = (k.by[t.n] || 0) + n; }

// ---------- часы игры: конец недели и розыгрыш ----------
function deadline(s, now) {
  for (const t of Object.values(s.tickets)) {
    if (!t.active || t.burned) continue;
    const o = owed(s, t);
    const fixLate = t.fix && t.fix.rejWeek > t.fix.repWeek;
    if (fixLate || o.some(x => t.debt.includes(x))) { t.burned = true; t.burnedWeek = s.processedWeek; mail(s, t.n, `Билет № ${t.n} сгорел: два пропуска подряд.`, now); continue; }
    t.fix = null;
    if (o.length) { t.debt = [...new Set([...t.debt, ...o])]; mail(s, t.n, `Билет № ${t.n}: пропуск. Не сдано чисел: ${o.join(', ')}. Теперь каждое из них стоит ${s.season.norm * 2} крестиков. Закройте их до понедельника 23:59 по МСК, иначе билет сгорит.`, now); }
  }
}
function draw(s, now, rnd) {
  const left = Array.from({ length: 90 }, (_, i) => i + 1).filter(x => !s.drawn.includes(x));
  const d = shuffle(left, rnd).slice(0, 6).sort((a, b) => a - b);
  s.drawn.push(...d); s.draws.push({ week: s.draws.length + 1, balls: d, at: now });
  for (const t of Object.values(s.tickets)) if (t.active && !t.burned && d.some(x => nums(t).includes(x))) mail(s, t.n, `Новые бочонки! На билете № ${t.n} есть числа к отшиву.`, now);
}
function finishClosest(s, now) {
  const lastAcc = n => s.tickets[n].lastAccAt || 0;
  const c = Object.values(s.tickets).filter(t => t.active && !t.burned)
    .sort((a, b) => (b.closed.length - a.closed.length) || (lastAcc(a.n) - lastAcc(b.n)))[0];
  s.over = true;
  if (c) { s.winner = { n: c.n, closest: true, at: now }; post(s, `🏆 Все бочонки вытянуты! Ни один билет не закрыт полностью, поэтому побеждает билет № ${c.n} — он ближе всех к финишу (${c.closed.length} из 15). Поздравляем! 🎉 Спасибо всем участницам. О следующем сезоне расскажем совсем скоро.`, now); mail(s, c.n, `Поздравляем! Ваш билет № ${c.n} ближе всех к финишу — вы победили!`, now); }
  else post(s, `❄️ Сезон «${s.season.name}» завершён: в игре не осталось ни одного билета. Спасибо за игру!`, now);
}
// Догоняет все наступившие вторники. Безопасно вызывать сколько угодно раз.
function tick(s, now, rnd) {
  if (s.over) return false;
  const target = Math.min(weekOf(s, now), MAX_WEEKS + 1);
  let changed = false;
  while (s.processedWeek < target && !s.over) {
    const at = startMs(s) + s.processedWeek * WEEK;
    if (s.processedWeek >= 1) deadline(s, at);
    if (s.processedWeek >= MAX_WEEKS) { s.processedWeek++; finishClosest(s, at); changed = true; break; }
    draw(s, at, rnd); s.processedWeek++; changed = true;
  }
  return changed;
}

// ---------- участница ----------
function activate(s, code, alreadyMine, now) {
  const t = byCode(s, code);
  if (!t) fail('NO_CODE', 'Такого кода нет. Проверьте написание');
  if (!canActivate(s, now)) fail('CLOSED', 'Приём кодов закрыт');
  if (alreadyMine.length >= MAX_TICKETS) fail('LIMIT', 'Максимум 5 билетов');
  if (t.active) { if (alreadyMine.includes(t.code)) fail('MINE', 'Этот билет уже у вас'); fail('TAKEN', 'Этот код уже активирован'); }
  t.active = true; return t.n;
}
function submitReport(s, { code, nums: sel, stitched, photos }, now) {
  if (s.over) fail('OVER', 'Сезон завершён');
  const t = byCode(s, code); if (!t || !t.active) fail('NO_CODE', 'Билет не найден');
  if (t.burned) fail('BURNED', 'Билет сгорел');
  const week = s.processedWeek, dow = dowOf(s, now);
  if (week < 1) fail('NOT_STARTED', 'Игра ещё не началась');
  const isFix = !!t.fix;
  let list;
  if (isFix) list = t.fix.nums;
  else {
    if (t.fixSentWeek === week && dow < 3) fail('FRIDAY', 'После исправления отчёт за эту неделю откроется с пятницы');
    list = owed(s, t);
  }
  sel = [...new Set((sel || []).map(Number))];
  if (!sel.length) fail('NO_NUMS', 'Отметьте хотя бы одно число');
  if (isFix && (sel.length !== list.length || sel.some(x => !list.includes(x)))) fail('FIX_NUMS', 'В исправлении должны быть те же числа');
  if (sel.some(x => !list.includes(x))) fail('BAD_NUMS', 'Эти числа нельзя сдать');
  if (!photos || !photos.before || !photos.after) fail('PHOTOS', 'Добавьте оба фото: «Было» и «Стало»');
  const norm = sel.reduce((a, x) => a + cost(s, t, x), 0);
  stitched = Math.floor(Number(stitched) || 0);
  if (stitched < norm) fail('NORM', `Вышито ${stitched} — меньше нормы ${norm}`);
  const r = { id: ++s.seq, t: t.n, nums: sel, norm, stitched, photos, week, dow, sentAt: now, status: 'pending', isFix, repWeek: isFix ? t.fix.repWeek : week, by: null, comment: '' };
  s.reports.push(r);
  t.pending = [...t.pending, ...sel];
  if (isFix) { t.fix = null; t.fixSentWeek = week; }
  return r;
}

// ---------- команда ----------
const staffOf = (s, key) => s.keys.find(k => k.code === String(key || '').trim().toUpperCase() && k.active) || null;
function needStaff(s, key, owner) { const k = staffOf(s, key); if (!k) fail('NO_ACCESS', 'Неверный или отключённый ключ'); if (owner && k.role !== 'owner') fail('NO_ACCESS', 'Только для владельца'); return k; }
function review(s, key, myCodes, { id, accept, comment }, now) {
  const k = needStaff(s, key);
  const r = s.reports.find(x => x.id === id && x.status === 'pending'); if (!r) fail('NO_REPORT', 'Отчёт не найден или уже проверен');
  const t = s.tickets[r.t];
  if (k.role !== 'owner' && (myCodes || []).includes(t.code)) fail('OWN', 'Свои отчёты проверяет другой участник команды');
  comment = String(comment || '').trim();
  if (!accept && !comment) fail('COMMENT', 'При отклонении комментарий обязателен');
  r.by = k.label; r.comment = comment; r.checkedAt = now; t.pending = remove(t.pending, r.nums);
  const removedPhotos = r.photos; r.photos = null;
  if (accept) {
    r.status = 'accepted';
    t.closed = [...new Set([...t.closed, ...r.nums])]; t.debt = remove(t.debt, r.nums);
    t.lastAccAt = r.sentAt;
    addStitched(s, t, r.isFix ? r.repWeek : r.week, r.stitched);
    mail(s, t.n, `Отчёт по билету № ${t.n} принят. Закрыты числа: ${r.nums.join(', ')}.` + (comment ? ` Комментарий проверяющего: ${comment}` : ''), now);
    if (t.closed.length === 15) t.finishedAt = r.sentAt;
    checkWinner(s, now);
  } else {
    r.status = 'rejected';
    t.fix = { nums: r.nums, reason: comment, rejWeek: s.processedWeek, repWeek: r.repWeek };
    checkWinner(s, now);
    mail(s, t.n, `Отчёт по билету № ${t.n} отклонён. Комментарий проверяющего: ${comment}. Исправьте до понедельника 23:59.`, now);
  }
  return { removedPhotos };
}
// Победа и ничья: побеждает билет, чей закрывающий отчёт отправлен раньше.
// Если на проверке есть более ранний отчёт, который тоже может закрыть билет, ждём его проверки.
function checkWinner(s, now) {
  if (s.winner) return;
  const done = Object.values(s.tickets).filter(t => t.closed.length === 15 && !t.burned).sort((a, b) => a.finishedAt - b.finishedAt);
  if (!done.length) return;
  const c = done[0];
  const earlierPending = s.reports.some(r => r.status === 'pending' && r.sentAt < c.finishedAt && s.tickets[r.t].closed.length + r.nums.length === 15);
  if (earlierPending) return;
  s.winner = { n: c.n, at: now }; s.over = true;
  post(s, `🏆 У нас есть победительница! Билет № ${c.n} закрыт полностью. Поздравляем! 🎉 Спасибо всем участницам. О следующем сезоне расскажем совсем скоро.`, now);
  mail(s, c.n, `Поздравляем! Билет № ${c.n} закрыт полностью — вы победили!`, now);
}

function reissueCode(s, n, rnd) {
  const t = s.tickets[n]; if (!t) fail('NO_TICKET', 'Нет такого билета');
  const used = new Set(Object.values(s.tickets).map(x => x.code));
  t.code = genCode(6, used, rnd); return t.code;
}
module.exports = { reissueCode,  GameError, newSeason, tick, activate, submitReport, review, staffOf, needStaff, genCode, owed, matched, cost, nums, byCode, weekOf, dowOf, dayIndex, canActivate, startMs, MSK, DAY, WEEK };
