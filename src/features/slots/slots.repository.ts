import type { PoolClient } from "pg";
import type { Db } from "../../shared/db.js";
import { withTransaction } from "../../shared/db.js";

export interface Slot {
  readonly id: string;
  readonly provider: string;
  readonly start: string;
  readonly end: string;
}

export interface SlotWithAvailability extends Slot {
  readonly available: boolean;
}

interface SlotRow {
  id: string;
  provider: string;
  start_raw: string;
  end_raw: string;
  available: boolean;
}

export class SlotsRepository {
  constructor(private readonly db: Db) {}

  async list(provider: string | undefined): Promise<SlotWithAvailability[]> {
    const { rows } = await this.db.query<SlotRow>(
      `SELECT s.id, s.provider, s.start_raw, s.end_raw,
              NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
         FROM slots s
        WHERE ($1::text IS NULL OR s.provider = $1)
        ORDER BY s.start_at ASC, s.id ASC`,
      [provider ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      start: r.start_raw,
      end: r.end_raw,
      available: r.available,
    }));
  }

  async replaceAll(slots: readonly Slot[]): Promise<void> {
    await withTransaction(this.db, async (client) => {
      // Takes the same lock family as bookings so a reset can't interleave with a booking mid-flight.
      await client.query("LOCK TABLE bookings, slots, idempotency_keys, booking_attempts IN ACCESS EXCLUSIVE MODE");
      await client.query("DELETE FROM bookings");
      await client.query("DELETE FROM slots");
      await client.query("DELETE FROM idempotency_keys");
      await client.query("DELETE FROM booking_attempts");
      for (const slot of slots) {
        await client.query(
          "INSERT INTO slots (id, provider, start_raw, end_raw, start_at) VALUES ($1, $2, $3, $4, $5)",
          [slot.id, slot.provider, slot.start, slot.end, new Date(slot.start)],
        );
      }
    });
  }

  async findStart(client: PoolClient, id: string): Promise<Date | null> {
    const { rows } = await client.query<{ start_at: Date }>("SELECT start_at FROM slots WHERE id = $1", [id]);
    return rows[0]?.start_at ?? null;
  }
}
