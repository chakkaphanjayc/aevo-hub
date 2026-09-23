import type { Database } from "@aevo/db";
import { resolvePrincipal } from "@aevo/db";

export interface AuthSession {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
  displayName?: string;
}

export class AuthenticationError extends Error {
  readonly code = "INVALID_CREDENTIALS";
  constructor() {
    super("Email or password is incorrect");
    this.name = "AuthenticationError";
  }
}

export class OAuthAuthenticationError extends Error {
  readonly code = "OAUTH_EXCHANGE_FAILED";
  constructor(message = "The OAuth sign-in could not be completed") {
    super(message);
    this.name = "OAuthAuthenticationError";
  }
}

export class PasswordUpdateError extends Error {
  readonly code: string;
  constructor(code = "PASSWORD_UPDATE_FAILED", message = "The password could not be updated") {
    super(message);
    this.code = code;
    this.name = "PasswordUpdateError";
  }
}

export class PasskeyAuthenticationError extends Error {
  readonly code: string;
  constructor(code = "PASSKEY_FAILED", message = "The passkey operation could not be completed") {
    super(message);
    this.code = code;
    this.name = "PasskeyAuthenticationError";
  }
}

export interface OAuthAuthSession extends AuthSession {
  email: string;
  displayName?: string;
}

export interface PasskeyOptionsResponse {
  challengeId: string;
  options: Record<string, unknown>;
  expiresAt?: number;
}

export interface PasskeySummary {
  id: string;
  friendlyName?: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface AuthServiceConfig {
  supabaseUrl?: string;
  supabaseKey?: string;
}

/**
 * Supabase Auth adapter used by the API. Password verification, JWT signing,
 * refresh-token rotation and account lockout remain inside Supabase Auth.
 */
export class AuthService {
  constructor(
    private readonly database: Database,
    private readonly integration: AuthServiceConfig = {}
  ) {}

  private get authClient() {
    return this.database.authClient ?? this.database.client;
  }

  private get authApiConfig(): { supabaseUrl: string; supabaseKey: string } {
    const supabaseUrl = this.integration.supabaseUrl?.trim();
    const supabaseKey = this.integration.supabaseKey?.trim();
    if (!supabaseUrl || !supabaseKey) throw new Error("Supabase Auth server integration is not configured");
    return { supabaseUrl, supabaseKey };
  }

  private async authApiRequest(
    path: string,
    options: { method?: string; body?: Record<string, unknown>; accessToken?: string }
  ): Promise<unknown> {
    const { supabaseUrl, supabaseKey } = this.authApiConfig;
    let response: Response;
    try {
      response = await fetch(new URL(path, `${supabaseUrl.replace(/\/$/u, "")}/`), {
        method: options.method ?? "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          apikey: supabaseKey,
          authorization: `Bearer ${options.accessToken ?? supabaseKey}`
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {})
      });
    } catch {
      throw new PasskeyAuthenticationError("AUTH_PROVIDER_UNAVAILABLE", "The authentication provider is temporarily unavailable");
    }

    const payload: unknown = await response.json().catch(() => null);
    if (response.ok) return payload;
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const code = typeof record.error_code === "string"
      ? record.error_code
      : typeof record.code === "string"
        ? record.code
        : "AUTH_PROVIDER_ERROR";
    const message = typeof record.msg === "string"
      ? record.msg
      : typeof record.message === "string"
        ? record.message
        : "The authentication provider rejected the request";
    throw new PasskeyAuthenticationError(code, message);
  }

  private static passkeyOptions(payload: unknown): PasskeyOptionsResponse {
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    const challengeId = typeof record?.challenge_id === "string" ? record.challenge_id : "";
    const options = record?.options && typeof record.options === "object" && !Array.isArray(record.options)
      ? record.options as Record<string, unknown>
      : null;
    if (!challengeId || !options) throw new PasskeyAuthenticationError("PASSKEY_INVALID_RESPONSE", "The passkey provider returned an invalid challenge");
    return {
      challengeId,
      options,
      ...(typeof record?.expires_at === "number" ? { expiresAt: record.expires_at } : {})
    };
  }

