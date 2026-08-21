import type { Intent, Logger, Sql } from "@elixir/core";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { z } from "zod";
import { verifyRequest } from "./auth/request-auth.js";
import { ProposalError, ProposalService } from "./proposals/service.js";

declare module "fastify" {
  interface FastifyRequest {
    signer: string;
    rawBody: string;
  }
}

const intentSchema = z.object({
  chain: z.union([
    z.object({ kind: z.literal("stellar"), network: z.enum(["public", "testnet"]) }),
    z.object({ kind: z.literal("evm"), chainId: z.number().int() }),
  ]),
  target: z.string().min(1),
  method: z.string().min(1),
  args: z.array(z.object({ name: z.string(), type: z.string(), value: z.unknown() })),
  value: z
    .string()
    .regex(/^\d+$/)
    .transform((v) => BigInt(v))
    .optional(),
});

const createSchema = z.object({
  account: z.string().min(1),
  intent: intentSchema,
  payload: z.string().min(1),
  signaturePayload: z.string().regex(/^[0-9a-f]{64}$/i),
  nonce: z
    .string()
    .regex(/^\d+$/)
    .transform((v) => BigInt(v)),
  expiresAtLedger: z.number().int().positive(),
});

const signSchema = z.object({
  signature: z.string().min(1),
  currentLedger: z.number().int().positive(),
});

export interface AppDeps {
  sql: Sql;
  logger?: Logger;
  now?: () => number;
}

export function buildApp({ sql, logger, now }: AppDeps): FastifyInstance {
  const opts: FastifyServerOptions = logger ? { loggerInstance: logger } : { logger: false };
  const app = Fastify(opts);
  const proposals = new ProposalService(sql);

  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body === "" ? undefined : JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get("/health", async () => ({ ok: true }));

  app.register(async (authed) => {
    authed.addHook("preHandler", async (req, reply) => {
      const res = verifyRequest(
        req.headers,
        req.method,
        req.url,
        req.rawBody ?? "",
        now ? now() : undefined,
      );
      if (!res.ok) {
        return reply.code(401).send({ error: "unauthorized", message: res.reason });
      }
      req.signer = res.signer;
    });

    authed.post("/proposals", async (req, reply) => {
      const body = createSchema.parse(req.body);
      const { value, ...rest } = body.intent;
      const intent = (value === undefined ? rest : { ...rest, value }) as Intent;
      const p = await proposals.create({
        account: body.account,
        proposer: req.signer,
        intent,
        payload: body.payload,
        signaturePayload: body.signaturePayload,
        nonce: body.nonce,
        expiresAtLedger: BigInt(body.expiresAtLedger),
      });
      return reply.code(201).send(serialize(p));
    });

    authed.get("/proposals/:id", async (req) => {
      const { id } = req.params as { id: string };
      return serialize(await proposals.get(id, req.signer));
    });

    authed.get("/accounts/:account/proposals", async (req) => {
      const { account } = req.params as { account: string };
      return (await proposals.list(account, req.signer)).map(serialize);
    });

    authed.post("/proposals/:id/signatures", async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = signSchema.parse(req.body);
      const p = await proposals.addSignature(
        id,
        req.signer,
        body.signature,
        BigInt(body.currentLedger),
      );
      return reply.code(201).send(serialize(p));
    });
  });

  app.setErrorHandler((err, _req: FastifyRequest, reply) => {
    if (err instanceof ProposalError) {
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "validation", issues: err.issues });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "internal" });
  });

  return app;
}

function serialize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
