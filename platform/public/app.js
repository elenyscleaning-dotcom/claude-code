'use strict';

// Compass CRM single-page frontend. No build step, no dependencies.

// ---------------------------------------------------------------------------
// Utilities

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
const raw = (s) => new Raw(s);

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Tagged template that escapes every interpolation unless it's already Raw.
function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('');
    else if (v instanceof Raw) out += v.s;
    else if (v !== false && v !== null && v !== undefined) out += esc(v);
    out += strings[i + 1];
  });
  return raw(out);
}

const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtMoney = (n) => money.format(n || 0);
const today = () => new Date().toISOString().slice(0, 10);

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.length === 10 ? `${s}T00:00:00` : `${s.replace(' ', 'T')}${s.includes('Z') || s.includes('+') ? '' : 'Z'}`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(s) {
  if (!s) return '';
  const d = new Date(`${s.replace(' ', 'T')}${s.includes('Z') || s.includes('+') ? '' : 'Z'}`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const fullName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ');

async function api(method, path, body) {
  const opts = { method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/')) {
    state.user = null;
    location.hash = '#/login';
    throw Object.assign(new Error('Please sign in'), { silent: true });
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { details: data.details });
  return data;
}

let toastTimer;
function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

function reportError(err) {
  if (!err.silent) toast(err.message, true);
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------------------
// App state & record type definitions

const state = { user: null, users: [] };
const STAGES = ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];

const TYPES = {
  contacts: {
    singular: 'contact',
    title: (r) => fullName(r),
    fields: [
      { name: 'first_name', label: 'First name', required: true },
      { name: 'last_name', label: 'Last name' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'title', label: 'Job title' },
      { name: 'status', label: 'Status', type: 'select', options: ['lead', 'customer', 'inactive'] },
      { name: 'company_id', label: 'Company', type: 'ref', ref: 'companies', full: true },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
  },
  companies: {
    singular: 'company',
    title: (r) => r.name,
    fields: [
      { name: 'name', label: 'Name', required: true, full: true },
      { name: 'industry', label: 'Industry' },
      { name: 'website', label: 'Website', type: 'url' },
      { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'address', label: 'Address' },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
  },
  deals: {
    singular: 'deal',
    title: (r) => r.title,
    fields: [
      { name: 'title', label: 'Title', required: true, full: true },
      { name: 'amount', label: 'Amount (USD)', type: 'number' },
      { name: 'stage', label: 'Stage', type: 'select', options: STAGES },
      { name: 'company_id', label: 'Company', type: 'ref', ref: 'companies' },
      { name: 'contact_id', label: 'Contact', type: 'ref', ref: 'contacts' },
      { name: 'expected_close', label: 'Expected close', type: 'date' },
      { name: 'owner_id', label: 'Owner', type: 'ref', ref: 'users' },
    ],
  },
  tasks: {
    singular: 'task',
    title: (r) => r.title,
    fields: [
      { name: 'title', label: 'Task', required: true, full: true },
      { name: 'due_date', label: 'Due date', type: 'date' },
      { name: 'assignee_id', label: 'Assignee', type: 'ref', ref: 'users' },
      { name: 'contact_id', label: 'Contact', type: 'ref', ref: 'contacts' },
      { name: 'deal_id', label: 'Deal', type: 'ref', ref: 'deals' },
    ],
  },
};

const refLabel = {
  companies: (r) => r.name,
  contacts: (r) => fullName(r) + (r.company_name ? ` (${r.company_name})` : ''),
  deals: (r) => r.title,
  users: (r) => r.name,
};

async function loadRefOptions(ref) {
  const { data } = await api('GET', ref === 'users' ? '/users' : `/${ref}?limit=1000`);
  return data.map((r) => ({ value: r.id, label: refLabel[ref](r) }));
}

// ---------------------------------------------------------------------------
// Modal forms

function openModal(content, onMount) {
  const dlg = document.getElementById('modal');
  dlg.innerHTML = content.toString();
  dlg.showModal();
  if (onMount) onMount(dlg);
  const first = $('input, select, textarea', dlg);
  if (first) first.focus();
  return dlg;
}

function closeModal() {
  document.getElementById('modal').close();
}

function fieldInput(f, value, refOptions) {
  const id = `f_${f.name}`;
  const common = raw(`id="${id}" name="${f.name}"${f.required ? ' required' : ''}`);
  let input;
  if (f.type === 'textarea') input = html`<textarea ${common}>${value ?? ''}</textarea>`;
  else if (f.type === 'select') {
    input = html`<select ${common}>${f.options.map((o) => html`<option value="${o}" ${raw(o === value ? 'selected' : '')}>${o[0].toUpperCase() + o.slice(1)}</option>`)}</select>`;
  } else if (f.type === 'ref') {
    input = html`<select ${common}><option value="">— None —</option>${(refOptions[f.ref] || []).map((o) => html`<option value="${o.value}" ${raw(o.value === value ? 'selected' : '')}>${o.label}</option>`)}</select>`;
  } else {
    const extra = f.type === 'number' ? raw(' min="0" step="any"') : raw('');
    input = html`<input type="${f.type || 'text'}" ${common}${extra} value="${value ?? ''}">`;
  }
  return html`<div class="field ${f.full ? 'full' : ''}"><label for="${id}">${f.label}</label>${input}<div class="error" data-error="${f.name}"></div></div>`;
}

// Open a create/edit form for a record type. Resolves with the saved record.
async function editRecord(typeName, record = {}, defaults = {}) {
  const type = TYPES[typeName];
  const refs = [...new Set(type.fields.filter((f) => f.type === 'ref').map((f) => f.ref))];
  const refOptions = {};
  await Promise.all(refs.map(async (r) => { refOptions[r] = await loadRefOptions(r); }));
  const values = { ...defaults, ...record };
  const isNew = !record.id;

  return new Promise((resolve) => {
    const dlg = openModal(html`
      <form method="dialog" novalidate>
        <h2>${isNew ? `New ${type.singular}` : `Edit ${type.singular}`}</h2>
        <div class="form-error" hidden></div>
        <div class="form-grid">${type.fields.map((f) => fieldInput(f, values[f.name], refOptions))}</div>
        <div class="actions">
          <button type="button" data-cancel>Cancel</button>
          <button type="submit" class="primary">${isNew ? 'Create' : 'Save'}</button>
        </div>
      </form>`);
    $('[data-cancel]', dlg).onclick = () => { closeModal(); resolve(null); };
    $('form', dlg).onsubmit = async (e) => {
      e.preventDefault();
      const payload = {};
      for (const f of type.fields) {
        const v = e.target.elements[f.name].value;
        payload[f.name] = f.type === 'ref' ? (v ? Number(v) : null) : f.type === 'number' ? (v === '' ? null : Number(v)) : v;
      }
      for (const [k, v] of Object.entries(defaults)) if (!(k in payload)) payload[k] = v;
      $$('[data-error]', dlg).forEach((el) => { el.textContent = ''; });
      const btn = $('button[type=submit]', dlg);
      btn.disabled = true;
      try {
        const saved = isNew ? await api('POST', `/${typeName}`, payload) : await api('PATCH', `/${typeName}/${record.id}`, payload);
        closeModal();
        toast(isNew ? `${type.singular[0].toUpperCase() + type.singular.slice(1)} created` : 'Saved');
        resolve(saved);
      } catch (err) {
        btn.disabled = false;
        const box = $('.form-error', dlg);
        box.textContent = err.message;
        box.hidden = false;
        for (const [k, msg] of Object.entries(err.details || {})) {
          const el = $(`[data-error="${k}"]`, dlg);
          if (el) el.textContent = `This field ${msg}`;
        }
      }
    };
    dlg.addEventListener('cancel', () => resolve(null), { once: true });
  });
}

async function confirmDelete(typeName, record) {
  const label = TYPES[typeName].title(record);
  if (!confirm(`Delete ${TYPES[typeName].singular} "${label}"? This cannot be undone.`)) return false;
  await api('DELETE', `/${typeName}/${record.id}`);
  toast('Deleted');
  return true;
}

// ---------------------------------------------------------------------------
// Layout

const NAV = [
  ['dashboard', 'Dashboard'],
  ['contacts', 'Contacts'],
  ['companies', 'Companies'],
  ['deals', 'Deals'],
  ['tasks', 'Tasks'],
  ['team', 'Team'],
];

function renderShell(active, content) {
  const app = document.getElementById('app');
  app.innerHTML = html`
    <div class="shell">
      <aside class="sidebar">
        <div class="brand"><img src="/favicon.svg" alt="">Compass</div>
        <nav class="nav">${NAV.map(([k, label]) => html`<a href="#/${k}" class="${k === active ? 'active' : ''}">${label}</a>`)}</nav>
        <div class="account">
          <div><strong>${state.user.name}</strong></div>
          <div class="muted small">${state.user.org_name}</div>
          <button class="link small" id="logout">Sign out</button>
        </div>
      </aside>
      <main class="main">${content}</main>
    </div>`.toString();
  $('#logout').onclick = async () => {
    await api('POST', '/auth/logout', {}).catch(() => {});
    state.user = null;
    location.hash = '#/login';
  };
  return $('.main');
}

function badge(value, extraClass = '') {
  return value ? html`<span class="badge ${value} ${extraClass}">${value}</span>` : '';
}

function applyBarWidths(root) {
  // Inline style attributes are blocked by our CSP, so set widths via the DOM.
  $$('[data-width]', root).forEach((el) => { el.style.width = `${el.dataset.width}%`; });
}

// ---------------------------------------------------------------------------
// Views

async function viewDashboard() {
  const d = await api('GET', '/dashboard');
  const max = Math.max(1, ...d.pipeline.map((p) => p.value));
  const main = renderShell('dashboard', html`
    <div class="page-head"><h1>Dashboard</h1><span class="spacer"></span>
      <button class="primary" id="new-deal">+ New deal</button></div>
    <div class="grid kpis">
      <div class="card kpi"><div class="label">Open pipeline</div><div class="value">${fmtMoney(d.open_pipeline_value)}</div></div>
      <div class="card kpi"><div class="label">Won this month</div><div class="value">${fmtMoney(d.won_this_month)}</div></div>
      <div class="card kpi"><div class="label">Win rate</div><div class="value">${d.win_rate === null ? '—' : `${Math.round(d.win_rate * 100)}%`}</div></div>
      <div class="card kpi"><div class="label">Open deals</div><div class="value">${d.counts.open_deals}</div></div>
      <div class="card kpi"><div class="label">Contacts</div><div class="value">${d.counts.contacts}</div></div>
      <div class="card kpi ${d.counts.overdue_tasks ? 'alert' : ''}"><div class="label">Overdue tasks</div><div class="value">${d.counts.overdue_tasks}</div></div>
    </div>
    <div class="grid two">
      <div class="card">
        <h2>Pipeline by stage</h2>
        ${d.pipeline.map((p) => html`<div class="bar-row ${p.stage}">
          <div>${p.stage[0].toUpperCase() + p.stage.slice(1)} <span class="muted small">(${p.count})</span></div>
          <div class="bar"><span data-width="${Math.round((p.value / max) * 100)}"></span></div>
          <div class="amt">${fmtMoney(p.value)}</div></div>`)}
      </div>
      <div class="card">
        <h2>Upcoming tasks</h2>
        ${d.upcoming_tasks.length ? html`<ul class="list">${d.upcoming_tasks.map(taskItem)}</ul>` : html`<div class="empty">No open tasks. Nice!</div>`}
      </div>
      <div class="card">
        <h2>Recent activity</h2>
        ${d.recent_activity.length ? html`<ul class="list timeline">${d.recent_activity.map((a) => activityItem(a, true))}</ul>` : html`<div class="empty">Activity you log on contacts, companies and deals shows up here.</div>`}
      </div>
    </div>`);
  applyBarWidths(main);
  bindTaskToggles(main, viewDashboard);
  $('#new-deal').onclick = async () => { if (await editRecord('deals', {}, { owner_id: state.user.id })) viewDashboard(); };
}

function listPage({ typeName, title, columns, filters = '', emptyText }) {
  return async function view(params) {
    const q = params.get('q') || '';
    const qs = new URLSearchParams(params);
    const { data, total } = await api('GET', `/${typeName}?${qs}`);
    const main = renderShell(typeName, html`
      <div class="page-head"><h1>${title}</h1><span class="muted">${total}</span><span class="spacer"></span>
        <a class="btn" href="/api/${typeName}/export.csv" download>Export CSV</a>
        <button class="primary" id="new">+ New ${TYPES[typeName].singular}</button></div>
      <div class="toolbar">
        <input type="search" id="search" placeholder="Search ${title.toLowerCase()}…" value="${q}">
        ${filters ? filters(params) : ''}
      </div>
      <div class="card table-wrap">
        ${data.length ? html`<table>
          <thead><tr>${columns.map((c) => html`<th class="${c.num ? 'num' : ''}">${c.label}</th>`)}</tr></thead>
          <tbody>${data.map((r) => html`<tr data-id="${r.id}">${columns.map((c) => html`<td class="${c.num ? 'num' : ''}">${c.render(r)}</td>`)}</tr>`)}</tbody>
        </table>` : html`<div class="empty">${q ? 'No matches.' : emptyText}</div>`}
      </div>`);
    $$('tbody tr', main).forEach((tr) => { tr.onclick = () => { location.hash = `#/${typeName}/${tr.dataset.id}`; }; });
    $('#new').onclick = async () => {
      const saved = await editRecord(typeName, {}, typeName === 'deals' ? { owner_id: state.user.id } : {});
      if (saved) location.hash = `#/${typeName}/${saved.id}`;
    };
    const search = $('#search');
    let timer;
    search.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = new URLSearchParams(params);
        if (search.value) next.set('q', search.value); else next.delete('q');
        navigateQuery(typeName, next);
      }, 250);
    };
    $$('[data-filter]', main).forEach((sel) => {
      sel.onchange = () => {
        const next = new URLSearchParams(params);
        if (sel.value) next.set(sel.dataset.filter, sel.value); else next.delete(sel.dataset.filter);
        navigateQuery(typeName, next);
      };
    });
    if (q) { search.focus(); search.setSelectionRange(q.length, q.length); }
  };
}

function navigateQuery(base, params) {
  const s = params.toString();
  location.hash = `#/${base}${s ? `?${s}` : ''}`;
}

const viewContacts = listPage({
  typeName: 'contacts',
  title: 'Contacts',
  emptyText: 'No contacts yet. Add your first customer or lead.',
  filters: (p) => html`<select data-filter="status">
    <option value="">All statuses</option>
    ${['lead', 'customer', 'inactive'].map((s) => html`<option value="${s}" ${raw(p.get('status') === s ? 'selected' : '')}>${s[0].toUpperCase() + s.slice(1)}</option>`)}
  </select>`,
  columns: [
    { label: 'Name', render: (r) => html`<strong>${fullName(r)}</strong>` },
    { label: 'Company', render: (r) => r.company_name || '' },
    { label: 'Email', render: (r) => r.email || '' },
    { label: 'Phone', render: (r) => r.phone || '' },
    { label: 'Status', render: (r) => badge(r.status) },
  ],
});

const viewCompanies = listPage({
  typeName: 'companies',
  title: 'Companies',
  emptyText: 'No companies yet.',
  columns: [
    { label: 'Name', render: (r) => html`<strong>${r.name}</strong>` },
    { label: 'Industry', render: (r) => r.industry || '' },
    { label: 'Phone', render: (r) => r.phone || '' },
    { label: 'Contacts', num: true, render: (r) => r.contact_count },
    { label: 'Open deals', num: true, render: (r) => r.open_deal_count },
  ],
});

async function viewDeals() {
  const { data } = await api('GET', '/deals?limit=1000');
  const byStage = Object.fromEntries(STAGES.map((s) => [s, []]));
  data.forEach((d) => byStage[d.stage].push(d));
  const main = renderShell('deals', html`
    <div class="page-head"><h1>Deals</h1><span class="spacer"></span>
      <a class="btn" href="/api/deals/export.csv" download>Export CSV</a>
      <button class="primary" id="new">+ New deal</button></div>
    <p class="muted small">Drag a card between columns to move it to another stage.</p>
    <div class="board">${STAGES.map((s) => html`
      <section class="column" data-stage="${s}">
        <div class="column-head"><span>${s}</span><span class="muted">${fmtMoney(byStage[s].reduce((t, d) => t + d.amount, 0))}</span></div>
        ${byStage[s].map((d) => html`<div class="deal-card" draggable="true" data-id="${d.id}" tabindex="0">
          <div><a href="#/deals/${d.id}">${d.title}</a></div>
          <div class="amt">${fmtMoney(d.amount)}</div>
          <div class="muted small">${d.company_name || d.contact_name || ''}</div>
        </div>`)}
      </section>`)}
    </div>`);
  $('#new').onclick = async () => { if (await editRecord('deals', {}, { owner_id: state.user.id })) viewDeals(); };

  let dragId = null;
  $$('.deal-card', main).forEach((card) => {
    card.ondragstart = (e) => { dragId = card.dataset.id; e.dataTransfer.effectAllowed = 'move'; };
    card.onkeydown = (e) => { if (e.key === 'Enter') location.hash = `#/deals/${card.dataset.id}`; };
  });
  $$('.column', main).forEach((col) => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('drop'); };
    col.ondragleave = () => col.classList.remove('drop');
    col.ondrop = async (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      if (!dragId) return;
      try {
        await api('PATCH', `/deals/${dragId}`, { stage: col.dataset.stage });
        viewDeals();
      } catch (err) { reportError(err); }
    };
  });
}

