import type {
  TraceDeeActionResult,
  TraceDeeActivityEventInput,
  TraceDeeActivityEventResult,
  TraceDeeHelpfulResult,
  TraceDeeFeedItem,
  TraceDeeFeedPage,
  TraceDeeFeedTab,
  TraceDeeJourneyAction,
  TraceDeeJourneyDetail,
  TraceDeeJourneySummary,
  TraceDeeJourneyStop as ContractJourneyStop,
  TraceDeePlaceSummary,
  TraceDeeComment,
  TraceDeeCommentResult,
  TraceDeeCompletionVerificationStatus,
  TraceDeeContentMutationResult,
  TraceDeeModerationAction,
  TraceDeeModerationQueueItem,
  TraceDeeModerationResult,
  TraceDeeExpertiseItem,
  TraceDeeReputationEvidence,
  TraceDeeProfilePreferences,
  TraceDeePreferenceUpdateResult,
  TraceDeeFeedInteractionResult,
  TraceDeeRankingGuardrailReport,
  TraceDeeNotification,
  TraceDeeNotificationReadResult,
  TraceDeePost,
  TraceDeePostResult,
  TraceDeeProfileExpertise,
  TraceDeeRatingResult,
  TraceDeeRatingSummary,
  TraceDeeReportResult,
  TraceDeeUserRelation,
  TraceDeeUserRelationResult,
  TraceDeeTraceAction,
  TraceDeeTraceDetail,
  TraceDeeTraceStop,
  TraceDeeLineageNode,
  TraceDeeRemixResult,
  TraceDeeRemixDraft,
  TraceDeeRemixStopDraft,
  TraceDeeRemixUpdateResult,
  TraceDeeRemixPublishResult,
  TraceDeeTraceLineage,
  TraceDeeTracerFollowResult
} from "@aevo/contracts";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";

type Row = Record<string, unknown>;

export interface TraceDeeFeedQuery {
  actorId?: string;
  tab?: TraceDeeFeedTab;
  query?: string;
  area?: string;
  cursor?: string;
  limit?: number;
}

export class TraceDeeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TraceDeeError";
  }
}

interface TraceDeeCursor {
  score: number;
  publishedAt: string;
  id: string;
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  const normalized = stringValue(value).trim();
  return normalized ? normalized : null;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(0, 32);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

async function getTraceDeeSuppressedActorIds(database: Database, actorId: string | undefined): Promise<Set<string>> {
  if (!actorId) return new Set<string>();
  const [blocksResult, mutesResult] = await Promise.all([
    database.client.from("tracedee_user_blocks").select("blocked_id").eq("blocker_id", actorId),
    database.client.from("tracedee_user_mutes").select("muted_id").eq("muter_id", actorId)
  ]);
  throwDatabaseError(blocksResult.error, "TraceDee blocked users lookup");
  throwDatabaseError(mutesResult.error, "TraceDee muted users lookup");
  return new Set([
    ...((blocksResult.data ?? []) as unknown as Row[]).map((row) => stringValue(row.blocked_id)),
    ...((mutesResult.data ?? []) as unknown as Row[]).map((row) => stringValue(row.muted_id))
  ].filter(Boolean));
}

function mapTraceDeeRatingSummary(row: Row): TraceDeeRatingSummary {
  const moderationStatus = stringValue(row.moderation_status, "VISIBLE");
  const validModerationStatuses = new Set(["VISIBLE", "LIMITED", "UNDER_REVIEW", "REMOVED"]);
  return {
    ratingId: stringValue(row.id),
    rating: numberValue(row.rating),
    tags: stringArray(row.tags),
    review: stringValue(row.review),
    moderationStatus: validModerationStatuses.has(moderationStatus)
      ? moderationStatus as TraceDeeRatingSummary["moderationStatus"]
      : "VISIBLE",
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at)
  };
}

function parseCursor(cursor: string | undefined): TraceDeeCursor | null {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!isRecord(value)) throw new Error("cursor is not an object");
    const score = numberValue(value.score, Number.NaN);
    const publishedAt = stringValue(value.publishedAt);
    const id = stringValue(value.id);
    if (!Number.isFinite(score) || !publishedAt || !/^[0-9a-f-]{36}$/iu.test(id)) throw new Error("cursor fields are invalid");
    if (!Number.isFinite(Date.parse(publishedAt))) throw new Error("cursor timestamp is invalid");
    return { score, publishedAt, id };
  } catch {
    throw new TraceDeeError("INVALID_CURSOR", "The TraceDee feed cursor is invalid");
  }
}

function encodeCursor(cursor: TraceDeeCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function throwTraceDeeRpcError(error: unknown, operation: string): never {
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; code?: unknown };
    const message = stringValue(candidate.message, `Supabase ${operation} failed`);
    const knownCodes = new Set([
      "UNAUTHORIZED",
      "TRACE_NOT_FOUND",
      "SOURCE_TRACE_NOT_FOUND",
      "REMIX_LINEAGE_LIMIT",
      "REMIX_NOT_OWNER",
      "REMIX_NOT_EDITABLE",
      "REMIX_NOT_PUBLISHABLE",
      "TRACE_REVISION_CONFLICT",
      "REMIX_STOPS_INVALID",
      "REMIX_STOP_PLACE_INVALID",
      "REMIX_STOP_DURATION_INVALID",
      "REMIX_STOP_BUDGET_INVALID",
      "REMIX_STOP_TRANSPORT_INVALID",
      "REMIX_PLACE_NOT_FOUND",
      "REMIX_STOP_DUPLICATE",
      "TRACE_HAS_NO_STOPS",
      "TRACER_FOLLOW_INPUT_INVALID",
      "TRACER_FOLLOW_SELF_INVALID",
      "TRACER_FOLLOW_ACTION_NOT_SUPPORTED",
      "TRACER_NOT_FOUND",
      "TRACE_ACTION_NOT_SUPPORTED",
      "PREFERENCES_INPUT_INVALID",
      "PREFERENCES_NEED_THREE_INTERESTS",
      "FEED_INTERACTION_INPUT_INVALID",
      "FEED_INTERACTION_UNSUPPORTED",
      "FEED_ITEM_NOT_FOUND",
      "RANKING_EVALUATION_MODE_INVALID",
      "RANKING_EVALUATION_INPUT_INVALID",
      "IDEMPOTENCY_KEY_INVALID",
      "REQUEST_HASH_INVALID",
      "IDEMPOTENCY_CONFLICT",
      "IDEMPOTENCY_IN_PROGRESS",
      "ACTIVITY_EVENT_NOT_SUPPORTED",
      "ACTIVITY_ENTITY_TYPE_INVALID",
      "JOURNEY_ACTION_NOT_SUPPORTED",
      "JOURNEY_NOT_FOUND",
      "JOURNEY_STOP_NOT_FOUND",
      "JOURNEY_STOP_INPUT_INVALID",
      "JOURNEY_STOP_NOT_EDITABLE",
      "JOURNEY_CANNOT_START",
      "JOURNEY_CANNOT_PAUSE",
      "JOURNEY_CANNOT_ABANDON",
      "JOURNEY_CANNOT_COMPLETE",
      "JOURNEY_INCOMPLETE",
      "JOURNEY_VERSION_CONFLICT",
      "COMPLETION_VERIFICATION_INPUT_INVALID",
      "USER_RELATION_INPUT_INVALID",
      "USER_RELATION_TARGET_NOT_FOUND",
      "NOTIFICATION_INPUT_INVALID",
      "NOTIFICATION_NOT_FOUND",
      "CONTENT_EDIT_INPUT_INVALID",
      "CONTENT_EDITABLE_NOT_FOUND",
      "CONTENT_NOT_EDITABLE",
      "CONTENT_VERSION_CONFLICT",
      "CONTENT_DELETE_INPUT_INVALID",
      "CONTENT_DELETE_NOT_ALLOWED",
      "RATING_INPUT_INVALID",
      "RATING_NOT_ELIGIBLE",
      "RATING_NOT_FOUND",
      "POST_INPUT_INVALID",
      "POST_TARGET_INVALID",
      "CONTRIBUTION_NOT_ELIGIBLE",
      "CONTENT_RATE_LIMITED",
      "CONTENT_DUPLICATE",
      "COMMENT_INPUT_INVALID",
      "COMMENT_THREAD_NOT_FOUND",
      "COMMENT_NOT_ALLOWED",
      "COMMENT_PARENT_INVALID",
      "REPORT_INPUT_INVALID",
      "CONTENT_NOT_FOUND",
      "REPORT_NOT_FOUND",
      "MODERATION_INPUT_INVALID",
      "MODERATION_ACTION_UNSUPPORTED",
      "PROJECTION_ROLLBACK_INVALID",
      "PROJECTION_RUN_NOT_FOUND",
      "PROJECTION_RUN_NOT_ROLLBACKABLE"
    ]);
    if (knownCodes.has(message)) throw new TraceDeeError(message, message);
    if (typeof candidate.code === "string" && knownCodes.has(candidate.code)) {
      throw new TraceDeeError(candidate.code, message);
    }
  }
  throwDatabaseError(error, operation);
}

