'use strict';

// Creates a demo workspace with sample data.
// Usage: npm run seed   (sign in as demo@example.com / demo12345)

const path = require('node:path');
const fs = require('node:fs');
const { openDb, tx } = require('../src/db');
const { hashPassword } = require('../src/auth');

const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'crm.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = openDb(dbFile);

const EMAIL = 'demo@example.com';
if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(EMAIL)) {
  console.log(`Demo workspace already exists. Sign in as ${EMAIL} / demo12345`);
  process.exit(0);
}

const daysFromNow = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

tx(db, () => {
  const org = Number(db.prepare("INSERT INTO orgs (name) VALUES ('Demo Company')").run().lastInsertRowid);
  const insUser = db.prepare('INSERT INTO users (org_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)');
  const owner = Number(insUser.run(org, 'Alex Rivera', EMAIL, hashPassword('demo12345'), 'owner').lastInsertRowid);
  const rep = Number(insUser.run(org, 'Sam Chen', 'sam@example.com', hashPassword('demo12345'), 'member').lastInsertRowid);

  const insCompany = db.prepare('INSERT INTO companies (org_id, name, industry, website, phone) VALUES (?, ?, ?, ?, ?)');
  const companies = [
    ['Brightside Dental', 'Healthcare', 'brightsidedental.example', '555-0100'],
    ['Oak & Pine Realty', 'Real estate', 'oakpine.example', '555-0101'],
    ['Harbor Logistics', 'Transportation', 'harborlogistics.example', '555-0102'],
    ['Greenleaf Cafe', 'Food & beverage', 'greenleaf.example', '555-0103'],
  ].map((c) => Number(insCompany.run(org, ...c).lastInsertRowid));

  const insContact = db.prepare(`INSERT INTO contacts (org_id, first_name, last_name, email, phone, title, status, company_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const contacts = [
    ['Priya', 'Patel', 'priya@brightsidedental.example', '555-0110', 'Office Manager', 'customer', companies[0]],
    ['Marcus', 'Lee', 'marcus@oakpine.example', '555-0111', 'Broker', 'lead', companies[1]],
    ['Jordan', 'Kim', 'jordan@harborlogistics.example', '555-0112', 'Operations Director', 'lead', companies[2]],
    ['Elena', 'Garcia', 'elena@greenleaf.example', '555-0113', 'Owner', 'customer', companies[3]],
    ['Tom', 'Walsh', 'tom.walsh@example.com', '555-0114', 'Facilities Lead', 'lead', null],
  ].map((c) => Number(insContact.run(org, ...c).lastInsertRowid));

  const insDeal = db.prepare(`INSERT INTO deals (org_id, title, amount, stage, expected_close, closed_at, company_id, contact_id, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const now = new Date().toISOString();
  const deals = [
    ['Annual service contract', 12000, 'won', daysFromNow(-5), now, companies[0], contacts[0], owner],
    ['Office expansion package', 8500, 'proposal', daysFromNow(14), null, companies[1], contacts[1], owner],
    ['Warehouse onboarding', 24000, 'negotiation', daysFromNow(7), null, companies[2], contacts[2], rep],
    ['Monthly retainer', 1800, 'qualified', daysFromNow(21), null, companies[3], contacts[3], rep],
    ['Pilot project', 3000, 'new', daysFromNow(30), null, null, contacts[4], owner],
    ['Holiday promotion', 2500, 'lost', daysFromNow(-20), now, companies[3], contacts[3], rep],
  ].map((d) => Number(insDeal.run(org, ...d).lastInsertRowid));

  const insTask = db.prepare('INSERT INTO tasks (org_id, title, due_date, contact_id, deal_id, assignee_id) VALUES (?, ?, ?, ?, ?, ?)');
  insTask.run(org, 'Send revised proposal', daysFromNow(2), contacts[1], deals[1], owner);
  insTask.run(org, 'Follow up on contract redlines', daysFromNow(-1), contacts[2], deals[2], rep);
  insTask.run(org, 'Schedule intro call', daysFromNow(4), contacts[4], deals[4], owner);
  insTask.run(org, 'Quarterly check-in', daysFromNow(10), contacts[0], null, owner);

  const insAct = db.prepare('INSERT INTO activities (org_id, type, body, contact_id, company_id, deal_id, author_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insAct.run(org, 'call', 'Discussed scope for the warehouse. They want a start date next month.', contacts[2], companies[2], deals[2], rep);
  insAct.run(org, 'email', 'Sent pricing sheet and case studies.', contacts[1], companies[1], deals[1], owner);
  insAct.run(org, 'meeting', 'Kickoff went well. Signed the annual contract.', contacts[0], companies[0], deals[0], owner);
});

console.log(`Demo workspace created in ${dbFile}. Sign in as ${EMAIL} / demo12345`);
