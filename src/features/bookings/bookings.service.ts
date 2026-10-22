import { createHash } from "node:crypto";
import type { Db } from "../../shared/db.js";
import { withTransaction } from "../../shared/db.js";
import { HttpError } from "../../shared/errors.js";
import type { SlotsRepository } from "../slots/slots.repository.js";
import { decodeCursor, encodeCursor, newBookingSchema, parseLimit } from "./bookings.dto.js";
import type { Booking } from "./bookings.dto.js";
import type { BookingsRepository } from "./bookings.repository.js";

export const RATE_LIMIT_MAX = 5;
export const RATE_LIMIT_WINDOW_SECONDS = 60;

export interface ServiceResponse {
  readonly status: number;
  readonly body: unknown;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hashBody(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

function rateLimitKey(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const email = (body as Record<string, unknown>)["email"];
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  return normalized === "" ? null : normalized;
}

export class BookingsService {
  constructor(
    private readonly db: Db,
    private readonly bookings: BookingsRepository,
    private readonly slots: SlotsRepository,
  ) {}

  async create(body: unknown, idempotencyKey: string | undefined): Promise<ServiceResponse> {
    await this.enforceRateLimit(body);

    if (idempotencyKey === undefined) {
      return withTransaction(this.db, (client) => this.attemptBooking(client, body));
    }

    const requestHash = hashBody(body);
    return withTransaction(this.db, async (client) => {
      // Serialises concurrent retries of the same key so only the first does the work.
      await this.bookings.lockIdempotencyKey(client, idempotencyKey);
      const existing = await this.bookings.findIdempotent(client, idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          return { status: 422, body: { error: "Idempotency-Key was already used with a different request body" } };
        }
        return { status: existing.status, body: existing.body };
      }
      const response = await this.attemptBooking(client, body);
      await this.bookings.saveIdempotent(client, idempotencyKey, { ...response, requestHash });
      return response;
    });
  }

  private async enforceRateLimit(body: unknown): Promise<void> {
    const email = rateLimitKey(body);
    if (email === null) return;
    // Own transaction: the attempt must stay recorded even if the booking itself fails or rolls back.
    const wait = await withTransaction(this.db, (client) =>
      this.bookings.recordAttempt(client, email, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS),
    );
    if (wait > 0) {
      throw new HttpError(429, "too many booking attempts, try again later", { "Retry-After": String(wait) });
    }
  }

  private async attemptBooking(
    client: Parameters<BookingsRepository["insertConfirmed"]>[0],
    body: unknown,
  ): Promise<ServiceResponse> {
    const parsed = newBookingSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, body: { error: "slot_id, name and a valid email are required" } };
    }
    const { slot_id: slotId, name, email } = parsed.data;

    const start = await this.slots.findStart(client, slotId);
    if (start === null) return { status: 404, body: { error: "slot not found" } };
    if (start.getTime() <= Date.now()) return { status: 400, body: { error: "slot has already started" } };

    const booking = await this.bookings.insertConfirmed(client, { slotId, name, email });
    if (booking === null) return { status: 409, body: { error: "slot already booked" } };
    return { status: 201, body: booking };
  }

  async get(id: string): Promise<Booking> {
    const booking = await this.bookings.findById(id);
    if (!booking) throw new HttpError(404, "booking not found");
    return booking;
  }

  async cancel(id: string): Promise<Booking> {
    const cancelled = await this.bookings.cancel(id);
    if (cancelled) return cancelled;
    const existing = await this.bookings.findById(id);
    if (!existing) throw new HttpError(404, "booking not found");
    throw new HttpError(409, "booking already cancelled");
  }

  async list(query: { email: unknown; limit: unknown; cursor: unknown }): Promise<{
    bookings: Booking[];
    next_cursor: string | null;
  }> {
    if (typeof query.email !== "string" || query.email.trim() === "") {
      throw new HttpError(400, "email is required");
    }
    const limit = parseLimit(query.limit);
    if (limit === null) throw new HttpError(400, "limit must be an integer between 1 and 50");

    let afterSeq: string | null = null;
    if (query.cursor !== undefined) {
      afterSeq = typeof query.cursor === "string" ? decodeCursor(query.cursor) : null;
      if (afterSeq === null) throw new HttpError(400, "invalid cursor");
    }

    const { bookings, nextSeq } = await this.bookings.listByEmail(query.email.trim(), afterSeq, limit);
    return { bookings, next_cursor: nextSeq === null ? null : encodeCursor(nextSeq) };
  }
}