function mapFeedRow(row: Row): TraceDeeFeedItem {
  const status = stringValue(row.status, "PUBLISHED");
  const visibility = stringValue(row.visibility, "PUBLIC");
  return {
    itemType: "TRACE",
    itemId: stringValue(row.item_id),
    slug: stringValue(row.slug),
    title: stringValue(row.title),
    description: stringValue(row.description),
    creatorId: stringValue(row.creator_id),
    creatorName: stringValue(row.creator_name, "Aevo member"),
    status: status === "PUBLISHED" ? "PUBLISHED" : "PUBLISHED",
    visibility: visibility === "PUBLIC" ? "PUBLIC" : "PUBLIC",
    coverPlaceId: nullableString(row.cover_place_id),
    area: stringValue(row.area),
    topicTags: stringArray(row.topic_tags),
    stopCount: numberValue(row.stop_count),
    followerCount: numberValue(row.follower_count),
    saveCount: numberValue(row.save_count),
    rankScore: numberValue(row.rank_score),
    reasonCode: row.reason_code === "FOLLOWING_TRACER" || row.reason_code === "TASTE_MATCH" || row.reason_code === "POPULAR" ? row.reason_code : "NEW_TRACE",
    reasonParams: jsonObject(row.reason_params),
    trackingToken: stringValue(row.tracking_token),
    publishedAt: stringValue(row.published_at)
  };
}