function taskItem(t) {
  const overdue = !t.done && t.due_date && t.due_date < today();
  return html`<li>
    <input type="checkbox" data-task="${t.id}" aria-label="Mark done" ${raw(t.done ? 'checked' : '')}>
    <div class="grow">
      <div class="${t.done ? 'task-done' : ''}">${t.title}</div>
      <div class="muted small">
        ${t.due_date ? html`${overdue ? badge('overdue') : ''} Due ${fmtDate(t.due_date)}` : ''}
        ${t.assignee_name ? html` · ${t.assignee_name}` : ''}
        ${t.contact_id ? html` · <a href="#/contacts/${t.contact_id}">${t.contact_name}</a>` : ''}
        ${t.deal_id ? html` · <a href="#/deals/${t.deal_id}">${t.deal_title}</a>` : ''}
      </div>
    </div>
    <button class="link small" data-edit-task="${t.id}">Edit</button>
  </li>`;
}

function bindTaskToggles(root, refresh, tasks) {
  $$('[data-task]', root).forEach((cb) => {
    cb.onchange = async () => {
      try {
        await api('PATCH', `/tasks/${cb.dataset.task}`, { done: cb.checked });
        refresh();
      } catch (err) { reportError(err); }
    };
  });
  $$('[data-edit-task]', root).forEach((btn) => {
    btn.onclick = async () => {
      const task = (tasks || []).find((t) => String(t.id) === btn.dataset.editTask)
        || await api('GET', `/tasks/${btn.dataset.editTask}`);
      if (await editRecord('tasks', task)) refresh();
    };
  });
}

