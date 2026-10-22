import { Router } from "express";
import { HttpError } from "../../shared/errors.js";
import { resetBodySchema } from "./slots.dto.js";
import type { SlotsRepository } from "./slots.repository.js";

export function slotsRoutes(repo: SlotsRepository): Router {
  const router = Router();

  router.post("/reset", async (req, res) => {
    const parsed = resetBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, "invalid slots payload");
    }
    const ids = new Set(parsed.data.slots.map((s) => s.id));
    if (ids.size !== parsed.data.slots.length) {
      throw new HttpError(400, "duplicate slot ids");
    }
    await repo.replaceAll(parsed.data.slots);
    res.status(200).json({ ok: true });
  });

  router.get("/slots", async (req, res) => {
    const provider = typeof req.query["provider"] === "string" ? req.query["provider"] : undefined;
    res.status(200).json({ slots: await repo.list(provider) });
  });

  return router;
}
