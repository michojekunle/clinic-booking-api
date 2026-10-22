import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { HttpError } from "./errors.js";

export function requireApiKey(expected: string): RequestHandler {
  const expectedBuf = Buffer.from(expected);
  return (req, _res, next) => {
    const provided = Buffer.from(req.header("X-API-Key") ?? "");
    const ok = provided.length === expectedBuf.length && timingSafeEqual(provided, expectedBuf);
    next(ok ? undefined : new HttpError(401, "missing or invalid API key"));
  };
}
