import type { ApplicationCode } from "@aevo/contracts";
import { isMissingDatabaseObject } from "@aevo/db";
import type { Database } from "@aevo/db";
import type { AuthSession } from "./service";

/**
 * The browser only receives this opaque value. Supabase bearer tokens stay in
 * the server-side app_sessions row and are encrypted at rest by the gateway.
 */
export interface AuthSessionCookie {
  sessionToken: string;
}

export function isAuthSessionCookie(value: unknown): value is AuthSessionCookie {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as AuthSessionCookie).sessionToken === "string" &&
    /^[A-Za-z0-9_-]{40,}$/.test((value as AuthSessionCookie).sessionToken)
  );
}

export interface ManagedAuthSession {
  id: string;
  userId: string;
  sessionToken: string;
  csrfTokenHash: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  lastSeenAt: Date;
}

export interface AuthSessionSummary {
  id: string;
  userAgent?: string;
  ipAddress?: string;
  createdAt: Date;
  lastSeenAt: Date;
  accessExpiresAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt?: Date;
  current: boolean;
}

export interface SessionCookieOptions {
  idleTimeoutSeconds: number;
  absoluteTimeoutSeconds: number;
  /** Runtime application boundary used once app_sessions has app_code. */
  applicationCode?: ApplicationCode;
}

interface SessionRow {
  id: string;
  user_id: string;
  csrf_token_hash: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string;
  last_seen_at: string;
  access_expires_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
  app_code?: ApplicationCode | null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export class SessionManagerError extends Error {
  readonly code = "SESSION_MANAGER_ERROR";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionManagerError";
  }
}

/**
 * Owns the application-session lifecycle. The database is deliberately
 * accessed through the server-only Supabase client supplied by @aevo/db.
 */
export class AuthSessionManager {
  private readonly keyPromise: Promise<CryptoKey>;

  constructor(
    private readonly database: Database,
    secret: string,
    private readonly options: SessionCookieOptions
  ) {
    this.keyPromise = this.createKey(secret);
  }

