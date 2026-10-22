import { Router } from "express";
import type { BookingsService } from "./bookings.service.js";

export function bookingsRoutes(service: BookingsService): Router {
  const router = Router();

  router.post("/bookings", async (req, res) => {
    const header = req.header("Idempotency-Key");
    const key = header !== undefined && header.trim() !== "" ? header.trim() : undefined;
    const result = await service.create(req.body, key);
    res.status(result.status).json(result.body);
  });

  router.get("/bookings", async (req, res) => {
    const { email, limit, cursor } = req.query;
    res.status(200).json(await service.list({ email, limit, cursor }));
  });

  router.get("/bookings/:id", async (req, res) => {
    res.status(200).json(await service.get(String(req.params["id"])));
  });

  router.delete("/bookings/:id", async (req, res) => {
    res.status(200).json(await service.cancel(String(req.params["id"])));
  });

  return router;
}
