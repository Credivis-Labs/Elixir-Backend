import { Address, Keypair, xdr, type Transaction } from "@stellar/stellar-sdk";
import type { FeeStats, RpcClient, SendResult, TxResult } from "./rpc.js";

export const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

export function hostFunction(): string {
  const args = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(CONTRACT).toScAddress(),
    functionName: "transfer",
    args: [],
  });
  return xdr.HostFunction.hostFunctionTypeInvokeContract(args).toXdr("base64");
}

export function authEntry(signer: string, expiresAtLedger: number, nonce = 1n): string {
  const args = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(CONTRACT).toScAddress(),
    functionName: "transfer",
    args: [],
  });
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(signer).toScAddress(),
        nonce: xdr.Int64.fromString(nonce.toString()),
        signatureExpirationLedger: expiresAtLedger,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(args),
      subInvocations: [],
    }),
  });
  return entry.toXdr("base64");
}

export function txError(code: "txBadSeq" | "txInsufficientFee"): string {
  const result = new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("0"),
    result:
      code === "txBadSeq"
        ? xdr.TransactionResultResult.txBadSeq()
        : xdr.TransactionResultResult.txInsufficientFee(),
    ext: xdr.TransactionResultExt.fromXdr(Buffer.from([0, 0, 0, 0])),
  });
  return result.toXdr("base64");
}

export interface FakeRpcOptions {
  ledger?: number;
  fees?: FeeStats;
  sequences?: Record<string, bigint>;
  /** Scripted responses to send(), consumed in order; last one repeats. */
  sends?: SendResult[];
  txStatus?: TxResult["status"];
}

export function fakeRpc(opts: FakeRpcOptions = {}) {
  const sent: Transaction[] = [];
  const sends = opts.sends ?? [{ status: "PENDING", hash: "abc" }];
  let i = 0;
  const rpc: RpcClient = {
    async getLatestLedger() {
      return opts.ledger ?? 100;
    },
    async getFeeStats() {
      return opts.fees ?? { p50: 100, p90: 120, max: 500 };
    },
    async getSequence(account) {
      return opts.sequences?.[account] ?? 10n;
    },
    async prepare(tx) {
      return tx;
    },
    async send(tx) {
      sent.push(tx);
      const r = sends[Math.min(i, sends.length - 1)]!;
      i++;
      return r;
    },
    async getTransaction() {
      return { status: opts.txStatus ?? "SUCCESS" };
    },
  };
  return { rpc, sent };
}

export const channelSecrets = (n: number) =>
  Array.from({ length: n }, () => Keypair.random().secret());
