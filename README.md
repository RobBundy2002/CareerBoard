# CareerBoard

CareerBoard is a multi-tenant collaborative job-search workspace for career groups. Owners and admins invite members, members manage their own applications, and the whole team can collaborate through comments, activity history, interviews, and analytics.

## Included

- Password authentication with expiring, revocable signed tokens
- Owner/admin/member authorization checked against team membership on every route
- Relational SQLite model: users, teams, memberships, invitations, companies, jobs, applications, comments, interviews, activity, and analytics events
- JSON API for collaboration, applications, comments, interviews, health, readiness, and analytics
- Durable SQLite job queue with an in-process worker for in-app comment and interview notifications
- Security headers, request-size limits, rate limiting, validation, and structured error logging
- GitHub Actions CI for checks, tests, dependency audit, and Docker builds
- Docker deployment configuration with `/api/health` and `/api/ready` probes

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Open http://localhost:3000. For production, set a strong `JWT_SECRET`, put SQLite on a persistent volume, and monitor `/api/health` and `/api/ready`. The event table is intentionally simple so it can later be replaced with PostHog or another analytics provider without changing the UI contract.
