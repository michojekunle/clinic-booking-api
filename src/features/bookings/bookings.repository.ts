import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Db } from "../../shared/db.js";
import type { Booking } from "./bookings.dto.js";

interface BookingRow {
  seq: string;
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: "confirmed" | "cancelled";
  created_at: Date;
}

const COLUMNS = "seq, id, slot_id, name, email, status, created_at";

function toBooking(r: BookingRow): Booking {
  return {
    id: r.id,
    slot_id: r.slot_id,
    name: r.name,
    email: r.email,
    status: r.status,
    created_at: r.created_at.toISOString(),
  };
}

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
  readonly requestHash: string;
}

export class BookingsRepository {
  constructor(private readonly db: Db) {}

  /** Returns null when the slot already has a confirmed booking. */
  async insertConfirmed(
    client: PoolClient,
    input: { slotId: string; name: string; email: string },
  ): Promise<Booking | null> {
    const { rows } = await client.query<BookingRow>(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
       RETURNING ${COLUMNS}`,
      [randomUUID(), input.slotId, input.name, input.email],
    );
    const row = rows[0];
    return row ? toBooking(row) : null;
  }

  async findById(id: string): Promise<Booking | null> {
    const { rows } = await this.db.query<BookingRow>(`SELECT ${COLUMNS} FROM bookings WHERE id = $1`, [id]);
    const row = rows[0];
    return row ? toBooking(row) : null;
  }

  /** Atomic: only one concurrent cancel can flip confirmed -> cancelled. */
  async cancel(id: string): Promise<Booking | null> {
    const { rows } = await this.db.query<BookingRow>(
      `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING ${COLUMNS}`,
      [id],
    );
    const row = rows[0];
    return row ? toBooking(row) : null;
  }

  async listByEmail(
    email: string,
    afterSeq: string | null,
    limit: number,
  ): Promise<{ bookings: Booking[]; nextSeq: string | null }> {
    const { rows } = await this.db.query<BookingRow>(
      `SELECT ${COLUMNS} FROM bookings
        WHERE lower(email) = $1 AND ($2::bigint IS NULL OR seq > $2::bigint)
        ORDER BY seq ASC
        LIMIT $3`,
      [email.toLowerCase(), afterSeq, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const hasMore = rows.length > limit && last !== undefined;
    return { bookings: page.map(toBooking), nextSeq: hasMore ? last.seq : null };
  }

  async lockIdempotencyKey(client: PoolClient, key: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [`idem:${key}`]);
  }

  async findIdempotent(client: PoolClient, key: string): Promise<StoredResponse | null> {
    const { rows } = await client.query<{ request_hash: string; status: number; body: unknown }>(
      "SELECT request_hash, status, body FROM idempotency_keys WHERE key = $1",
      [key],
    );
    const row = rows[0];
    return row ? { status: row.status, body: row.body, requestHash: row.request_hash } : null;
  }

  async saveIdempotent(client: PoolClient, key: string, stored: StoredResponse): Promise<void> {
    await client.query(
      "INSERT INTO idempotency_keys (key, request_hash, status, body) VALUES ($1, $2, $3, $4)",
      [key, stored.requestHash, stored.status, JSON.stringify(stored.body)],
    );
  }

  /**
   * Sliding-window limiter backed by Postgres so it holds across instances.
   * Returns 0 if the attempt is allowed (and recorded), otherwise seconds to wait.
   */
  async recordAttempt(client: PoolClient, email: string, max: number, windowSeconds: number): Promise<number> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2))", [`rate:${email}`]);
    const { rows } = await client.query<{ count: string; wait: number | null }>(
      `SELECT count(*) AS count,
              CEIL(EXTRACT(EPOCH FROM (min(attempted_at) + make_interval(secs => $2) - clock_timestamp())))::int AS wait
         FROM booking_attempts
        WHERE email = $1 AND attempted_at > clock_timestamp() - make_interval(secs => $2)`,
      [email, windowSeconds],
    );
    const row = rows[0];
    if (row && Number(row.count) >= max) {
      return Math.max(1, row.wait ?? windowSeconds);
    }
    await client.query("INSERT INTO booking_attempts (email) VALUES ($1)", [email]);
    return 0;
  }
}
