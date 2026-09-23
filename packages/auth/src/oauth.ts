export const oauthProviders = ["google", "apple", "line"] as const;
export type OAuthProvider = (typeof oauthProviders)[number];

export interface OAuthFlowState {
  state: string;
  codeVerifier: string;
  provider: OAuthProvider;
  next: string;
  application?: string;
  returnTo?: string;
  handoffState?: string;
  codeChallenge?: string;
  expiresAt: number;
}

export interface CreateOAuthFlowInput {
  provider: OAuthProvider;
  next: string;
  application?: string;
  returnTo?: string;
  handoffState?: string;
  codeChallenge?: string;
  ttlMs?: number;
}

export interface PasswordRecoveryFlowState {
  state: string;
  codeVerifier: string;
  expiresAt: number;
}

export interface PasswordRecoveryGrant {
  sessionId: string;
  userId: string;
  expiresAt: number;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function createKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function seal(value: string, secret: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await createKey(secret),
    new TextEncoder().encode(value)
  );
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), iv.length);
  return bytesToBase64Url(result);
}

async function open(value: string, secret: string): Promise<string | null> {
  try {
    const encoded = base64UrlToBytes(value);
    if (encoded.length <= 12) return null;
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: encoded.slice(0, 12) },
      await createKey(secret),
      encoded.slice(12)
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

function isProvider(value: unknown): value is OAuthProvider {
  return typeof value === "string" && oauthProviders.includes(value as OAuthProvider);
}

function isSafeString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isSafePath(value: unknown): value is string {
  return isSafeString(value, 2048) && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\");
}

export async function createOAuthFlow(
  input: CreateOAuthFlowInput,
  secret: string
): Promise<{ flow: OAuthFlowState; cookieValue: string; codeChallenge: string }> {
  const codeVerifier = randomToken(48);
  const codeChallenge = await sha256(codeVerifier);
  const flow: OAuthFlowState = {
    state: randomToken(32),
    codeVerifier,
    provider: input.provider,
    next: input.next,
    ...(input.application ? { application: input.application } : {}),
    ...(input.returnTo ? { returnTo: input.returnTo } : {}),
    ...(input.handoffState ? { handoffState: input.handoffState } : {}),
    ...(input.codeChallenge ? { codeChallenge: input.codeChallenge } : {}),
    expiresAt: Date.now() + (input.ttlMs ?? 5 * 60 * 1000)
  };
  return {
    flow,
    codeChallenge,
    cookieValue: await seal(JSON.stringify(flow), secret)
  };
}

export async function readOAuthFlow(cookieValue: string | null, secret: string): Promise<OAuthFlowState | null> {
  if (!cookieValue || cookieValue.length > 8192) return null;
  const payload = await open(cookieValue, secret);
  if (!payload) return null;
  try {
    const candidate = JSON.parse(payload) as Partial<OAuthFlowState>;
    if (
      !isSafeString(candidate.state, 256) ||
      !isSafeString(candidate.codeVerifier, 128) ||
      candidate.codeVerifier.length < 43 ||
      !isProvider(candidate.provider) ||
      !isSafePath(candidate.next) ||
      typeof candidate.expiresAt !== "number" ||
      candidate.expiresAt <= Date.now()
    ) return null;
    if (candidate.application !== undefined && !isSafeString(candidate.application, 16)) return null;
    if (candidate.returnTo !== undefined && !isSafePath(candidate.returnTo)) return null;
    if (candidate.handoffState !== undefined && !isSafeString(candidate.handoffState, 256)) return null;
    if (candidate.codeChallenge !== undefined && !isSafeString(candidate.codeChallenge, 256)) return null;
    return candidate as OAuthFlowState;
  } catch {
    return null;
  }
}

async function createSealedState<T extends object>(value: T, secret: string): Promise<string> {
  return seal(JSON.stringify(value), secret);
}

async function readSealedState<T extends object>(cookieValue: string | null, secret: string): Promise<T | null> {
  if (!cookieValue || cookieValue.length > 8192) return null;
  const payload = await open(cookieValue, secret);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as T;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function createPasswordRecoveryFlow(
  secret: string,
  ttlMs = 15 * 60 * 1000
): Promise<{ flow: PasswordRecoveryFlowState; cookieValue: string; codeChallenge: string }> {
  const codeVerifier = randomToken(48);
  const flow: PasswordRecoveryFlowState = {
    state: randomToken(32),
    codeVerifier,
    expiresAt: Date.now() + ttlMs
  };
  return {
    flow,
    cookieValue: await createSealedState(flow, secret),
    codeChallenge: await sha256(codeVerifier)
  };
}

export async function readPasswordRecoveryFlow(
  cookieValue: string | null,
  secret: string
): Promise<PasswordRecoveryFlowState | null> {
  const candidate = await readSealedState<Partial<PasswordRecoveryFlowState>>(cookieValue, secret);
  if (
    !candidate
    || !isSafeString(candidate.state, 256)
    || !isSafeString(candidate.codeVerifier, 128)
    || candidate.codeVerifier.length < 43
    || typeof candidate.expiresAt !== "number"
    || candidate.expiresAt <= Date.now()
  ) return null;
  return candidate as PasswordRecoveryFlowState;
}

export async function createPasswordRecoveryGrant(
  input: Omit<PasswordRecoveryGrant, "expiresAt"> & { ttlMs?: number },
  secret: string
): Promise<string> {
  const expiresAt = Date.now() + (input.ttlMs ?? 15 * 60 * 1000);
  return createSealedState({ sessionId: input.sessionId, userId: input.userId, expiresAt }, secret);
}

export async function readPasswordRecoveryGrant(
  cookieValue: string | null,
  secret: string
): Promise<PasswordRecoveryGrant | null> {
  const candidate = await readSealedState<Partial<PasswordRecoveryGrant>>(cookieValue, secret);
  if (
    !candidate
    || !isSafeString(candidate.sessionId, 128)
    || !isSafeString(candidate.userId, 128)
    || typeof candidate.expiresAt !== "number"
    || candidate.expiresAt <= Date.now()
  ) return null;
  return candidate as PasswordRecoveryGrant;
}

export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