async function viewTasks(params) {
  const show = params.get('show') || 'open';
  const qs = show === 'all' ? '' : `done=${show === 'done' ? 1 : 0}`;
  const { data } = await api('GET', `/tasks?${qs}`);
  const main = renderShell('tasks', html`
    <div class="page-head"><h1>Tasks</h1><span class="spacer"></span>
      <button class="primary" id="new">+ New task</button></div>
    <div class="toolbar">
      <select id="show">${[['open', 'Open'], ['done', 'Completed'], ['all', 'All']].map(([v, l]) => html`<option value="${v}" ${raw(v === show ? 'selected' : '')}>${l}</option>`)}</select>
    </div>
    <div class="card">${data.length ? html`<ul class="list">${data.map(taskItem)}</ul>` : html`<div class="empty">No tasks here.</div>`}</div>`);
  const refresh = () => viewTasks(params);
  bindTaskToggles(main, refresh, data);
  $('#show').onchange = (e) => { location.hash = `#/tasks?show=${e.target.value}`; };
  $('#new').onclick = async () => { if (await editRecord('tasks', {}, { assignee_id: state.user.id })) refresh(); };
}

function activityItem(a, showContext) {
  const ctx = [];
  if (showContext) {
    if (a.contact_id) ctx.push(html`<a href="#/contacts/${a.contact_id}">${a.contact_name}</a>`);
    if (a.company_id) ctx.push(html`<a href="#/companies/${a.company_id}">${a.company_name}</a>`);
    if (a.deal_id) ctx.push(html`<a href="#/deals/${a.deal_id}">${a.deal_title}</a>`);
  }
  return html`<li><div class="grow">
    <div class="muted small">${badge(a.type)} ${a.author_name || 'Someone'} · ${fmtDateTime(a.created_at)}${ctx.length ? html` · ${ctx.map((c, i) => html`${i ? ', ' : ''}${c}`)}` : ''}</div>
    <div class="body">${a.body}</div>
  </div>${showContext ? '' : html`<button class="link small danger" data-del-activity="${a.id}">Delete</button>`}</li>`;
}