export async function listTraceDeeFeed(database: Database, query: TraceDeeFeedQuery = {}): Promise<TraceDeeFeedPage> {
  const startedAt = Date.now();
  const limit = Math.max(1, Math.min(24, Math.trunc(query.limit ?? 12)));
  const cursor = parseCursor(query.cursor);
  const result = await database.client.rpc("tracedee_discovery_feed", {
    p_actor_id: query.actorId ?? null,
    p_tab: query.tab ?? "for_you",
    p_query: query.query?.trim() || null,
    p_area: query.area?.trim() || null,
    p_after_score: cursor?.score ?? null,
    p_after_published_at: cursor?.publishedAt ?? null,
    p_after_id: cursor?.id ?? null,
    p_limit: limit + 1
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee feed lookup");
  const rows = Array.isArray(result.data) ? result.data.filter(isRecord) : [];
  const hasNext = rows.length > limit;
  const items = rows.slice(0, limit).map(mapFeedRow);
  const last = items.at(-1);
  if (query.actorId && items.length > 0) {
    const reasonParams = items[0]?.reasonParams ?? {};
    const rankingMode = stringValue(reasonParams.rankingMode, "DETERMINISTIC");
    const deterministicItems = [...items].sort((left, right) => {
      const leftScore = numberValue(left.reasonParams.deterministicScore, left.rankScore);
      const rightScore = numberValue(right.reasonParams.deterministicScore, right.rankScore);
      return rightScore - leftScore || Date.parse(right.publishedAt) - Date.parse(left.publishedAt) || right.itemId.localeCompare(left.itemId);
    });
    const personalizedItems = [...items].sort((left, right) => {
      const leftScore = numberValue(left.reasonParams.personalizedScore, left.rankScore);
      const rightScore = numberValue(right.reasonParams.personalizedScore, right.rankScore);
      return rightScore - leftScore || Date.parse(right.publishedAt) - Date.parse(left.publishedAt) || right.itemId.localeCompare(left.itemId);
    });
    try {
      await database.client.rpc("tracedee_record_ranking_evaluation", {
        p_actor_id: query.actorId,
        p_session_id: null,
        p_model_version: rankingMode === "DETERMINISTIC" ? "tracedee-deterministic-v1" : "tracedee-taste-v1",
        p_ranking_mode: rankingMode,
        p_deterministic_item_ids: deterministicItems.map((item) => item.itemId),
        p_shadow_item_ids: personalizedItems.map((item) => item.itemId),
        p_served_item_ids: items.map((item) => item.itemId),
        p_context: { tab: query.tab ?? "for_you", query: query.query ?? null, area: query.area ?? null },
        p_metrics: { latencyMs: Date.now() - startedAt, itemCount: items.length, hasCursor: Boolean(query.cursor) }
      });
    } catch {
      // Evaluation is telemetry; it must not turn a usable feed into an error.
    }
  }
  return {
    items,
    nextCursor: hasNext && last
      ? encodeCursor({ score: last.rankScore, publishedAt: last.publishedAt, id: last.itemId })
      : null
  };
}

function mapTraceDeeInterest(value: unknown): { dimensionType: "TOPIC" | "AREA" | "CATEGORY"; dimensionKey: string; position: number } {
  const row = isRecord(value) ? value : {};
  const dimensionType = stringValue(row.dimensionType ?? row.dimension_type, "TOPIC").toUpperCase();
  return {
    dimensionType: dimensionType === "AREA" || dimensionType === "CATEGORY" ? dimensionType : "TOPIC",
    dimensionKey: stringValue(row.dimensionKey ?? row.dimension_key).toLowerCase(),
    position: numberValue(row.position)
  };
}

function mapTraceDeeProfilePreferences(value: unknown): TraceDeeProfilePreferences {
  if (!isRecord(value)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned invalid profile preferences");
  return {
    ok: true,
    profileId: stringValue(value.profileId ?? value.profile_id),
    personalizationEnabled: value.personalizationEnabled === true || value.personalization_enabled === true,
    onboardingCompleted: value.onboardingCompleted === true || value.onboarding_completed === true,
    interests: Array.isArray(value.interests) ? value.interests.map(mapTraceDeeInterest) : []
  };
}

export async function getTraceDeeProfilePreferences(database: Database, actorId: string): Promise<TraceDeeProfilePreferences> {
  const result = await database.client.rpc("tracedee_get_profile_preferences", { p_actor_id: actorId });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee profile preferences lookup");
  return mapTraceDeeProfilePreferences(result.data);
}

export async function updateTraceDeeProfilePreferences(
  database: Database,
  input: {
    actorId: string;
    personalizationEnabled: boolean;
    interests: Array<{ dimensionType: "TOPIC" | "AREA" | "CATEGORY"; dimensionKey: string }>;
    idempotencyKey: string;
    requestHash: string;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeePreferenceUpdateResult> {
  const result = await database.client.rpc("tracedee_update_profile_preferences", {
    p_actor_id: input.actorId,
    p_personalization_enabled: input.personalizationEnabled,
    p_interests: input.interests,
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee profile preferences update");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned invalid preferences response");
  const preferences = mapTraceDeeProfilePreferences(result.data);
  return {
    ...preferences,
    changed: result.data.changed === true,
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

export async function recordTraceDeeFeedInteraction(
  database: Database,
  input: {
    actorId: string;
    itemId: string;
    interactionType: "OPENED" | "DISMISSED" | "QUICK_BACK";
    trackingToken?: string;
    metadata?: Record<string, unknown>;
    idempotencyKey: string;
    requestHash: string;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeeFeedInteractionResult> {
  const result = await database.client.rpc("tracedee_record_feed_interaction", {
    p_actor_id: input.actorId,
    p_item_type: "TRACE",
    p_item_id: input.itemId,
    p_interaction_type: input.interactionType,
    p_tracking_token: input.trackingToken ?? null,
    p_metadata: input.metadata ?? {},
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee feed interaction");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned invalid feed interaction response");
  const interaction = stringValue(result.data.interactionType ?? result.data.interaction_type, "OPENED").toUpperCase();
  return {
    ok: true,
    itemType: "TRACE",
    itemId: stringValue(result.data.itemId ?? result.data.item_id),
    interactionType: interaction === "DISMISSED" ? "DISMISSED" : interaction === "QUICK_BACK" ? "QUICK_BACK" : "OPENED",
    changed: result.data.changed === true,
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

function mapTraceDeeRankingGuardrailReport(value: unknown): TraceDeeRankingGuardrailReport {
  if (!isRecord(value)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned invalid ranking guardrail report");
  const guardrails = isRecord(value.guardrails) ? Object.fromEntries(Object.entries(value.guardrails).map(([key, item]) => [key, item === true])) : {};
  return {
    since: stringValue(value.since),
    until: stringValue(value.until),
    evaluationCount: numberValue(value.evaluationCount ?? value.evaluation_count),
    personalizedEvaluationCount: numberValue(value.personalizedEvaluationCount ?? value.personalized_evaluation_count),
    shadowEvaluationCount: numberValue(value.shadowEvaluationCount ?? value.shadow_evaluation_count),
    servedItemCount: numberValue(value.servedItemCount ?? value.served_item_count),
    creatorConcentration: numberValue(value.creatorConcentration ?? value.creator_concentration),
    categoryDiversity: numberValue(value.categoryDiversity ?? value.category_diversity),
    hideRate: numberValue(value.hideRate ?? value.hide_rate),
    quickBackRate: numberValue(value.quickBackRate ?? value.quick_back_rate),
    averageLatencyMs: numberValue(value.averageLatencyMs ?? value.average_latency_ms),
    guardrails
  };
}

export async function getTraceDeeRankingGuardrailReport(
  database: Database,
  input: { since?: string; until?: string } = {}
): Promise<TraceDeeRankingGuardrailReport> {
  const result = await database.client.rpc("tracedee_ranking_guardrail_report", {
    p_since: input.since ?? null,
    p_until: input.until ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee ranking guardrail lookup");
  return mapTraceDeeRankingGuardrailReport(result.data);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function mapPlace(row: Row): TraceDeePlaceSummary {
  return {
    id: stringValue(row.id),
    slug: stringValue(row.slug),
    name: stringValue(row.name),
    area: stringValue(row.area),
    category: stringValue(row.category),
    description: stringValue(row.description),
    imageUrl: nullableString(row.image_url),
    latitude: nullableNumber(row.latitude),
    longitude: nullableNumber(row.longitude)
  };
}

export async function getTraceDeeTrace(
  database: Database,
  traceIdOrSlug: string,
  actorId?: string
): Promise<TraceDeeTraceDetail | null> {
  const traceResult = isUuid(traceIdOrSlug)
    ? await database.client
      .from("tracedee_traces")
      .select("id,slug,title,description,creator_id,status,visibility,revision,cover_place_id,area,topic_tags,estimated_minutes,estimated_budget_minor,published_at,created_at,updated_at")
      .eq("id", traceIdOrSlug)
      .eq("status", "PUBLISHED")
      .eq("visibility", "PUBLIC")
      .in("moderation_status", ["VISIBLE", "LIMITED"])
      .maybeSingle()
    : await database.client
      .from("tracedee_traces")
      .select("id,slug,title,description,creator_id,status,visibility,revision,cover_place_id,area,topic_tags,estimated_minutes,estimated_budget_minor,published_at,created_at,updated_at")
      .eq("slug", traceIdOrSlug)
      .eq("status", "PUBLISHED")
      .eq("visibility", "PUBLIC")
      .in("moderation_status", ["VISIBLE", "LIMITED"])
      .maybeSingle();
  throwDatabaseError(traceResult.error, "TraceDee trace lookup");
  if (!traceResult.data) return null;
  const trace = traceResult.data as unknown as Row;
  const traceId = stringValue(trace.id);

  const [stopsResult, creatorResult, saveCountResult, followCountResult, tracerFollowerCountResult, tracerFollowingResult] = await Promise.all([
    database.client
      .from("tracedee_trace_stops")
      .select("id,position,note,duration_minutes,transport_mode,budget_minor,place_id")
      .eq("trace_id", traceId)
      .order("position", { ascending: true }),
    database.client
      .from("user_profiles")
      .select("id,email,display_name")
      .eq("id", String(trace.creator_id))
      .maybeSingle(),
    database.client
      .from("tracedee_trace_saves")
      .select("trace_id", { count: "exact", head: true })
      .eq("trace_id", traceId),
    database.client
      .from("tracedee_trace_follows")
      .select("trace_id", { count: "exact", head: true })
      .eq("trace_id", traceId),
    database.client
      .from("tracedee_tracer_follows")
      .select("tracer_id", { count: "exact", head: true })
      .eq("tracer_id", String(trace.creator_id)),
    actorId
      ? database.client
        .from("tracedee_tracer_follows")
        .select("tracer_id")
        .eq("tracer_id", String(trace.creator_id))
        .eq("follower_id", actorId)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null })
  ]);
  throwDatabaseError(stopsResult.error, "TraceDee trace stops lookup");
  throwDatabaseError(creatorResult.error, "TraceDee creator lookup");
  throwDatabaseError(saveCountResult.error, "TraceDee trace save count");
  throwDatabaseError(followCountResult.error, "TraceDee trace follow count");
  throwDatabaseError(tracerFollowerCountResult.error, "TraceDee tracer follower count");
  throwDatabaseError(tracerFollowingResult.error, "TraceDee tracer following state");

  const stopRows = (stopsResult.data ?? []) as unknown as Row[];
  const placeIds = [...new Set(stopRows.map((row) => stringValue(row.place_id)).filter(Boolean))];
  const placesResult = placeIds.length > 0
    ? await database.client.from("tracedee_places").select("id,slug,name,area,category,description,image_url,latitude,longitude").in("id", placeIds)
    : { data: [], error: null };
  throwDatabaseError(placesResult.error, "TraceDee places lookup");
  const placeById = new Map(
    ((placesResult.data ?? []) as unknown as Row[]).map((row) => [stringValue(row.id), mapPlace(row)])
  );
  const stops: TraceDeeTraceStop[] = stopRows.flatMap((row) => {
    const place = placeById.get(stringValue(row.place_id));
    if (!place) return [];
    return [{
      id: stringValue(row.id),
      position: numberValue(row.position),
      note: stringValue(row.note),
      durationMinutes: nullableNumber(row.duration_minutes),
      transportMode: nullableString(row.transport_mode),
      budgetMinor: nullableNumber(row.budget_minor),
      place
    }];
  });

  let saved = false;
  let followed = false;
  if (actorId) {
    const [savedResult, followedResult] = await Promise.all([
      database.client.from("tracedee_trace_saves").select("trace_id").eq("trace_id", traceId).eq("user_id", actorId).maybeSingle(),
      database.client.from("tracedee_trace_follows").select("trace_id").eq("trace_id", traceId).eq("user_id", actorId).maybeSingle()
    ]);
    throwDatabaseError(savedResult.error, "TraceDee saved state lookup");
    throwDatabaseError(followedResult.error, "TraceDee followed state lookup");
    saved = Boolean(savedResult.data);
    followed = Boolean(followedResult.data);
  }

  const creator = creatorResult.data as unknown as Row | null;
  const creatorName = creator
    ? stringValue(creator.display_name).trim() || stringValue(creator.email).trim() || "Aevo member"
    : "Aevo member";
  const publishedAt = stringValue(trace.published_at || trace.created_at);
  return {
    itemType: "TRACE",
    itemId: traceId,
    slug: stringValue(trace.slug),
    title: stringValue(trace.title),
    description: stringValue(trace.description),
    creatorId: stringValue(trace.creator_id),
    creatorName,
    status: "PUBLISHED",
    visibility: "PUBLIC",
    coverPlaceId: nullableString(trace.cover_place_id),
    area: stringValue(trace.area),
    topicTags: stringArray(trace.topic_tags),
    stopCount: stops.length,
    followerCount: followCountResult.count ?? 0,
    saveCount: saveCountResult.count ?? 0,
    rankScore: 0,
    reasonCode: "NEW_TRACE",
    reasonParams: { area: stringValue(trace.area), stopCount: stops.length },
    trackingToken: crypto.randomUUID(),
    publishedAt,
    revision: numberValue(trace.revision, 1),
    estimatedMinutes: nullableNumber(trace.estimated_minutes),
    estimatedBudgetMinor: nullableNumber(trace.estimated_budget_minor),
    createdAt: stringValue(trace.created_at),
    updatedAt: stringValue(trace.updated_at),
    saved,
    followed,
    tracerFollowing: Boolean(tracerFollowingResult.data),
    tracerFollowerCount: tracerFollowerCountResult.count ?? 0,
    stops
  };
}

export async function searchTraceDeePlaces(
  database: Database,
  input: { query?: string; area?: string; limit?: number } = {}
): Promise<TraceDeePlaceSummary[]> {
  const result = await database.client.rpc("tracedee_search_places", {
    p_query: input.query?.trim() || null,
    p_area: input.area?.trim() || null,
    p_limit: Math.max(1, Math.min(48, Math.trunc(input.limit ?? 24)))
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee place search");
  const rows = Array.isArray(result.data) ? result.data.filter(isRecord) : [];
  return rows.map(mapPlace);
}

export async function getTraceDeeRemixDraft(
  database: Database,
  traceId: string,
  actorId: string
): Promise<TraceDeeRemixDraft | null> {
  const traceResult = await database.client
    .from("tracedee_traces")
    .select("id,slug,title,description,creator_id,status,visibility,revision,source_trace_id,root_trace_id,lineage_depth,area,topic_tags,estimated_minutes,estimated_budget_minor")
    .eq("id", traceId)
    .eq("creator_id", actorId)
    .eq("status", "DRAFT")
    .eq("visibility", "PRIVATE")
    .maybeSingle();
  throwDatabaseError(traceResult.error, "TraceDee remix draft lookup");
  if (!traceResult.data) return null;

  const trace = traceResult.data as unknown as Row;
  const [stopsResult] = await Promise.all([
    database.client
      .from("tracedee_trace_stops")
      .select("id,position,note,duration_minutes,transport_mode,budget_minor,place_id")
      .eq("trace_id", traceId)
      .order("position", { ascending: true })
  ]);
  throwDatabaseError(stopsResult.error, "TraceDee remix draft stops lookup");
  const stopRows = (stopsResult.data ?? []) as unknown as Row[];
  const placeIds = [...new Set(stopRows.map((row) => stringValue(row.place_id)).filter(Boolean))];
  const placesResult = placeIds.length > 0
    ? await database.client.from("tracedee_places").select("id,slug,name,area,category,description,image_url,latitude,longitude").in("id", placeIds)
    : { data: [], error: null };
  throwDatabaseError(placesResult.error, "TraceDee remix draft places lookup");
  const placeById = new Map(
    ((placesResult.data ?? []) as unknown as Row[]).map((row) => [stringValue(row.id), mapPlace(row)])
  );
  const stops: TraceDeeRemixStopDraft[] = stopRows.flatMap((row) => {
    const place = placeById.get(stringValue(row.place_id));
    if (!place) return [];
    const transport = nullableString(row.transport_mode);
    const validTransport = new Set(["WALK", "BIKE", "TRANSIT", "CAR", "RIDE_HAIL", "OTHER"]);
    return [{
      id: stringValue(row.id),
      position: numberValue(row.position),
      place,
      note: stringValue(row.note),
      durationMinutes: nullableNumber(row.duration_minutes),
      transportMode: transport && validTransport.has(transport) ? transport as TraceDeeRemixStopDraft["transportMode"] : null,
      budgetMinor: nullableNumber(row.budget_minor)
    }];
  });
  const sourceTraceId = nullableString(trace.source_trace_id);
  const rootTraceId = nullableString(trace.root_trace_id);
  if (!sourceTraceId || !rootTraceId) return null;
  return {
    ok: true,
    traceId: stringValue(trace.id),
    slug: stringValue(trace.slug),
    title: stringValue(trace.title),
    description: stringValue(trace.description),
    area: stringValue(trace.area),
    topicTags: stringArray(trace.topic_tags),
    estimatedMinutes: nullableNumber(trace.estimated_minutes),
    estimatedBudgetMinor: nullableNumber(trace.estimated_budget_minor),
    status: "DRAFT",
    visibility: "PRIVATE",
    revision: numberValue(trace.revision, 1),
    sourceTraceId,
    rootTraceId,
    lineageDepth: numberValue(trace.lineage_depth),
    stops
  };
}

function mapTraceDeeLineageNode(value: unknown): TraceDeeLineageNode {
  if (!isRecord(value)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid lineage node");
  const status = stringValue(value.status, "DRAFT");
  const visibility = stringValue(value.visibility, "PRIVATE");
  const validStatuses = new Set(["DRAFT", "PUBLISHED", "UNDER_REVIEW", "REMOVED", "ARCHIVED"]);
  const validVisibilities = new Set(["PUBLIC", "UNLISTED", "PRIVATE"]);
  return {
    id: stringValue(value.id),
    slug: stringValue(value.slug),
    title: stringValue(value.title),
    creatorId: stringValue(value.creatorId ?? value.creator_id),
    status: validStatuses.has(status) ? status as TraceDeeLineageNode["status"] : "DRAFT",
    visibility: validVisibilities.has(visibility) ? visibility as TraceDeeLineageNode["visibility"] : "PRIVATE",
    revision: numberValue(value.revision, 1),
    rootTraceId: nullableString(value.rootTraceId ?? value.root_trace_id),
    sourceTraceId: nullableString(value.sourceTraceId ?? value.source_trace_id),
    lineageDepth: numberValue(value.lineageDepth ?? value.lineage_depth),
    publishedAt: nullableString(value.publishedAt ?? value.published_at),
    createdAt: stringValue(value.createdAt ?? value.created_at)
  };
}

function mapTraceDeeLineage(value: unknown): TraceDeeTraceLineage {
  if (!isRecord(value)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid lineage response");
  const ancestors = Array.isArray(value.ancestors) ? value.ancestors.map(mapTraceDeeLineageNode) : [];
  const descendants = Array.isArray(value.descendants) ? value.descendants.map(mapTraceDeeLineageNode) : [];
  return {
    ok: true,
    trace: mapTraceDeeLineageNode(value.trace),
    source: value.source && isRecord(value.source) ? mapTraceDeeLineageNode(value.source) : null,
    root: value.root && isRecord(value.root) ? mapTraceDeeLineageNode(value.root) : null,
    ancestors,
    descendants
  };
}

export async function getTraceDeeTraceLineage(
  database: Database,
  traceId: string,
  actorId?: string
): Promise<TraceDeeTraceLineage | null> {
  const result = await database.client.rpc("tracedee_get_trace_lineage", {
    p_trace_id: traceId,
    p_actor_id: actorId ?? null
  });
  if (result.error) {
    if (result.error.message === "TRACE_NOT_FOUND") return null;
    throwTraceDeeRpcError(result.error, "TraceDee lineage lookup");
  }
  return mapTraceDeeLineage(result.data);
}

export async function createTraceDeeRemix(
  database: Database,
  input: {
    actorId: string;
    sourceTraceId: string;
    idempotencyKey: string;
    requestHash: string;
    title?: string;
    description?: string;
    slug?: string;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeeRemixResult> {
  const result = await database.client.rpc("tracedee_create_remix", {
    p_actor_id: input.actorId,
    p_source_trace_id: input.sourceTraceId,
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_title: input.title ?? null,
    p_description: input.description ?? null,
    p_slug: input.slug ?? null,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee remix creation");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid remix response");
  return {
    ok: true,
    remixTraceId: stringValue(result.data.remixTraceId ?? result.data.remix_trace_id),
    remixSlug: stringValue(result.data.remixSlug ?? result.data.remix_slug),
    sourceTraceId: stringValue(result.data.sourceTraceId ?? result.data.source_trace_id),
    rootTraceId: stringValue(result.data.rootTraceId ?? result.data.root_trace_id),
    remixerId: stringValue(result.data.remixerId ?? result.data.remixer_id),
    lineageDepth: numberValue(result.data.lineageDepth ?? result.data.lineage_depth),
    status: "DRAFT",
    revision: numberValue(result.data.revision, 1),
    stopCount: numberValue(result.data.stopCount ?? result.data.stop_count),
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

export async function updateTraceDeeRemix(
  database: Database,
  input: {
    actorId: string;
    traceId: string;
    idempotencyKey: string;
    requestHash: string;
    expectedRevision?: number;
    title?: string;
    description?: string;
    area?: string;
    topicTags?: string[];
    estimatedMinutes?: number;
    estimatedBudgetMinor?: number;
    stops?: Array<{
      placeId: string;
      note?: string;
      durationMinutes?: number;
      transportMode?: string;
      budgetMinor?: number;
    }>;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeeRemixUpdateResult> {
  const result = await database.client.rpc("tracedee_update_remix", {
    p_actor_id: input.actorId,
    p_trace_id: input.traceId,
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_expected_revision: input.expectedRevision ?? null,
    p_title: input.title ?? null,
    p_description: input.description ?? null,
    p_area: input.area ?? null,
    p_topic_tags: input.topicTags ?? null,
    p_estimated_minutes: input.estimatedMinutes ?? null,
    p_estimated_budget_minor: input.estimatedBudgetMinor ?? null,
    p_stops: input.stops ?? null,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee remix update");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid remix update response");
  return {
    ok: true,
    traceId: stringValue(result.data.traceId ?? result.data.trace_id),
    status: "DRAFT",
    revision: numberValue(result.data.revision, 1),
    stopCount: numberValue(result.data.stopCount ?? result.data.stop_count),
    changed: result.data.changed === true,
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

export async function publishTraceDeeRemix(
  database: Database,
  input: { actorId: string; traceId: string; idempotencyKey: string; requestHash: string; source?: string; sessionId?: string }
): Promise<TraceDeeRemixPublishResult> {
  const result = await database.client.rpc("tracedee_publish_remix", {
    p_actor_id: input.actorId,
    p_trace_id: input.traceId,
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee remix publish");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid remix publish response");
  return {
    ok: true,
    traceId: stringValue(result.data.traceId ?? result.data.trace_id),
    status: "PUBLISHED",
    revision: numberValue(result.data.revision, 1),
    sourceTraceId: stringValue(result.data.sourceTraceId ?? result.data.source_trace_id),
    rootTraceId: stringValue(result.data.rootTraceId ?? result.data.root_trace_id),
    lineageDepth: numberValue(result.data.lineageDepth ?? result.data.lineage_depth),
    stopCount: numberValue(result.data.stopCount ?? result.data.stop_count),
    changed: result.data.changed === true,
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

export async function setTraceDeeTracerFollow(
  database: Database,
  input: {
    actorId: string;
    tracerId: string;
    action: "follow" | "unfollow";
    idempotencyKey: string;
    requestHash: string;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeeTracerFollowResult> {
  const result = await database.client.rpc("tracedee_tracer_action", {
    p_actor_id: input.actorId,
    p_tracer_id: input.tracerId,
    p_action: input.action.toUpperCase(),
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee tracer follow");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid tracer follow response");
  return {
    ok: true,
    tracerId: stringValue(result.data.tracerId ?? result.data.tracer_id),
    following: result.data.following === true,
    followerCount: numberValue(result.data.followerCount ?? result.data.follower_count),
    changed: result.data.changed === true,
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

export async function applyTraceDeeAction(
  database: Database,
  input: {
    actorId: string;
    traceId: string;
    action: TraceDeeTraceAction;
    idempotencyKey: string;
    requestHash: string;
    source?: string;
    sessionId?: string;
    trackingToken?: string;
  }
): Promise<TraceDeeActionResult> {
  const result = await database.client.rpc("tracedee_trace_action", {
    p_actor_id: input.actorId,
    p_trace_id: input.traceId,
    p_action: input.action.toUpperCase(),
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null,
    p_tracking_token: input.trackingToken ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee trace action");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid action response");
  return {
    ok: true,
    traceId: stringValue(result.data.traceId ?? result.data.trace_id),
    action: input.action,
    saved: result.data.saved === true,
    followed: result.data.followed === true,
    changed: result.data.changed === true,
    stateVersion: numberValue(result.data.stateVersion ?? result.data.state_version, 1),
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

export async function recordTraceDeeActivityEvent(
  database: Database,
  input: TraceDeeActivityEventInput & { actorId?: string }
): Promise<TraceDeeActivityEventResult> {
  const result = await database.client.rpc("tracedee_record_activity_event", {
    p_event_type: input.eventType,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId ?? null,
    p_actor_id: input.actorId ?? null,
    p_source: "aevo-go",
    p_session_id: input.sessionId ?? null,
    p_metadata: input.metadata ?? {},
    p_tracking_token: input.trackingToken ?? null,
    p_correlation_id: input.correlationId ?? null,
    p_dedupe_key: input.dedupeKey ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee activity event");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid activity response");
  return {
    ok: true,
    eventId: stringValue(result.data.eventId ?? result.data.event_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    deduped: result.data.deduped === true
  };
}

export async function rateTraceDeeTrace(
  database: Database,
  input: {
    actorId: string;
    journeyId: string;
    rating: number;
    tags?: string[];
    review?: string;
    idempotencyKey: string;
    requestHash: string;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeeRatingResult> {
  const result = await database.client.rpc("tracedee_rate_trace", {
    p_actor_id: input.actorId,
    p_journey_id: input.journeyId,
    p_rating: input.rating,
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_tags: input.tags ?? [],
    p_review: input.review ?? "",
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee rating");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid rating response");
  const moderationStatus = stringValue(result.data.moderationStatus ?? result.data.moderation_status, "VISIBLE");
  const validModerationStatuses = new Set(["VISIBLE", "LIMITED", "UNDER_REVIEW", "REMOVED"]);
  return {
    ok: true,
    ratingId: stringValue(result.data.ratingId ?? result.data.rating_id),
    completionId: stringValue(result.data.completionId ?? result.data.completion_id),
    journeyId: stringValue(result.data.journeyId ?? result.data.journey_id),
    traceId: stringValue(result.data.traceId ?? result.data.trace_id),
    rating: numberValue(result.data.rating),
    tags: stringArray(result.data.tags),
    review: stringValue(result.data.review),
    moderationStatus: validModerationStatuses.has(moderationStatus)
      ? moderationStatus as TraceDeeRatingResult["moderationStatus"]
      : "VISIBLE",
    changed: result.data.changed === true,
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

function moderationStatus(value: unknown): TraceDeePostResult["status"] {
  const status = stringValue(value, "VISIBLE");
  return status === "LIMITED" || status === "UNDER_REVIEW" || status === "REMOVED" ? status : "VISIBLE";
}

export async function createTraceDeePost(
  database: Database,
  input: {
    actorId: string;
    journeyId: string;
    body: string;
    traceId?: string;
    placeId?: string;
    idempotencyKey: string;
    requestHash: string;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeePostResult> {
  const result = await database.client.rpc("tracedee_create_post", {
    p_actor_id: input.actorId,
    p_journey_id: input.journeyId,
    p_body: input.body,
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_trace_id: input.traceId ?? null,
    p_place_id: input.placeId ?? null,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee post creation");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid post response");
  return {
    ok: true,
    postId: stringValue(result.data.postId ?? result.data.post_id),
    threadId: stringValue(result.data.threadId ?? result.data.thread_id),
    journeyId: stringValue(result.data.journeyId ?? result.data.journey_id),
    traceId: stringValue(result.data.traceId ?? result.data.trace_id),
    placeId: nullableString(result.data.placeId ?? result.data.place_id),
    status: moderationStatus(result.data.status),
    body: stringValue(result.data.body),
    changed: result.data.changed === true,
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

export async function createTraceDeeComment(
  database: Database,
  input: {
    actorId: string;
    threadId: string;
    body: string;
    parentId?: string;
    idempotencyKey: string;
    requestHash: string;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeeCommentResult> {
  const result = await database.client.rpc("tracedee_create_comment", {
    p_actor_id: input.actorId,
    p_thread_id: input.threadId,
    p_body: input.body,
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_parent_id: input.parentId ?? null,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee comment creation");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid comment response");
  return {
    ok: true,
    commentId: stringValue(result.data.commentId ?? result.data.comment_id),
    threadId: stringValue(result.data.threadId ?? result.data.thread_id),
    postId: stringValue(result.data.postId ?? result.data.post_id),
    parentId: nullableString(result.data.parentId ?? result.data.parent_id),
    depth: numberValue(result.data.depth),
    status: moderationStatus(result.data.status),
    body: stringValue(result.data.body),
    changed: result.data.changed === true,
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

export async function listTraceDeeComments(database: Database, threadId: string, actorId?: string): Promise<TraceDeeComment[] | null> {
  const threadResult = await database.client
    .from("tracedee_comment_threads")
    .select("id,post_id")
    .eq("id", threadId)
    .maybeSingle();
  throwDatabaseError(threadResult.error, "TraceDee comment thread lookup");
  if (!threadResult.data) return null;
  const commentsResult = await database.client
    .from("tracedee_comments")
    .select("id,thread_id,author_id,parent_id,depth,status,body,created_at,updated_at")
    .eq("thread_id", threadId)
    .in("status", ["VISIBLE", "LIMITED"])
    .order("created_at", { ascending: true })
    .limit(100);
  throwDatabaseError(commentsResult.error, "TraceDee comments lookup");
  const rows = (commentsResult.data ?? []) as unknown as Row[];
  const suppressedActorIds = await getTraceDeeSuppressedActorIds(database, actorId);
  const visibleRows = rows.filter((row) => !suppressedActorIds.has(stringValue(row.author_id)));
  const commentIds = visibleRows.map((row) => stringValue(row.id)).filter(Boolean);
  const reactionsResult = commentIds.length > 0
    ? await database.client
      .from("tracedee_comment_reactions")
      .select("comment_id,user_id")
      .eq("reaction", "HELPFUL")
      .in("comment_id", commentIds)
    : { data: [], error: null };
  throwDatabaseError(reactionsResult.error, "TraceDee comment reactions lookup");
  const helpfulCounts = new Map<string, number>();
  const helpfulByActor = new Set<string>();
  for (const reaction of (reactionsResult.data ?? []) as unknown as Row[]) {
    const commentId = stringValue(reaction.comment_id);
    helpfulCounts.set(commentId, (helpfulCounts.get(commentId) ?? 0) + 1);
    if (actorId && stringValue(reaction.user_id) === actorId) helpfulByActor.add(commentId);
  }
  const authorIds = [...new Set(visibleRows.map((row) => stringValue(row.author_id)).filter(Boolean))];
  const profilesResult = authorIds.length > 0
    ? await database.client.from("user_profiles").select("id,email,display_name").in("id", authorIds)
    : { data: [], error: null };
  throwDatabaseError(profilesResult.error, "TraceDee comment authors lookup");
  const profiles = new Map(((profilesResult.data ?? []) as unknown as Row[]).map((row) => [
    stringValue(row.id),
    stringValue(row.display_name).trim() || stringValue(row.email).trim() || "Aevo member"
  ]));
  const postId = stringValue((threadResult.data as unknown as Row).post_id);
  return visibleRows.map((row) => ({
    commentId: stringValue(row.id),
    threadId: stringValue(row.thread_id),
    postId,
    authorId: stringValue(row.author_id),
    authorName: profiles.get(stringValue(row.author_id)) ?? "Aevo member",
    parentId: nullableString(row.parent_id),
    depth: numberValue(row.depth),
    status: stringValue(row.status, "VISIBLE") === "LIMITED" ? "LIMITED" : "VISIBLE",
    body: stringValue(row.body),
    helpful: helpfulByActor.has(stringValue(row.id)),
    helpfulCount: helpfulCounts.get(stringValue(row.id)) ?? 0,
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at)
  }));
}

export async function listTraceDeePosts(database: Database, input: { traceId: string; limit?: number; actorId?: string }): Promise<TraceDeePost[]> {
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 20)));
  const postsResult = await database.client
    .from("tracedee_posts")
    .select("id,author_id,trace_id,place_id,body,status,created_at,updated_at")
    .eq("trace_id", input.traceId)
    .in("status", ["VISIBLE", "LIMITED"])
    .order("created_at", { ascending: false })
    .limit(limit);
  throwDatabaseError(postsResult.error, "TraceDee posts lookup");
  const suppressedActorIds = await getTraceDeeSuppressedActorIds(database, input.actorId);
  const rows = ((postsResult.data ?? []) as unknown as Row[]).filter((row) => !suppressedActorIds.has(stringValue(row.author_id)));
  if (rows.length === 0) return [];

  const postIds = rows.map((row) => stringValue(row.id)).filter(Boolean);
  const [threadsResult, profilesResult] = await Promise.all([
    database.client.from("tracedee_comment_threads").select("id,post_id").in("post_id", postIds),
    database.client.from("user_profiles").select("id,email,display_name").in("id", [...new Set(rows.map((row) => stringValue(row.author_id)).filter(Boolean))])
  ]);
  throwDatabaseError(threadsResult.error, "TraceDee post threads lookup");
  throwDatabaseError(profilesResult.error, "TraceDee post authors lookup");

  const threadRows = (threadsResult.data ?? []) as unknown as Row[];
  const threadIds = threadRows.map((row) => stringValue(row.id)).filter(Boolean);
  const commentsResult = threadIds.length > 0
    ? await database.client
      .from("tracedee_comments")
      .select("thread_id")
      .in("thread_id", threadIds)
      .in("status", ["VISIBLE", "LIMITED"])
    : { data: [], error: null };
  throwDatabaseError(commentsResult.error, "TraceDee post comment counts lookup");

  const threadByPost = new Map(threadRows.map((row) => [stringValue(row.post_id), stringValue(row.id)]));
  const commentCounts = new Map<string, number>();
  for (const row of (commentsResult.data ?? []) as unknown as Row[]) {
    const threadId = stringValue(row.thread_id);
    commentCounts.set(threadId, (commentCounts.get(threadId) ?? 0) + 1);
  }
  const profiles = new Map(((profilesResult.data ?? []) as unknown as Row[]).map((row) => [
    stringValue(row.id),
    stringValue(row.display_name).trim() || stringValue(row.email).trim() || "Aevo member"
  ]));

  return rows.map((row) => {
    const postId = stringValue(row.id);
    const threadId = threadByPost.get(postId) ?? "";
    const status = stringValue(row.status, "VISIBLE");
    return {
      postId,
      threadId,
      authorId: stringValue(row.author_id),
      authorName: profiles.get(stringValue(row.author_id)) ?? "Aevo member",
      traceId: nullableString(row.trace_id),
      placeId: nullableString(row.place_id),
      status: status === "LIMITED" ? "LIMITED" : "VISIBLE",
      body: stringValue(row.body),
      commentCount: commentCounts.get(threadId) ?? 0,
      createdAt: stringValue(row.created_at),
      updatedAt: stringValue(row.updated_at)
    };
  });
}

export async function setTraceDeeCommentHelpful(
  database: Database,
  input: {
    actorId: string;
    commentId: string;
    active: boolean;
    idempotencyKey: string;
    requestHash: string;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeeHelpfulResult> {
  const result = await database.client.rpc("tracedee_set_comment_helpful", {
    p_actor_id: input.actorId,
    p_comment_id: input.commentId,
    p_active: input.active,
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee helpful reaction");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid helpful response");
  return {
    ok: true,
    commentId: stringValue(result.data.commentId ?? result.data.comment_id),
    active: result.data.active === true,
    helpfulCount: numberValue(result.data.helpfulCount ?? result.data.helpful_count),
    changed: result.data.changed === true,
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

export async function reportTraceDeeContent(
  database: Database,
  input: {
    actorId: string;
    entityType: "TRACE" | "PLACE" | "POST" | "COMMENT" | "PROFILE";
    entityId: string;
    reason: string;
    details?: string;
    idempotencyKey: string;
    requestHash: string;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeeReportResult> {
  const result = await database.client.rpc("tracedee_report_content", {
    p_actor_id: input.actorId,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId,
    p_reason: input.reason,
    p_details: input.details ?? "",
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee content report");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid report response");
  const status = stringValue(result.data.status, "OPEN");
  return {
    ok: true,
    reportId: stringValue(result.data.reportId ?? result.data.report_id),
    entityType: stringValue(result.data.entityType ?? result.data.entity_type) as TraceDeeReportResult["entityType"],
    entityId: stringValue(result.data.entityId ?? result.data.entity_id),
    status: status === "REVIEWING" || status === "RESOLVED" || status === "DISMISSED" ? status : "OPEN",
    changed: result.data.changed === true,
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

function moderationEntityType(value: unknown): TraceDeeModerationQueueItem["entityType"] {
  const candidate = stringValue(value).toUpperCase();
  return candidate === "PLACE" || candidate === "POST" || candidate === "COMMENT" || candidate === "PROFILE" ? candidate : "TRACE";
}

function moderationAction(value: unknown): TraceDeeModerationAction {
  const candidate = stringValue(value).toUpperCase();
  if (candidate === "LIMIT" || candidate === "REMOVE" || candidate === "RESTORE" || candidate === "DISMISS") return candidate;
  return "REVIEW";
}

export async function listTraceDeeModerationQueue(
  database: Database,
  input: { status?: "OPEN" | "REVIEWING" | "RESOLVED" | "DISMISSED"; limit?: number; beforeCreatedAt?: string; beforeId?: string } = {}
): Promise<TraceDeeModerationQueueItem[]> {
  const result = await database.client.rpc("tracedee_list_moderation_queue", {
    p_status: input.status ?? "OPEN",
    p_limit: input.limit ?? 50,
    p_before_created_at: input.beforeCreatedAt ?? null,
    p_before_id: input.beforeId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee moderation queue lookup");
  const rows = Array.isArray(result.data) ? result.data.filter(isRecord) : [];
  return rows.map((row) => {
    const resolution = row.resolution_code ? moderationAction(row.resolution_code) : null;
    const reportStatus = stringValue(row.report_status, "OPEN");
    return {
      reportId: stringValue(row.report_id),
      entityType: moderationEntityType(row.entity_type),
      entityId: stringValue(row.entity_id),
      reporterId: stringValue(row.reporter_id),
      reporterName: stringValue(row.reporter_name, "Aevo member"),
      reason: stringValue(row.reason),
      details: stringValue(row.details),
      reportStatus: reportStatus === "REVIEWING" || reportStatus === "RESOLVED" || reportStatus === "DISMISSED" ? reportStatus : "OPEN",
      evidenceSnapshot: jsonObject(row.evidence_snapshot),
      currentSnapshot: jsonObject(row.current_snapshot),
      reviewedBy: nullableString(row.reviewed_by),
      reviewedAt: nullableString(row.reviewed_at),
      resolutionCode: resolution,
      resolutionNote: stringValue(row.resolution_note),
      createdAt: stringValue(row.created_at)
    };
  });
}

export async function moderateTraceDeeReport(
  database: Database,
  input: {
    actorId: string;
    reportId: string;
    action: TraceDeeModerationAction;
    reason: string;
    idempotencyKey: string;
    requestHash: string;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeeModerationResult> {
  const result = await database.client.rpc("tracedee_moderate_report", {
    p_actor_id: input.actorId,
    p_report_id: input.reportId,
    p_action: input.action,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_source: input.source ?? "aevo-admin",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee moderation action");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid moderation response");
  const reportStatus = stringValue(result.data.reportStatus ?? result.data.report_status, "REVIEWING");
  const contentStatusValue = stringValue(result.data.contentStatus ?? result.data.content_status);
  return {
    ok: true,
    reportId: stringValue(result.data.reportId ?? result.data.report_id),
    entityType: moderationEntityType(result.data.entityType ?? result.data.entity_type),
    entityId: stringValue(result.data.entityId ?? result.data.entity_id),
    action: moderationAction(result.data.action),
    reportStatus: reportStatus === "RESOLVED" || reportStatus === "DISMISSED" ? reportStatus : "REVIEWING",
    contentStatus: contentStatusValue === "LIMITED" || contentStatusValue === "REMOVED" ? contentStatusValue : contentStatusValue === "VISIBLE" ? "VISIBLE" : null,
    auditId: stringValue(result.data.auditId ?? result.data.audit_id),
    changed: result.data.changed === true,
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

export async function setTraceDeeUserRelation(
  database: Database,
  input: {
    actorId: string;
    targetId: string;
    relation: TraceDeeUserRelation;
    active: boolean;
    idempotencyKey: string;
    requestHash: string;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeeUserRelationResult> {
  const result = await database.client.rpc("tracedee_set_user_relation", {
    p_actor_id: input.actorId,
    p_target_id: input.targetId,
    p_relation: input.relation,
    p_active: input.active,
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee user relation");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid user relation response");
  const relation = stringValue(result.data.relation).toUpperCase();
  return {
    ok: true,
    targetId: stringValue(result.data.targetId ?? result.data.target_id),
    relation: relation === "MUTE" ? "MUTE" : "BLOCK",
    active: result.data.active === true,
    changed: result.data.changed === true,
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

export async function listTraceDeeNotifications(
  database: Database,
  input: { actorId: string; limit?: number; unreadOnly?: boolean }
): Promise<TraceDeeNotification[]> {
  const result = await database.client.rpc("tracedee_list_notifications", {
    p_actor_id: input.actorId,
    p_limit: input.limit ?? 30,
    p_unread_only: input.unreadOnly ?? false
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee notification lookup");
  const rows = Array.isArray(result.data) ? result.data.filter(isRecord) : [];
  return rows.map((row) => ({
    id: stringValue(row.id),
    eventType: stringValue(row.event_type),
    entityType: stringValue(row.entity_type),
    entityId: nullableString(row.entity_id),
    actorId: nullableString(row.actor_id),
    lastActorId: nullableString(row.last_actor_id),
    payload: jsonObject(row.payload),
    aggregationCount: Math.max(1, numberValue(row.aggregation_count, 1)),
    readAt: nullableString(row.read_at),
    createdAt: stringValue(row.created_at)
  }));
}

export async function markTraceDeeNotificationRead(
  database: Database,
  input: {
    actorId: string;
    notificationId: string;
    read: boolean;
    idempotencyKey: string;
    requestHash: string;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeeNotificationReadResult> {
  const result = await database.client.rpc("tracedee_mark_notification_read", {
    p_actor_id: input.actorId,
    p_notification_id: input.notificationId,
    p_read: input.read,
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee notification read state");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid notification response");
  return {
    ok: true,
    notificationId: stringValue(result.data.notificationId ?? result.data.notification_id),
    read: result.data.read === true,
    changed: result.data.changed === true
  };
}

function contentMutationStatus(value: unknown): TraceDeeContentMutationResult["status"] {
  const status = stringValue(value, "VISIBLE");
  return status === "LIMITED" || status === "UNDER_REVIEW" || status === "REMOVED" ? status : "VISIBLE";
}

export async function editTraceDeeContent(
  database: Database,
  input: {
    actorId: string;
    entityType: "POST" | "COMMENT";
    entityId: string;
    body: string;
    expectedUpdatedAt?: string;
    idempotencyKey: string;
    requestHash: string;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeeContentMutationResult> {
  const result = await database.client.rpc("tracedee_edit_content", {
    p_actor_id: input.actorId,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId,
    p_body: input.body,
    p_expected_updated_at: input.expectedUpdatedAt ?? null,
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee content edit");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid content edit response");
  return {
    ok: true,
    entityType: stringValue(result.data.entityType ?? result.data.entity_type) === "COMMENT" ? "COMMENT" : "POST",
    entityId: stringValue(result.data.entityId ?? result.data.entity_id),
    status: contentMutationStatus(result.data.status),
    body: stringValue(result.data.body),
    editedAt: nullableString(result.data.editedAt ?? result.data.edited_at),
    changed: result.data.changed === true,
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

export async function deleteTraceDeeContent(
  database: Database,
  input: {
    actorId: string;
    entityType: "POST" | "COMMENT";
    entityId: string;
    idempotencyKey: string;
    requestHash: string;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeeContentMutationResult> {
  const result = await database.client.rpc("tracedee_delete_content", {
    p_actor_id: input.actorId,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId,
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee content deletion");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid content deletion response");
  return {
    ok: true,
    entityType: stringValue(result.data.entityType ?? result.data.entity_type) === "COMMENT" ? "COMMENT" : "POST",
    entityId: stringValue(result.data.entityId ?? result.data.entity_id),
    status: "REMOVED",
    changed: result.data.changed === true,
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

export async function listTraceDeeFeatureFlags(database: Database): Promise<Record<string, { enabled: boolean; rolloutPercent: number; config: Record<string, unknown> }>> {
  const result = await database.client
    .from("tracedee_feature_flags")
    .select("flag_key,enabled,rollout_percent,config")
    .order("flag_key", { ascending: true });
  throwDatabaseError(result.error, "TraceDee feature flag lookup");
  return Object.fromEntries(((result.data ?? []) as unknown as Row[]).map((row) => [
    stringValue(row.flag_key),
    {
      enabled: row.enabled === true,
      rolloutPercent: numberValue(row.rollout_percent),
      config: jsonObject(row.config)
    }
  ]));
}

export interface TraceDeeFeatureFlagRecord {
  flagKey: string;
  enabled: boolean;
  rolloutPercent: number;
  config: Record<string, unknown>;
}

export async function updateTraceDeeFeatureFlag(
  database: Database,
  input: { flagKey: string; enabled: boolean; rolloutPercent: number; config?: Record<string, unknown> }
): Promise<TraceDeeFeatureFlagRecord> {
  const result = await database.client
    .from("tracedee_feature_flags")
    .update({
      enabled: input.enabled,
      rollout_percent: Math.min(Math.max(Math.trunc(input.rolloutPercent), 0), 100),
      ...(input.config ? { config: input.config } : {}),
      updated_at: new Date().toISOString()
    })
    .eq("flag_key", input.flagKey)
    .select("flag_key,enabled,rollout_percent,config")
    .single();

  if (result.error || !result.data) {
    return throwDatabaseError(result.error ?? new Error("TraceDee feature flag was not found"), "TraceDee feature flag update");
  }

  const row = result.data as unknown as Row;
  return {
    flagKey: stringValue(row.flag_key),
    enabled: row.enabled === true,
    rolloutPercent: numberValue(row.rollout_percent),
    config: jsonObject(row.config)
  };
}

export interface TraceDeeProjectionRebuildResult {
  ok: true;
  runId: string;
  scoreVersion: number;
  profileCount: number;
  expertiseCount: number;
  tasteCount: number;
  qualityCount: number;
  calculatedAt: string;
  reason: string;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export async function rebuildTraceDeeProjections(database: Database, reason = "scheduled"): Promise<TraceDeeProjectionRebuildResult> {
  const result = await database.client.rpc("tracedee_rebuild_projections_with_run", { p_reason: reason });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee projection rebuild");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid projection response");
  return {
    ok: true,
    runId: stringValue(result.data.runId ?? result.data.run_id),
    scoreVersion: numberValue(result.data.scoreVersion ?? result.data.score_version, 1),
    profileCount: numberValue(result.data.profileCount ?? result.data.profile_count),
    expertiseCount: numberValue(result.data.expertiseCount ?? result.data.expertise_count),
    tasteCount: numberValue(result.data.tasteCount ?? result.data.taste_count),
    qualityCount: numberValue(result.data.qualityCount ?? result.data.quality_count),
    calculatedAt: stringValue(result.data.calculatedAt ?? result.data.calculated_at),
    reason: stringValue(result.data.reason, reason),
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

export interface TraceDeeProjectionRun {
  runId: string;
  scoreVersion: number;
  status: "APPLYING" | "APPLIED" | "ROLLED_BACK" | "FAILED";
  reason: string;
  profileCount: number;
  expertiseCount: number;
  tasteCount: number;
  qualityCount: number;
  failureReason: string;
  rollbackReason: string;
  createdAt: string;
  appliedAt: string | null;
  rolledBackAt: string | null;
}

function projectionRunStatus(value: unknown): TraceDeeProjectionRun["status"] {
  const status = stringValue(value, "FAILED");
  return status === "APPLYING" || status === "APPLIED" || status === "ROLLED_BACK" ? status : "FAILED";
}

export async function listTraceDeeProjectionRuns(database: Database, limit = 20): Promise<TraceDeeProjectionRun[]> {
  const result = await database.client.rpc("tracedee_list_projection_runs", { p_limit: limit });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee projection run lookup");
  const rows = Array.isArray(result.data) ? result.data.filter(isRecord) : [];
  return rows.map((row) => ({
    runId: stringValue(row.run_id),
    scoreVersion: numberValue(row.score_version, 1),
    status: projectionRunStatus(row.status),
    reason: stringValue(row.reason),
    profileCount: numberValue(row.profile_count),
    expertiseCount: numberValue(row.expertise_count),
    tasteCount: numberValue(row.taste_count),
    qualityCount: numberValue(row.quality_count),
    failureReason: stringValue(row.failure_reason),
    rollbackReason: stringValue(row.rollback_reason),
    createdAt: stringValue(row.created_at),
    appliedAt: nullableString(row.applied_at),
    rolledBackAt: nullableString(row.rolled_back_at)
  }));
}

export interface TraceDeeProjectionRollbackResult {
  ok: true;
  runId: string;
  scoreVersion: number;
  status: "ROLLED_BACK";
  changed: boolean;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export async function rollbackTraceDeeProjection(
  database: Database,
  input: { actorId: string; runId: string; reason: string; idempotencyKey: string; requestHash: string; source?: string; sessionId?: string }
): Promise<TraceDeeProjectionRollbackResult> {
  const result = await database.client.rpc("tracedee_rollback_projection", {
    p_actor_id: input.actorId,
    p_run_id: input.runId,
    p_reason: input.reason,
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_source: input.source ?? "aevo-admin",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee projection rollback");
  if (!isRecord(result.data)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid rollback response");
  return {
    ok: true,
    runId: stringValue(result.data.runId ?? result.data.run_id),
    scoreVersion: numberValue(result.data.scoreVersion ?? result.data.score_version, 1),
    status: "ROLLED_BACK",
    changed: result.data.changed === true,
    eventId: nullableString(result.data.eventId ?? result.data.event_id),
    correlationId: stringValue(result.data.correlationId ?? result.data.correlation_id),
    trackingToken: stringValue(result.data.trackingToken ?? result.data.tracking_token)
  };
}

export async function getTraceDeeProfileExpertise(database: Database, profileId: string): Promise<TraceDeeProfileExpertise> {
  const flagResult = await database.client
    .from("tracedee_feature_flags")
    .select("enabled")
    .eq("flag_key", "expertise_v1")
    .maybeSingle();
  throwDatabaseError(flagResult.error, "TraceDee expertise flag lookup");
  if (flagResult.data?.enabled !== true) {
    return { enabled: false, profileId, scoreVersion: 1, expertise: 0, confidence: 0, topics: [], calculatedAt: null };
  }

  const [profileResult, topicsResult] = await Promise.all([
    database.client
      .from("tracedee_profile_scores")
      .select("profile_id,score_version,expertise,confidence,calculated_at")
      .eq("profile_id", profileId)
      .order("score_version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    database.client
      .from("tracedee_expertise_scores")
      .select("topic,score,evidence_count,confidence,score_version")
      .eq("profile_id", profileId)
      .order("score", { ascending: false })
      .limit(24)
  ]);
  throwDatabaseError(profileResult.error, "TraceDee profile expertise lookup");
  throwDatabaseError(topicsResult.error, "TraceDee expertise topics lookup");
  const profile = profileResult.data as unknown as Row | null;
  const topics: TraceDeeExpertiseItem[] = ((topicsResult.data ?? []) as unknown as Row[]).map((row) => ({
    topic: stringValue(row.topic),
    score: numberValue(row.score),
    evidenceCount: numberValue(row.evidence_count),
    confidence: numberValue(row.confidence)
  }));
  return {
    enabled: true,
    profileId,
    scoreVersion: numberValue(profile?.score_version, numberValue((topicsResult.data?.[0] as unknown as Row | undefined)?.score_version, 1)),
    expertise: numberValue(profile?.expertise),
    confidence: numberValue(profile?.confidence),
    topics,
    calculatedAt: nullableString(profile?.calculated_at)
  };
}

export async function listTraceDeeReputationEvidence(
  database: Database,
  input: { profileId?: string; limit?: number } = {}
): Promise<TraceDeeReputationEvidence[]> {
  const result = await database.client.rpc("tracedee_list_reputation_evidence", {
    p_profile_id: input.profileId ?? null,
    p_limit: Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)))
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee reputation evidence lookup");
  const rows = Array.isArray(result.data) ? result.data.filter(isRecord) : [];
  return rows.map((row) => ({
    profileId: stringValue(row.profile_id),
    profileName: stringValue(row.profile_name, "Aevo member"),
    scoreVersion: numberValue(row.score_version, 1),
    reputation: numberValue(row.reputation),
    helpfulRatio: numberValue(row.helpful_ratio),
    downstreamCompletionRate: numberValue(row.downstream_completion_rate),
    ratingConfidence: numberValue(row.rating_confidence),
    reportOutcome: numberValue(row.report_outcome),
    accountTrust: numberValue(row.account_trust),
    evidenceCount: numberValue(row.evidence_count),
    components: jsonObject(row.components),
    calculatedAt: stringValue(row.calculated_at)
  }));
}

function mapJourneySummary(value: unknown): TraceDeeJourneySummary {
  if (!isRecord(value)) throw new TraceDeeError("INVALID_RESPONSE", "TraceDee returned an invalid journey response");
  const status = stringValue(value.status, "PLANNED");
  const validStatuses = new Set(["PLANNED", "ACTIVE", "PAUSED", "COMPLETED", "ABANDONED"]);
  const verificationStatus = stringValue(value.verificationStatus ?? value.verification_status);
  const validVerificationStatuses = new Set(["SELF_REPORTED", "PARTIAL", "VERIFIED", "REJECTED"]);
  return {
    ok: true,
    journeyId: stringValue(value.journeyId ?? value.journey_id),
    traceId: stringValue(value.traceId ?? value.trace_id),
    traceSlug: stringValue(value.traceSlug ?? value.trace_slug),
    status: validStatuses.has(status) ? status as TraceDeeJourneySummary["status"] : "PLANNED",
    version: numberValue(value.version, 1),
    traceRevision: numberValue(value.traceRevision ?? value.trace_revision, 1),
    stopCount: numberValue(value.stopCount ?? value.stop_count),
    completedStopCount: numberValue(value.completedStopCount ?? value.completed_stop_count),
    skippedStopCount: numberValue(value.skippedStopCount ?? value.skipped_stop_count),
    pendingStopCount: numberValue(value.pendingStopCount ?? value.pending_stop_count),
    completionId: nullableString(value.completionId ?? value.completion_id),
    changed: value.changed === true,
    eventId: nullableString(value.eventId ?? value.event_id),
    correlationId: stringValue(value.correlationId ?? value.correlation_id),
    trackingToken: nullableString(value.trackingToken ?? value.tracking_token),
    verificationStatus: validVerificationStatuses.has(verificationStatus)
      ? verificationStatus as TraceDeeCompletionVerificationStatus
      : null,
    verificationSummary: isRecord(value.verificationSummary ?? value.verification_summary)
      ? jsonObject(value.verificationSummary ?? value.verification_summary)
      : null,
    verificationEventId: nullableString(value.verificationEventId ?? value.verification_event_id),
    verificationTrackingToken: nullableString(value.verificationTrackingToken ?? value.verification_tracking_token)
  };
}

export async function createTraceDeeJourney(
  database: Database,
  input: { actorId: string; traceId: string; idempotencyKey: string; requestHash: string; source?: string; sessionId?: string }
): Promise<TraceDeeJourneySummary> {
  const result = await database.client.rpc("tracedee_create_journey", {
    p_actor_id: input.actorId,
    p_trace_id: input.traceId,
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee journey creation");
  return mapJourneySummary(result.data);
}

export async function applyTraceDeeJourneyAction(
  database: Database,
  input: {
    actorId: string;
    journeyId: string;
    action: TraceDeeJourneyAction;
    idempotencyKey: string;
    requestHash: string;
    stopId?: string;
    stopStatus?: "COMPLETED" | "SKIPPED";
    expectedVersion?: number;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeeJourneySummary> {
  const result = await database.client.rpc("tracedee_journey_action", {
    p_actor_id: input.actorId,
    p_journey_id: input.journeyId,
    p_action: input.action.toUpperCase(),
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_stop_id: input.stopId ?? null,
    p_stop_status: input.stopStatus ?? null,
    p_expected_version: input.expectedVersion ?? null,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee journey action");
  return mapJourneySummary(result.data);
}

export async function completeTraceDeeJourney(
  database: Database,
  input: {
    actorId: string;
    journeyId: string;
    idempotencyKey: string;
    requestHash: string;
    clientStartedAt?: string;
    clientCompletedAt?: string;
    locationPermission?: boolean;
    coarseLatitude?: number;
    coarseLongitude?: number;
    source?: string;
    sessionId?: string;
  }
): Promise<TraceDeeJourneySummary> {
  const result = await database.client.rpc("tracedee_complete_journey", {
    p_actor_id: input.actorId,
    p_journey_id: input.journeyId,
    p_idempotency_key: input.idempotencyKey,
    p_request_hash: input.requestHash,
    p_client_started_at: input.clientStartedAt ?? null,
    p_client_completed_at: input.clientCompletedAt ?? null,
    p_location_permission: input.locationPermission ?? false,
    p_coarse_latitude: input.coarseLatitude ?? null,
    p_coarse_longitude: input.coarseLongitude ?? null,
    p_source: input.source ?? "aevo-go",
    p_session_id: input.sessionId ?? null
  });
  if (result.error) throwTraceDeeRpcError(result.error, "TraceDee journey completion verification");
  return mapJourneySummary(result.data);
}

export async function getTraceDeeJourney(database: Database, journeyId: string, actorId: string): Promise<TraceDeeJourneyDetail | null> {
  const journeyResult = await database.client
    .from("tracedee_journeys")
    .select("id,user_id,trace_id,trace_revision,status,version,started_at,completed_at,created_at,updated_at")
    .eq("id", journeyId)
    .eq("user_id", actorId)
    .maybeSingle();
  throwDatabaseError(journeyResult.error, "TraceDee journey lookup");
  if (!journeyResult.data) return null;
  const journey = journeyResult.data as unknown as Row;
  const traceId = stringValue(journey.trace_id);
  const [traceResult, stopsResult, completionResult] = await Promise.all([
    database.client.from("tracedee_traces").select("id,slug").eq("id", traceId).maybeSingle(),
    database.client.from("tracedee_journey_stops").select("id,trace_stop_id,position,status,version,completed_at").eq("journey_id", journeyId).order("position", { ascending: true }),
    database.client.from("tracedee_completions").select("id,verification_status,verification_summary").eq("journey_id", journeyId).maybeSingle()
  ]);
  throwDatabaseError(traceResult.error, "TraceDee journey trace lookup");
  throwDatabaseError(stopsResult.error, "TraceDee journey stops lookup");
  throwDatabaseError(completionResult.error, "TraceDee journey completion lookup");
  if (!traceResult.data) return null;

  const completionId = nullableString((completionResult.data as unknown as Row | null)?.id);
  const completionRow = completionResult.data as unknown as Row | null;
  const ratingResult = completionId
    ? await database.client
      .from("tracedee_trace_ratings")
      .select("id,rating,tags,review,moderation_status,created_at,updated_at")
      .eq("completion_id", completionId)
      .maybeSingle()
    : { data: null, error: null };
  throwDatabaseError(ratingResult.error, "TraceDee journey rating lookup");

  const stopRows = (stopsResult.data ?? []) as unknown as Row[];
  const traceStopIds = [...new Set(stopRows.map((row) => stringValue(row.trace_stop_id)).filter(Boolean))];
  const traceStopsResult = traceStopIds.length > 0
    ? await database.client.from("tracedee_trace_stops").select("id,place_id,note").in("id", traceStopIds)
    : { data: [], error: null };
  throwDatabaseError(traceStopsResult.error, "TraceDee journey trace stop details lookup");
  const traceStopRows = (traceStopsResult.data ?? []) as unknown as Row[];
  const placeIds = [...new Set(traceStopRows.map((row) => stringValue(row.place_id)).filter(Boolean))];
  const placesResult = placeIds.length > 0
    ? await database.client.from("tracedee_places").select("id,slug,name,area,category,description,image_url,latitude,longitude").in("id", placeIds)
    : { data: [], error: null };
  throwDatabaseError(placesResult.error, "TraceDee journey places lookup");
  const placeById = new Map(((placesResult.data ?? []) as unknown as Row[]).map((row) => [stringValue(row.id), mapPlace(row)]));
  const traceStopById = new Map(traceStopRows.map((row) => [stringValue(row.id), row]));
  const stops: ContractJourneyStop[] = stopRows.flatMap((row) => {
    const traceStop = traceStopById.get(stringValue(row.trace_stop_id));
    const place = traceStop ? placeById.get(stringValue(traceStop.place_id)) : undefined;
    if (!traceStop || !place) return [];
    const status = stringValue(row.status, "PENDING");
    return [{
      id: stringValue(row.id),
      traceStopId: stringValue(row.trace_stop_id),
      position: numberValue(row.position),
      status: status === "COMPLETED" || status === "SKIPPED" ? status : "PENDING",
      version: numberValue(row.version, 1),
      completedAt: nullableString(row.completed_at),
      place,
      note: stringValue(traceStop.note)
    }];
  });
  const summaryCounts = {
    stopCount: stops.length,
    completedStopCount: stops.filter((stop) => stop.status === "COMPLETED").length,
    skippedStopCount: stops.filter((stop) => stop.status === "SKIPPED").length,
    pendingStopCount: stops.filter((stop) => stop.status === "PENDING").length
  };
  const trace = traceResult.data as unknown as Row;
  return {
    ok: true,
    journeyId: stringValue(journey.id),
    traceId,
    traceSlug: stringValue(trace.slug),
    status: stringValue(journey.status, "PLANNED") as TraceDeeJourneyDetail["status"],
    version: numberValue(journey.version, 1),
    traceRevision: numberValue(journey.trace_revision, 1),
    ...summaryCounts,
    completionId,
    changed: false,
    eventId: null,
    correlationId: crypto.randomUUID(),
    trackingToken: null,
    verificationStatus: completionRow
      ? (new Set(["SELF_REPORTED", "PARTIAL", "VERIFIED", "REJECTED"]).has(stringValue(completionRow.verification_status))
        ? stringValue(completionRow.verification_status) as TraceDeeCompletionVerificationStatus
        : null)
      : null,
    verificationSummary: completionRow && isRecord(completionRow.verification_summary)
      ? jsonObject(completionRow.verification_summary)
      : null,
    verificationEventId: null,
    verificationTrackingToken: null,
    createdAt: stringValue(journey.created_at),
    updatedAt: stringValue(journey.updated_at),
    startedAt: nullableString(journey.started_at),
    completedAt: nullableString(journey.completed_at),
    rating: ratingResult.data ? mapTraceDeeRatingSummary(ratingResult.data as unknown as Row) : null,
    stops
  };
}

export async function getTraceDeeJourneyForTrace(database: Database, traceIdOrSlug: string, actorId: string): Promise<TraceDeeJourneyDetail | null> {
  const traceResult = isUuid(traceIdOrSlug)
    ? await database.client.from("tracedee_traces").select("id").eq("id", traceIdOrSlug).eq("status", "PUBLISHED").eq("visibility", "PUBLIC").in("moderation_status", ["VISIBLE", "LIMITED"]).maybeSingle()
    : await database.client.from("tracedee_traces").select("id").eq("slug", traceIdOrSlug).eq("status", "PUBLISHED").eq("visibility", "PUBLIC").in("moderation_status", ["VISIBLE", "LIMITED"]).maybeSingle();
  throwDatabaseError(traceResult.error, "TraceDee journey trace resolution");
  if (!traceResult.data) return null;
  const traceId = String((traceResult.data as unknown as Row).id);
  const journeyResult = await database.client
    .from("tracedee_journeys")
    .select("id")
    .eq("trace_id", traceId)
    .eq("user_id", actorId)
    .in("status", ["PLANNED", "ACTIVE", "PAUSED"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  throwDatabaseError(journeyResult.error, "TraceDee active journey lookup");
  if (!journeyResult.data) return null;
  return getTraceDeeJourney(database, String((journeyResult.data as unknown as Row).id), actorId);
}
