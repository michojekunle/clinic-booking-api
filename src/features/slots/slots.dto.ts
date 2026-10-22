import { z } from "zod";

const dateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO date-time");

export const resetBodySchema = z.object({
  slots: z.array(
    z.object({
      id: z.string().min(1),
      provider: z.string().min(1),
      start: dateTime,
      end: dateTime,
    }),
  ),
});
