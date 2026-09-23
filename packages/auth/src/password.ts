export const PASSWORD_MIN_LENGTH = 12 as const;

const commonPasswords = new Set([
  "password",
  "password123",
  "password123!",
  "password1234!",
  "123456789012",
  "qwertyuiopas",
  "letmein123!"
]);

export interface PasswordPolicyResult {
  valid: boolean;
  score: 0 | 1 | 2 | 3 | 4;
  reasons: string[];
}

function characterClassCount(password: string): number {
  return [
    /[a-z]/u.test(password),
    /[A-Z]/u.test(password),
    /\d/u.test(password),
    /[^A-Za-z\d\s]/u.test(password)
  ].filter(Boolean).length;
}

/**
 * Application-level password guard. Supabase Auth remains the hashing and
 * leaked-password source of truth; this keeps the UX and registration/reset
 * boundaries consistent before the request reaches Supabase.
 */
export function validatePassword(password: string, email?: string): PasswordPolicyResult {
  const normalized = password.trim().toLowerCase();
  const reasons: string[] = [];
  const classes = characterClassCount(password);
  const score = Math.min(4, Math.max(0, Math.floor(password.length / 4) - 1) + Math.max(0, classes - 1)) as 0 | 1 | 2 | 3 | 4;

  if (password.length < PASSWORD_MIN_LENGTH) {
    reasons.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (classes < 3) {
    reasons.push("Use at least three of lowercase, uppercase, numbers, and symbols.");
  }
  if (/\s/u.test(password)) {
    reasons.push("Do not use spaces at the beginning or end of the password.");
  }
  if (commonPasswords.has(normalized)) {
    reasons.push("This password is too common.");
  }
  const emailLocalPart = email?.split("@", 1)[0]?.trim().toLowerCase();
  if (emailLocalPart && emailLocalPart.length >= 4 && normalized.includes(emailLocalPart)) {
    reasons.push("Do not include your email name in the password.");
  }

  return { valid: reasons.length === 0, score, reasons };
}

export function passwordPolicyMessage(result: PasswordPolicyResult): string {
  return result.reasons[0] ?? "Use a unique password that you do not reuse elsewhere.";
}
