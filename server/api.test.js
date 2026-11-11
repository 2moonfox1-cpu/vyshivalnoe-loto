'use strict';
const assert = require('assert');
const { makeApi } = require('./api');
const { memoryStore } = require('./store');
let NOW = Date.parse('2026-12-01T09:00:00Z'); // вт 01.12, 12:00 МСК — неделя раздачи
const store = memoryStore();
const api = makeApi({ store, ownerKey: 'OWNER123', now: () => NOW });
const call = async (b, expectErr) => { const r = await api(b); if (expectErr) { assert.strictEqual(r.body.error, expectErr, JSON.stringify(r.body)); return r.body; } assert.strictEqual(r.status, 200, JSON.stringify(r.body)); return r.body; };
const DAY = 864e5; let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; };
(async () => {
  ok((await call({ action: 'state', codes: [] })).noSeason, 'нет сезона');
  await call({ action: 'seasonNew', key: 'WRONG', name: 'Зима', startDate: '2026-12-08', norm: 200 }, 'NO_ACCESS');
  const sn = await call({ action: 'seasonNew', key: 'owner123', name: 'Зима-2026', startDate: '2026-12-08', norm: 200, prizes: ['Сыч'] });
  ok(sn.tickets.length === 100, '100 билетов с кодами');
  const codeA = sn.tickets[0].code, codeB = sn.tickets[1].code;
  let st = await call({ action: 'state', codes: [] });
  ok(st.board.includes('Сезон «Зима-2026» открыт'), 'объявление раздачи: ' + st.board);
  ok(st.canActivate, 'приём кодов открыт');
  await call({ action: 'activate', code: codeA, codes: [] });
  await call({ action: 'activate', code: codeA.toLowerCase(), codes: [codeA] }, 'MINE');
  await call({ action: 'activate', code: codeB, codes: [codeA] });
  // помощница
  const hk = await call({ action: 'keyAdd', key: 'OWNER123', label: 'П-1' });
  ok(hk.code.length === 8, 'ключ помощницы');
  ok((await call({ action: 'staffCheck', key: hk.code })).role === 'checker', 'вход помощницы');
  await call({ action: 'seasonSave', key: hk.code, norm: 300 }, 'NO_ACCESS');
  await call({ action: 'seasonSave', key: 'OWNER123', prizes: ['Брелок-сыч', 'Органайзер'] });
  // старт: вт 08.12 00:00 МСК = 07.12 21:00 UTC
  NOW = Date.parse('2026-12-07T21:00:01Z');
  st = await call({ action: 'state', codes: [codeA, codeB] });
  ok(st.week === 1 && st.lastDraw.length === 6, 'первый розыгрыш случился сам');
  ok(st.board.includes('Мешочек открыт'), 'объявление старта');
  await call({ action: 'seasonSave', key: 'OWNER123', norm: 300 }, 'RUNNING');
  // отчёт по билету, у которого есть совпадения (если нет — подождём недели)
  let t, guard = 0;
  while (!(t = st.tickets.find(x => x.canReport)) && guard++ < 10) { NOW += 7 * DAY; st = await call({ action: 'state', codes: [codeA, codeB] }); }
  ok(!!t, 'есть что сдавать');
  const code = t.n === 1 ? codeA : codeB;
  const up1 = await call({ action: 'uploadUrl', code, kind: 'before' }), up2 = await call({ action: 'uploadUrl', code, kind: 'after' });
  await call({ action: 'submit', code, nums: t.owed, stitched: 10, photos: { before: up1.key, after: up2.key } }, 'NORM');
  await call({ action: 'submit', code, nums: t.owed, stitched: t.due, photos: { before: 'p/x/1/a.jpg', after: up2.key } }, 'PHOTOS');
  const sub = await call({ action: 'submit', code, nums: t.owed, stitched: t.due, photos: { before: up1.key, after: up2.key } });
  // помощница со «своим» билетом не видит отчёт
  let lab = await call({ action: 'lab', key: hk.code, codes: [code] });
  ok(lab.pending.length === 0 && lab.hiddenOwn === 1, 'свой отчёт скрыт у помощницы');
  lab = await call({ action: 'lab', key: 'OWNER123', codes: [code] });
  ok(lab.pending.length === 1 && lab.pending[0].mine && lab.pending[0].photos.before.startsWith('mem://get/'), 'владелец видит свой отчёт с фото');
  await call({ action: 'review', key: hk.code, codes: [], id: sub.id, accept: false }, 'COMMENT');
  await call({ action: 'review', key: hk.code, codes: [], id: sub.id, accept: true, comment: 'Красиво' });
  ok(store._deleted.includes(up1.key) && store._deleted.includes(up2.key), 'фото удалены после приёма');
  st = await call({ action: 'state', codes: [codeA, codeB] });
  const tv = st.tickets.find(x => x.n === t.n);
  ok(tv.closed.length === t.owed.length, 'числа закрыты');
  ok(st.mail.some(m => m.text.includes('принят') && m.text.includes('Красиво')), 'письмо с комментарием');
  ok(Object.values(st.hist).flat().some(h => h.by === 'П-1'), 'история: кто проверил');
  ok(st.totals.mine === t.due && st.draws.find(d => d.week === st.week).mine >= 0, 'крестики учтены');
  lab = await call({ action: 'lab', key: 'OWNER123', codes: [] });
  ok(lab.checked.length === 1 && lab.tickets.length === 2 && lab.activated === 2, 'лаборантская: проверенные и билеты');
  // объявления
  await call({ action: 'postNow', key: 'OWNER123', text: 'Срочно!' });
  ok((await call({ action: 'state', codes: [] })).board === 'Срочно!', 'срочное объявление на доске');
  // перевыпуск кода
  const re = await call({ action: 'reissue', key: 'OWNER123', n: 1 });
  st = await call({ action: 'state', codes: [codeA] });
  ok(st.tickets.length === 0 && st.lostCodes.includes(codeA) && re.code !== codeA, 'старый код больше не работает');
  // пропуски: проматываем 3 недели без отчётов по билету 2
  for (let i = 0; i < 4; i++) { NOW += 7 * DAY; await call({ action: 'state', codes: [] }); }
  lab = await call({ action: 'lab', key: 'OWNER123', codes: [] });
  ok(lab.tickets.every(x => x.burned || (x.owed + x.debt === 0)), 'без отчётов билеты сгорают');
  console.log('API: пройдено проверок', pass);
})().catch(e => { console.error(e); process.exit(1); });
