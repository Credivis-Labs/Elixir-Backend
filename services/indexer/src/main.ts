import { createDb, createLogger, loadConfig } from "@elixir/core";
import { createServer } from "node:http";
import { z } from "zod";
import { Indexer } from "./indexer.js";
import { openAlerts, openGaps, proposalHistory, timeline } from "./queries.js";
import { rpcChainReader, rpcEventSource } from "./source.js";

const config = loadConfig({
  INDEXER_PORT: z.coerce.number().int().default(3002),
  INDEXER_POLL_MS: z.coerce.number().int().default(5000),
  INDEXER_RECONCILE_EVERY: z.coerce.number().int().default(60),
  INDEXER_GENESIS_LEDGER: z.coerce.number().int().optional(),
  INDEXER_EXTRA_CONTRACTS: z.string().default(""),
});
const log = createLogger("indexer");
const sql = createDb(config.DATABASE_URL);
const indexer = new Indexer(
  sql,
  rpcEventSource(config.SOROBAN_RPC_URL),
  rpcChainReader(config.SOROBAN_RPC_URL),
  log,
  {
    network: config.STELLAR_NETWORK,
    extraContracts: config.INDEXER_EXTRA_CONTRACTS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    ...(config.INDEXER_GENESIS_LEDGER !== undefined
      ? { genesisLedger: config.INDEXER_GENESIS_LEDGER }
      : {}),
  },
);

let running = true;
let ticks = 0;
async function loop() {
  while (running) {
    try {
      const r = await indexer.runOnce();
      if (r.ingested || r.gaps) log.info(r, "ingested");
      if (++ticks % config.INDEXER_RECONCILE_EVERY === 0) {
        const alerts = await indexer.reconcile();
        if (alerts) log.error({ alerts }, "reconciliation alerts raised");
      }
    } catch (err) {
      log.error(err, "ingest tick failed");
    }
    await new Promise((r) => setTimeout(r, config.INDEXER_POLL_MS));
  }
}

const server = createServer(async (req, res) => {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  };
  try {
    const url = new URL(req.url ?? "/", "http://local");
    const [, root, account, leaf] = url.pathname.split("/");
    if (root === "health") {
      return json(200, { ok: true, cursor: await indexer.cursor() });
    }
    if (root === "gaps") return json(200, await openGaps(sql, config.STELLAR_NETWORK));
    if (root === "alerts") return json(200, await openAlerts(sql));
    if (root === "accounts" && account && leaf === "timeline") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const before = url.searchParams.get("before");
      return json(
        200,
        await timeline(sql, account, {
          limit,
          ...(before ? { beforeLedger: Number(before) } : {}),
        }),
      );
    }
    if (root === "accounts" && account && leaf === "proposals") {
      return json(200, await proposalHistory(sql, account));
    }
    if (req.method === "POST" && root === "accounts" && account && leaf === "backfill") {
      const from = Number(url.searchParams.get("from") ?? 1);
      return json(200, await indexer.backfill(from, [account]));
    }
    if (req.method === "POST" && root === "accounts" && account && leaf === "reconcile") {
      return json(200, { alerts: await indexer.reconcile(account) });
    }
    return json(404, { error: "not_found" });
  } catch (err) {
    log.error(err);
    return json(500, { error: "internal" });
  }
});

server.listen(config.INDEXER_PORT, () => {
  log.info({ port: config.INDEXER_PORT, network: config.STELLAR_NETWORK }, "indexer listening");
});
void loop();

const shutdown = async () => {
  running = false;
  server.close();
  await sql.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
