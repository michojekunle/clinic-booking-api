import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { createApp } from "./app.js";
import { createPool, migrate } from "./shared/db.js";
import type { Db } from "./shared/db.js";

const KEY = "test-key";
const FUTURE = "2099-01-01T09:00:00Z";
const FUTURE_END = "2099-01-01T09:30:00Z";

let db: Db;
let server: Server;
let base: string;

interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper, JSON shape asserted per test
  headers: Headers;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

const slots = [
  { id: "s1", provider: "Dr Ade", start: FUTURE, end: FUTURE_END },
  { id: "s2", provider: "Dr Bola", start: "2099-01-01T08:00:00Z", end: "2099-01-01T08:30:00Z" },
  { id: "past", provider: "Dr Ade", start: "2020-01-01T09:00:00Z", end: "2020-01-01T09:30:00Z" },
];

before(async () => {
  db = createPool(process.env["DATABASE_URL"] ?? "");
  await migrate(db);
  server = createApp(db, KEY).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await db.end();
});

beforeEach(async () => {
  await call("POST", "/reset", { slots });
});

const person = (n: number): { slot_id: string; name: string; email: string } => ({
  slot_id: "s1",
  name: "Ada",
  email: `p${n}@x.com`,
});

describe("level 1 and 2", () => {
  it("lists slots earliest first with availability and filters by provider", async () => {
    const all = await call("GET", "/slots");
    assert.deepEqual(all.body.slots.map((s: { id: string }) => s.id), ["past", "s2", "s1"]);
    assert.equal(all.body.slots[2].available, true);
    assert.equal(all.body.slots[2].start, FUTURE);
    const ade = await call("GET", "/slots?provider=Dr%20Ade");
    assert.equal(ade.body.slots.length, 2);
  });

  it("books and fetches a booking, trimming and lowercasing", async () => {
    const created = await call("POST", "/bookings", { slot_id: "s1", name: "  Ada  ", email: " ADA@Example.com " });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, "Ada");
    assert.equal(created.body.email, "ada@example.com");
    assert.equal(created.body.status, "confirmed");
    const got = await call("GET", `/bookings/${created.body.id}`);
    assert.deepEqual(got.body, created.body);
    const slot = (await call("GET", "/slots")).body.slots.find((s: { id: string }) => s.id === "s1");
    assert.equal(slot.available, false);
  });

  it("returns 404 for an unknown booking", async () => {
    assert.equal((await call("GET", "/bookings/nope")).status, 404);
  });

  it("returns 401 for a missing or wrong key", async () => {
    assert.equal((await call("GET", "/slots", undefined, { "X-API-Key": "bad" })).status, 401);
    const res = await fetch(`${base}/slots`);
    assert.equal(res.status, 401);
  });

  it("returns 400 for invalid details, 404 for unknown slot, 400 for past slot", async () => {
    for (const bad of [
      {},
      { slot_id: "s1", name: "", email: "v1@b.co" },
      { slot_id: "s1", name: "A", email: "not-an-email" },
      { slot_id: "", name: "A", email: "v2@b.co" },
      { slot_id: 5, name: "A", email: "v3@b.co" },
      { slot_id: "s1", name: "   ", email: "v4@b.co" },
    ]) {
      assert.equal((await call("POST", "/bookings", bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await call("POST", "/bookings", { slot_id: "zzz", name: "A", email: "v5@b.co" })).status, 404);
    assert.equal((await call("POST", "/bookings", { slot_id: "past", name: "A", email: "v6@b.co" })).status, 400);
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await fetch(`${base}/bookings`, {
      method: "POST",
      headers: { "X-API-Key": KEY, "Content-Type": "application/json" },
      body: "{oops",
    });
    assert.equal(res.status, 400);
  });
});

describe("level 3", () => {
  it("lets exactly one of 25 simultaneous requests win", async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => call("POST", "/bookings", { ...person(i), email: `u${i}@x.com` })),
    );
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 201).length, 1);
    assert.equal(statuses.filter((s) => s === 409).length, 24);
  });

  it("cancels, frees the slot, and rejects a second cancel", async () => {
    const b = (await call("POST", "/bookings", person(1))).body;
    const cancelled = await call("DELETE", `/bookings/${b.id}`);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");
    assert.equal((await call("DELETE", `/bookings/${b.id}`)).status, 409);
    assert.equal((await call("DELETE", "/bookings/nope")).status, 404);
    assert.equal((await call("POST", "/bookings", person(2))).status, 201);
  });
});

