// Local Supabase with the Data API switched off, for the app only (Phase 11 proof).
//
// The shared GrowSpark database has its Data API (PostgREST, /rest/v1) switched off. This proxy stands in
// for that: it forwards everything to local Supabase (Auth, Storage, ...) except /rest/v1, which it
// refuses with 503 and records. Build and start the app through it, run the test suites (they keep using
// local Supabase directly to seed and compare), then read the record: it must be empty.
//
//   node tests/local-e2e/data-api-off-proxy.mjs                 (listens on 127.0.0.1:55321)
//   SUPABASE_URL_VIA=http://127.0.0.1:55321 npm run e2e:local:build && ...e2e:local:start
//   curl http://127.0.0.1:55321/__data-api-off/blocked          (the refused requests, as JSON)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';

const TARGET = { host: '127.0.0.1', port: 54321 };
const PORT = Number(process.env.DATA_API_OFF_PORT) || 55321;
const LOG = path.join(ROOT, 'tests', 'local-e2e', 'output', 'data-api-off-blocked.jsonl');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(LOG, '');
const blocked = [];
let forwarded = 0;

const server = http.createServer((req, res) => {
  if (req.url === '/__data-api-off/blocked') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ forwarded, blocked: blocked.length, requests: blocked }));
    return;
  }
  if (req.url.startsWith('/rest/v1')) {
    const entry = { at: new Date().toISOString(), method: req.method, path: decodeURIComponent(req.url).slice(0, 300), from: req.headers['user-agent']?.includes('Mozilla') ? 'browser' : 'server' };
    if (req.method !== 'OPTIONS') { blocked.push(entry); fs.appendFileSync(LOG, JSON.stringify(entry) + '\n'); }
    res.writeHead(req.method === 'OPTIONS' ? 204 : 503, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    });
    res.end(req.method === 'OPTIONS' ? '' : JSON.stringify({ code: 'DATA_API_OFF', message: 'The Data API is switched off' }));
    return;
  }
  forwarded++;
  const upstream = http.request({ ...TARGET, method: req.method, path: req.url, headers: { ...req.headers, host: `${TARGET.host}:${TARGET.port}` } }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (e) => { res.writeHead(502); res.end(String(e.message)); });
  req.pipe(upstream);
});
server.listen(PORT, '127.0.0.1', () => console.log(`Data API switched off: http://127.0.0.1:${PORT} -> local Supabase, /rest/v1 refused (record: ${LOG})`));
