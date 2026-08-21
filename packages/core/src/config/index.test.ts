import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "./index.js";

const good = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  SOROBAN_RPC_URL: "http://localhost:8000/soroban/rpc",
  HORIZON_URL: "http://localhost:8000",
};

describe("loadConfig", () => {
  it("parses a valid env with defaults", () => {
    const cfg = loadConfig(undefined, good);
    expect(cfg.STELLAR_NETWORK).toBe("testnet");
    expect(cfg.NODE_ENV).toBe("development");
  });

  it("fails loudly on a missing required var", () => {
    expect(() => loadConfig(undefined, { ...good, DATABASE_URL: undefined })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("lets services require extra secrets at boot", () => {
    expect(() => loadConfig({ RELAYER_CHANNEL_SECRETS: z.string().min(1) }, good)).toThrow(
      /RELAYER_CHANNEL_SECRETS/,
    );
  });
});
