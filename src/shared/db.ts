import pg from "pg";

export type Db = pg.Pool;

export function createPool(connectionString: string): Db {
  const ssl = /localhost|127\.0\.0\.1/.test(connectionString) ? undefined : { rejectUnauthorized: false };
  return new pg.Pool({ connectionString, ssl, max: 20 });
}

export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err: unknown) {
    await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
      console.error("rollback failed", rollbackErr);
    });
    throw err;
  } finally {
    client.release();
  }
}

// The partial unique index is the actual guarantee that a slot can never hold two
// confirmed bookings, no matter how many requests race.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id        TEXT PRIMARY KEY,
  provider  TEXT NOT NULL,
  start_raw TEXT NOT NULL,
  end_raw   TEXT NOT NULL,
  start_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS slots_start_idx ON slots (start_at, id);

CREATE TABLE IF NOT EXISTS bookings (
  seq        BIGSERIAL PRIMARY KEY,
  id         TEXT NOT NULL UNIQUE,
  slot_id    TEXT NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS bookings_email_seq_idx ON bookings (email, seq);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status       INT NOT NULL,
  body         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking_attempts (
  seq          BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS booking_attempts_email_idx ON booking_attempts (email, attempted_at);
`;

export async function migrate(db: Db): Promise<void> {
  // Serialise concurrent boots so two instances don't race CREATE IF NOT EXISTS.
  await withTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(727001)");
    await client.query(SCHEMA);
  });
}
