import { Keypair } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyPartialSignature } from "./verify.js";

const kp = Keypair.random();
const payload = createHash("sha256").update("intent").digest("hex");
const sig = Buffer.from(kp.sign(Buffer.from(payload, "hex"))).toString("base64");

describe("verifyPartialSignature", () => {
  it("accepts a valid signature from the claimed signer", () => {
    expect(verifyPartialSignature(kp.publicKey(), payload, sig)).toBe(true);
  });

  it("rejects a signature from a different key", () => {
    expect(verifyPartialSignature(Keypair.random().publicKey(), payload, sig)).toBe(false);
  });

  it("rejects a signature over a different payload", () => {
    const other = createHash("sha256").update("other").digest("hex");
    expect(verifyPartialSignature(kp.publicKey(), other, sig)).toBe(false);
  });

  it("rejects malformed inputs without throwing", () => {
    expect(verifyPartialSignature("not-a-key", payload, sig)).toBe(false);
    expect(verifyPartialSignature(kp.publicKey(), "zz", sig)).toBe(false);
    expect(verifyPartialSignature(kp.publicKey(), payload, "AAAA")).toBe(false);
  });
});
