import { createDb, createLogger, loadConfig, networkPassphrase } from "@elixir/core";
import { createServer } from "node:http";
import { z } from "zod";
import { ChannelPool } from "./channel-pool.js";
import { Relayer, RelayerError, buildFallbackTransaction } from "./relayer.js";
import { sorobanRpcClient } from "./rpc.js";
import { sqlSubmissionStore } from "./store.js";

const config = loadConfig({
  RELAYER_CHANNEL_SECRETS: z.string().min(1),
  RELAYER_PORT: z.coerce.number().int().default(3001),
  RELAYER_MAX_FEE: z.coerce.number().int().default(1_000_000),
});
const log = createLogger("relayer");
const sql = createDb(config.DATABASE_URL);
const rpc = sorobanRpcClient(config.SOROBAN_RPC_URL);
const pool = new ChannelPool(
  config.RELAYER_CHANNEL_SECRETS.split(",").map((s) => s.trim()),
  rpc,
);
const passphrase = networkPassphrase(config.STELLAR_NETWORK);
const relayer = new Relayer(rpc, pool, sqlSubmissionStore(sql), {
  networkPassphrase: passphrase,
  fee: { minFee: 100, maxFee: config.RELAYER_MAX_FEE, escalation: 1.5, surgeRatio: 2 },
});

const submitSchema = z.object({
  account: z.string(),
  proposalId: z.string().uuid().optional(),
  hostFunctionXdr: z.string(),
  authEntriesXdr: z.array(z.string()).min(1),
});

const fallbackSchema = submitSchema.extend({
  memberAccount: z.string(),
  fee: z.number().int().positive().default(1000),
});

const server = createServer(async (req, res) => {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(200, { ok: true, channels: pool.size, idle: pool.idle });
    }
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(relayer.metrics.prometheus());
    }
    if (req.method === "POST" && req.url === "/submit") {
      const { proposalId, ...body } = submitSchema.parse(JSON.parse(await readBody(req)));
      const result = await relayer.submit(proposalId ? { ...body, proposalId } : body);
      return json(200, result);
    }
    if (req.method === "POST" && req.url === "/fallback") {
      const body = fallbackSchema.parse(JSON.parse(await readBody(req)));
      const seq = await rpc.getSequence(body.memberAccount);
      const out = buildFallbackTransaction(body.memberAccount, seq, body, body.fee, passphrase);
      await sql`insert into fallback_submissions (account, proposal_id, submitter)
                values (${body.account}, ${body.proposalId ?? null}, ${body.memberAccount})`;
      relayer.metrics.inc("relayer_fallback_total");
      return json(200, out);
    }
    return json(404, { error: "not_found" });
  } catch (err) {
    if (err instanceof RelayerError) {
      log.warn({ code: err.code, details: err.details }, err.message);
      return json(409, { error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof z.ZodError) return json(400, { error: "validation", issues: err.issues });
    log.error(err);
    return json(500, { error: "internal" });
  }
});

server.listen(config.RELAYER_PORT, () => {
  log.info(
    { port: config.RELAYER_PORT, channels: pool.publicKeys(), network: config.STELLAR_NETWORK },
    "relayer listening",
  );
});

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const shutdown = async () => {
  server.close();
  await sql.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
