import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { ErrorRequestHandler, Express } from "express";
import { BookingsRepository } from "./features/bookings/bookings.repository.js";
import { bookingsRoutes } from "./features/bookings/bookings.routes.js";
import { BookingsService } from "./features/bookings/bookings.service.js";
import { SlotsRepository } from "./features/slots/slots.repository.js";
import { slotsRoutes } from "./features/slots/slots.routes.js";
import { requireApiKey } from "./shared/auth.js";
import type { Db } from "./shared/db.js";
import { HttpError } from "./shared/errors.js";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

export function createApp(db: Db, apiKey: string): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  // Public: the web page and a health probe. Everything else needs the API key.
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use(express.static(publicDir));

  app.use(requireApiKey(apiKey));
  app.use(express.json({ limit: "100kb" }));

  const slotsRepo = new SlotsRepository(db);
  const bookingsService = new BookingsService(db, new BookingsRepository(db), slotsRepo);
  app.use(slotsRoutes(slotsRepo));
  app.use(bookingsRoutes(bookingsService));

  app.use((_req, _res, next) => {
    next(new HttpError(404, "not found"));
  });

  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.set(err.headers).status(err.status).json({ error: err.message });
      return;
    }
    // body-parser errors (malformed JSON, too large) carry a 4xx status.
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(400).json({ error: "invalid request body" });
      return;
    }
    console.error("unhandled error", err);
    res.status(500).json({ error: "internal server error" });
  };
  app.use(onError);

  return app;
}
