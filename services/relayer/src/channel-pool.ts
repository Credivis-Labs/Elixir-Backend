import { Keypair } from "@stellar/stellar-sdk";
import type { RpcClient } from "./rpc.js";

export interface ChannelLease {
  keypair: Keypair;
  /** Sequence number to use for this transaction (already incremented). */
  sequence: bigint;
  /** Call after the tx is accepted or permanently rejected. */
  release(outcome: "ok" | "bad_seq" | "failed"): void;
}

interface Channel {
  keypair: Keypair;
  sequence: bigint | null;
  busy: boolean;
}

/**
 * A pool of funded G-accounts that act as transaction source and fee payer.
 *
 * Concurrency model: one channel is leased to at most one in-flight
 * transaction at a time, and the sequence number is tracked locally so two
 * concurrent submissions never collide. Waiters queue FIFO. On `bad_seq` the
 * local number is dropped and refetched from RPC before the next lease.
 *
 * Scope: one relayer process. Running several replicas against the same
 * channel set requires moving the lease into the DB (`for update skip locked`);
 * until then, give each replica its own channel secrets.
 */
export class ChannelPool {
  private readonly channels: Channel[];
  private readonly waiters: Array<(c: Channel) => void> = [];

  constructor(
    secrets: string[],
    private readonly rpc: RpcClient,
  ) {
    if (secrets.length === 0) throw new Error("ChannelPool needs at least one channel secret");
    this.channels = secrets.map((s) => ({
      keypair: Keypair.fromSecret(s),
      sequence: null,
      busy: false,
    }));
  }

  get size(): number {
    return this.channels.length;
  }

  get idle(): number {
    return this.channels.filter((c) => !c.busy).length;
  }

  publicKeys(): string[] {
    return this.channels.map((c) => c.keypair.publicKey());
  }

  async acquire(): Promise<ChannelLease> {
    const channel = await this.next();
    if (channel.sequence === null) {
      try {
        channel.sequence = await this.rpc.getSequence(channel.keypair.publicKey());
      } catch (err) {
        this.free(channel);
        throw err;
      }
    }
    channel.sequence += 1n;
    const sequence = channel.sequence;
    let released = false;
    return {
      keypair: channel.keypair,
      sequence,
      release: (outcome) => {
        if (released) return;
        released = true;
        if (outcome === "bad_seq") channel.sequence = null;
        // A failed submission that never reached the ledger does not consume the
        // sequence number; roll back so the next lease reuses it.
        if (outcome === "failed" && channel.sequence === sequence) channel.sequence = sequence - 1n;
        this.free(channel);
      },
    };
  }

  private next(): Promise<Channel> {
    const free = this.channels.find((c) => !c.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private free(channel: Channel) {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(channel);
      return;
    }
    channel.busy = false;
  }
}
