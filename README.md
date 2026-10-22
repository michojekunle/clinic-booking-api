# Clinic Booking API

Node.js + TypeScript + Express + Postgres. Implements the Koya Task 1 spec (levels 1–5) and a small web page at `/`.

## Run locally
```bash
cp .env.example .env   # set DATABASE_URL and API_KEY
npm install
npm run dev
npm test               # needs DATABASE_URL pointing at a throwaway database
```

## Design decisions
- **No double booking**: a partial unique index (`slot_id WHERE status='confirmed'`) plus `INSERT … ON CONFLICT DO NOTHING`. The database decides the winner, so it holds across processes. Cancelling frees the slot because the index only covers confirmed rows.
- **Idempotency**: key + canonical body hash stored with the response; a per-key advisory lock makes concurrent retries wait and replay the first response. Different body → 422.
- **Rate limit**: sliding 60s window of attempts per lower-cased email stored in Postgres (works on multiple instances), serialised by an advisory lock; failed attempts count, blocked ones don't.
- **Pagination**: opaque cursor over an insertion sequence, stable even with equal timestamps.
- The web page asks for the API key once (kept in localStorage) rather than embedding it in public JS.

## Deploy (Render + Neon)
1. Create a Neon project, copy the connection string.
2. Push to GitHub, create a Render web service from `render.yaml`, set `DATABASE_URL` and `API_KEY`.
