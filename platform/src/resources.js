'use strict';

// Declarative definitions for the CRM's record types. The API layer turns
// each of these into list / get / create / update / delete endpoints that are
// always scoped to the signed-in user's organization.

const DEAL_STAGES = ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];

const resources = {
  companies: {
    table: 'companies',
    alias: 'co',
    select: `SELECT co.*,
      (SELECT COUNT(*) FROM contacts c WHERE c.company_id = co.id) AS contact_count,
      (SELECT COUNT(*) FROM deals d WHERE d.company_id = co.id AND d.stage NOT IN ('won','lost')) AS open_deal_count
      FROM companies co`,
    fields: {
      name: { type: 'text', required: true, max: 200 },
      industry: { type: 'text', max: 100 },
      website: { type: 'text', max: 300 },
      phone: { type: 'text', max: 50 },
      address: { type: 'text', max: 500 },
      notes: { type: 'text', max: 10000 },
    },
    search: ['co.name', 'co.industry', 'co.website'],
    filters: {},
    order: 'co.name COLLATE NOCASE',
  },

  contacts: {
    table: 'contacts',
    alias: 'c',
    select: `SELECT c.*, co.name AS company_name
      FROM contacts c LEFT JOIN companies co ON co.id = c.company_id`,
    fields: {
      first_name: { type: 'text', required: true, max: 100 },
      last_name: { type: 'text', max: 100 },
      email: { type: 'email' },
      phone: { type: 'text', max: 50 },
      title: { type: 'text', max: 100 },
      status: { type: 'enum', values: ['lead', 'customer', 'inactive'] },
      company_id: { type: 'ref', table: 'companies' },
      notes: { type: 'text', max: 10000 },
    },
    search: ['c.first_name', 'c.last_name', 'c.email', 'c.phone', 'co.name'],
    filters: { company_id: 'c.company_id', status: 'c.status' },
    order: 'c.first_name COLLATE NOCASE, c.last_name COLLATE NOCASE',
  },

  deals: {
    table: 'deals',
    alias: 'd',
    select: `SELECT d.*, co.name AS company_name,
      TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS contact_name,
      u.name AS owner_name
      FROM deals d
      LEFT JOIN companies co ON co.id = d.company_id
      LEFT JOIN contacts c ON c.id = d.contact_id
      LEFT JOIN users u ON u.id = d.owner_id`,
    fields: {
      title: { type: 'text', required: true, max: 200 },
      amount: { type: 'number', min: 0 },
      stage: { type: 'enum', values: DEAL_STAGES },
      expected_close: { type: 'date' },
      company_id: { type: 'ref', table: 'companies' },
      contact_id: { type: 'ref', table: 'contacts' },
      owner_id: { type: 'ref', table: 'users' },
    },
    search: ['d.title', 'co.name', 'c.first_name', 'c.last_name'],
    filters: { stage: 'd.stage', company_id: 'd.company_id', contact_id: 'd.contact_id', owner_id: 'd.owner_id' },
    order: 'd.updated_at DESC',
    beforeWrite(values, existing) {
      // Track when a deal is closed so the dashboard can report won revenue by month.
      if (values.stage === undefined) return;
      const closed = values.stage === 'won' || values.stage === 'lost';
      const wasClosed = existing && (existing.stage === 'won' || existing.stage === 'lost');
      if (closed && (!wasClosed || existing.stage !== values.stage)) values.closed_at = new Date().toISOString();
      if (!closed) values.closed_at = null;
    },
  },

  tasks: {
    table: 'tasks',
    alias: 't',
    select: `SELECT t.*,
      TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS contact_name,
      d.title AS deal_title, u.name AS assignee_name
      FROM tasks t
      LEFT JOIN contacts c ON c.id = t.contact_id
      LEFT JOIN deals d ON d.id = t.deal_id
      LEFT JOIN users u ON u.id = t.assignee_id`,
    fields: {
      title: { type: 'text', required: true, max: 300 },
      due_date: { type: 'date' },
      done: { type: 'bool' },
      contact_id: { type: 'ref', table: 'contacts' },
      deal_id: { type: 'ref', table: 'deals' },
      assignee_id: { type: 'ref', table: 'users' },
    },
    search: ['t.title'],
    filters: { done: 't.done', contact_id: 't.contact_id', deal_id: 't.deal_id', assignee_id: 't.assignee_id' },
    order: 't.done, t.due_date IS NULL, t.due_date, t.id',
  },

  activities: {
    table: 'activities',
    alias: 'a',
    select: `SELECT a.*, u.name AS author_name,
      TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS contact_name,
      co.name AS company_name, d.title AS deal_title
      FROM activities a
      LEFT JOIN users u ON u.id = a.author_id
      LEFT JOIN contacts c ON c.id = a.contact_id
      LEFT JOIN companies co ON co.id = a.company_id
      LEFT JOIN deals d ON d.id = a.deal_id`,
    fields: {
      type: { type: 'enum', values: ['note', 'call', 'email', 'meeting'] },
      body: { type: 'text', required: true, max: 10000 },
      contact_id: { type: 'ref', table: 'contacts' },
      company_id: { type: 'ref', table: 'companies' },
      deal_id: { type: 'ref', table: 'deals' },
    },
    search: ['a.body'],
    filters: { contact_id: 'a.contact_id', company_id: 'a.company_id', deal_id: 'a.deal_id', type: 'a.type' },
    order: 'a.created_at DESC, a.id DESC',
    onCreate(values, user) {
      values.author_id = user.id;
    },
  },
};

module.exports = { resources, DEAL_STAGES };
