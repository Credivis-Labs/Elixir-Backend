import { Keypair, StrKey } from "@stellar/stellar-sdk";

/**
 * Validate an ed25519 partial signature before it is ever stored.
 *
 * `signaturePayload` is the 32-byte hash (hex) the signer committed to — the same
 * value a hardware wallet displays. The signer is a G-address; the signature is
 * base64 over the raw hash bytes.
 */
export function verifyPartialSignature(
  signer: string,
  signaturePayload: string,
  signature: string,
): boolean {
  if (!StrKey.isValidEd25519PublicKey(signer)) return false;
  if (!/^[0-9a-f]{64}$/i.test(signaturePayload)) return false;
  let sig: Buffer;
  try {
    sig = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  try {
    return Keypair.fromPublicKey(signer).verify(Buffer.from(signaturePayload, "hex"), sig);
  } catch {
    return false;
  }
}
