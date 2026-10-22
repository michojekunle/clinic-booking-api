import { createApp } from "./app.js";
import { loadConfig } from "./shared/config.js";
import { createPool, migrate } from "./shared/db.js";
import { SlotsRepository } from "./features/slots/slots.repository.js";

// Demo slots so the web page is usable on a fresh database; /reset replaces them.
async function seedIfEmpty(slots: SlotsRepository): Promise<void> {
  if ((await slots.list(undefined)).length > 0) return;
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 1);
  day.setUTCHours(9, 0, 0, 0);
  const demo = ["Dr Ade", "Dr Bola"].flatMap((provider, p) =>
    [0, 1, 2, 3].map((i) => {
      const start = new Date(day.getTime() + i * 30 * 60_000);
      const end = new Date(start.getTime() + 30 * 60_000);
      return { id: `s${p * 4 + i + 1}`, provider, start: start.toISOString(), end: end.toISOString() };
    }),
  );
  await slots.replaceAll(demo);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createPool(config.databaseUrl);
  await migrate(db);
  await seedIfEmpty(new SlotsRepository(db));
  const app = createApp(db, config.apiKey);
  const server = app.listen(config.port, () => {
    console.log(`listening on ${config.port}`);
  });
  const shutdown = (): void => {
    server.close(() => {
      db.end().catch((err: unknown) => console.error("pool close failed", err));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  console.error("fatal startup error", err);
  process.exit(1);
});
