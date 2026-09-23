export const tracedeeFeedTabs = ["for_you", "following", "nearby"] as const;
export type TraceDeeFeedTab = (typeof tracedeeFeedTabs)[number];

export const tracedeeTraceActions = ["save", "unsave", "follow", "unfollow"] as const;
export type TraceDeeTraceAction = (typeof tracedeeTraceActions)[number];

export type TraceDeeReasonCode = "FOLLOWING_TRACER" | "TASTE_MATCH" | "POPULAR" | "NEW_TRACE";

export interface TraceDeeFeedItem {
  itemType: "TRACE";
  itemId: string;
  slug: string;
  title: string;
  description: string;
  creatorId: string;
  creatorName: string;
  status: "PUBLISHED";
  visibility: "PUBLIC";
  coverPlaceId: string | null;
  area: string;
  topicTags: string[];
  stopCount: number;
  followerCount: number;
  saveCount: number;
  rankScore: number;
  reasonCode: TraceDeeReasonCode;
  reasonParams: Record<string, unknown>;
  trackingToken: string;
  publishedAt: string;
}

export interface TraceDeeFeedPage {
  items: TraceDeeFeedItem[];
  nextCursor: string | null;
}

export interface TraceDeePlaceSummary {
  id: string;
  slug: string;
  name: string;
  area: string;
  category: string;
  description: string;
  imageUrl: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface TraceDeeTraceStop {
  id: string;
  position: number;
  note: string;
  durationMinutes: number | null;
  transportMode: string | null;
  budgetMinor: number | null;
  place: TraceDeePlaceSummary;
}

export interface TraceDeeTraceDetail extends TraceDeeFeedItem {
  revision: number;
  estimatedMinutes: number | null;
  estimatedBudgetMinor: number | null;
  createdAt: string;
  updatedAt: string;
  saved: boolean;
  followed: boolean;
  tracerFollowing: boolean;
  tracerFollowerCount: number;
  stops: TraceDeeTraceStop[];
}

export interface TraceDeeTracerFollowResult {
  ok: true;
  tracerId: string;
  following: boolean;
  followerCount: number;
  changed: boolean;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export type TraceDeeTraceLifecycleStatus = "DRAFT" | "PUBLISHED" | "UNDER_REVIEW" | "REMOVED" | "ARCHIVED";

export interface TraceDeeLineageNode {
  id: string;
  slug: string;
  title: string;
  creatorId: string;
  status: TraceDeeTraceLifecycleStatus;
  visibility: "PUBLIC" | "UNLISTED" | "PRIVATE";
  revision: number;
  rootTraceId: string | null;
  sourceTraceId: string | null;
  lineageDepth: number;
  publishedAt: string | null;
  createdAt: string;
}

export interface TraceDeeRemixResult {
  ok: true;
  remixTraceId: string;
  remixSlug: string;
  sourceTraceId: string;
  rootTraceId: string;
  remixerId: string;
  lineageDepth: number;
  status: "DRAFT";
  revision: number;
  stopCount: number;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export interface TraceDeeRemixUpdateResult {
  ok: true;
  traceId: string;
  status: "DRAFT";
  revision: number;
  stopCount: number;
  changed: boolean;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export interface TraceDeeRemixPublishResult {
  ok: true;
  traceId: string;
  status: "PUBLISHED";
  revision: number;
  sourceTraceId: string;
  rootTraceId: string;
  lineageDepth: number;
  stopCount: number;
  changed: boolean;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export interface TraceDeeTraceLineage {
  ok: true;
  trace: TraceDeeLineageNode;
  source: TraceDeeLineageNode | null;
  root: TraceDeeLineageNode | null;
  ancestors: TraceDeeLineageNode[];
  descendants: TraceDeeLineageNode[];
}

export type TraceDeeTransportMode = "WALK" | "BIKE" | "TRANSIT" | "CAR" | "RIDE_HAIL" | "OTHER";

export interface TraceDeeRemixStopDraft {
  id: string;
  position: number;
  place: TraceDeePlaceSummary;
  note: string;
  durationMinutes: number | null;
  transportMode: TraceDeeTransportMode | null;
  budgetMinor: number | null;
}

export interface TraceDeeRemixDraft {
  ok: true;
  traceId: string;
  slug: string;
  title: string;
  description: string;
  area: string;
  topicTags: string[];
  estimatedMinutes: number | null;
  estimatedBudgetMinor: number | null;
  status: "DRAFT";
  visibility: "PRIVATE";
  revision: number;
  sourceTraceId: string;
  rootTraceId: string;
  lineageDepth: number;
  stops: TraceDeeRemixStopDraft[];
}

export interface TraceDeePlaceSearchResult {
  places: TraceDeePlaceSummary[];
}

export interface TraceDeeActionResult {
  ok: true;
  traceId: string;
  action: TraceDeeTraceAction;
  saved: boolean;
  followed: boolean;
  changed: boolean;
  stateVersion: number;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export interface TraceDeeActivityEventInput {
  eventType: "feed_item_impressed" | "feed_item_opened";
  entityType: "TRACE" | "PLACE" | "POST" | "TRACER";
  entityId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  trackingToken?: string;
  correlationId?: string;
  dedupeKey?: string;
}

export interface TraceDeeActivityEventResult {
  ok: true;
  eventId: string;
  trackingToken: string;
  correlationId: string;
  deduped: boolean;
}

export type TraceDeeRatingModerationStatus = "VISIBLE" | "LIMITED" | "UNDER_REVIEW" | "REMOVED";

export interface TraceDeeRatingResult {
  ok: true;
  ratingId: string;
  completionId: string;
  journeyId: string;
  traceId: string;
  rating: number;
  tags: string[];
  review: string;
  moderationStatus: TraceDeeRatingModerationStatus;
  changed: boolean;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export interface TraceDeeRatingSummary {
  ratingId: string;
  rating: number;
  tags: string[];
  review: string;
  moderationStatus: TraceDeeRatingModerationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TraceDeePostResult {
  ok: true;
  postId: string;
  threadId: string;
  journeyId: string;
  traceId: string;
  placeId: string | null;
  status: TraceDeeRatingModerationStatus;
  body: string;
  changed: boolean;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export interface TraceDeeCommentResult {
  ok: true;
  commentId: string;
  threadId: string;
  postId: string;
  parentId: string | null;
  depth: number;
  status: TraceDeeRatingModerationStatus;
  body: string;
  changed: boolean;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export interface TraceDeeComment {
  commentId: string;
  threadId: string;
  postId: string;
  authorId: string;
  authorName: string;
  parentId: string | null;
  depth: number;
  status: "VISIBLE" | "LIMITED";
  body: string;
  helpful: boolean;
  helpfulCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TraceDeePost {
  postId: string;
  threadId: string;
  authorId: string;
  authorName: string;
  traceId: string | null;
  placeId: string | null;
  status: "VISIBLE" | "LIMITED";
  body: string;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TraceDeeHelpfulResult {
  ok: true;
  commentId: string;
  active: boolean;
  helpfulCount: number;
  changed: boolean;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export type TraceDeeUserRelation = "BLOCK" | "MUTE";

export interface TraceDeeUserRelationResult {
  ok: true;
  targetId: string;
  relation: TraceDeeUserRelation;
  active: boolean;
  changed: boolean;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export interface TraceDeeNotification {
  id: string;
  eventType: string;
  entityType: string;
  entityId: string | null;
  actorId: string | null;
  lastActorId: string | null;
  payload: Record<string, unknown>;
  aggregationCount: number;
  readAt: string | null;
  createdAt: string;
}

export interface TraceDeeNotificationReadResult {
  ok: true;
  notificationId: string;
  read: boolean;
  changed: boolean;
}

export interface TraceDeeContentMutationResult {
  ok: true;
  entityType: "POST" | "COMMENT";
  entityId: string;
  status: TraceDeeRatingModerationStatus;
  body?: string;
  editedAt?: string | null;
  changed: boolean;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export interface TraceDeeReportResult {
  ok: true;
  reportId: string;
  entityType: "TRACE" | "PLACE" | "POST" | "COMMENT" | "PROFILE";
  entityId: string;
  status: "OPEN" | "REVIEWING" | "RESOLVED" | "DISMISSED";
  changed: boolean;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export type TraceDeeModerationAction = "REVIEW" | "LIMIT" | "REMOVE" | "RESTORE" | "DISMISS";

export interface TraceDeeModerationQueueItem {
  reportId: string;
  entityType: "TRACE" | "PLACE" | "POST" | "COMMENT" | "PROFILE";
  entityId: string;
  reporterId: string;
  reporterName: string;
  reason: string;
  details: string;
  reportStatus: "OPEN" | "REVIEWING" | "RESOLVED" | "DISMISSED";
  evidenceSnapshot: Record<string, unknown>;
  currentSnapshot: Record<string, unknown>;
  reviewedBy: string | null;
  reviewedAt: string | null;
  resolutionCode: TraceDeeModerationAction | null;
  resolutionNote: string;
  createdAt: string;
}

export interface TraceDeeModerationResult {
  ok: true;
  reportId: string;
  entityType: "TRACE" | "PLACE" | "POST" | "COMMENT" | "PROFILE";
  entityId: string;
  action: TraceDeeModerationAction;
  reportStatus: "REVIEWING" | "RESOLVED" | "DISMISSED";
  contentStatus: "VISIBLE" | "LIMITED" | "REMOVED" | null;
  auditId: string;
  changed: boolean;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export interface TraceDeeExpertiseItem {
  topic: string;
  score: number;
  evidenceCount: number;
  confidence: number;
}

export interface TraceDeeProfileExpertise {
  enabled: boolean;
  profileId: string;
  scoreVersion: number;
  expertise: number;
  confidence: number;
  topics: TraceDeeExpertiseItem[];
  calculatedAt: string | null;
}

export interface TraceDeeReputationEvidence {
  profileId: string;
  profileName: string;
  scoreVersion: number;
  reputation: number;
  helpfulRatio: number;
  downstreamCompletionRate: number;
  ratingConfidence: number;
  reportOutcome: number;
  accountTrust: number;
  evidenceCount: number;
  components: Record<string, unknown>;
  calculatedAt: string;
}

export interface TraceDeeProfileInterest {
  dimensionType: "TOPIC" | "AREA" | "CATEGORY";
  dimensionKey: string;
  position: number;
}

export interface TraceDeeProfilePreferences {
  ok: true;
  profileId: string;
  personalizationEnabled: boolean;
  onboardingCompleted: boolean;
  interests: TraceDeeProfileInterest[];
}

export interface TraceDeePreferenceUpdateResult extends TraceDeeProfilePreferences {
  changed: boolean;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export interface TraceDeeFeedInteractionResult {
  ok: true;
  itemType: "TRACE";
  itemId: string;
  interactionType: "OPENED" | "DISMISSED" | "QUICK_BACK";
  changed: boolean;
  eventId: string | null;
  correlationId: string;
  trackingToken: string;
}

export interface TraceDeeRankingGuardrailReport {
  since: string;
  until: string;
  evaluationCount: number;
  personalizedEvaluationCount: number;
  shadowEvaluationCount: number;
  servedItemCount: number;
  creatorConcentration: number;
  categoryDiversity: number;
  hideRate: number;
  quickBackRate: number;
  averageLatencyMs: number;
  guardrails: Record<string, boolean>;
}

export type TraceDeeJourneyStatus = "PLANNED" | "ACTIVE" | "PAUSED" | "COMPLETED" | "ABANDONED";
export type TraceDeeJourneyStopStatus = "PENDING" | "COMPLETED" | "SKIPPED";
export type TraceDeeJourneyAction = "start" | "update_stop" | "pause" | "abandon" | "complete";
export type TraceDeeCompletionVerificationStatus = "SELF_REPORTED" | "PARTIAL" | "VERIFIED" | "REJECTED";

export interface TraceDeeCompletionVerification {
  status: TraceDeeCompletionVerificationStatus;
  summary: Record<string, unknown>;
  eventId: string | null;
  trackingToken: string | null;
}

export interface TraceDeeJourneySummary {
  ok: true;
  journeyId: string;
  traceId: string;
  traceSlug: string;
  status: TraceDeeJourneyStatus;
  version: number;
  traceRevision: number;
  stopCount: number;
  completedStopCount: number;
  skippedStopCount: number;
  pendingStopCount: number;
  completionId: string | null;
  changed: boolean;
  eventId: string | null;
  correlationId: string;
  trackingToken: string | null;
  verificationStatus: TraceDeeCompletionVerificationStatus | null;
  verificationSummary: Record<string, unknown> | null;
  verificationEventId: string | null;
  verificationTrackingToken: string | null;
}

export interface TraceDeeJourneyStop {
  id: string;
  traceStopId: string;
  position: number;
  status: TraceDeeJourneyStopStatus;
  version: number;
  completedAt: string | null;
  place: TraceDeePlaceSummary;
  note: string;
}

export interface TraceDeeJourneyDetail extends TraceDeeJourneySummary {
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  rating: TraceDeeRatingSummary | null;
  stops: TraceDeeJourneyStop[];
}
