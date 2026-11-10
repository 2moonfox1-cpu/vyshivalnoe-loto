'use strict';
const assert = require('assert');
const G = require('./game.js');
let seed = 42; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const D = G.DAY;
const at = (s, day, hour = 12) => G.startMs(s) + day * D + hour * 3600e3; // day 0 = день старта (вт)
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; };
const throwsCode = (fn, code) => { try { fn(); } catch (e) { assert.strictEqual(e.code, code, e.message); pass++; return; } assert.fail('expected ' + code); };

// 1. Генерация
let s = G.newSeason(null, { name: 'Тест', startDate: '2026-12-08', norm: 200, prizes: ['Сыч'] }, rnd);
const T = Object.values(s.tickets);
ok(T.length === 100, '100 билетов');
ok(T.every(t => t.grid.every(r => r.filter(Boolean).length === 5) && G.nums(t).length === 15), 'по 5 чисел в строке');
ok(new Set(T.map(t => t.code)).size === 100, 'коды уникальны');
throwsCode(() => G.newSeason(null, { name: 'x', startDate: '2026-12-09' }, rnd), 'BAD_DATE');

// 2. Активация: окно раздачи
throwsCode(() => G.activate(s, T[0].code, [], at(s, -8)), 'CLOSED');
ok(G.activate(s, T[0].code, [], at(s, -3)) === 1, 'активация в раздачу');
throwsCode(() => G.activate(s, T[0].code, [T[0].code], at(s, -3)), 'MINE');
throwsCode(() => G.activate(s, T[0].code, [], at(s, -3)), 'TAKEN');
throwsCode(() => G.activate(s, 'ZZZZZZ', [], at(s, -3)), 'NO_CODE');
throwsCode(() => G.activate(s, T[6].code, [1, 2, 3, 4, 5].map(i => T[i].code), at(s, -3)), 'LIMIT');
ok(G.activate(s, T[1].code, [], at(s, 0, 23)) === 2, 'активация в день старта до 23:59');
throwsCode(() => G.activate(s, T[2].code, [], at(s, 1, 0)), 'CLOSED');

// 3. Розыгрыш
ok(!G.tick(s, at(s, -1), rnd) && s.drawn.length === 0, 'до старта бочонков нет');
G.tick(s, at(s, 0, 0) + 1, rnd); ok(s.drawn.length === 6 && s.processedWeek === 1, 'первый розыгрыш');
ok(!G.tick(s, at(s, 3), rnd), 'повторный tick ничего не меняет');

// 4. Отчёт, норма, пропуски, долг, сгорание — сценарий на подконтрольном билете
s = G.newSeason(null, { name: 'Тест', startDate: '2026-12-08', norm: 200 }, rnd);
const t = s.tickets[1]; t.active = true;
const n15 = G.nums(t);
// подменяем розыгрыш: неделя 1 — три числа билета
const forceDraw = (balls) => { s.drawn.push(...balls); s.draws.push({ week: s.draws.length + 1, balls }); s.processedWeek++; };
s.processedWeek = 0; forceDraw([n15[0], n15[1], n15[2], ...[1,2,3,4,5,6,7,8,9,10,11,12].filter(x=>!n15.includes(x)).slice(0,3)]);
throwsCode(() => G.submitReport(s, { code: t.code, nums: [n15[0]], stitched: 199, photos: { before: 'a', after: 'b' } }, at(s, 1)), 'NORM');
throwsCode(() => G.submitReport(s, { code: t.code, nums: [n15[0]], stitched: 200, photos: { before: 'a' } }, at(s, 1)), 'PHOTOS');
const r1 = G.submitReport(s, { code: t.code, nums: [n15[0]], stitched: 200, photos: { before: 'a', after: 'b' } }, at(s, 1));
ok(t.pending.includes(n15[0]), 'на проверке');
s.keys.push({ code: 'OWNERKEY', label: 'Владелец', role: 'owner', active: true }, { code: 'HELPKEY1', label: 'П-1', role: 'checker', active: true });
throwsCode(() => G.review(s, 'HELPKEY1', [t.code], { id: r1.id, accept: true }, at(s, 2)), 'OWN');
throwsCode(() => G.review(s, 'HELPKEY1', [], { id: r1.id, accept: false }, at(s, 2)), 'COMMENT');
const rv = G.review(s, 'HELPKEY1', [], { id: r1.id, accept: true, comment: 'Красиво' }, at(s, 2));
ok(t.closed.includes(n15[0]) && rv.removedPhotos && r1.photos === null, 'принят, фото удалены');
// конец недели 1: два числа не сданы -> долг
const deadlineAndDraw = (balls) => { s.processedWeek; const G2 = require('./game.js'); };
// вызываем внутренний цикл через tick с подменённым rnd невозможен, поэтому моделируем deadline через tick на неделю 2 с пустым розыгрышем
const realTick = (day) => G.tick(s, at(s, day, 0) + 1, rnd);
realTick(7);
ok(t.debt.includes(n15[1]) && t.debt.includes(n15[2]), 'пропуск -> долг ×2');
ok(G.cost(s, t, n15[1]) === 400, 'долг стоит 400');
// неделя 2 не сдаём -> сгорание в конце
realTick(14);
ok(t.burned, 'два пропуска подряд -> сгорел');
throwsCode(() => G.submitReport(s, { code: t.code, nums: [n15[1]], stitched: 400, photos: { before: 'a', after: 'b' } }, at(s, 15)), 'BURNED');

