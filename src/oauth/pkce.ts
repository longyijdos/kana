import { createHash, randomBytes } from "node:crypto";
import type { OAuthPkcePair } from "./types";

const OAUTH_RANDOM_BYTES = 32;

export function createOAuthPkcePair(): OAuthPkcePair {
  const codeVerifier = base64UrlEncode(randomBytes(OAUTH_RANDOM_BYTES));
  const codeChallenge = base64UrlEncode(createHash("sha256").update(codeVerifier).digest());

  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: "S256",
  };
}

export function createOAuthState(): string {
  return base64UrlEncode(randomBytes(OAUTH_RANDOM_BYTES));
}

function base64UrlEncode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}
