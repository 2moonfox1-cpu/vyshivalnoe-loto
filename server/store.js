'use strict';
// Хранилище игры.
//  • loto_main  — одна запись «main»: всё состояние игры (сжато). Пишется атомарно с проверкой версии.
//  • loto_mail  — письма участницам, по записи на билет.
//  • loto_hist  — история проверенных отчётов, по записи на билет.
//  • бакет      — фото отчётов (до проверки).
const zlib = require('zlib');
const { signHeaders, presign } = require('./aws');

class Conflict extends Error { constructor() { super('conflict'); this.code = 'CONFLICT'; } }
const MAIL_KEEP = 40, HIST_KEEP = 40;

function cloudStore({ endpoint, bucket, region = 'ru-central1', creds }) {
  async function call(op, payload) {
    const body = JSON.stringify(payload);
    const headers = signHeaders({ method: 'POST', url: endpoint, body, service: 'dynamodb', region, creds,
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'DynamoDB_20120810.' + op } });
    const r = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(6000) });
    const text = await r.text(); const j = text ? JSON.parse(text) : {};
    if (!r.ok) { const t = String(j.__type || ''); const e = new Error(op + ': ' + (j.message || j.Message || r.status)); e.type = t; throw e; }
    return j;
  }
  const isMissing = e => /ResourceNotFound/.test(e.type || '') || /not found|does not exist/i.test(e.message);
  async function ensureTables() {
    for (const [name, key, type] of [['loto_main', 'id', 'S'], ['loto_mail', 't', 'N'], ['loto_hist', 't', 'N']]) {
      try { await call('DescribeTable', { TableName: name }); }
      catch (e) { if (!isMissing(e)) throw e; await call('CreateTable', { TableName: name, AttributeDefinitions: [{ AttributeName: key, AttributeType: type }], KeySchema: [{ AttributeName: key, KeyType: 'HASH' }] }); }
    }
  }
  const pack = o => zlib.gzipSync(Buffer.from(JSON.stringify(o))).toString('base64');
  const unpack = b => JSON.parse(zlib.gunzipSync(Buffer.from(b, 'base64')).toString());
  return {
    _call: call,
    ensureTables,
    async getMain() {
      const r = await call('GetItem', { TableName: 'loto_main', Key: { id: { S: 'main' } } });
      if (!r.Item) return { state: null, version: 0 };
      return { state: unpack(r.Item.data.B), version: Number(r.Item.v.N) };
    },
    async putMain(state, prevVersion) {
      try {
        await call('PutItem', { TableName: 'loto_main', Item: { id: { S: 'main' }, v: { N: String(prevVersion + 1) }, data: { B: pack(state) } },
          ConditionExpression: prevVersion ? 'v = :pv' : 'attribute_not_exists(id)', ...(prevVersion ? { ExpressionAttributeValues: { ':pv': { N: String(prevVersion) } } } : {}) });
      } catch (e) { if (/ConditionalCheckFailed/.test(e.type || '')) throw new Conflict(); throw e; }
    },
    async getLists(table, ts) {
      const out = {}; if (!ts.length) return out;
      for (let i = 0; i < ts.length; i += 100) {
        const r = await call('BatchGetItem', { RequestItems: { [table]: { Keys: ts.slice(i, i + 100).map(t => ({ t: { N: String(t) } })) } } });
        for (const it of (r.Responses && r.Responses[table]) || []) out[it.t.N] = JSON.parse(it.list.S);
      }
      return out;
    },
    async scanLists(table) {
      const out = {}; let start;
      do {
        const r = await call('Scan', { TableName: table, ...(start ? { ExclusiveStartKey: start } : {}) });
        for (const it of r.Items || []) out[it.t.N] = JSON.parse(it.list.S);
        start = r.LastEvaluatedKey;
      } while (start);
      return out;
    },
    async appendLists(table, byT, keep) {
      const cur = await this.getLists(table, Object.keys(byT));
      for (const [t, items] of Object.entries(byT)) {
        const list = [...(cur[t] || []), ...items].slice(-keep);
        await call('PutItem', { TableName: table, Item: { t: { N: String(t) }, list: { S: JSON.stringify(list) } } });
      }
    },
    async clearLists(table) {
      const all = await this.scanLists(table);
      for (const t of Object.keys(all)) await call('DeleteItem', { TableName: table, Key: { t: { N: t } } });
    },
    photoPutUrl: key => presign({ method: 'PUT', url: `https://storage.yandexcloud.net/${bucket}/${key}`, region, creds, expires: 900 }),
    photoGetUrl: key => presign({ method: 'GET', url: `https://storage.yandexcloud.net/${bucket}/${key}`, region, creds, expires: 3600 }),
    async deletePhoto(key) {
      const url = `https://storage.yandexcloud.net/${bucket}/${key}`;
      const headers = signHeaders({ method: 'DELETE', url, service: 's3', region, creds });
      await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000) }).catch(() => {});
    },
  };
}

