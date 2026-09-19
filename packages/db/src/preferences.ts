import { supportedLocales, type SupportedLocale, type UserPreferences } from "@aevo/contracts";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";

interface UserPreferencesRow {
  id: string;
  locale: string | null;
  updated_at: string;
}

function isSupportedLocale(value: string | null | undefined): value is SupportedLocale {
  return supportedLocales.includes(value as SupportedLocale);
}

function mapPreferences(row: UserPreferencesRow | null, userId: string): UserPreferences {
  return {
    userId,
    locale: isSupportedLocale(row?.locale) ? row.locale : null,
    updatedAt: row?.updated_at || ""
  };
}

export async function getUserPreferences(database: Database, userId: string): Promise<UserPreferences> {
  const result = await database.client
    .from("user_profiles")
    .select("id,locale,updated_at")
    .eq("id", userId)
    .maybeSingle();
  throwDatabaseError(result.error, "user preferences lookup");
  return mapPreferences(result.data as UserPreferencesRow | null, userId);
}

export async function updateUserPreferences(
  database: Database,
  userId: string,
  input: { locale: SupportedLocale }
): Promise<UserPreferences> {
  const result = await database.client
    .from("user_profiles")
    .update({ locale: input.locale })
    .eq("id", userId)
    .select("id,locale,updated_at")
    .single();
  throwDatabaseError(result.error, "user preferences update");
  return mapPreferences(result.data as UserPreferencesRow, userId);
}
