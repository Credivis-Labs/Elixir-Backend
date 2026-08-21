import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { signRequest, verifyRequest } from "./request-auth.js";

const kp = Keypair.random();
const now = 1_700_000_000;

describe("request auth", () => {
  it("round-trips a signed request", () => {
    const body = JSON.stringify({ a: 1 });
    const headers = signRequest(kp, "POST", "/proposals", body, now);
    const res = verifyRequest(headers, "POST", "/proposals", body, now);
    expect(res).toEqual({ ok: true, signer: kp.publicKey() });
  });

  it("rejects a tampered body", () => {
    const headers = signRequest(kp, "POST", "/proposals", "{}", now);
    expect(verifyRequest(headers, "POST", "/proposals", "{ }", now).ok).toBe(false);
  });

  it("rejects a replay on a different path", () => {
    const headers = signRequest(kp, "GET", "/proposals/a", "", now);
    expect(verifyRequest(headers, "GET", "/proposals/b", "", now).ok).toBe(false);
  });

  it("rejects stale timestamps", () => {
    const headers = signRequest(kp, "GET", "/x", "", now);
    expect(verifyRequest(headers, "GET", "/x", "", now + 61).ok).toBe(false);
    expect(verifyRequest(headers, "GET", "/x", "", now + 59).ok).toBe(true);
  });

  it("rejects missing headers", () => {
    expect(verifyRequest({}, "GET", "/x", "", now)).toMatchObject({ ok: false });
  });
});