function activityPanel(activities) {
  return html`<div class="card">
    <h2>Activity</h2>
    <form id="log-activity" class="stack">
      <div class="row">
        <select name="type" aria-label="Activity type">${['note', 'call', 'email', 'meeting'].map((t) => html`<option value="${t}">${t[0].toUpperCase() + t.slice(1)}</option>`)}</select>
      </div>
      <textarea name="body" placeholder="Log a note, call, email or meeting…" required aria-label="Activity details"></textarea>
      <div><button class="primary" type="submit">Log activity</button></div>
    </form>
    ${activities.length ? html`<ul class="list timeline">${activities.map((a) => activityItem(a, false))}</ul>` : html`<div class="empty">No activity yet.</div>`}
  </div>`;
}

function bindActivityPanel(root, link, refresh) {
  $('#log-activity', root).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    if (!f.body.value.trim()) return;
    try {
      await api('POST', '/activities', { type: f.type.value, body: f.body.value, ...link });
      refresh();
    } catch (err) { reportError(err); }
  };
  $$('[data-del-activity]', root).forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Delete this activity?')) return;
      try {
        await api('DELETE', `/activities/${btn.dataset.delActivity}`);
        refresh();
      } catch (err) { reportError(err); }
    };
  });
}

function props(pairs) {
  return html`<dl class="props">${pairs.filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

function safeUrl(u) {
  if (!u) return '';
  const href = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  return html`<a href="${href}" target="_blank" rel="noopener noreferrer">${u}</a>`;
}

function detailHead(typeName, record, back) {
  return html`<div class="page-head">
    <a href="#/${back}">← ${back[0].toUpperCase() + back.slice(1)}</a>
    <h1>${TYPES[typeName].title(record)}</h1>
    <span class="spacer"></span>
    <button id="edit">Edit</button>
    <button class="danger" id="delete">Delete</button>
  </div>`;
}

function bindDetailHead(typeName, record, back, refresh) {
  $('#edit').onclick = async () => { if (await editRecord(typeName, record)) refresh(); };
  $('#delete').onclick = async () => {
    try { if (await confirmDelete(typeName, record)) location.hash = `#/${back}`; } catch (err) { reportError(err); }
  };
}

