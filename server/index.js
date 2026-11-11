'use strict';
// Точка входа для Yandex Cloud Functions.
// Переменные окружения функции:
//   DOCAPI_ENDPOINT, BUCKET — адреса базы и бакета
//   ACCESS_KEY_ID, SECRET_ACCESS_KEY — статический ключ сервисного аккаунта loto-robot
//   OWNER_KEY — ключ владельца для входа в Лаборантскую
//   TIME_SHIFT_DAYS — (необязательно) сдвиг времени для тестового прогона
const { cloudStore, bucketStore } = require('./store');
const { makeApi } = require('./api');
let api, ready, store;
function init() {
  if (api) return;
  const creds = { id: process.env.ACCESS_KEY_ID, secret: process.env.SECRET_ACCESS_KEY };
  // STORE=ydb — хранить игру в базе YDB; по умолчанию — в бакете (база Яндекса сейчас не отвечает на чтение)
  store = process.env.STORE === 'ydb' ? cloudStore({ endpoint: process.env.DOCAPI_ENDPOINT, bucket: process.env.BUCKET, creds }) : bucketStore({ bucket: process.env.BUCKET, creds });
  // Таблицы создаются один раз; ошибка здесь не должна вешать запросы
  ready = Promise.race([store.ensureTables().catch(e => { console.error('ensureTables', e.message); }), new Promise(r => setTimeout(r, 4000))]);
  // TIME_SHIFT_DAYS — только для тестового прогона: сдвигает часы игры вперёд на N дней. Для настоящего сезона — 0 или пусто.
  const shift = Number(process.env.TIME_SHIFT_DAYS || 0) * 864e5;
  api = makeApi({ store, ownerKey: process.env.OWNER_KEY, now: () => Date.now() + shift });
}
const { signHeaders } = require('./aws');
async function s3(method, key, body = '') {
  const url = `https://storage.yandexcloud.net/${process.env.BUCKET}/${key}`;
  const headers = signHeaders({ method, url, body, service: 's3', region: 'ru-central1', creds: { id: process.env.ACCESS_KEY_ID, secret: process.env.SECRET_ACCESS_KEY } });
  const r = await fetch(url, { method, headers, body: method === 'PUT' ? body : undefined, signal: AbortSignal.timeout(6000) });
  const t = await r.text(); if (!r.ok) throw new Error('S3 ' + r.status + ' ' + t.slice(0, 150)); return t;
}
// Проверка, что бакет честно отклоняет запись по устаревшей версии (защита от одновременных правок)
async function condTest() {
  await s3('PUT', 'diag/cond.txt', 'a');
  const st = async h => { const url = `https://storage.yandexcloud.net/${process.env.BUCKET}/diag/cond.txt`;
    const headers = signHeaders({ method: 'PUT', url, body: 'b', service: 's3', region: 'ru-central1', creds: { id: process.env.ACCESS_KEY_ID, secret: process.env.SECRET_ACCESS_KEY }, headers: h });
    return (await fetch(url, { method: 'PUT', headers, body: 'b', signal: AbortSignal.timeout(6000) })).status; };
  const a = await st({ 'if-none-match': '*' }), b = await st({ 'if-match': '"wrong"' });
  return { ifNoneMatch: a, ifMatch: b, safe: a === 412 && b === 412 };
}
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json; charset=utf-8' };
module.exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  init(); await ready;
  let body = {};
  try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : (event.body || '{}')); } catch (e) { /* пустое тело */ }
  if (body.action === 'diag') {
    const out = { env: { endpoint: !!process.env.DOCAPI_ENDPOINT, bucket: !!process.env.BUCKET, keyId: !!process.env.ACCESS_KEY_ID, secret: !!process.env.SECRET_ACCESS_KEY, owner: !!process.env.OWNER_KEY }, node: process.version, steps: [] };
    // Пробный вызов базы: только безопасные операции; в ответе — время и ошибка, без содержимого
    const SAFE = ['DescribeTable', 'ListTables', 'GetItem', 'Scan', 'Query'];
    const steps = body.op && SAFE.includes(body.op) ? [[body.op, () => store._call(body.op, body.payload || {})]]
      : [['describe', () => store._call('DescribeTable', { TableName: 'loto_main' })], ['getPlain', () => store._call('GetItem', { TableName: 'loto_main', Key: { id: { S: 'main' } } })],
         ['getMain', () => store.getMain()], ['condTest', condTest]];
    out.steps = await Promise.all(steps.map(async ([name, fn]) => {
      const t = Date.now(); try { const r = await fn(); return { name, ms: Date.now() - t, ok: true, size: JSON.stringify(r).length, ...(name === 'condTest' ? { cond: r } : {}) }; } catch (e) { return { name, ms: Date.now() - t, ok: false, error: String(e.message || e).slice(0, 300) }; }
    }));
    return { statusCode: 200, headers: CORS, body: JSON.stringify(out) };
  }
  const r = await api(body);
  return { statusCode: r.status, headers: CORS, body: JSON.stringify(r.body) };
};
