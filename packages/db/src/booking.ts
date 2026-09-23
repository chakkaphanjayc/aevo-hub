import type {
  AddWaitlistInput,
  BookableResourceSummary,
  BookableResourceType,
  BookingHoldSummary,
  BookingSlotSummary,
  BookingStatus,
  BookingSummary,
  BookingWaitlistSummary,
  OperatingHourSummary,
  SessionPrincipal,
  VenueAvailabilitySummary,
  VenueSummary,
  WaitlistStatus
} from "@aevo/contracts";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";

type Row = Record<string, unknown>;

export class BookingValidationError extends Error {
  readonly code = "BOOKING_VALIDATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "BookingValidationError";
  }
}

export class BookingConflictError extends Error {
  readonly code = "BOOKING_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "BookingConflictError";
  }
}

function mapVenue(row: Row): VenueSummary {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    storeId: row.store_id ? String(row.store_id) : undefined,
    name: String(row.name),
    slug: String(row.slug),
    description: String(row.description ?? ""),
    address: String(row.address ?? ""),
    timezone: String(row.timezone ?? "Asia/Bangkok"),
    slotDurationMinutes: Number(row.slot_duration_minutes ?? 60),
    status: row.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapResource(row: Row): BookableResourceSummary {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    venueId: String(row.venue_id),
    name: String(row.name),
    resourceType: String(row.resource_type ?? "COURT") as BookableResourceType,
    capacity: Number(row.capacity ?? 1),
    basePriceMinor: Number(row.base_price_minor ?? 0),
    status: (row.status ?? "ACTIVE") as "ACTIVE" | "INACTIVE" | "MAINTENANCE",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapBooking(row: Row): BookingSummary {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    venueId: String(row.venue_id),
    resourceId: String(row.resource_id),
    orderId: row.order_id ? String(row.order_id) : undefined,
    customerName: String(row.customer_name),
    customerPhone: row.customer_phone ? String(row.customer_phone) : undefined,
    customerEmail: row.customer_email ? String(row.customer_email) : undefined,
    startAt: String(row.start_at),
    endAt: String(row.end_at),
    partySize: Number(row.party_size ?? 1),
    status: (row.status ?? "CONFIRMED") as BookingStatus,
    amountMinor: Number(row.amount_minor ?? 0),
    checkinCode: row.checkin_code ? String(row.checkin_code) : undefined,
    checkedInAt: row.checked_in_at ? String(row.checked_in_at) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    publicTrackingToken: row.public_tracking_token ? String(row.public_tracking_token) : undefined,
    slotHoldId: row.slot_hold_id ? String(row.slot_hold_id) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export async function listVenues(
  database: Database,
  principal: SessionPrincipal,
  storeId?: string
): Promise<VenueSummary[]> {
  let query = database.client
    .from("venues")
    .select("id,organization_id,store_id,name,slug,description,address,timezone,slot_duration_minutes,status,created_at,updated_at")
    .eq("organization_id", principal.organizationId);

  if (storeId) {
    query = query.or(`store_id.eq.${storeId},store_id.is.null`);
  }

  const result = await query.order("name", { ascending: true });
  throwDatabaseError(result.error, "list venues");
  if (!result.data) return [];
  return (result.data as Row[]).map(mapVenue);
}

export async function createVenue(
  database: Database,
  principal: SessionPrincipal,
  input: {
    name: string;
    slug: string;
    storeId?: string | undefined;
    description?: string | undefined;
    address?: string | undefined;
    timezone?: string | undefined;
    slotDurationMinutes?: number | undefined;
  }
): Promise<VenueSummary> {
  const result = await database.client
    .from("venues")
    .insert({
      organization_id: principal.organizationId,
      name: input.name.trim(),
      slug: input.slug.trim().toLowerCase(),
      store_id: input.storeId ?? null,
      description: input.description ?? "",
      address: input.address ?? "",
      timezone: input.timezone ?? "Asia/Bangkok",
      slot_duration_minutes: input.slotDurationMinutes ?? 60,
      status: "ACTIVE"
    })
    .select("id,organization_id,store_id,name,slug,description,address,timezone,slot_duration_minutes,status,created_at,updated_at")
    .single();

  throwDatabaseError(result.error, "create venue");
  return mapVenue(result.data as Row);
}

export async function listResources(
  database: Database,
  principal: SessionPrincipal,
  venueId: string
): Promise<BookableResourceSummary[]> {
  const result = await database.client
    .from("bookable_resources")
    .select("id,organization_id,venue_id,name,resource_type,capacity,base_price_minor,status,created_at,updated_at")
    .eq("organization_id", principal.organizationId)
    .eq("venue_id", venueId)
    .order("name", { ascending: true });

  throwDatabaseError(result.error, "list resources");
  if (!result.data) return [];
  return (result.data as Row[]).map(mapResource);
}

export async function createResource(
  database: Database,
  principal: SessionPrincipal,
  input: {
    venueId: string;
    name: string;
    resourceType?: BookableResourceType | undefined;
    capacity?: number | undefined;
    basePriceMinor: number;
  }
): Promise<BookableResourceSummary> {
  const result = await database.client
    .from("bookable_resources")
    .insert({
      organization_id: principal.organizationId,
      venue_id: input.venueId,
      name: input.name.trim(),
      resource_type: input.resourceType ?? "COURT",
      capacity: input.capacity ?? 1,
      base_price_minor: input.basePriceMinor,
      status: "ACTIVE"
    })
    .select("id,organization_id,venue_id,name,resource_type,capacity,base_price_minor,status,created_at,updated_at")
    .single();

  throwDatabaseError(result.error, "create resource");
  return mapResource(result.data as Row);
}

export async function listBookings(
  database: Database,
  principal: SessionPrincipal,
  venueId: string,
  options?: { date?: string | undefined; resourceId?: string | undefined }
): Promise<BookingSummary[]> {
  let query = database.client
    .from("bookings")
    .select(bookingSelect)
    .eq("organization_id", principal.organizationId)
    .eq("venue_id", venueId);

  if (options?.resourceId) {
    query = query.eq("resource_id", options.resourceId);
  }

  if (options?.date) {
    const dayStart = `${options.date}T00:00:00.000Z`;
    const dayEnd = `${options.date}T23:59:59.999Z`;
    query = query.gte("start_at", dayStart).lte("start_at", dayEnd);
  }

  const result = await query.order("start_at", { ascending: true });
  throwDatabaseError(result.error, "list bookings");
  if (!result.data) return [];
  return (result.data as Row[]).map(mapBooking);
}

export function generateCheckinCode(): string {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

const bookingSelect = "id,organization_id,venue_id,resource_id,order_id,customer_name,customer_phone,customer_email,start_at,end_at,party_size,status,amount_minor,checkin_code,checked_in_at,notes,public_tracking_token,slot_hold_id,created_at,updated_at";

function throwBookingError(error: { message: string; code?: string } | null, operation: string): void {
  if (!error) return;
  const message = error.message || `Supabase ${operation} failed`;
  if (error.code === "P0001" || error.code === "40001" || error.code === "23505") {
    if (message === "BOOKING_HOLD_EXPIRED") throw new BookingValidationError("เวลาสำรองหมดอายุแล้ว กรุณาเลือก slot ใหม่");
    throw new BookingConflictError(
      message === "BOOKING_CONFLICT" || message === "BOOKING_HOLD_CONFLICT"
        ? "ช่วงเวลานี้มีผู้จองหรือกำลังถูกสำรองอยู่ กรุณาเลือกช่วงเวลาอื่น"
        : message
    );
  }
  if (error.code === "22023" || error.code === "23503" || error.code === "22P02") {
    throw new BookingValidationError(message);
  }
  throwDatabaseError(error, operation);
}

function mapBookingHold(row: Row): BookingHoldSummary {
  return {
    id: String(row.id),
    venueId: String(row.venue_id),
    resourceId: String(row.resource_id),
    startAt: String(row.start_at),
    endAt: String(row.end_at),
    partySize: Number(row.party_size ?? 1),
    amountMinor: Number(row.amount_minor ?? 0),
    expiresAt: String(row.expires_at),
    serverTime: String(row.server_time ?? new Date().toISOString())
  };
}

function firstRow(data: unknown): Row | undefined {
  if (Array.isArray(data)) return data[0] as Row | undefined;
  return data && typeof data === "object" ? data as Row : undefined;
}

export async function createPublicBooking(
  database: Database,
  input: {
    organizationId: string;
    venueId: string;
    resourceId: string;
    customerName: string;
    customerPhone?: string | undefined;
    customerEmail?: string | undefined;
    startAt: string;
    endAt: string;
    amountMinor?: number | undefined;
    notes?: string | undefined;
  },
  idempotencyKey: string
): Promise<BookingSummary> {
  const normalizedKey = idempotencyKey.trim();
  if (!normalizedKey) throw new BookingValidationError("Idempotency-Key is required for booking confirmation");

  const result = await database.client.rpc("create_booking", {
    p_organization_id: input.organizationId,
    p_venue_id: input.venueId,
    p_resource_id: input.resourceId,
    p_customer_name: input.customerName.trim(),
    p_customer_phone: input.customerPhone?.trim() || null,
    p_customer_email: input.customerEmail?.trim().toLowerCase() || null,
    p_start_at: input.startAt,
    p_end_at: input.endAt,
    p_requested_amount_minor: input.amountMinor ?? null,
    p_notes: input.notes?.trim() || null,
    p_idempotency_key: normalizedKey,
    p_created_by: null
  });
  throwBookingError(result.error, "public booking creation");

  const row = firstRow(result.data);
  const bookingId = row?.booking_id ? String(row.booking_id) : "";
  if (!bookingId) throw new Error("Supabase public booking creation returned no booking");

  const bookingResult = await database.client
    .from("bookings")
    .select(bookingSelect)
    .eq("organization_id", input.organizationId)
    .eq("id", bookingId)
    .single();
  throwBookingError(bookingResult.error, "public booking lookup");
  return mapBooking(bookingResult.data as Row);
}

export async function createPublicBookingSlotHold(
  database: Database,
  input: {
    organizationId: string;
    venueId: string;
    resourceId: string;
    startAt: string;
    endAt: string;
    partySize: number;
    amountMinor?: number | undefined;
  },
  idempotencyKey: string
): Promise<BookingHoldSummary> {
  const normalizedKey = idempotencyKey.trim();
  if (!normalizedKey) throw new BookingValidationError("Idempotency-Key is required for a booking hold");
  const result = await database.client.rpc("create_booking_slot_hold", {
    p_organization_id: input.organizationId,
    p_venue_id: input.venueId,
    p_resource_id: input.resourceId,
    p_start_at: input.startAt,
    p_end_at: input.endAt,
    p_party_size: input.partySize,
    p_requested_amount_minor: input.amountMinor ?? null,
    p_idempotency_key: normalizedKey
  });
  throwBookingError(result.error, "public booking hold creation");
  const row = firstRow(result.data);
  if (!row?.hold_id) throw new Error("Supabase public booking hold creation returned no hold");
  return mapBookingHold({
    id: row.hold_id,
    venue_id: row.venue_id,
    resource_id: row.resource_id,
    start_at: row.start_at,
    end_at: row.end_at,
    party_size: row.party_size,
    amount_minor: row.amount_minor,
    expires_at: row.expires_at,
    server_time: row.server_time
  });
}

export async function confirmPublicBookingSlotHold(
  database: Database,
  input: {
    holdId: string;
    customerName: string;
    customerPhone?: string | undefined;
    customerEmail?: string | undefined;
    notes?: string | undefined;
  },
  idempotencyKey: string
): Promise<BookingSummary> {
  const normalizedKey = idempotencyKey.trim();
  if (!normalizedKey) throw new BookingValidationError("Idempotency-Key is required for booking confirmation");
  const holdResult = await database.client
    .from("booking_slot_holds")
    .select("organization_id")
    .eq("id", input.holdId)
    .single();
  throwBookingError(holdResult.error, "booking hold lookup");
  const organizationId = String((holdResult.data as Row).organization_id);
  const result = await database.client.rpc("confirm_booking_slot_hold", {
    p_hold_id: input.holdId,
    p_customer_name: input.customerName.trim(),
    p_customer_phone: input.customerPhone?.trim() || null,
    p_customer_email: input.customerEmail?.trim().toLowerCase() || null,
    p_notes: input.notes?.trim() || null,
    p_idempotency_key: normalizedKey,
    p_created_by: null
  });
  throwBookingError(result.error, "public booking confirmation");
  const row = firstRow(result.data);
  const bookingId = row?.booking_id ? String(row.booking_id) : "";
  if (!bookingId) throw new Error("Supabase public booking confirmation returned no booking");
  const bookingResult = await database.client
    .from("bookings")
    .select(bookingSelect)
    .eq("organization_id", organizationId)
    .eq("id", bookingId)
    .single();
  throwBookingError(bookingResult.error, "public booking confirmation lookup");
  return mapBooking(bookingResult.data as Row);
}

export async function getPublicBookingByToken(
  database: Database,
  trackingToken: string
): Promise<BookingSummary | null> {
  const normalizedToken = trackingToken.trim();
  if (!normalizedToken) return null;
  const result = await database.client
    .from("bookings")
    .select(bookingSelect)
    .eq("public_tracking_token", normalizedToken)
    .maybeSingle();
  throwBookingError(result.error, "public booking tracking lookup");
  return result.data ? mapBooking(result.data as Row) : null;
}

export async function createBooking(
  database: Database,
  principal: SessionPrincipal,
  input: {
    venueId: string;
    resourceId: string;
    customerName: string;
    customerPhone?: string | undefined;
    customerEmail?: string | undefined;
    startAt: string;
    endAt: string;
    amountMinor: number;
    partySize?: number | undefined;
    notes?: string | undefined;
    orderId?: string | undefined;
  }
): Promise<BookingSummary> {
  // Check for overlapping active bookings on this resource
  const existingBookings = await database.client
    .from("bookings")
    .select("id,start_at,end_at,status")
    .eq("organization_id", principal.organizationId)
    .eq("resource_id", input.resourceId)
    .in("status", ["HELD", "CONFIRMED", "CHECKED_IN"])
    .lt("start_at", input.endAt)
    .gt("end_at", input.startAt);

  throwDatabaseError(existingBookings.error, "check booking overlap");
  if (existingBookings.data && existingBookings.data.length > 0) {
    throw new BookingConflictError("ช่วงเวลาดังกล่าวมีผู้จองแล้ว กรุณาเลือกช่วงเวลาอื่น");
  }

  const checkinCode = generateCheckinCode();

  const result = await database.client
    .from("bookings")
    .insert({
      organization_id: principal.organizationId,
      venue_id: input.venueId,
      resource_id: input.resourceId,
      order_id: input.orderId ?? null,
      customer_name: input.customerName.trim(),
      customer_phone: input.customerPhone ?? null,
      customer_email: input.customerEmail ?? null,
      start_at: input.startAt,
      end_at: input.endAt,
      party_size: input.partySize ?? 1,
      status: "CONFIRMED",
      amount_minor: input.amountMinor,
      checkin_code: checkinCode,
      notes: input.notes ?? null
    })
    .select(bookingSelect)
    .single();

  throwDatabaseError(result.error, "create booking");
  return mapBooking(result.data as Row);
}

export async function checkinBooking(
  database: Database,
  principal: SessionPrincipal,
  bookingId: string,
  code?: string | undefined
): Promise<BookingSummary> {
  let query = database.client
    .from("bookings")
    .select(bookingSelect)
    .eq("organization_id", principal.organizationId)
    .eq("id", bookingId);

  if (code) {
    query = query.eq("checkin_code", code.trim().toUpperCase());
  }

  const existing = await query.maybeSingle();
  throwDatabaseError(existing.error, "find booking for checkin");
  if (!existing.data) {
    throw new Error("ไม่พบรายการจองหรือรหัส Check-in ไม่ถูกต้อง");
  }

  const now = new Date().toISOString();
  const updateResult = await database.client
    .from("bookings")
    .update({
      status: "CHECKED_IN",
      checked_in_at: now
    })
    .eq("id", bookingId)
    .select(bookingSelect)
    .single();

  throwDatabaseError(updateResult.error, "perform checkin");
  return mapBooking(updateResult.data as Row);
}

export async function getVenueAvailability(
  database: Database,
  principal: SessionPrincipal,
  venueId: string,
  dateStr: string,
  partySize = 1
): Promise<VenueAvailabilitySummary> {
  // Fetch venue
  const venueResult = await database.client
    .from("venues")
    .select("id,name,timezone,slot_duration_minutes")
    .eq("organization_id", principal.organizationId)
    .eq("id", venueId)
    .single();
  throwDatabaseError(venueResult.error, "fetch venue");
  const venue = venueResult.data as Row;

  const timezone = String(venue.timezone ?? "Asia/Bangkok");

  // Fetch active resources
  const resources = await listResources(database, principal, venueId);
  const activeResources = resources.filter((r) => r.status === "ACTIVE");

  // Fetch bookings and unexpired holds. Both are server-authoritative and are
  // intentionally read through the trusted Gateway client only.
  const bookings = await listBookings(database, principal, venueId);
  const now = new Date();
  const holdResult = await database.client
    .from("booking_slot_holds")
    .select("resource_id,start_at,end_at,status,expires_at")
    .eq("organization_id", principal.organizationId)
    .eq("venue_id", venueId)
    .eq("status", "HELD")
    .gt("expires_at", now.toISOString());
  throwDatabaseError(holdResult.error, "fetch booking holds");
  const holds = (holdResult.data ?? []) as Row[];

  const operatingHourResult = await database.client
    .from("operating_hours")
    .select("day_of_week,open_time,close_time,enabled")
    .eq("organization_id", principal.organizationId)
    .eq("venue_id", venueId)
    .eq("day_of_week", new Date(`${dateStr}T00:00:00.000Z`).getUTCDay())
    .maybeSingle();
  throwDatabaseError(operatingHourResult.error, "fetch venue operating hours");

  const slotMinutes = Number(venue.slot_duration_minutes ?? 60);
  const slots: BookingSlotSummary[] = [];

  const configuredHours = operatingHourResult.data as Row | null;
  const isClosed = configuredHours && configuredHours.enabled === false;
  const parseTime = (value: unknown, fallback: number): number => {
    if (typeof value !== "string") return fallback;
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    if (!match) return fallback;
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const openMinute = configuredHours ? parseTime(configuredHours.open_time, 8 * 60) : 8 * 60;
  const closeMinute = configuredHours ? parseTime(configuredHours.close_time, 22 * 60) : 22 * 60;

  const localDateTimeToUtc = (localTime: string): string => {
    const match = /^(\d{2}):(\d{2})$/.exec(localTime);
    if (!match) return `${dateStr}T00:00:00.000Z`;
    const [year, month, day] = dateStr.split("-").map(Number);
    const targetUtc = Date.UTC(year, month - 1, day, Number(match[1]), Number(match[2]), 0, 0);
    let guess = new Date(targetUtc);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      }).formatToParts(guess);
      const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
      const displayedUtc = Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day), Number(value.hour), Number(value.minute), Number(value.second));
      guess = new Date(guess.getTime() + (targetUtc - displayedUtc));
    }
    return guess.toISOString();
  };

  for (const resource of activeResources) {
    let currentTotalMin = openMinute;

    while (!isClosed && currentTotalMin + slotMinutes <= closeMinute) {
      const nextTotalMin = currentTotalMin + slotMinutes;
      const currentHour = Math.floor(currentTotalMin / 60);
      const currentMin = currentTotalMin % 60;
      const nextHour = Math.floor(nextTotalMin / 60);
      const nextMin = nextTotalMin % 60;

      const pad = (n: number) => String(n).padStart(2, "0");
      const localStart = `${pad(currentHour)}:${pad(currentMin)}`;
      const localEnd = `${pad(nextHour)}:${pad(nextMin)}`;

      const startIso = localDateTimeToUtc(localStart);
      const endIso = localDateTimeToUtc(localEnd);

      const isBooked = bookings.some(
        (b) =>
          b.resourceId === resource.id &&
          ["HELD", "CONFIRMED", "CHECKED_IN"].includes(b.status) &&
          new Date(b.startAt).getTime() < new Date(endIso).getTime() &&
          new Date(b.endAt).getTime() > new Date(startIso).getTime()
      );
      const isHeld = holds.some(
        (hold) =>
          String(hold.resource_id) === resource.id &&
          new Date(String(hold.start_at)).getTime() < new Date(endIso).getTime() &&
          new Date(String(hold.end_at)).getTime() > new Date(startIso).getTime()
      );
      const isPast = new Date(startIso).getTime() <= now.getTime();
      const exceedsCapacity = partySize > resource.capacity;
      const unavailableReason = isPast ? "PAST" as const : isBooked ? "BOOKED" as const : isHeld ? "BOOKED" as const : exceedsCapacity ? "BLOCKED" as const : undefined;

      slots.push({
        id: `${resource.id}-${localStart}`,
        venueId,
        resourceId: resource.id,
        startAt: startIso,
        endAt: endIso,
        localStartTime: localStart,
        localEndTime: localEnd,
        priceMinor: resource.basePriceMinor,
        available: unavailableReason === undefined,
        ...(unavailableReason ? { reason: unavailableReason } : {})
      });

      currentTotalMin = nextTotalMin;
    }
  }

  return {
    venueId,
    date: dateStr,
    timezone,
    slotDurationMinutes: slotMinutes,
    slots
  };
}