async function viewContact(id) {
  const [c, deals, tasks, acts] = await Promise.all([
    api('GET', `/contacts/${id}`),
    api('GET', `/deals?contact_id=${id}`),
    api('GET', `/tasks?contact_id=${id}`),
    api('GET', `/activities?contact_id=${id}`),
  ]);
  const refresh = () => viewContact(id);
  const main = renderShell('contacts', html`
    ${detailHead('contacts', c, 'contacts')}
    <div class="grid detail">
      <div class="stack">
        <div class="card">
          ${props([
            ['Status', badge(c.status)],
            ['Title', c.title],
            ['Company', c.company_id ? html`<a href="#/companies/${c.company_id}">${c.company_name}</a>` : ''],
            ['Email', c.email ? html`<a href="mailto:${c.email}">${c.email}</a>` : ''],
            ['Phone', c.phone ? html`<a href="tel:${c.phone}">${c.phone}</a>` : ''],
            ['Added', fmtDate(c.created_at)],
          ])}
          ${c.notes ? html`<p class="body">${c.notes}</p>` : ''}
        </div>
        <div class="card">
          <h2>Deals</h2>
          ${deals.data.length ? html`<ul class="list">${deals.data.map((d) => html`<li><div class="grow"><a href="#/deals/${d.id}">${d.title}</a></div>${badge(d.stage)}<span>${fmtMoney(d.amount)}</span></li>`)}</ul>` : html`<div class="muted">No deals.</div>`}
          <button class="link" id="add-deal">+ Add deal</button>
        </div>
        <div class="card">
          <h2>Tasks</h2>
          ${tasks.data.length ? html`<ul class="list">${tasks.data.map(taskItem)}</ul>` : html`<div class="muted">No tasks.</div>`}
          <button class="link" id="add-task">+ Add task</button>
        </div>
      </div>
      ${activityPanel(acts.data)}
    </div>`);
  bindDetailHead('contacts', c, 'contacts', refresh);
  bindTaskToggles(main, refresh, tasks.data);
  bindActivityPanel(main, { contact_id: c.id, company_id: c.company_id || undefined }, refresh);
  $('#add-deal').onclick = async () => {
    if (await editRecord('deals', {}, { contact_id: c.id, company_id: c.company_id, owner_id: state.user.id })) refresh();
  };
  $('#add-task').onclick = async () => {
    if (await editRecord('tasks', {}, { contact_id: c.id, assignee_id: state.user.id })) refresh();
  };
}

