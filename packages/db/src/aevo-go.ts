import type { Database } from "./client";
import { throwDatabaseError } from "./errors";

export interface AevoGoSettings {
  discovery: {
    searchEnabled: boolean;
    mapEnabled: boolean;
    defaultRadiusKm: number;
    maxResults: number;
  };
  community: {
    traceDeeEnabled: boolean;
    commentsEnabled: boolean;
    contributionsEnabled: boolean;
    requireModeration: boolean;
  };
  booking: {
    enabled: boolean;
    holdMinutes: number;
    maxPartySize: number;
  };
  notifications: {
    pushEnabled: boolean;
    marketingOptInRequired: boolean;
  };
  privacy: {
    allowGuestBrowse: boolean;
    requireAccountToSave: boolean;
  };
  analytics: {
    enabled: boolean;
    retentionDays: number;
  };
}

export interface AevoGoSettingsRecord {
  config: AevoGoSettings;
  updatedBy: string | null;
  updatedAt: string;
}

export interface AevoGoFeatureFlag {
  flagKey: string;
  enabled: boolean;
  rolloutPercent: number;
  config: Record<string, unknown>;
}

export interface AevoGoDailyActivity {
  date: string;
  events: number;
  impressions: number;
  interactions: number;
}

export interface AevoGoOverview {
  asOf: string;
  windowDays: number;
  activePlaces: number;
  publicStores: number;
  publishedTraces: number;
  totalJourneys: number;
  completedJourneys: number;
  bookingsCreated: number;
  bookingsCompleted: number;
  bookingsCancelled: number;
  ordersCreated: number;
  ordersCompleted: number;
  ratingsCount: number;
  averageRating: number;
  openReports: number;
  activityEvents: number;
  feedImpressions: number;
  feedInteractions: number;
  pendingOutbox: number;
  enabledFeatureFlags: number;
  featureFlagCount: number;
  dailyActivity: AevoGoDailyActivity[];
}