function mapWaitlist(row: Row): BookingWaitlistSummary {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    venueId: String(row.venue_id),
    resourceId: row.resource_id ? String(row.resource_id) : undefined,
    customerName: String(row.customer_name),
    customerPhone: row.customer_phone ? String(row.customer_phone) : undefined,
    partySize: Number(row.party_size ?? 1),
    status: (row.status ?? "WAITING") as WaitlistStatus,
    position: Number(row.position ?? 1),
    estimatedWaitMinutes: row.estimated_wait_minutes ? Number(row.estimated_wait_minutes) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export async function listWaitlists(
  database: Database,
  principal: SessionPrincipal,
  venueId: string,
  options: { status?: WaitlistStatus | undefined } = {}
): Promise<BookingWaitlistSummary[]> {
  let query = database.client
    .from("booking_waitlists")
    .select("*")
    .eq("organization_id", principal.organizationId)
    .eq("venue_id", venueId)
    .order("position", { ascending: true });

  if (options.status) {
    query = query.eq("status", options.status);
  }

  const result = await query;
  if (result.error) throwDatabaseError(result.error, "list booking waitlists");
  return (result.data ?? []).map((row) => mapWaitlist(row as Row));
}

export async function addToWaitlist(
  database: Database,
  principal: SessionPrincipal,
  input: AddWaitlistInput
): Promise<BookingWaitlistSummary> {
  const existing = await database.client
    .from("booking_waitlists")
    .select("position")
    .eq("organization_id", principal.organizationId)
    .eq("venue_id", input.venueId)
    .eq("status", "WAITING")
    .order("position", { ascending: false })
    .limit(1);

  const nextPosition = (existing.data && existing.data[0]?.position ? Number(existing.data[0].position) : 0) + 1;

  const result = await database.client
    .from("booking_waitlists")
    .insert({
      organization_id: principal.organizationId,
      venue_id: input.venueId,
      resource_id: input.resourceId ?? null,
      customer_name: input.customerName.trim(),
      customer_phone: input.customerPhone?.trim() ?? null,
      party_size: input.partySize,
      status: "WAITING",
      position: nextPosition,
      estimated_wait_minutes: input.estimatedWaitMinutes ?? null
    })
    .select("*")
    .single();

  if (result.error) throwDatabaseError(result.error, "add to booking waitlist");
  return mapWaitlist(result.data as Row);
}

export async function updateWaitlistStatus(
  database: Database,
  principal: SessionPrincipal,
  waitlistId: string,
  status: WaitlistStatus
): Promise<BookingWaitlistSummary> {
  const result = await database.client
    .from("booking_waitlists")
    .update({
      status,
      updated_at: new Date().toISOString()
    })
    .eq("organization_id", principal.organizationId)
    .eq("id", waitlistId)
    .select("*")
    .single();

  if (result.error) throwDatabaseError(result.error, "update waitlist status");
  return mapWaitlist(result.data as Row);
}