describe("level 4", () => {
  it("replays the same response for a retried idempotency key, even concurrently", async () => {
    const headers = { "Idempotency-Key": "k1" };
    const rs = await Promise.all(Array.from({ length: 5 }, () => call("POST", "/bookings", person(1), headers)));
    assert.ok(rs.every((r) => r.status === 201));
    assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
    const list = await call("GET", "/bookings?email=P1@X.com");
    assert.equal(list.body.bookings.length, 1);
  });

  it("replays a stored 409 and returns 422 for a different body", async () => {
    await call("POST", "/bookings", person(1));
    const first = await call("POST", "/bookings", person(2), { "Idempotency-Key": "k2" });
    assert.equal(first.status, 409);
    assert.equal((await call("POST", "/bookings", person(2), { "Idempotency-Key": "k2" })).status, 409);
    assert.equal((await call("POST", "/bookings", person(3), { "Idempotency-Key": "k2" })).status, 422);
  });

  it("pages bookings oldest first with cursors", async () => {
    await call("POST", "/reset", {
      slots: Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, provider: "P", start: FUTURE, end: FUTURE_END })),
    });
    // Different "people" would be rate-limited together here, so use one email under the limit of 5.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await call("POST", "/bookings", { slot_id: `x${i}`, name: "A", email: "page@x.com" })).body.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `/bookings?email=PAGE@x.com&limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const r: Res = await call("GET", q);
      assert.equal(r.status, 200);
      seen.push(...r.body.bookings.map((b: { id: string }) => b.id));
      cursor = r.body.next_cursor;
      pages++;
    } while (cursor !== null);
    assert.deepEqual(seen, ids);
    assert.equal(pages, 3);
  });

  it("rejects bad limits, bad cursors and missing email", async () => {
    for (const l of ["0", "51", "abc", "1.5", "-1"]) {
      assert.equal((await call("GET", `/bookings?email=a@b.co&limit=${l}`)).status, 400, l);
    }
    assert.equal((await call("GET", "/bookings?email=a@b.co&cursor=%%%")).status, 400);
    assert.equal((await call("GET", "/bookings")).status, 400);
    assert.equal((await call("GET", "/bookings?email=nobody@b.co")).body.next_cursor, null);
  });
});

describe("level 5", () => {
  it("allows 5 attempts per email per minute including failures, then 429 with Retry-After", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await call("POST", "/bookings", { slot_id: "zzz", name: "A", email: "spam@x.com" });
      assert.equal(r.status, 404);
    }
    const blocked = await call("POST", "/bookings", { slot_id: "s1", name: "A", email: "SPAM@x.com" });
    assert.equal(blocked.status, 429);
    const retry = Number(blocked.headers.get("Retry-After"));
    assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 60, `Retry-After=${retry}`);
    assert.equal((await call("POST", "/bookings", { slot_id: "s1", name: "A", email: "other@x.com" })).status, 201);
  });

  it("counts concurrent attempts correctly", async () => {
    const rs = await Promise.all(
      Array.from({ length: 12 }, () => call("POST", "/bookings", { slot_id: "zzz", name: "A", email: "c@x.com" })),
    );
    assert.equal(rs.filter((r) => r.status === 404).length, 5);
    assert.equal(rs.filter((r) => r.status === 429).length, 7);
  });
});
