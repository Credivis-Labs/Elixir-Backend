import { createDb, createLogger, loadConfig } from "@elixir/core";
import { z } from "zod";
import { buildApp } from "./app.js";

const config = loadConfig({ API_PORT: z.coerce.number().int().default(3000) });
const log = createLogger("api");
const sql = createDb(config.DATABASE_URL);

const app = buildApp({ sql, logger: log });
await app.listen({ port: config.API_PORT, host: "0.0.0.0" });
log.info({ port: config.API_PORT, network: config.STELLAR_NETWORK }, "api listening");

const shutdown = async () => {
  await app.close();
  await sql.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
