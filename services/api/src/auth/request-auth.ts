import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";

export const SIGNER_HEADER = "x-elixir-signer";
export const TIMESTAMP_HEADER = "x-elixir-timestamp";
export const SIGNATURE_HEADER = "x-elixir-signature";
export const MAX_SKEW_SECONDS = 60;

/**
 * Signed-request authn. The caller proves control of a G-address by signing
 *   sha256(method \n path \n timestamp \n sha256(body))
 * with that key. Authz (is this key a signer on the account, with which roles)
 * happens in the service against `account_signers`.
 *
 * No sessions, no passwords: the same key that signs proposals signs requests,
 * so there is no second credential to phish.
 */
export function requestDigest(
  method: string,
  path: string,
  timestamp: string,
  body: string | Buffer,
): Buffer {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHash("sha256")
    .update(`${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`)
    .digest();
}

export function signRequest(
  kp: Keypair,
  method: string,
  path: string,
  body: string | Buffer = "",
  now = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const timestamp = String(now);
  const signature = Buffer.from(kp.sign(requestDigest(method, path, timestamp, body))).toString(
    "base64",
  );
  return {
    [SIGNER_HEADER]: kp.publicKey(),
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: signature,
  };
}

export type AuthResult = { ok: true; signer: string } | { ok: false; reason: string };

export function verifyRequest(
  headers: Record<string, string | string[] | undefined>,
  method: string,
  path: string,
  body: string | Buffer,
  now = Math.floor(Date.now() / 1000),
): AuthResult {
  const signer = header(headers, SIGNER_HEADER);
  const timestamp = header(headers, TIMESTAMP_HEADER);
  const signature = header(headers, SIGNATURE_HEADER);
  if (!signer || !timestamp || !signature) return { ok: false, reason: "missing auth headers" };
  if (!StrKey.isValidEd25519PublicKey(signer)) return { ok: false, reason: "invalid signer" };
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: "timestamp outside allowed skew" };
  }
  const sig = Buffer.from(signature, "base64");
  if (sig.length !== 64) return { ok: false, reason: "malformed signature" };
  try {
    const ok = Keypair.fromPublicKey(signer).verify(
      requestDigest(method, path, timestamp, body),
      sig,
    );
    return ok ? { ok: true, signer } : { ok: false, reason: "signature does not verify" };
  } catch {
    return { ok: false, reason: "signature does not verify" };
  }
}

function header(h: Record<string, string | string[] | undefined>, name: string): string | null {
  const v = h[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}
