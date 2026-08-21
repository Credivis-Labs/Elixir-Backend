/**
 * Chain-agnostic intent. Mirrors `@credivis/elixir-sdk` `Intent` exactly; swap to the
 * SDK import once it is published as a versioned package (docs/ADR-001-stack.md).
 * The DB stores THIS, never raw XDR, as the canonical form of a proposal.
 */
export type ChainId =
  { kind: "stellar"; network: "public" | "testnet" } | { kind: "evm"; chainId: number };

export interface IntentArg {
  name: string;
  type: string;
  value: unknown;
}

export interface Intent {
  chain: ChainId;
  target: string;
  method: string;
  args: readonly IntentArg[];
  value?: bigint;
}
