import { z } from "zod";

// Deliberately simple: one @, no spaces, a dot in the domain. Full RFC validation rejects real addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const newBookingSchema = z.object({
  slot_id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  email: z
    .string()
    .trim()
    .min(1)
    .max(254)
    .regex(EMAIL_RE)
    .transform((v) => v.toLowerCase()),
});

export type NewBooking = z.infer<typeof newBookingSchema>;

export interface Booking {
  readonly id: string;
  readonly slot_id: string;
  readonly name: string;
  readonly email: string;
  readonly status: "confirmed" | "cancelled";
  readonly created_at: string;
}

const LIMIT_RE = /^\d+$/;

export function parseLimit(raw: unknown): number | null {
  if (raw === undefined) return 10;
  if (typeof raw !== "string" || !LIMIT_RE.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 50 ? n : null;
}

export function encodeCursor(seq: string): string {
  return Buffer.from(seq, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): string | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  return /^\d{1,18}$/.test(decoded) ? decoded : null;
}
