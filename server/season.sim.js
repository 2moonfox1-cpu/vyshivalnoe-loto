'use strict';
// Полный сезон: 100 билетов, ~60 участниц, разное поведение. Проверяем правила и размер данных.
const assert = require('assert'), zlib = require('zlib');
const { makeApi } = require('./api'); const { memoryStore } = require('./store');
let NOW = Date.parse('2026-12-01T09:00:00Z'); const store = memoryStore();
let mainBytes = 0; const put = store.putMain; store.putMain = async (s, v) => { mainBytes = Math.max(mainBytes, zlib.gzipSync(JSON.stringify(s)).length); return put(s, v); };
const api = makeApi({ store, ownerKey: 'O', now: () => NOW });
const call = async b => { const r = await api(b); if (r.status !== 200 && !['NORM','FRIDAY','BURNED','OVER','NO_CODE','FIX_NUMS','BAD_NUMS','NO_REPORT'].includes(r.body.error)) throw new Error(JSON.stringify(r.body)); return r.body; };
const H = 36e5, DAY = 24 * H;
(async () => {
  const sn = await call({ action: 'seasonNew', key: 'O', name: 'Зима', startDate: '2026-12-08', norm: 200, prizes: ['Сыч'] });
  await call({ action: 'keyAdd', key: 'O', label: 'П-1' });
  // 60 участниц, у каждой 1–3 билета; характер: прилежная / забывчивая / ленивая
  const people = []; let ti = 0;
  for (let i = 0; i < 60 && ti < 100; i++) { const k = 1 + (i % 3); const cs = sn.tickets.slice(ti, ti + k).map(t => t.code); ti += k; people.push({ codes: cs, kind: ['good', 'forget', 'lazy'][i % 3] }); }
  for (const p of people) { const ok = []; for (const c of p.codes) { await call({ action: 'activate', code: c, codes: ok }); ok.push(c); } }
  let weeks = 0, reports = 0, rejects = 0; const sent = new Set();
  while (true) {
    NOW += 7 * DAY; // новый вторник 12:00 МСК
    const st0 = await call({ action: 'state', codes: [] }); if (st0.over) break; weeks++;
    NOW += 2 * DAY;
    for (const p of people) {
      const st = await call({ action: 'state', codes: p.codes });
      for (const t of st.tickets) {
        if (!t.canReport) continue;
        if (p.kind === 'lazy' && Math.random() < 0.35) continue;
        if (p.kind === 'forget' && Math.random() < 0.15) continue;
        const nums = t.fix ? t.fix.nums : t.owed; const due = nums.reduce((a, x) => a + (t.debt.includes(x) ? 400 : 200), 0);
        const b = await call({ action: 'uploadUrl', code: t.code, kind: 'before' }), a = await call({ action: 'uploadUrl', code: t.code, kind: 'after' });
        const r = await call({ action: 'submit', code: t.code, nums, stitched: due, photos: { before: b.key, after: a.key } });
        if (r.id) { reports++; sent.add(b.key); sent.add(a.key); }
      }
    }
    NOW += 2 * DAY; // проверка в пятницу
    const lab = await call({ action: 'lab', key: 'O', codes: [] });
    for (const r of lab.pending) { const rej = Math.random() < 0.05; if (rej) rejects++; await call({ action: 'review', key: 'O', codes: [], id: r.id, accept: !rej, comment: rej ? 'Нет КС' : '' }); }
    // исправления в субботу
    NOW += 1 * DAY;
    for (const p of people) { const st = await call({ action: 'state', codes: p.codes }); for (const t of st.tickets) if (t.fix && p.kind !== 'lazy') {
      const b = await call({ action: 'uploadUrl', code: t.code, kind: 'before' }), a = await call({ action: 'uploadUrl', code: t.code, kind: 'after' });
      const rr = await call({ action: 'submit', code: t.code, nums: t.fix.nums, stitched: t.fix.nums.length * 400, photos: { before: b.key, after: a.key } }); if (rr.id) { sent.add(b.key); sent.add(a.key); } } }
    const lab2 = await call({ action: 'lab', key: 'O', codes: [] });
    for (const r of lab2.pending) await call({ action: 'review', key: 'O', codes: [], id: r.id, accept: true });
    NOW -= 5 * DAY; // вернуться ко вторнику (+7 в начале цикла)
    if (weeks > 20) throw new Error('сезон не закончился');
  }
  const st = await call({ action: 'state', codes: [] }); const lab = await call({ action: 'lab', key: 'O', codes: [] });
  const burned = lab.tickets.filter(t => t.burned).length;
  assert.ok(st.over && st.winner, 'есть победитель');
  const w = lab.tickets.find(t => t.n === st.winner.n); assert.ok(w && !w.burned, 'победитель не сгорел');
  if (!st.winner.closest) assert.strictEqual(w.closed, 15, 'победитель закрыл 15');
  const left = [...store._photos].filter(k => sent.has(k)); assert.ok(left.length === 0, 'фото отправленных отчётов удалены: осталось ' + left.length);
  const orphans = store._photos.size;
  console.log(`Недель: ${weeks}, бочонков: ${st.drawn}, отчётов: ${reports}, отклонено: ${rejects}`);
  console.log(`Победил билет № ${st.winner.n}${st.winner.closest ? ' (ближе всех к финишу)' : ''}, сгорело билетов: ${burned}`);
  console.log(`Объявление: ${st.board.slice(0, 70)}…`);
  console.log(`Фото, загруженных без отправки отчёта (удалит правило хранилища): ${orphans}`);
  console.log(`Макс. размер состояния в базе (сжато): ${(mainBytes / 1024).toFixed(1)} КБ`);
})().catch(e => { console.error('ОШИБКА', e); process.exit(1); });