  private static authSessionFromPayload(payload: unknown): OAuthAuthSession {
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    const user = record?.user && typeof record.user === "object" ? record.user as Record<string, unknown> : null;
    const userId = typeof user?.id === "string" ? user.id : "";
    const email = typeof user?.email === "string" ? user.email.trim().toLowerCase() : "";
    const accessToken = typeof record?.access_token === "string" ? record.access_token : "";
    const refreshToken = typeof record?.refresh_token === "string" ? record.refresh_token : "";
    if (!userId || !email || !accessToken || !refreshToken) {
      throw new PasskeyAuthenticationError("PASSKEY_INVALID_SESSION", "The passkey provider returned an invalid session");
    }
    const expiresAt = typeof record?.expires_at === "number" && Number.isFinite(record.expires_at)
      ? new Date(record.expires_at * 1000)
      : typeof record?.expires_in === "number" && Number.isFinite(record.expires_in)
        ? new Date(Date.now() + record.expires_in * 1000)
        : new Date(Date.now() + 60 * 60 * 1000);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new PasskeyAuthenticationError("PASSKEY_INVALID_SESSION", "The passkey session has expired");
    }
    const metadata = user?.user_metadata && typeof user.user_metadata === "object"
      ? user.user_metadata as Record<string, unknown>
      : undefined;
    const displayName = typeof metadata?.full_name === "string"
      ? metadata.full_name.trim()
      : typeof metadata?.display_name === "string"
        ? metadata.display_name.trim()
        : typeof metadata?.name === "string"
          ? metadata.name.trim()
          : undefined;
    return {
      userId,
      email,
      accessToken,
      refreshToken,
      expiresAt,
      ...(displayName ? { displayName } : {})
    };
  }

  async login(input: { email: string; password: string; ipAddress?: string; userAgent?: string }): Promise<AuthSession> {
    // IP/user-agent are accepted by the domain interface for audit integrations;
    // Supabase Auth applies its own request metadata and rate limits here.
    void input.ipAddress;
    void input.userAgent;
    const { data, error } = await this.authClient.auth.signInWithPassword({
      email: input.email.trim().toLowerCase(),
      password: input.password
    });
    if (error || !data.session || !data.user) throw new AuthenticationError();

    const expiresAt = data.session.expires_at
      ? new Date(data.session.expires_at * 1000)
      : new Date(Date.now() + 60 * 60 * 1000);
    return {
      userId: data.user.id,
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt
    };
  }

  /**
   * Exchange a Supabase Auth PKCE code on the server. The browser only gets
   * the opaque application session created by the gateway after this method
   * returns; Supabase access and refresh tokens never cross that boundary.
   */
  async exchangeOAuthCode(input: {
    code: string;
    codeVerifier: string;
    supabaseUrl: string;
    supabaseKey: string;
  }): Promise<OAuthAuthSession> {
    const endpoint = new URL("/auth/v1/token", input.supabaseUrl);
    endpoint.searchParams.set("grant_type", "pkce");
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          apikey: input.supabaseKey,
          authorization: `Bearer ${input.supabaseKey}`
        },
        body: JSON.stringify({
          auth_code: input.code,
          code_verifier: input.codeVerifier
        })
      });
    } catch {
      throw new OAuthAuthenticationError();
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== "object") throw new OAuthAuthenticationError();
    const record = payload as Record<string, unknown>;
    const user = record.user && typeof record.user === "object"
      ? record.user as Record<string, unknown>
      : null;
    const userId = typeof user?.id === "string" ? user.id : "";
    const email = typeof user?.email === "string" ? user.email.trim().toLowerCase() : "";
    const accessToken = typeof record.access_token === "string" ? record.access_token : "";
    const refreshToken = typeof record.refresh_token === "string" ? record.refresh_token : "";
    if (!userId || !email || !accessToken || !refreshToken) throw new OAuthAuthenticationError();

    const expiresAt = typeof record.expires_at === "number" && Number.isFinite(record.expires_at)
      ? new Date(record.expires_at * 1000)
      : typeof record.expires_in === "number" && Number.isFinite(record.expires_in)
        ? new Date(Date.now() + record.expires_in * 1000)
        : new Date(Date.now() + 60 * 60 * 1000);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new OAuthAuthenticationError();
    }

    const metadata = user?.user_metadata && typeof user.user_metadata === "object"
      ? user.user_metadata as Record<string, unknown>
      : undefined;
    const displayName = typeof metadata?.full_name === "string"
      ? metadata.full_name.trim()
      : typeof metadata?.display_name === "string"
        ? metadata.display_name.trim()
        : typeof metadata?.name === "string"
          ? metadata.name.trim()
          : undefined;
    return {
      userId,
      email,
      accessToken,
      refreshToken,
      expiresAt,
      ...(displayName ? { displayName } : {})
    };
  }

  async requestPasswordReset(input: {
    email: string;
    redirectTo: string;
    codeChallenge: string;
  }): Promise<void> {
    try {
      await this.authApiRequest("/auth/v1/recover", {
        body: {
          email: input.email.trim().toLowerCase(),
          redirect_to: input.redirectTo,
          code_challenge: input.codeChallenge,
          code_challenge_method: "S256"
        }
      });
    } catch (error) {
      // The caller deliberately returns the same response for existing and
      // unknown email addresses. Preserve the error for logging only.
      throw new OAuthAuthenticationError(error instanceof Error ? error.message : "Password recovery request failed");
    }
  }

  async exchangePasswordRecoveryCode(input: {
    code: string;
    codeVerifier: string;
  }): Promise<OAuthAuthSession> {
    const { supabaseUrl, supabaseKey } = this.authApiConfig;
    return this.exchangeOAuthCode({
      code: input.code,
      codeVerifier: input.codeVerifier,
      supabaseUrl,
      supabaseKey
    });
  }

  async updatePassword(accessToken: string, password: string, currentPassword?: string): Promise<void> {
    try {
      await this.authApiRequest("/auth/v1/user", {
        method: "PUT",
        accessToken,
        body: {
          password,
          ...(currentPassword ? { current_password: currentPassword } : {})
        }
      });
    } catch (error) {
      if (error instanceof PasskeyAuthenticationError) {
        throw new PasswordUpdateError(error.code, error.message);
      }
      throw new PasswordUpdateError();
    }
  }

  async revokeAllSessions(userId: string): Promise<void> {
    const { error } = await this.authClient.auth.admin.signOut(userId, "global");
    if (error) throw new PasswordUpdateError("SESSION_REVOCATION_FAILED", "The password changed, but existing sessions could not be revoked");
  }

  async startPasskeyRegistration(accessToken: string): Promise<PasskeyOptionsResponse> {
    return AuthService.passkeyOptions(await this.authApiRequest("/auth/v1/passkeys/registration/options", { accessToken, body: {} }));
  }

  async verifyPasskeyRegistration(input: {
    accessToken: string;
    challengeId: string;
    credential: Record<string, unknown>;
  }): Promise<PasskeySummary> {
    const payload = await this.authApiRequest("/auth/v1/passkeys/registration/verify", {
      accessToken: input.accessToken,
      body: { challenge_id: input.challengeId, credential: input.credential }
    });
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    if (!record || typeof record.id !== "string") throw new PasskeyAuthenticationError("PASSKEY_INVALID_RESPONSE", "The passkey provider returned an invalid credential");
    return {
      id: record.id,
      ...(typeof record.friendly_name === "string" ? { friendlyName: record.friendly_name } : {}),
      createdAt: typeof record.created_at === "string" ? record.created_at : new Date().toISOString()
    };
  }

  async startPasskeyAuthentication(): Promise<PasskeyOptionsResponse> {
    return AuthService.passkeyOptions(await this.authApiRequest("/auth/v1/passkeys/authentication/options", { body: {} }));
  }

  async verifyPasskeyAuthentication(input: {
    challengeId: string;
    credential: Record<string, unknown>;
  }): Promise<OAuthAuthSession> {
    const payload = await this.authApiRequest("/auth/v1/passkeys/authentication/verify", {
      body: { challenge_id: input.challengeId, credential: input.credential }
    });
    return AuthService.authSessionFromPayload(payload);
  }

  async listPasskeys(accessToken: string): Promise<PasskeySummary[]> {
    const payload = await this.authApiRequest("/auth/v1/passkeys", { method: "GET", accessToken });
    if (!Array.isArray(payload)) throw new PasskeyAuthenticationError("PASSKEY_INVALID_RESPONSE", "The passkey provider returned an invalid list");
    return payload.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string") return [];
      return [{
        id: record.id,
        ...(typeof record.friendly_name === "string" ? { friendlyName: record.friendly_name } : {}),
        createdAt: typeof record.created_at === "string" ? record.created_at : "",
        ...(typeof record.last_used_at === "string" ? { lastUsedAt: record.last_used_at } : {})
      } satisfies PasskeySummary];
    });
  }

  async updatePasskey(accessToken: string, passkeyId: string, friendlyName: string): Promise<PasskeySummary> {
    const payload = await this.authApiRequest(`/auth/v1/passkeys/${encodeURIComponent(passkeyId)}`, {
      method: "PATCH",
      accessToken,
      body: { friendly_name: friendlyName }
    });
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    if (!record || typeof record.id !== "string") throw new PasskeyAuthenticationError("PASSKEY_INVALID_RESPONSE", "The passkey provider returned an invalid credential");
    return {
      id: record.id,
      ...(typeof record.friendly_name === "string" ? { friendlyName: record.friendly_name } : {}),
      createdAt: typeof record.created_at === "string" ? record.created_at : "",
      ...(typeof record.last_used_at === "string" ? { lastUsedAt: record.last_used_at } : {})
    };
  }

  async deletePasskey(accessToken: string, passkeyId: string): Promise<void> {
    await this.authApiRequest(`/auth/v1/passkeys/${encodeURIComponent(passkeyId)}`, {
      method: "DELETE",
      accessToken
    });
  }

  async resolveIdentity(accessToken: string): Promise<AuthenticatedUser | null> {
    if (!accessToken) return null;
    const { data, error } = await this.authClient.auth.getUser(accessToken);
    if (error || !data.user || !data.user.email) return null;
    const profileResult = await this.database.client
      .from("user_profiles")
      .select("display_name,status")
      .eq("id", data.user.id)
      .maybeSingle();
    if (profileResult.error || !profileResult.data || profileResult.data.status === "DISABLED") return null;
    const metadata = data.user.user_metadata as Record<string, unknown> | undefined;
    const profileDisplayName = typeof profileResult.data?.display_name === "string"
      ? profileResult.data.display_name.trim()
      : "";
    const displayName = profileDisplayName || (typeof metadata?.full_name === "string"
      ? metadata.full_name
      : typeof metadata?.display_name === "string"
        ? metadata.display_name
        : undefined);
    return {
      userId: data.user.id,
      email: data.user.email,
      ...(displayName ? { displayName } : {})
    };
  }

  /**
   * Resolve an identity from an already validated application session.
   *
   * Browser requests carry an opaque app-session cookie. The session manager
   * has already checked its hash, revocation and expiry before this method is
   * called, so asking Supabase Auth to validate the same access token again
   * only adds a remote network round trip. The profile status check remains
   * here so disabling a user immediately invalidates the application session
   * read path as well.
   */
  async resolveIdentityByUserId(userId: string): Promise<AuthenticatedUser | null> {
    if (!userId) return null;
    const profileResult = await this.database.client
      .from("user_profiles")
      .select("id,email,display_name,status")
      .eq("id", userId)
      .maybeSingle();
    if (profileResult.error || !profileResult.data || profileResult.data.status === "DISABLED") return null;

    const email = typeof profileResult.data.email === "string"
      ? profileResult.data.email.trim()
      : "";
    if (!email) return null;
    const displayName = typeof profileResult.data.display_name === "string"
      ? profileResult.data.display_name.trim()
      : "";
    return {
      userId: String(profileResult.data.id),
      email,
      ...(displayName ? { displayName } : {})
    };
  }

  async resolve(accessToken: string, organizationId?: string) {
    const identity = await this.resolveIdentity(accessToken);
    if (!identity) return null;
    return resolvePrincipal(this.database, identity.userId, organizationId, identity);
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    if (!refreshToken) throw new AuthenticationError();
    const { data, error } = await this.authClient.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session || !data.user) throw new AuthenticationError();
    const expiresAt = data.session.expires_at
      ? new Date(data.session.expires_at * 1000)
      : new Date(Date.now() + 60 * 60 * 1000);
    return {
      userId: data.user.id,
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt
    };
  }

  async logout(accessToken: string, refreshToken?: string): Promise<void> {
    if (!accessToken) return;
    // Prefer revoking the current Supabase session. The app session is still
    // revoked by the gateway even if this network call is unavailable.
    if (refreshToken) {
      const setSession = await this.authClient.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
      });
      if (!setSession.error) {
        const localSignOut = await this.authClient.auth.signOut({ scope: "local" });
        if (!localSignOut.error) return;
      }
    }

    // Fallback for deployments where the Auth API does not allow local
    // revocation from a server-side client. This is intentionally global so a
    // failed local revoke cannot leave the refresh token usable indefinitely.
    const userResult = await this.authClient.auth.getUser(accessToken);
    if (userResult.error || !userResult.data.user) return;
    const { error } = await this.authClient.auth.admin.signOut(userResult.data.user.id, "global");
    if (error) throw new Error(`Supabase logout failed: ${error.message}`);
  }
}