  private async createKey(secret: string): Promise<CryptoKey> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  private async encrypt(value: string): Promise<string> {
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await this.keyPromise,
      new TextEncoder().encode(value)
    );
    const result = new Uint8Array(iv.length + ciphertext.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertext), iv.length);
    return bytesToBase64Url(result);
  }

  private async decrypt(value: string): Promise<string> {
    const encoded = base64UrlToBytes(value);
    if (encoded.length <= 12) throw new SessionManagerError("Invalid encrypted session token");
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: encoded.slice(0, 12) },
      await this.keyPromise,
      encoded.slice(12)
    );
    return new TextDecoder().decode(plaintext);
  }

  private get supportsPreAppCodeSchema(): boolean {
    return this.options.applicationCode === undefined || this.options.applicationCode === "HUB";
  }

  private async readRow(sessionToken: string): Promise<{ row: SessionRow; accessToken: string; refreshToken: string } | null> {
    const tokenHash = await sha256(sessionToken);
    const baseFields = "id,user_id,csrf_token_hash,access_token_ciphertext,refresh_token_ciphertext,last_seen_at,access_expires_at,idle_expires_at,absolute_expires_at,revoked_at";
    let result = await this.database.client
      .from("app_sessions")
      .select(`${baseFields},app_code`)
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (result.error && this.supportsPreAppCodeSchema && isMissingDatabaseObject(result.error)) {
      // Keep the Hub rollback path compatible with deployments that predate
      // the additive app_code column. Once present, the column is enforced.
      result = await this.database.client
        .from("app_sessions")
        .select(baseFields)
        .eq("token_hash", tokenHash)
        .maybeSingle();
    }
    if (result.error) throw new SessionManagerError(`Session lookup failed: ${result.error.message}`, { cause: result.error });
    const row = result.data as SessionRow | null;
    if (!row || row.revoked_at) return null;
    if (this.options.applicationCode === "HUB") {
      // Hub keeps a narrow rollback path for rows created before app_code was
      // introduced, but it must never accept another application's session.
      if (row.app_code && row.app_code !== "HUB") return null;
    } else if (this.options.applicationCode && row.app_code !== this.options.applicationCode) {
      // Privileged and downstream runtimes fail closed when the session is not
      // explicitly bound to their application boundary.
      return null;
    }

    const now = Date.now();
    if (now >= Date.parse(row.idle_expires_at) || now >= Date.parse(row.absolute_expires_at)) {
      await this.revokeById(row.id);
      return null;
    }

    try {
      const [accessToken, refreshToken] = await Promise.all([
        this.decrypt(row.access_token_ciphertext),
        this.decrypt(row.refresh_token_ciphertext)
      ]);
      return { row, accessToken, refreshToken };
    } catch (error) {
      throw new SessionManagerError("Session token decryption failed", { cause: error });
    }
  }

  private async revokeById(sessionId: string, replacedBy?: string): Promise<boolean> {
    const result = await this.database.client
      .from("app_sessions")
      .update({ revoked_at: new Date().toISOString(), ...(replacedBy ? { replaced_by: replacedBy } : {}) })
      .eq("id", sessionId)
      .is("revoked_at", null)
      .select("id")
      .maybeSingle();
    if (result.error) throw new SessionManagerError(`Session revoke failed: ${result.error.message}`, { cause: result.error });
    return Boolean(result.data);
  }

  private async insert(
    userId: string,
    authSession: AuthSession,
    metadata: { ipAddress?: string; userAgent?: string },
    absoluteExpiresAt: Date,
    now = new Date()
  ): Promise<{ session: ManagedAuthSession; csrfToken: string }> {
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const accessExpiresAt = new Date(Math.min(authSession.expiresAt.getTime(), absoluteExpiresAt.getTime()));
    const idleExpiresAt = new Date(Math.min(
      absoluteExpiresAt.getTime(),
      now.getTime() + this.options.idleTimeoutSeconds * 1000
    ));
    const [tokenHash, csrfTokenHash, accessTokenCiphertext, refreshTokenCiphertext] = await Promise.all([
      sha256(sessionToken),
      sha256(csrfToken),
      this.encrypt(authSession.accessToken),
      this.encrypt(authSession.refreshToken)
    ]);

    const result = await this.database.client
      .from("app_sessions")
      .insert({
        user_id: userId,
        token_hash: tokenHash,
        csrf_token_hash: csrfTokenHash,
        access_token_ciphertext: accessTokenCiphertext,
        refresh_token_ciphertext: refreshTokenCiphertext,
        user_agent: metadata.userAgent?.slice(0, 512) ?? null,
        ip_address: metadata.ipAddress?.slice(0, 128) ?? null,
        last_seen_at: now.toISOString(),
        access_expires_at: accessExpiresAt.toISOString(),
        idle_expires_at: idleExpiresAt.toISOString(),
        absolute_expires_at: absoluteExpiresAt.toISOString(),
        // Existing Hub deployments may not have the additive app_code column
        // yet; the migration default keeps those sessions compatible. Other
        // application runtimes must identify themselves explicitly.
        ...(this.options.applicationCode && this.options.applicationCode !== "HUB"
          ? { app_code: this.options.applicationCode }
          : {})
      })
      .select("id")
      .single();
    if (result.error || !result.data) {
      throw new SessionManagerError(`Session creation failed: ${result.error?.message ?? "missing session id"}`, { cause: result.error ?? undefined });
    }

    return {
      csrfToken,
      session: {
        id: String(result.data.id),
        userId,
        sessionToken,
        csrfTokenHash,
        accessToken: authSession.accessToken,
        refreshToken: authSession.refreshToken,
        accessExpiresAt,
        idleExpiresAt,
        absoluteExpiresAt,
        lastSeenAt: now
      }
    };
  }

  async create(
    userId: string,
    authSession: AuthSession,
    metadata: { ipAddress?: string; userAgent?: string }
  ): Promise<{ session: ManagedAuthSession; csrfToken: string }> {
    const now = new Date();
    const absoluteExpiresAt = new Date(now.getTime() + this.options.absoluteTimeoutSeconds * 1000);
    return this.insert(userId, authSession, metadata, absoluteExpiresAt, now);
  }

  /**
   * Return credentials for a currently active Hub session to the trusted
   * server-to-server handoff boundary. This method is never exposed through
   * a browser route; the caller must immediately create an app-scoped target
   * session and must not serialize the tokens to the client.
   */
  async getActiveCredentials(userId: string): Promise<AuthSession | null> {
    let result = await this.database.client
      .from("app_sessions")
      .select("user_id,access_token_ciphertext,refresh_token_ciphertext,access_expires_at,idle_expires_at,absolute_expires_at,revoked_at,app_code")
      .eq("user_id", userId)
      .eq("app_code", this.options.applicationCode ?? "HUB")
      .is("revoked_at", null)
      .gt("idle_expires_at", new Date().toISOString())
      .gt("absolute_expires_at", new Date().toISOString())
      .order("last_seen_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (result.error && this.supportsPreAppCodeSchema && isMissingDatabaseObject(result.error)) {
      result = await this.database.client
        .from("app_sessions")
        .select("user_id,access_token_ciphertext,refresh_token_ciphertext,access_expires_at,idle_expires_at,absolute_expires_at,revoked_at")
        .eq("user_id", userId)
        .is("revoked_at", null)
        .gt("idle_expires_at", new Date().toISOString())
        .gt("absolute_expires_at", new Date().toISOString())
        .order("last_seen_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    }
    if (result.error) throw new SessionManagerError(`Session handoff lookup failed: ${result.error.message}`, { cause: result.error });
    const row = result.data as (SessionRow & { user_id: string }) | null;
    if (!row || row.revoked_at) return null;
    const [accessToken, refreshToken] = await Promise.all([
      this.decrypt(row.access_token_ciphertext),
      this.decrypt(row.refresh_token_ciphertext)
    ]);
    return {
      userId,
      accessToken,
      refreshToken,
      expiresAt: new Date(row.access_expires_at)
    };
  }

  async resolve(sessionToken: string): Promise<ManagedAuthSession | null> {
    if (!isAuthSessionCookie({ sessionToken })) return null;
    const stored = await this.readRow(sessionToken);
    if (!stored) return null;
    const now = new Date();
    const lastSeenAt = new Date(stored.row.last_seen_at);
    const shouldTouch = now.getTime() - lastSeenAt.getTime() >= 5 * 60 * 1000;
    const idleExpiresAt = new Date(Math.min(
      Date.parse(stored.row.absolute_expires_at),
      now.getTime() + this.options.idleTimeoutSeconds * 1000
    ));
    if (shouldTouch) {
      const touched = await this.database.client
        .from("app_sessions")
        .update({ last_seen_at: now.toISOString(), idle_expires_at: idleExpiresAt.toISOString() })
        .eq("id", stored.row.id)
        .is("revoked_at", null);
      if (touched.error) throw new SessionManagerError(`Session touch failed: ${touched.error.message}`, { cause: touched.error });
    }
    return {
      id: stored.row.id,
      userId: stored.row.user_id,
      sessionToken,
      csrfTokenHash: stored.row.csrf_token_hash,
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
      accessExpiresAt: new Date(stored.row.access_expires_at),
      idleExpiresAt,
      absoluteExpiresAt: new Date(stored.row.absolute_expires_at),
      lastSeenAt: shouldTouch ? now : lastSeenAt
    };
  }

  async list(userId: string, currentSessionId?: string): Promise<AuthSessionSummary[]> {
    let result = await this.database.client
      .from("app_sessions")
      .select("id,user_agent,ip_address,created_at,last_seen_at,access_expires_at,idle_expires_at,absolute_expires_at,revoked_at")
      .eq("user_id", userId)
      .eq("app_code", this.options.applicationCode ?? "HUB")
      .is("revoked_at", null)
      .gt("absolute_expires_at", new Date().toISOString())
      .order("last_seen_at", { ascending: false });
    if (result.error && this.supportsPreAppCodeSchema && isMissingDatabaseObject(result.error)) {
      result = await this.database.client
        .from("app_sessions")
        .select("id,user_agent,ip_address,created_at,last_seen_at,access_expires_at,idle_expires_at,absolute_expires_at,revoked_at")
        .eq("user_id", userId)
        .is("revoked_at", null)
        .gt("absolute_expires_at", new Date().toISOString())
        .order("last_seen_at", { ascending: false });
    }
    if (result.error) throw new SessionManagerError(`Session list failed: ${result.error.message}`, { cause: result.error });
    return ((result.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      ...(row.user_agent ? { userAgent: String(row.user_agent) } : {}),
      ...(row.ip_address ? { ipAddress: String(row.ip_address) } : {}),
      createdAt: new Date(String(row.created_at)),
      lastSeenAt: new Date(String(row.last_seen_at)),
      accessExpiresAt: new Date(String(row.access_expires_at)),
      idleExpiresAt: new Date(String(row.idle_expires_at)),
      absoluteExpiresAt: new Date(String(row.absolute_expires_at)),
      ...(row.revoked_at ? { revokedAt: new Date(String(row.revoked_at)) } : {}),
      current: currentSessionId === String(row.id)
    }));
  }

  async revokeForUser(userId: string, sessionId: string): Promise<boolean> {
    let result = await this.database.client
      .from("app_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("user_id", userId)
      .eq("app_code", this.options.applicationCode ?? "HUB")
      .is("revoked_at", null)
      .select("id")
      .maybeSingle();
    if (result.error && this.supportsPreAppCodeSchema && isMissingDatabaseObject(result.error)) {
      result = await this.database.client
        .from("app_sessions")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", sessionId)
        .eq("user_id", userId)
        .is("revoked_at", null)
        .select("id")
        .maybeSingle();
    }
    if (result.error) throw new SessionManagerError(`Session revoke failed: ${result.error.message}`, { cause: result.error });
    return Boolean(result.data);
  }

  async rotate(
    current: ManagedAuthSession,
    authSession: AuthSession,
    metadata: { ipAddress?: string; userAgent?: string }
  ): Promise<{ session: ManagedAuthSession; csrfToken: string }> {
    const replacement = await this.insert(current.userId, authSession, metadata, current.absoluteExpiresAt);
    const revoked = await this.revokeById(current.id, replacement.session.id);
    if (!revoked) {
      await this.revokeById(replacement.session.id);
      throw new SessionManagerError("Session rotation was already completed");
    }
    return replacement;
  }

  async revoke(sessionToken: string): Promise<void> {
    const tokenHash = await sha256(sessionToken);
    let result = await this.database.client
      .from("app_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("token_hash", tokenHash)
      .eq("app_code", this.options.applicationCode ?? "HUB")
      .is("revoked_at", null);
    if (result.error && this.supportsPreAppCodeSchema && isMissingDatabaseObject(result.error)) {
      result = await this.database.client
        .from("app_sessions")
        .update({ revoked_at: new Date().toISOString() })
        .eq("token_hash", tokenHash)
        .is("revoked_at", null);
    }
    if (result.error) throw new SessionManagerError(`Session revoke failed: ${result.error.message}`, { cause: result.error });
  }

  async revokeAll(userId: string): Promise<void> {
    let result = await this.database.client
      .from("app_sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("app_code", this.options.applicationCode ?? "HUB")
      .is("revoked_at", null);
    if (result.error && this.supportsPreAppCodeSchema && isMissingDatabaseObject(result.error)) {
      result = await this.database.client
        .from("app_sessions")
        .update({ revoked_at: new Date().toISOString() })
        .eq("user_id", userId)
        .is("revoked_at", null);
    }
    if (result.error) throw new SessionManagerError(`Session revoke-all failed: ${result.error.message}`, { cause: result.error });
  }

  async verifyCsrf(session: ManagedAuthSession, token: string | null): Promise<boolean> {
    if (!token) return false;
    return constantTimeEqual(session.csrfTokenHash, await sha256(token));
  }
}
