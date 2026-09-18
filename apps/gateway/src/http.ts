import { isAuthSessionCookie, type AuthSessionCookie } from "@aevo/auth";

export function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const pair of cookie.split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

export function encodeAuthSessionCookie(session: AuthSessionCookie): string {
  return JSON.stringify(session);
}

export function decodeAuthSessionCookie(value: string): AuthSessionCookie | null {
  if (!value || value.length > 8192) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isAuthSessionCookie(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export type SameSite = "lax" | "strict" | "none";
function sameSiteAttribute(sameSite: SameSite): string {
  return sameSite === "lax" ? "Lax" : sameSite === "strict" ? "Strict" : "None";
}

export function sessionCookie(name: string, value: string, expiresAt: Date, secure: boolean, sameSite: SameSite = "lax"): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSiteAttribute(sameSite)}; Max-Age=${maxAge}; Expires=${expiresAt.toUTCString()}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(name: string, secure: boolean, sameSite: SameSite = "lax"): string {
  return `${name}=; Path=/; HttpOnly; SameSite=${sameSiteAttribute(sameSite)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function csrfCookie(name: string, value: string, expiresAt: Date, secure: boolean, sameSite: SameSite = "lax"): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${name}=${encodeURIComponent(value)}; Path=/; SameSite=${sameSiteAttribute(sameSite)}; Max-Age=${maxAge}; Expires=${expiresAt.toUTCString()}${secure ? "; Secure" : ""}`;
}

export function clearCsrfCookie(name: string, secure: boolean, sameSite: SameSite = "lax"): string {
  return `${name}=; Path=/; SameSite=${sameSiteAttribute(sameSite)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0${secure ? "; Secure" : ""}`;
}

/**
 * Elysia/Bun accepts multiple Set-Cookie values as an array. Keeping this in
 * one helper avoids accidentally replacing the session cookie with the CSRF
 * cookie when a response needs to set both.
 */
export function setCookies(set: { headers: Record<string, string | number | string[]> }, cookies: string[]): void {
  const existing = set.headers["set-cookie"];
  const values: string[] = existing
    ? (Array.isArray(existing)
      ? existing.filter((value): value is string => typeof value === "string")
      : typeof existing === "string" ? [existing] : [])
    : [];
  set.headers["set-cookie"] = [...values, ...cookies];
}

export function clientIp(request: Request): string | undefined {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
}