async function viewCompany(id) {
  const [co, contacts, deals, acts] = await Promise.all([
    api('GET', `/companies/${id}`),
    api('GET', `/contacts?company_id=${id}`),
    api('GET', `/deals?company_id=${id}`),
    api('GET', `/activities?company_id=${id}`),
  ]);
  const refresh = () => viewCompany(id);
  const main = renderShell('companies', html`
    ${detailHead('companies', co, 'companies')}
    <div class="grid detail">
      <div class="stack">
        <div class="card">
          ${props([
            ['Industry', co.industry],
            ['Website', safeUrl(co.website)],
            ['Phone', co.phone ? html`<a href="tel:${co.phone}">${co.phone}</a>` : ''],
            ['Address', co.address],
            ['Added', fmtDate(co.created_at)],
          ])}
          ${co.notes ? html`<p class="body">${co.notes}</p>` : ''}
        </div>
        <div class="card">
          <h2>People</h2>
          ${contacts.data.length ? html`<ul class="list">${contacts.data.map((c) => html`<li><div class="grow"><a href="#/contacts/${c.id}">${fullName(c)}</a><div class="muted small">${c.title || ''}</div></div>${badge(c.status)}</li>`)}</ul>` : html`<div class="muted">No contacts.</div>`}
          <button class="link" id="add-contact">+ Add contact</button>
        </div>
        <div class="card">
          <h2>Deals</h2>
          ${deals.data.length ? html`<ul class="list">${deals.data.map((d) => html`<li><div class="grow"><a href="#/deals/${d.id}">${d.title}</a></div>${badge(d.stage)}<span>${fmtMoney(d.amount)}</span></li>`)}</ul>` : html`<div class="muted">No deals.</div>`}
          <button class="link" id="add-deal">+ Add deal</button>
        </div>
      </div>
      ${activityPanel(acts.data)}
    </div>`);
  bindDetailHead('companies', co, 'companies', refresh);
  bindActivityPanel(main, { company_id: co.id }, refresh);
  $('#add-contact').onclick = async () => { if (await editRecord('contacts', {}, { company_id: co.id })) refresh(); };
  $('#add-deal').onclick = async () => {
    if (await editRecord('deals', {}, { company_id: co.id, owner_id: state.user.id })) refresh();
  };
}

