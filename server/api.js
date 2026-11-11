'use strict';
// Обработчик запросов приложения. Все запросы — POST с JSON { action, ... }.
const crypto = require('crypto');
const G = require('./game');
const { Conflict, MAIL_KEEP, HIST_KEEP } = require('./store');

const rnd = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;
const err = (code, message) => Object.assign(new G.GameError(code, message));
const pub = s => ({ name: s.season.name, startDate: s.season.startDate, norm: s.season.norm, prizes: s.season.prizes });
const dayOff = (s, now) => G.dayIndex(s, now);
const thousands = n => { const k = Math.floor(n / 1000); return k + (k % 10 === 1 && k % 100 !== 11 ? ' тысячи' : ' тысяч'); };
const totalStitched = s => Object.values(s.tickets).reduce((a, t) => a + t.stitched, 0);
const subst = (s, text) => text.replace(/\{сезон\}/g, s.season.name).replace(/\{тыс\}/g, thousands(totalStitched(s)));
const DEFAULT_SCHED = [
  { off: -7, text: '🎉 Сезон «{сезон}» открыт! Внесите свои билеты в разделе «Моя комната». Код можно ввести до вторника 23:59 по МСК — дня первого розыгрыша. Потом приём закрывается.' },
  { off: -1, text: '❄️ Скоро старт! Проверьте, что все ваши билеты на месте в «Моей комнате». Первые бочонки достанем из мешочка во вторник в 00:00 по МСК.' },
  { off: 0, text: '🎉 Мешочек открыт, первые бочонки вытянуты! Загляните в свои билеты: совпадения подсвечены. ⚠️ Последний шанс ввести код билета — сегодня до 23:59.' },
  { off: 21, text: '✨ Игра набирает обороты: уже выпало 24 бочонка из 90!' },
  { off: 35, text: '🏁 Половина пути позади! Выпало почти 40 бочонков. У кого-то закрыта уже треть билета. Держим темп!' },
  { off: 42, text: '💪 Вышито уже больше {тыс} крестиков всеми вместе! Спасибо, что вы с нами.' },
  { off: 56, text: '🔥 Напряжение растёт! Некоторые билеты совсем близко к финишу. Каждый новый бочонок может стать последним.' },
  { off: 70, text: '⏳ Финал близко! Не копите долги: при двойном пропуске подряд билет сгорает, и обидно потерять его в шаге от победы.' },
].map((x, i) => ({ ...x, id: i + 1 }));

// Обслуживание: розыгрыши и «заморозка» опубликованных объявлений. Возвращает true, если состояние изменилось.
function maintain(s, now) {
  let ch = G.tick(s, now, rnd);
  for (const a of s.sched) if (a.off <= dayOff(s, now) && !a.frozen) { a.frozen = subst(s, a.text); ch = true; }
  if (s.posts.length > 10) { s.posts = s.posts.slice(-10); ch = true; }
  if (s.over && s.reports.length) ch = true;
  return ch;
}
function board(s, now) {
  const items = s.sched.filter(a => a.off <= dayOff(s, now)).map(a => ({ at: G.startMs(s) + a.off * G.DAY, text: a.frozen || subst(s, a.text) }))
    .concat(s.posts.map(p => ({ at: p.at, text: p.text }))).sort((a, b) => b.at - a.at);
  return items[0] ? items[0].text : '';
}

