'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { createApi, HttpError } = require('./api');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, headers, payload) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(payload);
}

function sendJson(res, status, body, headers = {}) {
  send(res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
    JSON.stringify(body));
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA fallback
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, {}, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
    send(res, 200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' },
      req.method === 'HEAD' ? undefined : data);
  });
}

function createServer({ dbFile = ':memory:', secureCookies = false, logger = console } = {}) {
  const db = openDb(dbFile);
  const handleApi = createApi(db, { secureCookies });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, {}, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    }
    try {
      let body;
      if (!['GET', 'HEAD', 'DELETE'].includes(req.method)) {
        // Requiring a JSON content type blocks cross-site form posts (CSRF),
        // since browsers cannot send application/json cross-origin without CORS.
        const type = String(req.headers['content-type'] || '');
        if (!type.startsWith('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
        const text = await readBody(req);
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          throw new HttpError(400, 'Invalid JSON');
        }
      } else if (req.method === 'DELETE') {
        // DELETE has no body; require a custom header so it can't be forged cross-site.
        if (req.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'Missing X-Requested-With header');
      }
      const out = await handleApi(req, url, body);
      if (out.raw !== undefined) return send(res, out.status || 200, out.headers || {}, out.raw);
      return sendJson(res, out.status || 200, out.body, out.headers);
    } catch (err) {
      if (err instanceof HttpError) {
        return sendJson(res, err.status, { error: err.message, details: err.details });
      }
      logger.error(err);
      return sendJson(res, 500, { error: 'Internal server error' });
    }
  });
  server.db = db;
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'crm.db');
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const server = createServer({ dbFile, secureCookies: process.env.SECURE_COOKIES === '1' });
  server.listen(port, () => console.log(`CRM running at http://localhost:${port} (database: ${dbFile})`));
}