async function viewDeal(id) {
  const [d, tasks, acts] = await Promise.all([
    api('GET', `/deals/${id}`),
    api('GET', `/tasks?deal_id=${id}`),
    api('GET', `/activities?deal_id=${id}`),
  ]);
  const refresh = () => viewDeal(id);
  const main = renderShell('deals', html`
    ${detailHead('deals', d, 'deals')}
    <div class="grid detail">
      <div class="stack">
        <div class="card">
          <div class="field">
            <label for="stage">Stage</label>
            <select id="stage">${STAGES.map((s) => html`<option value="${s}" ${raw(s === d.stage ? 'selected' : '')}>${s[0].toUpperCase() + s.slice(1)}</option>`)}</select>
          </div>
          ${props([
            ['Amount', fmtMoney(d.amount)],
            ['Company', d.company_id ? html`<a href="#/companies/${d.company_id}">${d.company_name}</a>` : ''],
            ['Contact', d.contact_id ? html`<a href="#/contacts/${d.contact_id}">${d.contact_name}</a>` : ''],
            ['Owner', d.owner_name],
            ['Expected close', fmtDate(d.expected_close)],
            ['Closed', fmtDate(d.closed_at)],
          ])}
        </div>
        <div class="card">
          <h2>Tasks</h2>
          ${tasks.data.length ? html`<ul class="list">${tasks.data.map(taskItem)}</ul>` : html`<div class="muted">No tasks.</div>`}
          <button class="link" id="add-task">+ Add task</button>
        </div>
      </div>
      ${activityPanel(acts.data)}
    </div>`);
  bindDetailHead('deals', d, 'deals', refresh);
  bindTaskToggles(main, refresh, tasks.data);
  bindActivityPanel(main, { deal_id: d.id, contact_id: d.contact_id || undefined, company_id: d.company_id || undefined }, refresh);
  $('#stage').onchange = async (e) => {
    try {
      await api('PATCH', `/deals/${d.id}`, { stage: e.target.value });
      toast('Stage updated');
      refresh();
    } catch (err) { reportError(err); }
  };
  $('#add-task').onclick = async () => {
    if (await editRecord('tasks', {}, { deal_id: d.id, contact_id: d.contact_id, assignee_id: state.user.id })) refresh();
  };
}

