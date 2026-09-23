import type { ApplicationCode } from "@aevo/contracts";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";
import { isApplicationActive } from "./application-access";

export interface AuthorizationCodeInput {
  userId: string;
  application: Exclude<ApplicationCode, "HUB" | "ADMIN">;
  returnPath: string;
  state?: string;
  codeChallenge?: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface ConsumedAuthorizationCode {
  userId: string;
  application: Exclude<ApplicationCode, "HUB" | "ADMIN">;
  returnPath: string;
  state?: string;
}

export class AuthorizationCodeError extends Error {
  readonly code = "HANDOFF_INVALID";

  constructor(message = "The authorization handoff is invalid or expired") {
    super(message);
    this.name = "AuthorizationCodeError";
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

interface AuthorizationCodeRow {
  id: string;
  user_id: string;
  app_code: Exclude<ApplicationCode, "HUB" | "ADMIN">;
  return_path: string;
  state_hash: string | null;
  code_challenge: string | null;
  expires_at: string;
  consumed_at: string | null;
}

export async function createAuthorizationCode(
  database: Database,
  input: AuthorizationCodeInput
): Promise<{ code: string; expiresAt: Date }> {
  if (!await isApplicationActive(database, input.application)) {
    throw new AuthorizationCodeError("The target application is disabled");
  }
  const code = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 1000);
  const [codeHash, stateHash] = await Promise.all([
    sha256(code),
    input.state ? sha256(input.state) : Promise.resolve(null)
  ]);
  const result = await database.client
    .from("app_authorization_codes")
    .insert({
      code_hash: codeHash,
      user_id: input.userId,
      app_code: input.application,
      return_path: input.returnPath,
      state_hash: stateHash,
      code_challenge: input.codeChallenge ?? null,
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      user_agent: input.userAgent?.slice(0, 512) ?? null,
      ip_address: input.ipAddress?.slice(0, 128) ?? null
    })
    .select("id")
    .single();
  throwDatabaseError(result.error, "authorization code creation");
  if (!result.data) throw new AuthorizationCodeError("Authorization code creation failed");
  return { code, expiresAt };
}

export async function consumeAuthorizationCode(
  database: Database,
  input: {
    code: string;
    application: Exclude<ApplicationCode, "HUB" | "ADMIN">;
    state?: string;
    codeVerifier?: string;
  }
): Promise<ConsumedAuthorizationCode> {
  if (!await isApplicationActive(database, input.application)) {
    throw new AuthorizationCodeError("The target application is disabled");
  }
  const codeHash = await sha256(input.code);
  const result = await database.client
    .from("app_authorization_codes")
    .select("id,user_id,app_code,return_path,state_hash,code_challenge,expires_at,consumed_at")
    .eq("code_hash", codeHash)
    .eq("app_code", input.application)
    .maybeSingle();
  throwDatabaseError(result.error, "authorization code lookup");
  const row = result.data as AuthorizationCodeRow | null;
  if (!row || row.consumed_at || Date.parse(row.expires_at) <= Date.now()) throw new AuthorizationCodeError();

  if (row.state_hash) {
    if (!input.state || !constantTimeEqual(row.state_hash, await sha256(input.state))) {
      throw new AuthorizationCodeError("The authorization state is invalid");
    }
  }
  if (row.code_challenge) {
    if (!input.codeVerifier || !constantTimeEqual(row.code_challenge, await sha256(input.codeVerifier))) {
      throw new AuthorizationCodeError("The authorization verifier is invalid");
    }
  }

  const consumedAt = new Date().toISOString();
  const consumed = await database.client
    .from("app_authorization_codes")
    .update({ consumed_at: consumedAt })
    .eq("id", row.id)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle();
  throwDatabaseError(consumed.error, "authorization code consume");
  if (!consumed.data) throw new AuthorizationCodeError("The authorization code was already used");

  return {
    userId: row.user_id,
    application: row.app_code,
    returnPath: row.return_path,
    ...(input.state ? { state: input.state } : {})
  };
}
