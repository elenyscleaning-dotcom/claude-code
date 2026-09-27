# Compass CRM

A customer relationship management (CRM) platform for small businesses. Any company can sign up for its own private workspace, then track its customers, companies, sales pipeline, tasks and communication history. Team members share that workspace.

It has no dependencies: it runs on Node.js 22.13 or newer with the built-in SQLite database, and there is no build step or `npm install`.

## Quick start

```bash
cd platform
npm run seed   # optional: creates a demo workspace (demo@example.com / demo12345)
npm start      # http://localhost:3000
```

Open http://localhost:3000 and either sign in to the demo workspace or create your own.

## Features

| Area | What you can do |
| --- | --- |
| **Workspaces** | Each signup creates an isolated organization. Every query is scoped to the user's organization, and a workspace can't read or link to another workspace's records. |
| **Dashboard** | Open pipeline value, revenue won this month, win rate, open deals, contacts, overdue tasks, pipeline by stage, upcoming tasks, recent activity. |
| **Contacts** | Leads and customers, linked to companies. Search, filter by status, and export to CSV. |
| **Companies** | Accounts with their people, deals and activity. |
| **Deals** | A Kanban board with drag-and-drop between stages (new, qualified, proposal, negotiation, won, lost). Records when each deal closed. |
| **Tasks** | Due dates, assignees, overdue badges, links to contacts and deals. |
| **Activity log** | Notes, calls, emails and meetings on any contact, company or deal. |
| **Team** | The workspace owner adds and removes members. |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_FILE` | `platform/data/crm.db` | SQLite file (`:memory:` for a throwaway database) |
| `SECURE_COOKIES` | unset | Set to `1` when serving over HTTPS |

## Project layout

```
platform/
├── src/
│   ├── server.js     HTTP server, static files, body parsing, security headers
│   ├── api.js        REST routes, validation, dashboard, auth and team endpoints, CSV export
│   ├── resources.js  Record types (fields, search, filters) that drive the generic CRUD endpoints
│   ├── auth.js       scrypt password hashing, sessions, cookies, login rate limiting
│   └── db.js         SQLite schema
├── public/           Single-page frontend (vanilla JS, no framework)
├── scripts/seed.js   Demo data
└── test/             API tests (node:test)
```

To add a new record type, add a table in `db.js` and an entry in `resources.js`. The list, get, create, update and delete endpoints (plus search, filters and organization scoping) come from that definition.

## API

Every endpoint is under `/api`, and requests and responses are JSON. Authentication uses an HttpOnly session cookie.

- `POST /auth/signup` `{org_name, name, email, password}`, `POST /auth/login`, `POST /auth/logout`
- `GET /me`, `GET /dashboard`
- `GET|POST /users` and `DELETE /users/:id` (adding and removing users is owner-only)
- `GET|POST /{contacts,companies,deals,tasks,activities}`: list (`?q=`, filters, `limit`, `offset`) or create
- `GET|PATCH|DELETE /{resource}/:id`
- `GET /{contacts,companies,deals}/export.csv`

Requests that change data must send `Content-Type: application/json`, and `DELETE` requests must send `X-Requested-With: fetch`. These requirements block cross-site request forgery.

## Security

- Passwords are hashed with scrypt, and session tokens are 256-bit random values.
- Login attempts are rate limited per IP address and email.
- A strict Content-Security-Policy is set, and the frontend escapes all interpolated values.
- CSV exports neutralize spreadsheet formulas.
- Every read and write is scoped to the user's organization, including checks on linked records.

## Tests

```bash
npm test
```

The suite covers auth, validation, CRUD, isolation between organizations, dashboard math, team permissions, CSV export, CSRF protection, static file serving and rate limiting.

## Roadmap ideas

Email invitations and password reset, custom fields, CSV import, per-user activity reports, email and calendar integrations, and Postgres for larger deployments.