function makeApi({ store, ownerKey, now: clock = () => Date.now() }) {
  // Выполнить изменение состояния атомарно (с повтором при одновременных запросах)
  async function mutate(fn) {
    for (let i = 0; i < 20; i++) {
      if (i) await new Promise(r => setTimeout(r, 20 + Math.random() * 80 * Math.min(i, 5)));
      const { state, version } = await store.getMain();
      if (!state) throw err('NO_SEASON', 'Сезон ещё не создан');
      const now = clock();
      state.mail = []; maintain(state, now);
      let result = await fn(state, now);
      // Сезон закончился — непроверенные отчёты больше не нужны, их фото удаляем
      if (state.over && state.reports.length) {
        const keys = state.reports.flatMap(r => r.photos ? [r.photos.before, r.photos.after] : []);
        state.reports = []; result = result || {}; result._delete = [...(result._delete || []), ...keys];
      }
      const mail = state.mail, hist = state._hist || []; delete state._hist; state.mail = [];
      try { await store.putMain(state, version); } catch (e) { if (e instanceof Conflict) continue; throw e; }
      if (mail.length) await store.appendLists('loto_mail', group(mail, m => m.t), MAIL_KEEP);
      if (hist.length) await store.appendLists('loto_hist', group(hist, h => h.t), HIST_KEEP);
      if (result && result._delete) for (const k of result._delete) await store.deletePhoto(k);
      if (result) delete result._delete;
      return { result, state };
    }
    throw err('BUSY', 'Сервер занят, попробуйте ещё раз');
  }
  const group = (arr, k) => arr.reduce((o, x) => ((o[k(x)] = o[k(x)] || []).push(x), o), {});
  async function read() {
    const { state, version } = await store.getMain();
    if (!state) return { state: null };
    const probe = JSON.parse(JSON.stringify(state)); probe.mail = [];
    if (maintain(probe, clock())) return (await mutate(() => null));
    return { state };
  }
  const staff = (s, key) => {
    const k = String(key || '').trim().toUpperCase();
    if (ownerKey && k === ownerKey.toUpperCase()) return { code: k, label: 'Владелец', role: 'owner', active: true };
    return G.staffOf(s, k);
  };
  const needStaff = (s, key, owner) => { const k = staff(s, key); if (!k) throw err('NO_ACCESS', 'Неверный или отключённый ключ'); if (owner && k.role !== 'owner') throw err('NO_ACCESS', 'Только для владельца'); return k; };
  const myTickets = (s, codes) => (codes || []).map(c => G.byCode(s, c)).filter(t => t && t.active);

  function ticketView(s, t, now) {
    const o = G.owed(s, t), week = s.processedWeek, dow = G.dowOf(s, now);
    let canReport = !t.burned && !s.over && week >= 1 && (!!t.fix || o.length > 0), why = '';
    if (!t.fix && t.fixSentWeek === week && dow < 3 && o.length) { canReport = false; why = 'После исправления отчёт за эту неделю откроется с пятницы.'; }
    else if (!t.fix && !o.length) why = t.pending.length ? 'Все выпавшие числа на проверке.' : 'Сейчас сдавать нечего.';
    return { n: t.n, code: t.code, grid: t.grid, closed: t.closed, pending: t.pending, debt: t.debt, owed: o, due: o.reduce((a, x) => a + G.cost(s, t, x), 0),
      fix: t.fix && { nums: t.fix.nums, reason: t.fix.reason }, burned: t.burned, burnedWeek: t.burnedWeek, stitched: t.stitched, canReport, why };
  }

  const handlers = {
    // ---------- участница ----------
    async state({ codes }) {
      const { state: s } = await read(); const now = clock();
      if (!s) return { noSeason: true };
      const mine = myTickets(s, codes);
      const [mail, hist] = await Promise.all([store.getLists('loto_mail', mine.map(t => t.n)), store.getLists('loto_hist', mine.map(t => t.n))]);
      const myNs = mine.map(t => t.n);
      return {
        season: pub(s), now, week: s.processedWeek, dow: G.dowOf(s, now), dayIndex: dayOff(s, now), canActivate: G.canActivate(s, now),
        drawn: s.drawn.length, lastDraw: s.draws.length ? s.draws[s.draws.length - 1].balls : [],
        draws: s.draws.map(d => ({ week: d.week, balls: d.balls, all: (s.wk[d.week] || {}).all || 0, mine: myNs.reduce((a, n) => a + (((s.wk[d.week] || {}).by || {})[n] || 0), 0) })),
        totals: { all: totalStitched(s), mine: mine.reduce((a, t) => a + t.stitched, 0) },
        board: board(s, now), over: s.over, winner: s.winner,
        tickets: mine.map(t => ticketView(s, t, now)),
        reports: s.reports.filter(r => myNs.includes(r.t)).map(r => ({ id: r.id, t: r.t, nums: r.nums, stitched: r.stitched, week: r.week, dow: r.dow, status: 'pending', isFix: r.isFix })),
        hist, mail: Object.values(mail).flat().sort((a, b) => a.at - b.at),
        lostCodes: (codes || []).filter(c => !mine.some(t => t.code === String(c).toUpperCase())),
      };
    },
    async activate({ code, codes }) {
      const { result } = await mutate((s, now) => ({ n: G.activate(s, code, myTickets(s, codes).map(t => t.code), now), code: String(code).trim().toUpperCase() }));
      return result;
    },
    async uploadUrl({ code, kind }) {
      const { state: s } = await read();
      const t = s && G.byCode(s, code); if (!t || !t.active || t.burned) throw err('NO_CODE', 'Билет не найден');
      if (!['before', 'after'].includes(kind)) throw err('BAD', 'Неверный тип фото');
      const key = `p/${s.season.startDate}/${t.n}/${kind}-${crypto.randomBytes(8).toString('hex')}.jpg`;
      return { key, url: store.photoPutUrl(key) };
    },
    async submit({ code, nums, stitched, photos }) {
      const { result } = await mutate((s, now) => {
        const t = G.byCode(s, code); const pre = t ? `p/${s.season.startDate}/${t.n}/` : '#';
        if (!photos || !String(photos.before || '').startsWith(pre) || !String(photos.after || '').startsWith(pre)) throw err('PHOTOS', 'Добавьте оба фото: «Было» и «Стало»');
        const r = G.submitReport(s, { code, nums, stitched, photos }, now); return { id: r.id };
      });
      return result;
    },

    // ---------- команда ----------
    async lab({ key, codes }) {
      const { state: s } = await read(); const now = clock();
      if (!s) { needStaffNoSeason(key); return { noSeason: true, role: 'owner', label: 'Владелец' }; }
      const k = needStaff(s, key); const mine = myTickets(s, codes).map(t => t.n);
      const hide = r => k.role !== 'owner' && mine.includes(r.t);
      const hist = await store.scanLists('loto_hist');
      return {
        role: k.role, label: k.label, now, week: s.processedWeek, dow: G.dowOf(s, now), over: s.over, winner: s.winner,
        pending: s.reports.filter(r => !hide(r)).sort((a, b) => a.sentAt - b.sentAt).map(r => ({ ...r, photos: { before: store.photoGetUrl(r.photos.before), after: store.photoGetUrl(r.photos.after) }, ks: `${(s.draws[r.week - 1] || { balls: [] }).balls.join(' ')}, Б${r.t}`, mine: mine.includes(r.t) })),
        hiddenOwn: s.reports.filter(hide).length,
        checked: Object.values(hist).flat().sort((a, b) => b.checkedAt - a.checkedAt).slice(0, 300),
        fixed: Object.fromEntries(Object.values(s.tickets).map(t => [t.n, { fix: !!t.fix, burned: t.burned }])),
        tickets: Object.values(s.tickets).filter(t => t.active).map(t => ({ n: t.n, closed: t.closed.length, owed: G.owed(s, t).filter(x => !t.debt.includes(x)).length, debt: G.owed(s, t).filter(x => t.debt.includes(x)).length, pending: t.pending.length, fix: !!t.fix, burned: t.burned, mine: mine.includes(t.n) })),
        ...(k.role === 'owner' ? { season: pub(s), sched: s.sched.map(a => ({ ...a, date: G.startMs(s) + a.off * G.DAY + 3 * 3600e3, published: a.off <= dayOff(s, now), text: a.frozen || subst(s, a.text) })), keys: s.keys, activated: Object.values(s.tickets).filter(t => t.active).length } : {}),
      };
    },
    async review({ key, codes, id, accept, comment }) {
      const { result } = await mutate((s, now) => {
        const k = needStaff(s, key);
        const r = s.reports.find(x => x.id === Number(id));
        if (!r) throw err('NO_REPORT', 'Отчёт не найден или уже проверен');
        const before = r.photos;
        if (k.role !== 'owner' && myTickets(s, codes).some(t => t.n === r.t)) throw err('OWN', 'Свои отчёты проверяет другой участник команды');
        // game.review требует ключ из s.keys — даём временный ключ владельца
        const tmp = { code: '__' + k.code, label: k.label, role: 'owner', active: true }; s.keys.push(tmp);
        try { G.review(s, tmp.code, [], { id: r.id, accept, comment }, now); } finally { s.keys = s.keys.filter(x => x !== tmp); }
        s.reports = s.reports.filter(x => x.id !== r.id);
        (s._hist = []).push({ id: r.id, t: r.t, nums: r.nums, stitched: r.stitched, week: r.week, dow: r.dow, status: r.status, comment: r.comment, by: r.by, isFix: r.isFix, sentAt: r.sentAt, checkedAt: now });
        return { ok: true, _delete: [before.before, before.after] };
      });
      return result;
    },

    // ---------- владелец ----------
    async seasonNew({ key, name, startDate, norm, prizes }) {
      const { state: old, version } = await store.getMain();
      if (old) { needStaff(old, key, true); if (old.draws.length && !old.over) throw err('RUNNING', 'Сезон уже идёт: создать новый можно после окончания текущего'); }
      else needStaffNoSeason(key);
      const n = Math.floor(Number(norm)); if (!n || n < 10) throw err('BAD', 'Норма — целое число от 10');
      if (!String(name || '').trim()) throw err('BAD', 'Введите название сезона');
      const s = G.newSeason(old, { name: String(name).trim(), startDate, norm: n, prizes: (prizes || []).map(String).filter(Boolean) }, rnd);
      if (!old || !old.sched || !old.sched.length) s.sched = DEFAULT_SCHED.map(x => ({ ...x }));
      else s.sched = s.sched.map(a => ({ ...a, frozen: undefined }));
      s.mail = [];
      await store.putMain(s, version);
      await store.clearLists('loto_mail'); await store.clearLists('loto_hist');
      return { ok: true, tickets: Object.values(s.tickets).map(t => ({ n: t.n, code: t.code, nums: G.nums(t).sort((a, b) => a - b) })) };
    },
    async seasonSave({ key, name, startDate, norm, prizes }) {
      const { result } = await mutate(s => {
        needStaff(s, key, true);
        if (name !== undefined) { if (!String(name).trim()) throw err('BAD', 'Введите название сезона'); s.season.name = String(name).trim(); }
        if (startDate !== undefined && startDate !== s.season.startDate) {
          if (s.draws.length) throw err('RUNNING', 'После первого розыгрыша дату старта менять нельзя');
          if (new Date(startDate + 'T00:00:00Z').getUTCDay() !== 2) throw err('BAD_DATE', 'Дата старта должна быть вторником');
          s.season.startDate = startDate;
        }
        if (norm !== undefined && Number(norm) !== s.season.norm) {
          if (s.draws.length) throw err('RUNNING', 'После старта норму менять нельзя');
          const n = Math.floor(Number(norm)); if (!n || n < 10) throw err('BAD', 'Норма — целое число от 10'); s.season.norm = n;
        }
        if (prizes !== undefined) s.season.prizes = prizes.map(String).map(x => x.trim()).filter(Boolean);
        return { ok: true };
      });
      return result;
    },
    async ticketsExport({ key }) {
      const { state: s } = await read(); needStaff(s, key, true);
      return { tickets: Object.values(s.tickets).map(t => ({ n: t.n, code: t.code, active: t.active, burned: t.burned, nums: G.nums(t).sort((a, b) => a - b) })) };
    },
    async reissue({ key, n }) {
      const { result } = await mutate(s => { needStaff(s, key, true); return { n: Number(n), code: G.reissueCode(s, Number(n), rnd) }; });
      return result;
    },
    async schedAdd({ key, date, text }) {
      const { result } = await mutate(s => {
        needStaff(s, key, true); if (!String(text || '').trim()) throw err('BAD', 'Введите текст');
        const off = Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(s.season.startDate + 'T00:00:00Z')) / G.DAY);
        if (!Number.isFinite(off)) throw err('BAD', 'Выберите дату');
        s.sched.push({ id: ++s.seq, off, text: String(text).trim() }); return { ok: true };
      });
      return result;
    },
    async schedDel({ key, id }) { const { result } = await mutate(s => { needStaff(s, key, true); s.sched = s.sched.filter(a => a.id !== Number(id)); return { ok: true }; }); return result; },
    async postNow({ key, text }) {
      const { result } = await mutate((s, now) => { needStaff(s, key, true); if (!String(text || '').trim()) throw err('BAD', 'Введите текст'); s.posts.push({ id: ++s.seq, at: now, text: String(text).trim() }); return { ok: true }; });
      return result;
    },
    async keyAdd({ key, label }) {
      const { result } = await mutate(s => {
        needStaff(s, key, true); label = String(label || '').trim();
        if (!label) throw err('BAD', 'Введите метку'); if (s.keys.some(k => k.label === label)) throw err('BAD', 'Такая метка уже есть');
        const used = new Set(s.keys.map(k => k.code)); const code = G.genCode(8, used, rnd);
        s.keys.push({ code, label, role: 'checker', active: true }); return { code };
      });
      return result;
    },
    async keyToggle({ key, code }) {
      const { result } = await mutate(s => { needStaff(s, key, true); const k = s.keys.find(x => x.code === code); if (!k) throw err('BAD', 'Нет такого ключа'); k.active = !k.active; return { active: k.active }; });
      return result;
    },
    async staffCheck({ key }) {
      const { state: s } = await read();
      if (!s) { needStaffNoSeason(key); return { role: 'owner', label: 'Владелец' }; }
      const k = needStaff(s, key); return { role: k.role, label: k.label };
    },
  };
  function needStaffNoSeason(key) { if (!ownerKey || String(key || '').trim().toUpperCase() !== ownerKey.toUpperCase()) throw err('NO_ACCESS', 'Неверный ключ'); }

  const LIM = { comment: 1000, text: 2000, label: 40, name: 80 };
  return async function handle(body) {
    for (const [k, n] of Object.entries(LIM)) if (body && typeof body[k] === 'string' && body[k].length > n) return { status: 400, body: { error: 'TOO_LONG', message: 'Слишком длинный текст' } };
    if (body && Array.isArray(body.prizes)) body.prizes = body.prizes.slice(0, 20).map(x => String(x).slice(0, 200));
    if (body && Array.isArray(body.codes)) body.codes = body.codes.slice(0, 10);
    try {
      const h = handlers[body && body.action];
      if (!h) return { status: 400, body: { error: 'BAD_ACTION', message: 'Неизвестное действие' } };
      return { status: 200, body: await h(body) };
    } catch (e) {
      if (e instanceof G.GameError) return { status: 400, body: { error: e.code, message: e.message } };
      console.error(e); return { status: 500, body: { error: 'SERVER', message: 'Ошибка сервера. Попробуйте позже' } };
    }
  };
}
module.exports = { makeApi, DEFAULT_SCHED };
