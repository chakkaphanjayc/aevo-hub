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

/**
 * Supabase Auth adapter used by the API. Password verification, JWT signing,
 * refresh-token rotation and account lockout remain inside Supabase Auth.
 */
export class AuthService {
  constructor(private readonly database: Database) {}

  private get authClient() {
    return this.database.authClient ?? this.database.client;
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

  async resolveIdentity(accessToken: string): Promise<AuthenticatedUser | null> {
    if (!accessToken) return null;
    const { data, error } = await this.authClient.auth.getUser(accessToken);
    if (error || !data.user || !data.user.email) return null;
    const profileResult = await this.database.client
      .from("user_profiles")
      .select("display_name,status")
      .eq("id", data.user.id)
      .maybeSingle();
    if (profileResult.error || profileResult.data?.status === "DISABLED") return null;
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

  async resolve(accessToken: string, organizationId?: string) {
    const identity = await this.resolveIdentity(accessToken);
    if (!identity) return null;
    return resolvePrincipal(this.database, identity.userId, organizationId);
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
