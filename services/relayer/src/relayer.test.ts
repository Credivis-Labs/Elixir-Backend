import { Keypair, Networks, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { ChannelPool } from "./channel-pool.js";
import { defaultFeeConfig, pickFee } from "./fee.js";
import {
  authEntry,
  channelSecrets,
  fakeRpc,
  hostFunction,
  txError,
  type FakeRpcOptions,
} from "./fixtures.js";
import { Relayer, RelayerError, buildFallbackTransaction, hashAuth } from "./relayer.js";
import { memorySubmissionStore } from "./store.js";

const signer = Keypair.random().publicKey();
const request = (expiresAtLedger = 500) => ({
  account: "CACCOUNT",
  hostFunctionXdr: hostFunction(),
  authEntriesXdr: [authEntry(signer, expiresAtLedger)],
});

function setup(opts: FakeRpcOptions = {}, channels = 2) {
  const { rpc, sent } = fakeRpc(opts);
  const pool = new ChannelPool(channelSecrets(channels), rpc);
  const store = memorySubmissionStore();
  const relayer = new Relayer(rpc, pool, store, {
    networkPassphrase: Networks.TESTNET,
    pollIntervalMs: 1,
    confirmTimeoutMs: 50,
  });
  return { relayer, pool, store, sent };
}

const authOf = (tx: Transaction) => {
  const op = tx.operations[0];
  return op && op.type === "invokeHostFunction" ? (op.auth ?? []) : [];
};

describe("pickFee", () => {
  it("bids p50 in calm conditions and escalates per attempt", () => {
    const stats = { p50: 200, p90: 250, max: 1000 };
    expect(pickFee(stats, 0)).toEqual({ ok: true, fee: 200, surge: false });
    expect(pickFee(stats, 1)).toEqual({ ok: true, fee: 300, surge: false });
  });

  it("bids p90 during surge", () => {
    expect(pickFee({ p50: 100, p90: 900, max: 2000 }, 0)).toEqual({
      ok: true,
      fee: 900,
      surge: true,
    });
  });

  it("refuses above the cap", () => {
    const d = pickFee({ p50: 100, p90: 120, max: 500 }, 0, { ...defaultFeeConfig, maxFee: 50 });
    expect(d).toMatchObject({ ok: false, reason: "over_cap", cap: 50 });
  });

  it("never goes below the floor", () => {
    expect(pickFee({ p50: 1, p90: 1, max: 1 }, 0)).toMatchObject({ fee: 100 });
  });
});

describe("ChannelPool", () => {
  it("hands out distinct channels to concurrent callers and queues the rest", async () => {
    const { rpc } = fakeRpc();
    const pool = new ChannelPool(channelSecrets(2), rpc);
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect(a.keypair.publicKey()).not.toBe(b.keypair.publicKey());
    expect(pool.idle).toBe(0);

    let resolved = false;
    const c = pool.acquire().then((l) => {
      resolved = true;
      return l;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    a.release("ok");
    const lease = await c;
    expect(resolved).toBe(true);
    expect(lease.keypair.publicKey()).toBe(a.keypair.publicKey());
    expect(lease.sequence).toBe(a.sequence + 1n);
  });

  it("rolls back the sequence on a failure that never reached the ledger", async () => {
    const { rpc } = fakeRpc();
    const pool = new ChannelPool(channelSecrets(1), rpc);
    const a = await pool.acquire();
    a.release("failed");
    const b = await pool.acquire();
    expect(b.sequence).toBe(a.sequence);
  });

  it("refetches the sequence after bad_seq", async () => {
    const { rpc } = fakeRpc();
    let calls = 0;
    const orig = rpc.getSequence;
    rpc.getSequence = async (acct) => {
      calls++;
      return orig(acct);
    };
    const pool = new ChannelPool(channelSecrets(1), rpc);
    (await pool.acquire()).release("bad_seq");
    await pool.acquire();
    expect(calls).toBe(2);
  });
});

describe("Relayer", () => {
  it("submits from a channel account without touching the auth entries", async () => {
    const { relayer, store, sent } = setup();
    const req = request();
    const result = await relayer.submit(req);
    expect(result.txHash).toBe("abc");
    expect(result.attempts).toBe(1);
    expect(sent).toHaveLength(1);
    const tx = sent[0]!;
    expect(tx.source).toBe(result.channel);
    expect(hashAuth(authOf(tx))).toBe(result.authHash);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({ status: "success", feeStroops: 100 });
    expect(relayer.metrics.get("relayer_submissions_total", { outcome: "success" })).toBe(1);
  });

  it("rejects expired auth entries before any network call", async () => {
    const { relayer, sent, store } = setup({ ledger: 100 });
    const err = await relayer.submit(request(101)).catch((e) => e);
    expect(err).toBeInstanceOf(RelayerError);
    expect(err.code).toBe("auth_expired");
    expect(err.details).toEqual({ expiresAtLedger: 101, currentLedger: 100 });
    expect(sent).toHaveLength(0);
    expect(store.records[0]?.status).toBe("expired");
  });

  it("escalates the fee on txInsufficientFee and keeps the auth bytes identical", async () => {
    const { relayer, sent } = setup({
      sends: [
        { status: "ERROR", hash: "x", errorResult: txError("txInsufficientFee") },
        { status: "PENDING", hash: "ok" },
      ],
    });
    const result = await relayer.submit(request());
    expect(result.attempts).toBe(2);
    expect(result.feeStroops).toBe(150);
    expect(sent).toHaveLength(2);
    expect(hashAuth(authOf(sent[0]!))).toBe(hashAuth(authOf(sent[1]!)));
    expect(Number(sent[1]!.fee)).toBeGreaterThan(Number(sent[0]!.fee));
    expect(relayer.metrics.get("relayer_fee_escalations_total")).toBe(1);
  });

  it("resyncs the sequence on txBadSeq and retries", async () => {
    const { relayer, sent } = setup(
      {
        sends: [
          { status: "ERROR", hash: "x", errorResult: txError("txBadSeq") },
          { status: "PENDING", hash: "ok" },
        ],
      },
      1,
    );
    const result = await relayer.submit(request());
    expect(result.txHash).toBe("ok");
    expect(sent).toHaveLength(2);
  });

  it("refuses when the fee would exceed the cap", async () => {
    const { rpc } = fakeRpc({ fees: { p50: 5_000_000, p90: 5_000_000, max: 9_000_000 } });
    const relayer = new Relayer(
      rpc,
      new ChannelPool(channelSecrets(1), rpc),
      memorySubmissionStore(),
      {
        networkPassphrase: Networks.TESTNET,
      },
    );
    const err = await relayer.submit(request()).catch((e) => e);
    expect(err.code).toBe("fee_cap_exceeded");
  });

  it("reports on-chain failure with the tx hash", async () => {
    const { relayer, store } = setup({ txStatus: "FAILED" });
    const err = await relayer.submit(request()).catch((e) => e);
    expect(err.code).toBe("tx_failed");
    expect(err.details.txHash).toBe("abc");
    expect(store.records[0]?.status).toBe("failed");
  });

  it("surfaces a settle timeout instead of hanging", async () => {
    const { relayer } = setup({ txStatus: "NOT_FOUND" });
    const err = await relayer.submit(request()).catch((e) => e);
    expect(err.code).toBe("timeout");
  });
});

describe("buildFallbackTransaction", () => {
  it("produces a member-sourced tx carrying the identical auth entries", () => {
    const member = Keypair.random();
    const req = request();
    const { txXdr, authHash } = buildFallbackTransaction(
      member.publicKey(),
      41n,
      req,
      1000,
      Networks.TESTNET,
    );
    const tx = TransactionBuilder.fromXdr(txXdr, Networks.TESTNET) as Transaction;
    expect(tx.source).toBe(member.publicKey());
    expect(tx.sequence).toBe("42");
    expect(hashAuth(authOf(tx))).toBe(authHash);
    expect(tx.signatures).toHaveLength(0);
  });
});
