'use strict';

const { tx } = require('./db');
const auth = require('./auth');
const { resources, DEAL_STAGES } = require('./resources');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validate and normalize a request body against a resource's field definitions.
// With partial=true (updates) missing fields are left alone.
function validate(db, orgId, fields, body, partial) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  const values = {};
  const errors = {};
  for (const [name, def] of Object.entries(fields)) {
    if (!(name in body)) {
      if (!partial && def.required) errors[name] = 'is required';
      continue;
    }
    let v = body[name];
    if (typeof v === 'string') v = v.trim();
    if (v === '' || v === null || v === undefined) {
      if (def.required) errors[name] = 'is required';
      else values[name] = null;
      continue;
    }
    switch (def.type) {
      case 'text':
        if (typeof v !== 'string') errors[name] = 'must be text';
        else if (def.max && v.length > def.max) errors[name] = `must be at most ${def.max} characters`;
        else values[name] = v;
        break;
      case 'email':
        if (typeof v !== 'string' || !EMAIL_RE.test(v) || v.length > 254) errors[name] = 'must be a valid email';
        else values[name] = v.toLowerCase();
        break;
      case 'number': {
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n)) errors[name] = 'must be a number';
        else if (def.min !== undefined && n < def.min) errors[name] = `must be at least ${def.min}`;
        else values[name] = n;
        break;
      }
      case 'date':
        if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
          errors[name] = 'must be a date (YYYY-MM-DD)';
        } else values[name] = v;
        break;
      case 'enum':
        if (!def.values.includes(v)) errors[name] = `must be one of: ${def.values.join(', ')}`;
        else values[name] = v;
        break;
      case 'bool':
        values[name] = v === true || v === 1 || v === 'true' || v === '1' ? 1 : 0;
        break;
      case 'ref': {
        const id = Number(v);
        if (!Number.isInteger(id) || id <= 0) {
          errors[name] = 'must be an id';
          break;
        }
        // Referenced records must belong to the same organization.
        const found = db.prepare(`SELECT 1 FROM ${def.table} WHERE id = ? AND org_id = ?`).get(id, orgId);
        if (!found) errors[name] = 'does not exist';
        else values[name] = id;
        break;
      }
      default:
        throw new Error(`Unknown field type ${def.type}`);
    }
  }
  if (Object.keys(errors).length) throw new HttpError(422, 'Validation failed', errors);
  return values;
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
  return id;
}

function plain(row) {
  return row ? { ...row } : row;
}

// ---------------------------------------------------------------------------
// Generic resource handlers

