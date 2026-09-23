import { ApiClient } from "@aevocado/contracts";
import type {
  AccessDecisionResponse,
  ApplicationCode,
  AuthenticatedMeResponse
} from "@aevocado/api-contract";
import { safeReturnPath } from "@aevocado/api-contract";

export interface AuthClientOptions {
  api: ApiClient;
  application: ApplicationCode;
  accountsPath?: string;
  csrfCookieName?: string;
  csrfToken?: () => string | undefined;
}

export interface SignInRedirectOptions {
  returnPath?: string;
}

export class AuthClient {
  readonly application: ApplicationCode;
  private readonly api: ApiClient;
  private readonly accountsPath: string;
  private readonly csrfCookieName: string;
  private readonly csrfToken?: () => string | undefined;

  constructor(options: AuthClientOptions) {
    this.api = options.api;
    this.application = options.application;
    this.accountsPath = options.accountsPath ?? "/login";
    this.csrfCookieName = options.csrfCookieName ?? "aevo_csrf";
    this.csrfToken = options.csrfToken;
  }

  private csrfHeaders(): HeadersInit {
    const explicitToken = this.csrfToken?.();
    if (explicitToken) return { "x-csrf-token": explicitToken };
    if (typeof document === "undefined") return {};
    const token = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${this.csrfCookieName}=`))
      ?.slice(this.csrfCookieName.length + 1);
    if (!token) return {};
    try {
      return { "x-csrf-token": decodeURIComponent(token) };
    } catch {
      return { "x-csrf-token": token };
    }
  }

  async me(): Promise<AuthenticatedMeResponse> {
    return this.api.request<AuthenticatedMeResponse>("/api/auth/me");
  }

  async refresh(): Promise<void> {
    await this.api.request<void>("/api/auth/refresh", {
      method: "POST",
      retryOnUnauthorized: false,
      headers: this.csrfHeaders()
    });
  }

  async logout(): Promise<void> {
    await this.api.request<void>("/api/auth/logout", {
      method: "POST",
      retryOnUnauthorized: false,
      headers: this.csrfHeaders()
    });
  }

  async access(context: { organizationId?: string; storeId?: string } = {}): Promise<AccessDecisionResponse> {
    const params = new URLSearchParams({ application: this.application });
    if (context.organizationId) params.set("organizationId", context.organizationId);
    if (context.storeId) params.set("storeId", context.storeId);
    return this.api.request<AccessDecisionResponse>(`/api/v1/access?${params.toString()}`);
  }

  signInRedirect(options: SignInRedirectOptions = {}): string {
    const returnPath = safeReturnPath(options.returnPath, "/");
    const params = new URLSearchParams({
      app: this.application,
      returnTo: returnPath
    });
    return `${this.accountsPath}?${params.toString()}`;
  }
}

export function createAuthClient(options: AuthClientOptions): AuthClient {
  return new AuthClient(options);
}