// Хранилище целиком в Object Storage (бакете) — на случай, если база YDB недоступна.
//  state/main.json.gz — состояние игры; запись с проверкой версии (If-Match по ETag)
//  state/mail/<билет>.json — письма; state/hist.json.gz — история проверенных отчётов
function bucketStore({ bucket, region = 'ru-central1', creds }) {
  const base = `https://storage.yandexcloud.net/${bucket}/`;
  async function req(method, key, { body, headers = {} } = {}) {
    const url = base + key;
    const h = signHeaders({ method, url, body: body || '', service: 's3', region, creds, headers });
    return fetch(url, { method, headers: h, body, signal: AbortSignal.timeout(6000) });
  }
  const gz = o => zlib.gzipSync(Buffer.from(JSON.stringify(o)));
  const ungz = b => JSON.parse(zlib.gunzipSync(b).toString());
  async function getObj(key, packed) {
    const r = await req('GET', key);
    if (r.status === 404) return { data: null, etag: null };
    if (!r.ok) throw new Error('S3 GET ' + r.status + ' ' + (await r.text()).slice(0, 120));
    const buf = Buffer.from(await r.arrayBuffer());
    return { data: packed ? ungz(buf) : JSON.parse(buf.toString()), etag: r.headers.get('etag') };
  }
  async function putObj(key, data, packed, cond = {}) {
    const body = packed ? gz(data) : Buffer.from(JSON.stringify(data));
    const r = await req('PUT', key, { body, headers: { 'content-type': packed ? 'application/gzip' : 'application/json', ...cond } });
    if (r.status === 412 || r.status === 409) throw new Conflict();
    if (!r.ok) throw new Error('S3 PUT ' + r.status + ' ' + (await r.text()).slice(0, 120));
    return r.headers.get('etag');
  }
  const listKey = (table, t) => table === 'loto_mail' ? `state/mail/${t}.json` : null;
  return {
    _req: req,
    async ensureTables() {},
    async getMain() { const { data, etag } = await getObj('state/main.json.gz', true); return { state: data, version: data ? etag : 0 }; },
    async putMain(state, prev) { await putObj('state/main.json.gz', state, true, prev ? { 'if-match': prev } : { 'if-none-match': '*' }); },
    async getLists(table, ts) {
      if (table === 'loto_hist') { const all = (await getObj('state/hist.json.gz', true)).data || {}; return Object.fromEntries(ts.filter(t => all[t]).map(t => [t, all[t]])); }
      const out = {}; await Promise.all(ts.map(async t => { const { data } = await getObj(listKey(table, t)); if (data) out[t] = data; })); return out;
    },
    async scanLists(table) {
      if (table === 'loto_hist') return (await getObj('state/hist.json.gz', true)).data || {};
      throw new Error('scan only for hist');
    },
    async appendLists(table, byT, keep) {
      if (table === 'loto_hist') {
        for (let i = 0; i < 5; i++) {
          const { data, etag } = await getObj('state/hist.json.gz', true); const all = data || {};
          for (const [t, items] of Object.entries(byT)) all[t] = [...(all[t] || []), ...items].slice(-keep);
          try { await putObj('state/hist.json.gz', all, true, etag ? { 'if-match': etag } : { 'if-none-match': '*' }); return; } catch (e) { if (!(e instanceof Conflict)) throw e; }
        }
        return;
      }
      await Promise.all(Object.entries(byT).map(async ([t, items]) => {
        const { data } = await getObj(listKey(table, t)); await putObj(listKey(table, t), [...(data || []), ...items].slice(-keep), false);
      }));
    },
    async clearLists(table) {
      if (table === 'loto_hist') { await req('DELETE', 'state/hist.json.gz'); return; }
      await Promise.all(Array.from({ length: 100 }, (_, i) => req('DELETE', listKey(table, i + 1)).catch(() => {})));
    },
    photoPutUrl: key => presign({ method: 'PUT', url: base + key, region, creds, expires: 900 }),
    photoGetUrl: key => presign({ method: 'GET', url: base + key, region, creds, expires: 3600 }),
    async deletePhoto(key) { await req('DELETE', key).catch(() => {}); },
  };
}

// Хранилище в памяти — для проверок без облака
function memoryStore() {
  let main = null, version = 0; const lists = { loto_mail: {}, loto_hist: {} }; const photos = new Set(), deleted = [];
  return {
    _photos: photos, _deleted: deleted,
    async ensureTables() {},
    async getMain() { return { state: main ? JSON.parse(main) : null, version }; },
    async putMain(state, prev) { if (prev !== version) throw new Conflict(); main = JSON.stringify(state); version++; },
    async getLists(table, ts) { const o = {}; for (const t of ts) if (lists[table][t]) o[t] = JSON.parse(JSON.stringify(lists[table][t])); return o; },
    async scanLists(table) { return JSON.parse(JSON.stringify(lists[table])); },
    async appendLists(table, byT, keep) { for (const [t, it] of Object.entries(byT)) lists[table][t] = [...(lists[table][t] || []), ...it].slice(-keep); },
    async clearLists(table) { lists[table] = {}; },
    photoPutUrl: key => { photos.add(key); return 'mem://put/' + key; },
    photoGetUrl: key => 'mem://get/' + key,
    async deletePhoto(key) { deleted.push(key); photos.delete(key); },
  };
}
module.exports = { cloudStore, bucketStore, memoryStore, Conflict, MAIL_KEEP, HIST_KEEP };
