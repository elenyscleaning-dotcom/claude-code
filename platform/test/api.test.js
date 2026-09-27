'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');

let server;
let base;

before(async () => {
  server = createServer({ dbFile: ':memory:', logger: { error() {} } });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// Minimal client that keeps its own session cookie.
function client() {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const opts = { method, headers: { 'X-Requested-With': 'fetch', ...headers } };
    if (cookie) opts.headers.Cookie = cookie;
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(base + path, opts);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
}

let n = 0;
async function newWorkspace(name = 'Acme') {
  const call = client();
  n += 1;
  const r = await call('POST', '/api/auth/signup', {
    org_name: name, name: 'Owner', email: `owner${n}@example.com`, password: 'password123',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { call, user: r.data.user, email: `owner${n}@example.com` };
}

test('signup, me, logout, login', async () => {
  const { call, user, email } = await newWorkspace();
  assert.equal(user.role, 'owner');
  assert.equal(user.org_name, 'Acme');
  assert.equal((await call('GET', '/api/me')).data.user.email, email);

  await call('POST', '/api/auth/logout', {});
  assert.equal((await call('GET', '/api/me')).status, 401);

  assert.equal((await call('POST', '/api/auth/login', { email, password: 'wrong-password' })).status, 401);
  const ok = await call('POST', '/api/auth/login', { email: email.toUpperCase(), password: 'password123' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
});

test('signup validation and duplicate email', async () => {
  const call = client();
  const bad = await call('POST', '/api/auth/signup', { org_name: '', name: '', email: 'nope', password: 'short' });
  assert.equal(bad.status, 422);
  assert.deepEqual(Object.keys(bad.data.details).sort(), ['email', 'name', 'org_name', 'password']);

  const { email } = await newWorkspace();
  const dup = await client()('POST', '/api/auth/signup', { org_name: 'X', name: 'Y', email, password: 'password123' });
  assert.equal(dup.status, 409);
});

test('requires auth for data endpoints', async () => {
  const call = client();
  for (const p of ['/api/contacts', '/api/dashboard', '/api/users']) {
    assert.equal((await call('GET', p)).status, 401);
  }
});

test('CRUD for contacts with company link and search', async () => {
  const { call } = await newWorkspace();
  const co = await call('POST', '/api/companies', { name: 'Globex', industry: 'Energy' });
  assert.equal(co.status, 201);

  const c = await call('POST', '/api/contacts', {
    first_name: 'Ada', last_name: 'Lovelace', email: 'ADA@Example.com', company_id: co.data.id, status: 'customer',
  });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal(c.data.email, 'ada@example.com');
  assert.equal(c.data.company_name, 'Globex');

  await call('POST', '/api/contacts', { first_name: 'Grace', last_name: 'Hopper' });

  assert.equal((await call('GET', '/api/contacts')).data.total, 2);
  assert.equal((await call('GET', '/api/contacts?q=globex')).data.total, 1);
  assert.equal((await call('GET', '/api/contacts?status=customer')).data.data[0].first_name, 'Ada');
  assert.equal((await call('GET', '/api/contacts?q=%25')).data.total, 0, 'LIKE wildcards are escaped');

  const upd = await call('PATCH', `/api/contacts/${c.data.id}`, { title: 'Analyst', company_id: null });
  assert.equal(upd.data.title, 'Analyst');
  assert.equal(upd.data.company_id, null);
  assert.equal(upd.data.last_name, 'Lovelace', 'partial update keeps other fields');

  const companies = await call('GET', '/api/companies');
  assert.equal(companies.data.data[0].contact_count, 0);

  assert.equal((await call('DELETE', `/api/contacts/${c.data.id}`)).status, 200);
  assert.equal((await call('GET', `/api/contacts/${c.data.id}`)).status, 404);
});

test('validation errors', async () => {
  const { call } = await newWorkspace();
  const r = await call('POST', '/api/contacts', { email: 'bad', status: 'vip', company_id: 99999 });
  assert.equal(r.status, 422);
  assert.deepEqual(Object.keys(r.data.details).sort(), ['company_id', 'email', 'first_name', 'status']);

  const d = await call('POST', '/api/deals', { title: 'X', amount: -5, expected_close: '2024-13-45' });
  assert.equal(d.status, 422);
  assert.ok(d.data.details.amount);
  assert.ok(d.data.details.expected_close);
});

test('organizations are isolated from each other', async () => {
  const a = await newWorkspace('Org A');
  const b = await newWorkspace('Org B');
  const co = await a.call('POST', '/api/companies', { name: 'Secret Co' });
  const contact = await a.call('POST', '/api/contacts', { first_name: 'Hidden' });

  assert.equal((await b.call('GET', '/api/companies')).data.total, 0);
  assert.equal((await b.call('GET', `/api/companies/${co.data.id}`)).status, 404);
  assert.equal((await b.call('PATCH', `/api/companies/${co.data.id}`, { name: 'Pwned' })).status, 404);
  assert.equal((await b.call('DELETE', `/api/contacts/${contact.data.id}`)).status, 404);

  // Cannot link to another org's records.
  const leak = await b.call('POST', '/api/contacts', { first_name: 'X', company_id: co.data.id });
  assert.equal(leak.status, 422);
  assert.equal(leak.data.details.company_id, 'does not exist');

  assert.equal((await a.call('GET', `/api/companies/${co.data.id}`)).data.name, 'Secret Co');
});

test('deals track closed_at and feed the dashboard', async () => {
  const { call } = await newWorkspace();
  const d1 = await call('POST', '/api/deals', { title: 'Big one', amount: 5000, stage: 'proposal' });
  const d2 = await call('POST', '/api/deals', { title: 'Small one', amount: 1000 });
  await call('POST', '/api/deals', { title: 'Nope', amount: 700, stage: 'lost' });
  assert.equal(d2.data.stage, 'new');
  assert.equal(d1.data.closed_at, null);

  const won = await call('PATCH', `/api/deals/${d1.data.id}`, { stage: 'won' });
  assert.ok(won.data.closed_at);

  await call('POST', '/api/tasks', { title: 'Overdue', due_date: '2000-01-01' });
  await call('POST', '/api/tasks', { title: 'Done', done: true });

  const dash = (await call('GET', '/api/dashboard')).data;
  assert.equal(dash.open_pipeline_value, 1000);
  assert.equal(dash.won_this_month, 5000);
  assert.equal(dash.win_rate, 0.5);
  assert.equal(dash.counts.open_deals, 1);
  assert.equal(dash.counts.open_tasks, 1);
  assert.equal(dash.counts.overdue_tasks, 1);
  assert.equal(dash.pipeline.find((p) => p.stage === 'won').value, 5000);

  const reopened = await call('PATCH', `/api/deals/${d1.data.id}`, { stage: 'negotiation' });
  assert.equal(reopened.data.closed_at, null);
});

test('tasks filter by done and activities record author', async () => {
  const { call, user } = await newWorkspace();
  const c = await call('POST', '/api/contacts', { first_name: 'Bob' });
  const t = await call('POST', '/api/tasks', { title: 'Call Bob', contact_id: c.data.id, assignee_id: user.id });
  assert.equal(t.data.contact_name, 'Bob');
  assert.equal(t.data.assignee_name, 'Owner');
  await call('PATCH', `/api/tasks/${t.data.id}`, { done: true });
  assert.equal((await call('GET', '/api/tasks?done=0')).data.total, 0);
  assert.equal((await call('GET', '/api/tasks?done=1')).data.total, 1);

  const a = await call('POST', '/api/activities', { type: 'call', body: 'Left voicemail', contact_id: c.data.id });
  assert.equal(a.status, 201);
  assert.equal(a.data.author_name, 'Owner');
  assert.equal((await call('GET', `/api/activities?contact_id=${c.data.id}`)).data.total, 1);

  // Deleting the contact removes its activity timeline.
  await call('DELETE', `/api/contacts/${c.data.id}`);
  assert.equal((await call('GET', '/api/activities')).data.total, 0);
});

test('team management is owner-only', async () => {
  const owner = await newWorkspace();
  const add = await owner.call('POST', '/api/users', { name: 'Member', email: 'member-x@example.com', password: 'password123' });
  assert.equal(add.status, 201);
  assert.equal(add.data.role, 'member');
  assert.equal(add.data.password_hash, undefined);

  const member = client();
  assert.equal((await member('POST', '/api/auth/login', { email: 'member-x@example.com', password: 'password123' })).status, 200);
  assert.equal((await member('GET', '/api/users')).data.data.length, 2);
  assert.equal((await member('POST', '/api/users', { name: 'X', email: 'x2@example.com', password: 'password123' })).status, 403);
  assert.equal((await member('DELETE', `/api/users/${owner.user.id}`)).status, 403);

  assert.equal((await owner.call('DELETE', `/api/users/${owner.user.id}`)).status, 400);
  assert.equal((await owner.call('DELETE', `/api/users/${add.data.id}`)).status, 200);
  assert.equal((await member('GET', '/api/me')).status, 401, 'removed member session is gone');
});

test('CSV export escapes values and neutralizes formulas', async () => {
  const { call } = await newWorkspace();
  await call('POST', '/api/contacts', { first_name: '=HYPERLINK("x")', last_name: 'Smith, Jr.' });
  const r = await call('GET', '/api/contacts/export.csv');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.ok(r.data.includes('"\'=HYPERLINK(""x"")"'), r.data);
  assert.ok(r.data.includes('"Smith, Jr."'));
});

test('CSRF protections on mutating requests', async () => {
  const { call } = await newWorkspace();
  const form = await call('POST', '/api/contacts', undefined, { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(form.status, 415);
  const c = await call('POST', '/api/contacts', { first_name: 'Z' });
  const del = await call('DELETE', `/api/contacts/${c.data.id}`, undefined, { 'X-Requested-With': '' });
  assert.equal(del.status, 403);
});

test('serves the frontend with security headers and blocks traversal', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Compass CRM/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 403);
});

test('login is rate limited', async () => {
  const call = client();
  let last;
  for (let i = 0; i < 11; i++) last = await call('POST', '/api/auth/login', { email: 'rl@example.com', password: 'x' });
  assert.equal(last.status, 429);
});
