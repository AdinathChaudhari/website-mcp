/**
 * Chrome extension ID derived from the public key in extension/manifest.json ("key").
 * Derivation: sha256(DER public key), first 16 bytes, each nibble mapped to a-p. A unit test recomputes it.
 * The matching private key was discarded; unpacked loading does not need it.
 */
export const EXTENSION_ID = "hbgecabdpefkklkdepjlkcldclafoefm";
