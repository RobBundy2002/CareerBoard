# CareerBoard

CareerBoard is a collaborative job-application tracker for career groups. Members can keep applications in one shared pipeline, record next steps, and see progress over time.

## Included

- Password authentication with signed sessions
- SQLite persistence for users, teams, applications, and product events
- JSON API for auth, applications, health checks, and analytics
- Responsive frontend with Saved → Applied → Interview → Offer → Rejected pipeline
- First-party event analytics stored in the database
- `/api/health` endpoint for uptime monitoring
- Docker deployment configuration

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Open http://localhost:3000. For production, set a strong `JWT_SECRET`, put SQLite on a persistent volume, and monitor `/api/health` with an uptime service. The event table is intentionally simple so it can later be replaced with PostHog or another analytics provider without changing the UI contract.