async function viewTeam() {
  const { data } = await api('GET', '/users');
  const isOwner = state.user.role === 'owner';
  const main = renderShell('team', html`
    <div class="page-head"><h1>Team</h1><span class="muted">${state.user.org_name}</span></div>
    <div class="grid two">
      <div class="card">
        <h2>Members</h2>
        <ul class="list">${data.map((u) => html`<li><div class="grow"><strong>${u.name}</strong><div class="muted small">${u.email}</div></div>
          ${badge(u.role)}
          ${isOwner && u.id !== state.user.id ? html`<button class="link small danger" data-remove="${u.id}">Remove</button>` : ''}</li>`)}</ul>
      </div>
      ${isOwner ? html`<div class="card">
        <h2>Add a team member</h2>
        <p class="muted small">They can sign in right away with this email and password. Ask them to keep it private.</p>
        <form id="add-member" novalidate>
          <div class="form-error" hidden></div>
          <div class="field"><label for="m_name">Name</label><input id="m_name" name="name" required></div>
          <div class="field"><label for="m_email">Email</label><input id="m_email" name="email" type="email" required></div>
          <div class="field"><label for="m_password">Temporary password</label><input id="m_password" name="password" type="password" minlength="8" required autocomplete="new-password"></div>
          <button class="primary" type="submit">Add member</button>
        </form>
      </div>` : html`<div class="card muted">Only the workspace owner can add or remove team members.</div>`}
    </div>`);
  if (isOwner) {
    $('#add-member', main).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      try {
        await api('POST', '/users', { name: f.name.value, email: f.email.value, password: f.password.value });
        toast('Team member added');
        viewTeam();
      } catch (err) {
        const box = $('.form-error', main);
        box.textContent = err.details ? Object.entries(err.details).map(([k, v]) => `${k} ${v}`).join('; ') : err.message;
        box.hidden = false;
      }
    };
    $$('[data-remove]', main).forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Remove this team member? Their records stay in the workspace.')) return;
        try { await api('DELETE', `/users/${btn.dataset.remove}`); viewTeam(); } catch (err) { reportError(err); }
      };
    });
  }
}

function viewAuth(mode) {
  const signup = mode === 'signup';
  document.getElementById('app').innerHTML = html`
    <div class="auth">
      <div class="brand"><img src="/favicon.svg" alt="">Compass CRM</div>
      <div class="card">
        <h2>${signup ? 'Create your workspace' : 'Sign in'}</h2>
        <form id="auth-form" novalidate>
          <div class="form-error" hidden></div>
          ${signup ? html`
            <div class="field"><label for="org_name">Company name</label><input id="org_name" name="org_name" required autocomplete="organization"></div>
            <div class="field"><label for="name">Your name</label><input id="name" name="name" required autocomplete="name"></div>` : ''}
          <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email"></div>
          <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" required minlength="8" autocomplete="${signup ? 'new-password' : 'current-password'}"></div>
          <button class="primary" type="submit">${signup ? 'Create workspace' : 'Sign in'}</button>
        </form>
      </div>
      <p class="muted">${signup ? html`Already have an account? <a href="#/login">Sign in</a>` : html`New here? <a href="#/signup">Create a workspace</a>`}</p>
    </div>`.toString();
  $('#auth-form input').focus();
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(e.target));
    const box = $('.form-error');
    try {
      const { user } = await api('POST', signup ? '/auth/signup' : '/auth/login', payload);
      state.user = user;
      location.hash = '#/dashboard';
    } catch (err) {
      const labels = { org_name: 'Company name', name: 'Name', email: 'Email', password: 'Password' };
      box.textContent = err.details ? Object.entries(err.details).map(([k, v]) => `${labels[k] || k} ${v}`).join('. ') : err.message;
      box.hidden = false;
    }
  };
}

// ---------------------------------------------------------------------------
// Router

const ROUTES = {
  dashboard: viewDashboard,
  contacts: viewContacts,
  companies: viewCompanies,
  deals: viewDeals,
  tasks: viewTasks,
  team: viewTeam,
};
const DETAIL = { contacts: viewContact, companies: viewCompany, deals: viewDeal };

async function route() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [section, id] = path.split('/');
  const params = new URLSearchParams(query);

  if (section === 'login' || section === 'signup') {
    if (state.user) { location.hash = '#/dashboard'; return; }
    viewAuth(section);
    return;
  }
  if (!state.user) {
    try {
      state.user = (await api('GET', '/me')).user;
    } catch {
      return; // api() redirects to login on 401
    }
  }
  try {
    if (id && DETAIL[section]) await DETAIL[section](Number(id));
    else if (ROUTES[section]) await ROUTES[section](params);
    else location.hash = '#/dashboard';
  } catch (err) {
    reportError(err);
  }
}

window.addEventListener('hashchange', route);
route();
