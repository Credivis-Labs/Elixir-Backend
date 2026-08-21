import { createDb, createLogger, loadConfig } from "@elixir/core";

const config = loadConfig();
const log = createLogger("indexer");
const sql = createDb(config.DATABASE_URL);

await sql`select 1`;
log.info({ network: config.STELLAR_NETWORK }, "indexer booted");

const shutdown = async () => {
  await sql.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
