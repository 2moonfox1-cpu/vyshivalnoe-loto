'use strict';
// Подпись запросов AWS Signature V4 — для Document API (YDB) и Object Storage. Без сторонних библиотек.
const crypto = require('crypto');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s, 'utf8').digest();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = p => p.split('/').map(enc).join('/');
function stamp(now) { const d = new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, ''); return { amz: d, day: d.slice(0, 8) }; }
function keyFor(secret, day, region, service) { return hmac(hmac(hmac(hmac('AWS4' + secret, day), region), service), 'aws4_request'); }

// Подпись заголовками (обычный запрос)
function signHeaders({ method, url, headers = {}, body = '', service, region, creds, now = Date.now() }) {
  const u = new URL(url), { amz, day } = stamp(now);
  const h = { ...headers, host: u.host, 'x-amz-date': amz, 'x-amz-content-sha256': sha(body) };
  const names = Object.keys(h).map(k => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const query = [...u.searchParams].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => enc(k) + '=' + enc(v)).join('&');
  const canon = [method, encPath(decodeURIComponent(u.pathname)), query, names.map(n => n + ':' + lower[n]).join('\n') + '\n', names.join(';'), lower['x-amz-content-sha256']].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amz, scope, sha(canon)].join('\n');
  const sig = crypto.createHmac('sha256', keyFor(creds.secret, day, region, service)).update(sts).digest('hex');
  h.Authorization = `AWS4-HMAC-SHA256 Credential=${creds.id}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
  return h;
}

// Подпись в ссылке (presigned URL) — чтобы браузер сам загрузил/показал фото
function presign({ method, url, service = 's3', region, creds, expires = 900, now = Date.now() }) {
  const u = new URL(url), { amz, day } = stamp(now), scope = `${day}/${region}/${service}/aws4_request`;
  const q = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${creds.id}/${scope}`, 'X-Amz-Date': amz, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': 'host' };
  const query = Object.keys(q).sort().map(k => enc(k) + '=' + enc(q[k])).join('&');
  const canon = [method, encPath(decodeURIComponent(u.pathname)), query, 'host:' + u.host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amz, scope, sha(canon)].join('\n');
  const sig = crypto.createHmac('sha256', keyFor(creds.secret, day, region, service)).update(sts).digest('hex');
  return `${u.origin}${encPath(decodeURIComponent(u.pathname))}?${query}&X-Amz-Signature=${sig}`;
}
module.exports = { signHeaders, presign };