export const defaultAevoGoSettings: AevoGoSettings = {
  discovery: {
    searchEnabled: true,
    mapEnabled: true,
    defaultRadiusKm: 15,
    maxResults: 50
  },
  community: {
    traceDeeEnabled: true,
    commentsEnabled: false,
    contributionsEnabled: true,
    requireModeration: true
  },
  booking: {
    enabled: true,
    holdMinutes: 10,
    maxPartySize: 12
  },
  notifications: {
    pushEnabled: true,
    marketingOptInRequired: true
  },
  privacy: {
    allowGuestBrowse: true,
    requireAccountToSave: true
  },
  analytics: {
    enabled: true,
    retentionDays: 90
  }
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function section(source: JsonRecord, key: string): JsonRecord {
  return record(source[key]);
}

function booleanValue(source: JsonRecord, key: string, fallback: boolean): boolean {
  return typeof source[key] === "boolean" ? source[key] as boolean : fallback;
}

function integerValue(source: JsonRecord, key: string, fallback: number, min: number, max: number): number {
  const value = Number(source[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function normalizeAevoGoSettings(value: unknown): AevoGoSettings {
  const source = record(value);
  const discovery = section(source, "discovery");
  const community = section(source, "community");
  const booking = section(source, "booking");
  const notifications = section(source, "notifications");
  const privacy = section(source, "privacy");
  const analytics = section(source, "analytics");

  return {
    discovery: {
      searchEnabled: booleanValue(discovery, "searchEnabled", defaultAevoGoSettings.discovery.searchEnabled),
      mapEnabled: booleanValue(discovery, "mapEnabled", defaultAevoGoSettings.discovery.mapEnabled),
      defaultRadiusKm: integerValue(discovery, "defaultRadiusKm", defaultAevoGoSettings.discovery.defaultRadiusKm, 1, 100),
      maxResults: integerValue(discovery, "maxResults", defaultAevoGoSettings.discovery.maxResults, 10, 200)
    },
    community: {
      traceDeeEnabled: booleanValue(community, "traceDeeEnabled", defaultAevoGoSettings.community.traceDeeEnabled),
      commentsEnabled: booleanValue(community, "commentsEnabled", defaultAevoGoSettings.community.commentsEnabled),
      contributionsEnabled: booleanValue(community, "contributionsEnabled", defaultAevoGoSettings.community.contributionsEnabled),
      requireModeration: booleanValue(community, "requireModeration", defaultAevoGoSettings.community.requireModeration)
    },
    booking: {
      enabled: booleanValue(booking, "enabled", defaultAevoGoSettings.booking.enabled),
      holdMinutes: integerValue(booking, "holdMinutes", defaultAevoGoSettings.booking.holdMinutes, 1, 60),
      maxPartySize: integerValue(booking, "maxPartySize", defaultAevoGoSettings.booking.maxPartySize, 1, 100)
    },
    notifications: {
      pushEnabled: booleanValue(notifications, "pushEnabled", defaultAevoGoSettings.notifications.pushEnabled),
      marketingOptInRequired: booleanValue(notifications, "marketingOptInRequired", defaultAevoGoSettings.notifications.marketingOptInRequired)
    },
    privacy: {
      allowGuestBrowse: booleanValue(privacy, "allowGuestBrowse", defaultAevoGoSettings.privacy.allowGuestBrowse),
      requireAccountToSave: booleanValue(privacy, "requireAccountToSave", defaultAevoGoSettings.privacy.requireAccountToSave)
    },
    analytics: {
      enabled: booleanValue(analytics, "enabled", defaultAevoGoSettings.analytics.enabled),
      retentionDays: integerValue(analytics, "retentionDays", defaultAevoGoSettings.analytics.retentionDays, 7, 730)
    }
  };
}

function mapSettingsRow(row: Record<string, unknown> | null | undefined): AevoGoSettingsRecord {
  return {
    config: normalizeAevoGoSettings(row?.config),
    updatedBy: typeof row?.updated_by === "string" ? row.updated_by : null,
    updatedAt: typeof row?.updated_at === "string" ? row.updated_at : ""
  };
}

export async function getAevoGoSettings(database: Database): Promise<AevoGoSettingsRecord> {
  const result = await database.client
    .from("aevo_go_settings")
    .select("config,updated_by,updated_at")
    .eq("setting_key", "default")
    .maybeSingle();

  if (result.error) return throwDatabaseError(result.error, "Aevo Go settings lookup");
  return mapSettingsRow(result.data as Record<string, unknown> | null);
}

export async function updateAevoGoSettings(
  database: Database,
  config: AevoGoSettings,
  updatedBy: string
): Promise<AevoGoSettingsRecord> {
  const normalized = normalizeAevoGoSettings(config);
  const result = await database.client
    .from("aevo_go_settings")
    .upsert({
      setting_key: "default",
      config: normalized,
      updated_by: updatedBy,
      updated_at: new Date().toISOString()
    }, { onConflict: "setting_key" })
    .select("config,updated_by,updated_at")
    .single();

  if (result.error) return throwDatabaseError(result.error, "Aevo Go settings update");
  return mapSettingsRow(result.data as Record<string, unknown>);
}

function parseOverview(value: unknown): AevoGoOverview {
  const source = record(value);
  const dailyActivity = Array.isArray(source.dailyActivity)
    ? source.dailyActivity.map((item) => {
      const row = record(item);
      return {
        date: typeof row.date === "string" ? row.date : "",
        events: Number(row.events) || 0,
        impressions: Number(row.impressions) || 0,
        interactions: Number(row.interactions) || 0
      };
    })
    : [];

  return {
    asOf: typeof source.asOf === "string" ? source.asOf : new Date().toISOString(),
    windowDays: Number(source.windowDays) || 30,
    activePlaces: Number(source.activePlaces) || 0,
    publicStores: Number(source.publicStores) || 0,
    publishedTraces: Number(source.publishedTraces) || 0,
    totalJourneys: Number(source.totalJourneys) || 0,
    completedJourneys: Number(source.completedJourneys) || 0,
    bookingsCreated: Number(source.bookingsCreated) || 0,
    bookingsCompleted: Number(source.bookingsCompleted) || 0,
    bookingsCancelled: Number(source.bookingsCancelled) || 0,
    ordersCreated: Number(source.ordersCreated) || 0,
    ordersCompleted: Number(source.ordersCompleted) || 0,
    ratingsCount: Number(source.ratingsCount) || 0,
    averageRating: Number(source.averageRating) || 0,
    openReports: Number(source.openReports) || 0,
    activityEvents: Number(source.activityEvents) || 0,
    feedImpressions: Number(source.feedImpressions) || 0,
    feedInteractions: Number(source.feedInteractions) || 0,
    pendingOutbox: Number(source.pendingOutbox) || 0,
    enabledFeatureFlags: Number(source.enabledFeatureFlags) || 0,
    featureFlagCount: Number(source.featureFlagCount) || 0,
    dailyActivity
  };
}

export async function getAevoGoOverview(database: Database, days = 30): Promise<AevoGoOverview> {
  const result = await database.client.rpc("aevo_go_admin_overview", { p_days: days });
  if (result.error) return throwDatabaseError(result.error, "Aevo Go overview lookup");
  return parseOverview(result.data);
}
