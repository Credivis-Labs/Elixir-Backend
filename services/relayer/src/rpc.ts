import { rpc, type Transaction } from "@stellar/stellar-sdk";

export interface FeeStats {
  /** Inclusion fee percentiles in stroops. */
  p50: number;
  p90: number;
  max: number;
}

export interface SendResult {
  status: "PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR";
  hash: string;
  errorResult?: string;
}

export interface TxResult {
  status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  resultXdr?: string;
}

/**
 * The slice of Soroban RPC the relayer uses, so tests can fake it and so the
 * real client is swappable (e.g. for a Galexie-backed ledger source later).
 */
export interface RpcClient {
  getLatestLedger(): Promise<number>;
  getFeeStats(): Promise<FeeStats>;
  getSequence(account: string): Promise<bigint>;
  /** Simulate and attach footprint + resource fee. Must not touch op auth. */
  prepare(tx: Transaction): Promise<Transaction>;
  send(tx: Transaction): Promise<SendResult>;
  getTransaction(hash: string): Promise<TxResult>;
}

export function sorobanRpcClient(url: string): RpcClient {
  const server = new rpc.Server(url, { allowHttp: url.startsWith("http://") });
  return {
    async getLatestLedger() {
      return (await server.getLatestLedger()).sequence;
    },
    async getFeeStats() {
      const s = await server.getFeeStats();
      const f = s.sorobanInclusionFee;
      return { p50: Number(f.p50), p90: Number(f.p90), max: Number(f.max) };
    },
    async getSequence(account) {
      return BigInt((await server.getAccount(account)).sequenceNumber());
    },
    async prepare(tx) {
      return (await server.prepareTransaction(tx)) as Transaction;
    },
    async send(tx) {
      const r = await server.sendTransaction(tx);
      return {
        status: r.status,
        hash: r.hash,
        errorResult: r.errorResult ? r.errorResult.toXdr("base64") : undefined,
      } as SendResult;
    },
    async getTransaction(hash) {
      const r = await server.getTransaction(hash);
      return {
        status: r.status,
        resultXdr:
          r.status === rpc.Api.GetTransactionStatus.NOT_FOUND
            ? undefined
            : r.resultXdr.toXdr("base64"),
      } as TxResult;
    },
  };
}
