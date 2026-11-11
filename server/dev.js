'use strict';
// Локальный сервер для проверки приложения без облака: node server/dev.js → http://localhost:8787
// Время можно перематывать: POST /api {action:'devTime', days: N}
const http = require('http'), fs = require('fs'), path = require('path');
const { makeApi } = require('./api'); const { memoryStore } = require('./store');
const PORT = +process.env.PORT || 8787, WEB = path.join(__dirname, '..', 'web');
let shift = Number(process.env.SHIFT_DAYS || 0) * 864e5;
const store = memoryStore(), photos = new Map();
store.photoPutUrl = key => `http://localhost:${PORT}/photo/${key}`;
store.photoGetUrl = key => `http://localhost:${PORT}/photo/${key}`;
const del = store.deletePhoto; store.deletePhoto = async k => { photos.delete(k); return del(k); };
const api = makeApi({ store, ownerKey: 'OWNER-DEV', now: () => Date.now() + shift });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' };
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', async () => {
    const body = Buffer.concat(chunks);
    if (req.url.startsWith('/photo/')) {
      const k = decodeURIComponent(req.url.slice(7).split('?')[0]);
      if (req.method === 'PUT') { photos.set(k, body); res.writeHead(200, cors); return res.end(); }
      if (photos.has(k)) { res.writeHead(200, { ...cors, 'Content-Type': 'image/jpeg' }); return res.end(photos.get(k)); }
      res.writeHead(404, cors); return res.end();
    }
    if (req.url === '/api' && req.method === 'POST') {
      const b = JSON.parse(body.toString() || '{}');
      if (b.action === 'devTime') { shift += (b.days || 0) * 864e5 + (b.hours || 0) * 36e5; res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ now: new Date(Date.now() + shift).toISOString() })); }
      const r = await api(b); res.writeHead(r.status, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r.body));
    }
    let f = req.url.split('?')[0]; if (f === '/') f = '/index.html';
    const fp = path.join(WEB, path.normalize(f));
    if (!fp.startsWith(WEB) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('not found'); }
    if (f === '/config.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end("window.LOTO_API='/api';"); }
    let data = fs.readFileSync(fp);
    res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8' }); res.end(data);
  });
}).listen(PORT, () => console.log('Локальный сервер: http://localhost:' + PORT));