// 5. Отклонение и правило пятницы
s = G.newSeason(null, { name: 'Тест', startDate: '2026-12-08', norm: 200 }, rnd);
s.keys.push({ code: 'OWNERKEY', label: 'Владелец', role: 'owner', active: true });
const u = s.tickets[5]; u.active = true; const m = G.nums(u);
s.drawn.push(m[0]); s.draws.push({ week: 1, balls: [m[0]] }); s.processedWeek = 1;
const ra = G.submitReport(s, { code: u.code, nums: [m[0]], stitched: 200, photos: { before: 'a', after: 'b' } }, at(s, 5));
s.drawn.push(m[1]); s.draws.push({ week: 2, balls: [m[1]] }); s.processedWeek = 2; // наступила неделя 2 (без deadline-обработки; отчёт был на проверке)
G.review(s, 'OWNERKEY', [u.code], { id: ra.id, accept: false, comment: 'Нет КС' }, at(s, 8));
ok(u.fix && u.fix.rejWeek === 2 && u.fix.repWeek === 1, 'отклонён, ждём исправления');
throwsCode(() => G.submitReport(s, { code: u.code, nums: [m[1]], stitched: 200, photos: { before: 'a', after: 'b' } }, at(s, 8)), 'FIX_NUMS');
G.submitReport(s, { code: u.code, nums: [m[0]], stitched: 200, photos: { before: 'a', after: 'b' } }, at(s, 8));
throwsCode(() => G.submitReport(s, { code: u.code, nums: [m[1]], stitched: 200, photos: { before: 'a', after: 'b' } }, at(s, 9)), 'FRIDAY');
ok(G.submitReport(s, { code: u.code, nums: [m[1]], stitched: 200, photos: { before: 'a', after: 'b' } }, at(s, 10)).id > 0, 'с пятницы можно');

// 6. Неисправленное позднее отклонение -> сгорание
s = G.newSeason(null, { name: 'Тест', startDate: '2026-12-08', norm: 200 }, rnd);
s.keys.push({ code: 'OWNERKEY', label: 'Владелец', role: 'owner', active: true });
const w = s.tickets[7]; w.active = true; const q = G.nums(w);
G.tick(s, at(s, 0, 0) + 1, rnd);
const mine = G.owed(s, w);
if (mine.length) {
  const rq = G.submitReport(s, { code: w.code, nums: mine, stitched: 200 * mine.length, photos: { before: 'a', after: 'b' } }, at(s, 6));
  G.tick(s, at(s, 7, 0) + 1, rnd);
  G.review(s, 'OWNERKEY', [], { id: rq.id, accept: false, comment: 'Нет КС' }, at(s, 8));
  G.tick(s, at(s, 14, 0) + 1, rnd);
  ok(w.burned, 'не исправила отклонённый -> сгорел');
} else pass++;

// 7. Победа и ничья
s = G.newSeason(null, { name: 'Тест', startDate: '2026-12-08', norm: 200 }, rnd);
s.keys.push({ code: 'OWNERKEY', label: 'Владелец', role: 'owner', active: true });
const A = s.tickets[10], B = s.tickets[11]; A.active = B.active = true;
const na = G.nums(A), nb = G.nums(B);
s.drawn.push(...new Set([...na, ...nb])); s.processedWeek = 2;
A.closed = na.slice(0, 14); B.closed = nb.slice(0, 14);
const lastA = na[14], lastB = nb[14];
const rA = G.submitReport(s, { code: A.code, nums: [lastA], stitched: 200, photos: { before: 'a', after: 'b' } }, at(s, 9, 10));
const rB = G.submitReport(s, { code: B.code, nums: [lastB], stitched: 200, photos: { before: 'a', after: 'b' } }, at(s, 9, 9));
G.review(s, 'OWNERKEY', [], { id: rA.id, accept: true }, at(s, 10));
ok(!s.winner, 'ждём более ранний отчёт B');
G.review(s, 'OWNERKEY', [], { id: rB.id, accept: true }, at(s, 10, 13));
ok(s.winner && s.winner.n === B.n && s.over, 'побеждает раньше отправивший');

// 8. Полный сезон без закрытия -> ближайший к финишу
s = G.newSeason(null, { name: 'Тест', startDate: '2026-12-08', norm: 200 }, rnd);
const C = s.tickets[20], E = s.tickets[21]; C.active = E.active = true;
for (let d = 0; d <= 15 * 7; d += 7) {
  G.tick(s, at(s, d, 0) + 1, rnd);
  for (const x of [C, E]) { if (x.burned) continue; const o = G.owed(s, x); x.closed.push(...o.slice(x === C ? 0 : 1)); x.debt = x.debt.filter(v => !x.closed.includes(v)); if (x === E && o.length) x.debt = []; }
}
ok(s.drawn.length === 90 && s.over, 'сезон завершился после 90 бочонков');
ok(s.winner && s.winner.closest, 'есть победитель — ближайший к финишу');
console.log('Пройдено проверок:', pass);
