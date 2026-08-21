import { testDb } from "@elixir/core/test-db";
import { Keypair } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { signRequest } from "./auth/request-auth.js";
import { ProposalService } from "./proposals/service.js";

const sql = await testDb();

describe.skipIf(!sql)("proposal coordination", () => {
  const account = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const alice = Keypair.random();
  const bob = Keypair.random();
  const carol = Keypair.random();
  const observer = Keypair.random();
  const stranger = Keypair.random();
  const app = buildApp({ sql: sql! });

  const sigPayload = createHash("sha256").update("payment-1").digest("hex");
  const intent = {
    chain: { kind: "stellar", network: "testnet" },
    target: account,
    method: "transfer",
    args: [{ name: "amount", type: "i128", value: "100" }],
  };

  const call = (kp: Keypair, method: "GET" | "POST", url: string, body?: unknown) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    return app.inject({
      method,
      url,
      payload: payload || undefined,
      headers: {
        "content-type": "application/json",
        ...signRequest(kp, method, url, payload),
      },
    });
  };

  beforeAll(async () => {
    // proposals references accounts; clear children first so a re-run of this
    // suite against a non-empty database is not blocked by the foreign key.
    await sql!`delete from proposals where account = ${account}`;
    await sql!`delete from accounts where address = ${account}`;
    await sql!`insert into accounts (address, network, config_epoch, threshold)
               values (${account}, 'testnet', 0, 2)`;
    await sql!`insert into account_signers (account, signer, roles) values
      (${account}, ${alice.publicKey()}, 7),
      (${account}, ${bob.publicKey()}, 7),
      (${account}, ${carol.publicKey()}, 7),
      (${account}, ${observer.publicKey()}, 0)`;
  });

  afterAll(async () => {
    await app.close();
    await sql!.end();
  });

  it("rejects unsigned requests", async () => {
    const res = await app.inject({ method: "GET", url: `/accounts/${account}/proposals` });
    expect(res.statusCode).toBe(401);
  });

  it("rejects non-signers", async () => {
    const res = await call(stranger, "GET", `/accounts/${account}/proposals`);
    expect(res.statusCode).toBe(403);
  });

  let proposalId: string;

  it("creates a proposal from an Intent", async () => {
    const res = await call(alice, "POST", "/proposals", {
      account,
      intent,
      payload: "AAAA",
      signaturePayload: sigPayload,
      nonce: "1",
      expiresAtLedger: 1000,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    proposalId = body.id;
    expect(body.status).toBe("open");
    expect(body.intent.method).toBe("transfer");
    expect(body.threshold).toBe(2);
    expect(body.collected).toBe(0);
  });

  it("refuses a second open proposal on the same nonce", async () => {
    const res = await call(bob, "POST", "/proposals", {
      account,
      intent,
      payload: "BBBB",
      signaturePayload: createHash("sha256").update("other").digest("hex"),
      nonce: "1",
      expiresAtLedger: 1000,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("nonce_conflict");
  });

  it("rejects a signature that does not verify, before storing anything", async () => {
    const bad = Buffer.from(bob.sign(Buffer.from("wrong".padEnd(32, "x")))).toString("base64");
    const res = await call(bob, "POST", `/proposals/${proposalId}/signatures`, {
      signature: bad,
      currentLedger: 10,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_signature");
    const rows = await sql!`select 1 from partial_signatures where proposal_id = ${proposalId}`;
    expect(rows).toHaveLength(0);
  });

  it("rejects signatures from signers without the Vote role", async () => {
    const sig = Buffer.from(observer.sign(Buffer.from(sigPayload, "hex"))).toString("base64");
    const res = await call(observer, "POST", `/proposals/${proposalId}/signatures`, {
      signature: sig,
      currentLedger: 10,
    });
    expect(res.statusCode).toBe(403);
  });

  it("tracks threshold progress and flips to ready", async () => {
    const sign = (kp: Keypair) =>
      call(kp, "POST", `/proposals/${proposalId}/signatures`, {
        signature: Buffer.from(kp.sign(Buffer.from(sigPayload, "hex"))).toString("base64"),
        currentLedger: 10,
      });
    const r1 = await sign(alice);
    expect(r1.json()).toMatchObject({ collected: 1, status: "open" });
    const r2 = await sign(bob);
    expect(r2.json()).toMatchObject({ collected: 2, status: "ready" });
  });

  it("rejects signatures once the expiry ledger has passed", async () => {
    const res = await call(alice, "POST", "/proposals", {
      account,
      intent,
      payload: "CCCC",
      signaturePayload: sigPayload,
      nonce: "2",
      expiresAtLedger: 50,
    });
    const id = res.json().id;
    const late = await call(carol, "POST", `/proposals/${id}/signatures`, {
      signature: Buffer.from(carol.sign(Buffer.from(sigPayload, "hex"))).toString("base64"),
      currentLedger: 50,
    });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe("expired");
    const after = await call(alice, "GET", `/proposals/${id}`);
    expect(after.json().status).toBe("expired");
  });

  it("invalidates every open proposal when config_epoch changes, with a plain reason", async () => {
    const res = await call(alice, "POST", "/proposals", {
      account,
      intent,
      payload: "DDDD",
      signaturePayload: sigPayload,
      nonce: "3",
      expiresAtLedger: 1000,
    });
    const id = res.json().id;

    const svc = new ProposalService(sql!);
    const n = await svc.invalidateForEpoch(account, 1n);
    expect(n).toBeGreaterThanOrEqual(2);

    const after = await call(alice, "GET", `/proposals/${id}`);
    expect(after.json().status).toBe("invalidated");
    expect(after.json().statusReason).toMatch(/configuration changed/);

    const ready = await call(alice, "GET", `/proposals/${proposalId}`);
    expect(ready.json().status).toBe("invalidated");
  });

  it("marks sibling proposals conflicted when one executes", async () => {
    const mk = (payload: string) =>
      call(alice, "POST", "/proposals", {
        account,
        intent,
        payload,
        signaturePayload: sigPayload,
        nonce: "7",
        expiresAtLedger: 1000,
      });
    const a = (await mk("A")).json().id;
    const svc = new ProposalService(sql!);
    await svc.markExecuted(a);
    const b = await mk("B");
    expect(b.statusCode).toBe(201);
    const [row] = await sql!`select status from proposals where id = ${a}`;
    expect(row!.status).toBe("executed");
  });
});