function listRecords(db, user, res, query) {
  const where = [`${res.alias}.org_id = ?`];
  const params = [user.org_id];
  const q = (query.get('q') || '').trim();
  if (q) {
    // Escape LIKE wildcards so a search for "50%" matches literally.
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push(`(${res.search.map((col) => `${col} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    for (let i = 0; i < res.search.length; i++) params.push(like);
  }
  for (const [param, col] of Object.entries(res.filters)) {
    const v = query.get(param);
    if (v === null || v === '') continue;
    where.push(`${col} = ?`);
    params.push(param === 'done' ? (v === 'true' || v === '1' ? 1 : 0) : v);
  }
  const limit = Math.min(Math.max(Number(query.get('limit')) || 200, 1), 1000);
  const offset = Math.max(Number(query.get('offset')) || 0, 0);
  const whereSql = where.join(' AND ');
  const rows = db.prepare(`${res.select} WHERE ${whereSql} ORDER BY ${res.order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset).map(plain);
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM (${res.select} WHERE ${whereSql})`).get(...params);
  return { data: rows, total, limit, offset };
}

function getRecord(db, user, res, id) {
  const row = db.prepare(`${res.select} WHERE ${res.alias}.id = ? AND ${res.alias}.org_id = ?`).get(id, user.org_id);
  if (!row) throw new HttpError(404, 'Not found');
  return plain(row);
}

function createRecord(db, user, res, body) {
  const values = validate(db, user.org_id, res.fields, body, false);
  if (res.beforeWrite) res.beforeWrite(values, null);
  if (res.onCreate) res.onCreate(values, user);
  values.org_id = user.org_id;
  const cols = Object.keys(values);
  const info = db.prepare(`INSERT INTO ${res.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => values[c]));
  return getRecord(db, user, res, Number(info.lastInsertRowid));
}

function updateRecord(db, user, res, id, body) {
  const existing = getRecord(db, user, res, id);
  const values = validate(db, user.org_id, res.fields, body, true);
  if (res.beforeWrite) res.beforeWrite(values, existing);
  const cols = Object.keys(values);
  if (cols.length) {
    db.prepare(`UPDATE ${res.table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now')
      WHERE id = ? AND org_id = ?`).run(...cols.map((c) => values[c]), id, user.org_id);
  }
  return getRecord(db, user, res, id);
}

function deleteRecord(db, user, res, id) {
  const info = db.prepare(`DELETE FROM ${res.table} WHERE id = ? AND org_id = ?`).run(id, user.org_id);
  if (!info.changes) throw new HttpError(404, 'Not found');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Dashboard

function dashboard(db, user) {
  const org = user.org_id;
  const one = (sql, ...p) => plain(db.prepare(sql).get(org, ...p));
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;

  const pipeline = DEAL_STAGES.map((stage) => {
    const r = one('SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS value FROM deals WHERE org_id = ? AND stage = ?', stage);
    return { stage, count: r.count, value: r.value };
  });
  const open = pipeline.filter((p) => p.stage !== 'won' && p.stage !== 'lost');
  const wonAll = one("SELECT COUNT(*) AS n FROM deals WHERE org_id = ? AND stage = 'won'").n;
  const lostAll = one("SELECT COUNT(*) AS n FROM deals WHERE org_id = ? AND stage = 'lost'").n;

  return {
    counts: {
      contacts: one('SELECT COUNT(*) AS n FROM contacts WHERE org_id = ?').n,
      customers: one("SELECT COUNT(*) AS n FROM contacts WHERE org_id = ? AND status = 'customer'").n,
      companies: one('SELECT COUNT(*) AS n FROM companies WHERE org_id = ?').n,
      open_deals: open.reduce((s, p) => s + p.count, 0),
      open_tasks: one('SELECT COUNT(*) AS n FROM tasks WHERE org_id = ? AND done = 0').n,
      overdue_tasks: one('SELECT COUNT(*) AS n FROM tasks WHERE org_id = ? AND done = 0 AND due_date < ?', today).n,
    },
    open_pipeline_value: open.reduce((s, p) => s + p.value, 0),
    won_this_month: one(
      "SELECT COALESCE(SUM(amount), 0) AS v FROM deals WHERE org_id = ? AND stage = 'won' AND closed_at >= ?",
      monthStart,
    ).v,
    win_rate: wonAll + lostAll ? wonAll / (wonAll + lostAll) : null,
    pipeline,
    upcoming_tasks: db.prepare(`${resources.tasks.select}
      WHERE t.org_id = ? AND t.done = 0 ORDER BY t.due_date IS NULL, t.due_date LIMIT 8`).all(org).map(plain),
    recent_activity: db.prepare(`${resources.activities.select}
      WHERE a.org_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 10`).all(org).map(plain),
  };
}

// ---------------------------------------------------------------------------
// Auth & team

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, org_id: u.org_id, org_name: u.org_name };
}

function validateCredentials(body, needName) {
  const errors = {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!EMAIL_RE.test(email)) errors.email = 'must be a valid email';
  if (password.length < 8) errors.password = 'must be at least 8 characters';
  if (password.length > 200) errors.password = 'is too long';
  if (needName && !name) errors.name = 'is required';
  if (name.length > 100) errors.name = 'is too long';
  return { email, password, name, errors };
}

function signup(db, body) {
  const { email, password, name, errors } = validateCredentials(body || {}, true);
  const orgName = typeof body?.org_name === 'string' ? body.org_name.trim() : '';
  if (!orgName) errors.org_name = 'is required';
  else if (orgName.length > 200) errors.org_name = 'is too long';
  if (Object.keys(errors).length) throw new HttpError(422, 'Validation failed', errors);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'An account with that email already exists', { email: 'is already registered' });
  }
  return tx(db, () => {
    const orgId = Number(db.prepare('INSERT INTO orgs (name) VALUES (?)').run(orgName).lastInsertRowid);
    const userId = Number(db.prepare(
      "INSERT INTO users (org_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'owner')",
    ).run(orgId, name, email, auth.hashPassword(password)).lastInsertRowid);
    return userId;
  });
}

function addTeamMember(db, user, body) {
  if (user.role !== 'owner') throw new HttpError(403, 'Only the workspace owner can add team members');
  const { email, password, name, errors } = validateCredentials(body || {}, true);
  if (Object.keys(errors).length) throw new HttpError(422, 'Validation failed', errors);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'An account with that email already exists', { email: 'is already registered' });
  }
  const id = Number(db.prepare(
    "INSERT INTO users (org_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'member')",
  ).run(user.org_id, name, email, auth.hashPassword(password)).lastInsertRowid);
  return plain(db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(id));
}

function removeTeamMember(db, user, id) {
  if (user.role !== 'owner') throw new HttpError(403, 'Only the workspace owner can remove team members');
  if (id === user.id) throw new HttpError(400, 'You cannot remove yourself');
  const info = db.prepare('DELETE FROM users WHERE id = ? AND org_id = ?').run(id, user.org_id);
  if (!info.changes) throw new HttpError(404, 'Not found');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// CSV export

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Neutralize spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

const CSV_COLUMNS = {
  contacts: ['id', 'first_name', 'last_name', 'email', 'phone', 'title', 'status', 'company_name', 'notes', 'created_at'],
  companies: ['id', 'name', 'industry', 'website', 'phone', 'address', 'contact_count', 'open_deal_count', 'created_at'],
  deals: ['id', 'title', 'amount', 'stage', 'expected_close', 'closed_at', 'company_name', 'contact_name', 'owner_name', 'created_at'],
};

// ---------------------------------------------------------------------------
// Router

function createApi(db, options = {}) {
  const loginLimiter = new auth.RateLimiter(options.loginAttempts || 10, 15 * 60 * 1000);
  const secureCookies = Boolean(options.secureCookies);

  return async function handleApi(req, url, body) {
    const segments = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const method = req.method;
    const cookies = auth.parseCookies(req.headers.cookie);
    const token = cookies[auth.COOKIE_NAME];

    // Public auth endpoints
    if (segments[0] === 'auth') {
      if (method === 'POST' && segments[1] === 'signup') {
        const userId = signup(db, body);
        const s = auth.createSession(db, userId);
        return {
          status: 201,
          headers: { 'Set-Cookie': auth.sessionCookie(s.token, s.expires, secureCookies) },
          body: { user: publicUser(auth.userForToken(db, s.token)) },
        };
      }
      if (method === 'POST' && segments[1] === 'login') {
        const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
        const password = typeof body?.password === 'string' ? body.password : '';
        const ip = req.socket?.remoteAddress || 'unknown';
        if (!loginLimiter.allow(`${ip}|${email}`)) {
          throw new HttpError(429, 'Too many login attempts. Try again in a few minutes.');
        }
        const row = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
        if (!row || !auth.verifyPassword(password, row.password_hash)) {
          throw new HttpError(401, 'Incorrect email or password');
        }
        const s = auth.createSession(db, row.id);
        return {
          headers: { 'Set-Cookie': auth.sessionCookie(s.token, s.expires, secureCookies) },
          body: { user: publicUser(auth.userForToken(db, s.token)) },
        };
      }
      if (method === 'POST' && segments[1] === 'logout') {
        auth.destroySession(db, token);
        return { headers: { 'Set-Cookie': auth.sessionCookie('', null, secureCookies) }, body: { ok: true } };
      }
      throw new HttpError(404, 'Not found');
    }

    const user = auth.userForToken(db, token);
    if (!user) throw new HttpError(401, 'Not signed in');

    if (segments[0] === 'me' && method === 'GET') return { body: { user: publicUser(user) } };
    if (segments[0] === 'dashboard' && method === 'GET') return { body: dashboard(db, user) };
    if (segments[0] === 'meta' && method === 'GET') {
      return { body: { deal_stages: DEAL_STAGES } };
    }

    if (segments[0] === 'users') {
      if (method === 'GET' && segments.length === 1) {
        const rows = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE org_id = ? ORDER BY name')
          .all(user.org_id).map(plain);
        return { body: { data: rows } };
      }
      if (method === 'POST' && segments.length === 1) return { status: 201, body: addTeamMember(db, user, body) };
      if (method === 'DELETE' && segments.length === 2) return { body: removeTeamMember(db, user, parseId(segments[1])) };
      throw new HttpError(405, 'Method not allowed');
    }

    const res = resources[segments[0]];
    if (!res) throw new HttpError(404, 'Not found');

    if (segments[1] === 'export.csv' && method === 'GET' && CSV_COLUMNS[segments[0]]) {
      const { data } = listRecords(db, user, res, new URLSearchParams({ limit: '1000000' }));
      return {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${segments[0]}.csv"`,
        },
        raw: toCsv(data, CSV_COLUMNS[segments[0]]),
      };
    }

    if (segments.length === 1) {
      if (method === 'GET') return { body: listRecords(db, user, res, url.searchParams) };
      if (method === 'POST') return { status: 201, body: createRecord(db, user, res, body) };
      throw new HttpError(405, 'Method not allowed');
    }
    if (segments.length === 2) {
      const id = parseId(segments[1]);
      if (method === 'GET') return { body: getRecord(db, user, res, id) };
      if (method === 'PATCH' || method === 'PUT') return { body: updateRecord(db, user, res, id, body) };
      if (method === 'DELETE') return { body: deleteRecord(db, user, res, id) };
      throw new HttpError(405, 'Method not allowed');
    }
    throw new HttpError(404, 'Not found');
  };
}

module.exports = { createApi, HttpError };
