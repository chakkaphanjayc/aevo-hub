import type {
  DemoDataSummary,
  OnboardingObjective,
  OnboardingSessionSummary,
  OnboardingStep,
  SetupBookingInput,
  SetupChecklistItem,
  SetupChecklistSummary,
  SetupOrganizationInput,
  SetupStoreInput
} from "@aevo/contracts";
import type { Database } from "./client";
import { throwDatabaseError } from "./errors";

type Row = Record<string, unknown>;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "aevo";
}

function mapOnboardingSession(row: Row): OnboardingSessionSummary {
  const objectives = Array.isArray(row.objectives)
    ? (row.objectives as string[])
    : typeof row.objectives === "string"
    ? JSON.parse(row.objectives)
    : [];

  const completedSteps = Array.isArray(row.completed_steps)
    ? (row.completed_steps as string[])
    : typeof row.completed_steps === "string"
    ? JSON.parse(row.completed_steps)
    : [];

  return {
    id: String(row.id),
    userId: String(row.user_id),
    organizationId: row.organization_id ? String(row.organization_id) : null,
    storeId: row.store_id ? String(row.store_id) : null,
    currentStep: (String(row.current_step) as OnboardingStep) || "REGISTER",
    objectives,
    completedSteps,
    isCompleted: Boolean(row.is_completed),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export async function getOrCreateOnboardingSession(
  database: Database,
  userId: string,
  organizationId?: string | null
): Promise<OnboardingSessionSummary> {
  // Check existing session
  let query = database.client
    .from("onboarding_sessions")
    .select("id, user_id, organization_id, store_id, current_step, objectives, completed_steps, is_completed, created_at, updated_at");

  if (userId) {
    query = query.eq("user_id", userId);
  }
  if (organizationId) {
    query = query.eq("organization_id", organizationId);
  }

  const existing = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (existing.error && existing.error.code !== "PGRST116") {
    throwDatabaseError(existing.error, "lookup onboarding session");
  }

  if (existing.data) {
    return mapOnboardingSession(existing.data as Row);
  }

  // Create new session
  const insertResult = await database.client
    .from("onboarding_sessions")
    .insert({
      user_id: userId,
      organization_id: organizationId || null,
      current_step: "REGISTER",
      objectives: [],
      completed_steps: ["REGISTER"],
      is_completed: false
    })
    .select("id, user_id, organization_id, store_id, current_step, objectives, completed_steps, is_completed, created_at, updated_at")
    .single();

  if (insertResult.error) {
    throwDatabaseError(insertResult.error, "create onboarding session");
  }

  return mapOnboardingSession(insertResult.data as Row);
}

export async function updateOnboardingObjectives(
  database: Database,
  sessionId: string,
  objectives: OnboardingObjective[]
): Promise<OnboardingSessionSummary> {
  // Fetch current session
  const current = await database.client
    .from("onboarding_sessions")
    .select("completed_steps")
    .eq("id", sessionId)
    .single();

  const completed = new Set<string>(
    Array.isArray(current.data?.completed_steps)
      ? current.data.completed_steps
      : ["REGISTER"]
  );
  completed.add("OBJECTIVES");

  const result = await database.client
    .from("onboarding_sessions")
    .update({
      objectives,
      current_step: "ORGANIZATION",
      completed_steps: Array.from(completed),
      updated_at: new Date().toISOString()
    })
    .eq("id", sessionId)
    .select("id, user_id, organization_id, store_id, current_step, objectives, completed_steps, is_completed, created_at, updated_at")
    .single();

  if (result.error) {
    throwDatabaseError(result.error, "update onboarding objectives");
  }

  return mapOnboardingSession(result.data as Row);
}

export async function setupOnboardingOrganization(
  database: Database,
  sessionId: string,
  userId: string,
  input: SetupOrganizationInput
): Promise<{ organizationId: string; session: OnboardingSessionSummary }> {
  // 1. Fetch session to check if org already created
  const sessionRes = await database.client
    .from("onboarding_sessions")
    .select("organization_id, completed_steps")
    .eq("id", sessionId)
    .single();

  let orgId = sessionRes.data?.organization_id ? String(sessionRes.data.organization_id) : null;
  const slug = `${slugify(input.name)}-${Date.now().toString(36)}`;

  if (orgId) {
    // Update existing org
    const updateRes = await database.client
      .from("organizations")
      .update({
        name: input.name,
        legal_name: input.legalName || input.name,
        business_type: input.businessType || "general",
        country: input.country || "TH",
        timezone: input.timezone || "Asia/Bangkok",
        currency: input.currency || "THB",
        logo_url: input.logoUrl || null,
        contact_email: input.contactEmail || null,
        contact_phone: input.contactPhone || null,
        onboarding_status: "IN_PROGRESS",
        updated_at: new Date().toISOString()
      })
      .eq("id", orgId);

    if (updateRes.error) {
      throwDatabaseError(updateRes.error, "update organization");
    }
  } else {
    // Insert new org
    const insertRes = await database.client
      .from("organizations")
      .insert({
        name: input.name,
        slug,
        legal_name: input.legalName || input.name,
        business_type: input.businessType || "general",
        country: input.country || "TH",
        timezone: input.timezone || "Asia/Bangkok",
        currency: input.currency || "THB",
        logo_url: input.logoUrl || null,
        contact_email: input.contactEmail || null,
        contact_phone: input.contactPhone || null,
        status: "ACTIVE",
        onboarding_status: "IN_PROGRESS"
      })
      .select("id")
      .single();

    if (insertRes.error || !insertRes.data) {
      throwDatabaseError(insertRes.error, "insert organization");
      throw new Error("Failed to insert organization");
    }
    orgId = String(insertRes.data.id);

    // Find OWNER role
    const roleRes = await database.client
      .from("roles")
      .select("id")
      .eq("code", "OWNER")
      .single();

    if (roleRes.data?.id) {
      // Upsert membership
      await database.client.from("memberships").upsert({
        organization_id: orgId,
        user_id: userId,
        role_id: roleRes.data.id,
        status: "ACTIVE"
      });
    }
  }

  const subscriptionResult = await database.client
    .from("subscriptions")
    .select("id,plan_id")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (subscriptionResult.error) throwDatabaseError(subscriptionResult.error, "load onboarding subscription");

  let planId = String(subscriptionResult.data?.plan_id ?? "starter");
  if (!subscriptionResult.data) {
    const createdSubscription = await database.client
      .from("subscriptions")
      .insert({
        organization_id: orgId,
        plan_id: planId,
        provider: "MANUAL",
        status: "TRIALING"
      })
      .select("id,plan_id")
      .single();
    if (createdSubscription.error || !createdSubscription.data) {
      throwDatabaseError(createdSubscription.error, "create onboarding subscription");
      throw new Error("Failed to create onboarding subscription");
    }
    planId = String(createdSubscription.data.plan_id);
  }

  const existingEntitlements = await database.client
    .from("organization_entitlements")
    .select("feature_key")
    .eq("organization_id", orgId);
  if (existingEntitlements.error) throwDatabaseError(existingEntitlements.error, "load onboarding entitlements");
  if (!existingEntitlements.data || existingEntitlements.data.length === 0) {
    const planEntitlements = await database.client
      .from("plan_entitlements")
      .select("feature_key,is_enabled,limit_value")
      .eq("plan_id", planId);
    if (planEntitlements.error) throwDatabaseError(planEntitlements.error, "load onboarding plan entitlements");
    if (planEntitlements.data && planEntitlements.data.length > 0) {
      const entitlementInsert = await database.client
        .from("organization_entitlements")
        .insert((planEntitlements.data as Row[]).map((entitlement) => ({
          organization_id: orgId,
          feature_key: String(entitlement.feature_key),
          is_enabled: Boolean(entitlement.is_enabled),
          custom_override: false,
          limit_value: entitlement.limit_value === null || entitlement.limit_value === undefined
            ? null
            : Number(entitlement.limit_value)
        })));
      if (entitlementInsert.error) throwDatabaseError(entitlementInsert.error, "create onboarding entitlements");
    }
  }

  // Update session
  const completed = new Set<string>(
    Array.isArray(sessionRes.data?.completed_steps)
      ? sessionRes.data.completed_steps
      : ["REGISTER", "OBJECTIVES"]
  );
  completed.add("ORGANIZATION");

  const updateSessionRes = await database.client
    .from("onboarding_sessions")
    .update({
      organization_id: orgId,
      current_step: "STORE",
      completed_steps: Array.from(completed),
      updated_at: new Date().toISOString()
    })
    .eq("id", sessionId)
    .select("id, user_id, organization_id, store_id, current_step, objectives, completed_steps, is_completed, created_at, updated_at")
    .single();

  if (updateSessionRes.error) {
    throwDatabaseError(updateSessionRes.error, "update onboarding session after org");
  }

  return {
    organizationId: orgId,
    session: mapOnboardingSession(updateSessionRes.data as Row)
  };
}

export async function setupOnboardingStore(
  database: Database,
  sessionId: string,
  input: SetupStoreInput
): Promise<{ storeId: string; session: OnboardingSessionSummary }> {
  const sessionRes = await database.client
    .from("onboarding_sessions")
    .select("organization_id, store_id, completed_steps")
    .eq("id", sessionId)
    .single();

  const orgId = input.organizationId || (sessionRes.data?.organization_id ? String(sessionRes.data.organization_id) : null);
  if (!orgId) throw new Error("Organization ID required for store setup");

  let storeId = sessionRes.data?.store_id ? String(sessionRes.data.store_id) : null;

  if (storeId) {
    const updateRes = await database.client
      .from("stores")
      .update({
        name: input.name,
        code: input.code.trim().toUpperCase(),
        store_mode: input.storeMode || "POS",
        address: input.address || null,
        phone: input.phone || null,
        tax_id: input.taxId || null,
        updated_at: new Date().toISOString()
      })
      .eq("id", storeId);

    if (updateRes.error) throwDatabaseError(updateRes.error, "update store");
  } else {
    const insertRes = await database.client
      .from("stores")
      .insert({
        organization_id: orgId,
        name: input.name,
        code: input.code.trim().toUpperCase(),
        store_mode: input.storeMode || "POS",
        address: input.address || null,
        phone: input.phone || null,
        tax_id: input.taxId || null,
        timezone: "Asia/Bangkok",
        currency: "THB",
        status: "ACTIVE"
      })
      .select("id")
      .single();

    if (insertRes.error || !insertRes.data) {
      throwDatabaseError(insertRes.error, "create store");
      throw new Error("Failed to create store");
    }
    storeId = String(insertRes.data.id);
  }

  // Update session
  const completed = new Set<string>(
    Array.isArray(sessionRes.data?.completed_steps)
      ? sessionRes.data.completed_steps
      : ["REGISTER", "OBJECTIVES", "ORGANIZATION"]
  );
  completed.add("STORE");

  const updateSessionRes = await database.client
    .from("onboarding_sessions")
    .update({
      organization_id: orgId,
      store_id: storeId,
      current_step: "APPS",
      completed_steps: Array.from(completed),
      updated_at: new Date().toISOString()
    })
    .eq("id", sessionId)
    .select("id, user_id, organization_id, store_id, current_step, objectives, completed_steps, is_completed, created_at, updated_at")
    .single();

  if (updateSessionRes.error) {
    throwDatabaseError(updateSessionRes.error, "update session after store");
  }

  return {
    storeId,
    session: mapOnboardingSession(updateSessionRes.data as Row)
  };
}

export async function setupOnboardingApps(
  database: Database,
  sessionId: string,
  appIds: string[]
): Promise<OnboardingSessionSummary> {
  const sessionRes = await database.client
    .from("onboarding_sessions")
    .select("organization_id, store_id, objectives, completed_steps")
    .eq("id", sessionId)
    .single();

  const orgId = sessionRes.data?.organization_id ? String(sessionRes.data.organization_id) : null;
  if (!orgId) throw new Error("Organization ID required for app selection");

  const appResult = await database.client
    .from("apps")
    .select("id,status")
    .in("id", appIds);
  if (appResult.error) throwDatabaseError(appResult.error, "validate onboarding apps");
  const availableApps = new Set(
    (appResult.data ?? [])
      .filter((app: Row) => String(app.status) !== "DEPRECATED")
      .map((app: Row) => String(app.id))
  );
  const invalidApp = appIds.find((appId) => !availableApps.has(appId));
  if (invalidApp) throw new Error(`Application '${invalidApp}' is not available`);

  // App selection is onboarding intent. Runtime access remains determined by
  // the organization plan and the server-side entitlement engine.
  if (appIds.length > 0) {
    const objectives = Array.isArray(sessionRes.data?.objectives)
      ? sessionRes.data.objectives.map(String)
      : [];
    const objectiveUpdate = await database.client
      .from("onboarding_sessions")
      .update({ objectives: Array.from(new Set([...objectives, ...appIds])), updated_at: new Date().toISOString() })
      .eq("id", sessionId);
    if (objectiveUpdate.error) throwDatabaseError(objectiveUpdate.error, "save onboarding app selection");
  }

  const completed = new Set<string>(
    Array.isArray(sessionRes.data?.completed_steps)
      ? sessionRes.data.completed_steps
      : ["REGISTER", "OBJECTIVES", "ORGANIZATION", "STORE"]
  );
  completed.add("APPS");

  const updateSessionRes = await database.client
    .from("onboarding_sessions")
    .update({
      current_step: "RESOURCES",
      completed_steps: Array.from(completed),
      updated_at: new Date().toISOString()
    })
    .eq("id", sessionId)
    .select("id, user_id, organization_id, store_id, current_step, objectives, completed_steps, is_completed, created_at, updated_at")
    .single();

  if (updateSessionRes.error) {
    throwDatabaseError(updateSessionRes.error, "update session after apps");
  }

  return mapOnboardingSession(updateSessionRes.data as Row);
}

export async function setupOnboardingBooking(
  database: Database,
  sessionId: string,
  input: SetupBookingInput
): Promise<{ venueId: string; session: OnboardingSessionSummary }> {
  const sessionRes = await database.client
    .from("onboarding_sessions")
    .select("organization_id, store_id, completed_steps")
    .eq("id", sessionId)
    .single();

  const orgId = input.organizationId || (sessionRes.data?.organization_id ? String(sessionRes.data.organization_id) : null);
  const storeId = input.storeId || (sessionRes.data?.store_id ? String(sessionRes.data.store_id) : null);
  if (!orgId) throw new Error("Organization ID required for booking setup");

  const venueSlug = `${slugify(input.venueName)}-${Date.now().toString(36)}`;

  // Create Venue
  const venueRes = await database.client
    .from("venues")
    .insert({
      organization_id: orgId,
      store_id: storeId,
      name: input.venueName,
      slug: venueSlug,
      description: `Venue created during onboarding for ${input.businessType}`,
      address: "สาขาหลัก",
      timezone: "Asia/Bangkok",
      slot_duration_minutes: input.durationMinutes || 60,
      status: "ACTIVE"
    })
    .select("id")
    .single();

  if (venueRes.error || !venueRes.data) {
    throwDatabaseError(venueRes.error, "create onboarding venue");
    throw new Error("Failed to create venue");
  }
  const venueId = String(venueRes.data.id);

  // Create Bookable Resources
  const resourceType =
    input.businessType.toLowerCase().includes("court") || input.businessType.toLowerCase().includes("sport")
      ? "COURT"
      : input.businessType.toLowerCase().includes("room")
      ? "ROOM"
      : "TABLE";

  for (const name of input.resourceNames) {
    await database.client.from("bookable_resources").insert({
      organization_id: orgId,
      venue_id: venueId,
      name: name.trim(),
      resource_type: resourceType,
      capacity: 4,
      base_price_minor: input.priceMinor || 0,
      status: "ACTIVE"
    });
  }

  const completed = new Set<string>(
    Array.isArray(sessionRes.data?.completed_steps)
      ? sessionRes.data.completed_steps
      : []
  );
  completed.add("RESOURCES");

  const updateSessionRes = await database.client
    .from("onboarding_sessions")
    .update({
      current_step: "STAFF",
      completed_steps: Array.from(completed),
      updated_at: new Date().toISOString()
    })
    .eq("id", sessionId)
    .select("id, user_id, organization_id, store_id, current_step, objectives, completed_steps, is_completed, created_at, updated_at")
    .single();

  return {
    venueId,
    session: mapOnboardingSession(updateSessionRes.data as Row)
  };
}

export async function markOnboardingStep(
  database: Database,
  sessionId: string,
  step: "RESOURCES" | "STAFF"
): Promise<OnboardingSessionSummary> {
  const sessionRes = await database.client
    .from("onboarding_sessions")
    .select("organization_id, completed_steps")
    .eq("id", sessionId)
    .single();

  if (sessionRes.error) throwDatabaseError(sessionRes.error, "load onboarding progress");

  const completed = new Set<string>(
    Array.isArray(sessionRes.data?.completed_steps)
      ? sessionRes.data.completed_steps
      : []
  );
  completed.add(step);

  const nextStep = completed.has("STAFF") ? "COMPLETE" : step === "RESOURCES" ? "STAFF" : "COMPLETE";
  const updateRes = await database.client
    .from("onboarding_sessions")
    .update({
      current_step: nextStep,
      completed_steps: Array.from(completed),
      updated_at: new Date().toISOString()
    })
    .eq("id", sessionId)
    .select("id, user_id, organization_id, store_id, current_step, objectives, completed_steps, is_completed, created_at, updated_at")
    .single();

  if (updateRes.error) throwDatabaseError(updateRes.error, "save onboarding progress");
  return mapOnboardingSession(updateRes.data as Row);
}

export async function generateDemoData(
  database: Database,
  orgId: string,
  storeId: string,
  businessType: string = "general"
): Promise<DemoDataSummary> {
  const isRestaurant = businessType.toLowerCase().includes("food") || businessType.toLowerCase().includes("cafe") || businessType.toLowerCase().includes("restaurant");
  const isSport = businessType.toLowerCase().includes("sport") || businessType.toLowerCase().includes("court") || businessType.toLowerCase().includes("badminton");

  let categoriesCreated = 0;
  let productsCreated = 0;
  let venuesCreated = 0;
  let resourcesCreated = 0;
  let ordersCreated = 0;
  let bookingsCreated = 0;

  // 1. Create Demo Categories
  const catNames = isSport
    ? ["บริการเช่าสนาม", "เครื่องดื่มและขนม", "อุปกรณ์กีฬา"]
    : ["เครื่องดื่มชงสด", "อาหารจานหลัก", "ของว่างและเบเกอรี่"];

  const catMap: Record<string, string> = {};
  const randSuffixUpper = Math.random().toString(36).substring(2, 6).toUpperCase();
  const randSuffixLower = randSuffixUpper.toLowerCase();

  for (let i = 0; i < catNames.length; i++) {
    const code = `DEMO_CAT_${i + 1}_${randSuffixUpper}`;
    const slug = `demo-cat-${i + 1}-${randSuffixLower}`;
    const catRes = await database.client
      .from("categories")
      .insert({
        organization_id: orgId,
        code,
        name: catNames[i],
        slug,
        sort_order: i + 1,
        status: "ACTIVE",
        is_demo_data: true
      })
      .select("id")
      .single();

    if (catRes.data?.id) {
      catMap[catNames[i]] = String(catRes.data.id);
      categoriesCreated++;
    }
  }

  // 2. Create Demo Products
  const demoProducts = isSport
    ? [
        { name: "สนามแบดมินตัน 1 ชม. (Peak)", sku: `DEMO-CRT-01-${randSuffixUpper}`, price: 25000, cat: "บริการเช่าสนาม" },
        { name: "สนามแบดมินตัน 1 ชม. (Off-Peak)", sku: `DEMO-CRT-02-${randSuffixUpper}`, price: 18000, cat: "บริการเช่าสนาม" },
        { name: "เช่าไม้แบด Yonex Nano (ชิ้น)", sku: `DEMO-EQ-01-${randSuffixUpper}`, price: 5000, cat: "อุปกรณ์กีฬา" },
        { name: "ลูกแบด RSL Silver (หลอด)", sku: `DEMO-EQ-02-${randSuffixUpper}`, price: 85000, cat: "อุปกรณ์กีฬา" },
        { name: "น้ำแร่เย็น 500ml", sku: `DEMO-BEV-01-${randSuffixUpper}`, price: 1500, cat: "เครื่องดื่มและขนม" },
        { name: "เกลือแร่สปอร์ตดริงก์", sku: `DEMO-BEV-02-${randSuffixUpper}`, price: 2500, cat: "เครื่องดื่มและขนม" }
      ]
    : [
        { name: "Iced Americano คั่วกลาง", sku: `DEMO-COF-01-${randSuffixUpper}`, price: 6500, cat: "เครื่องดื่มชงสด" },
        { name: "Matcha Latte มัทฉะพรีเมียม", sku: `DEMO-TEA-01-${randSuffixUpper}`, price: 7500, cat: "เครื่องดื่มชงสด" },
        { name: "Sparkling Yuzu Espresso", sku: `DEMO-COF-02-${randSuffixUpper}`, price: 8500, cat: "เครื่องดื่มชงสด" },
        { name: "ข้าวผัดกะเพราเนื้อโคขุน ไข่ดาวกรอบ", sku: `DEMO-FOOD-01-${randSuffixUpper}`, price: 12900, cat: "อาหารจานหลัก" },
        { name: "สปาเก็ตตี้คาโบนาร่าเบคอนกรอบ", sku: `DEMO-FOOD-02-${randSuffixUpper}`, price: 15900, cat: "อาหารจานหลัก" },
        { name: "Croissant เนยสดฝรั่งเศส", sku: `DEMO-BAKE-01-${randSuffixUpper}`, price: 6500, cat: "ของว่างและเบเกอรี่" }
      ];

  const createdProductIds: string[] = [];
  for (const item of demoProducts) {
    const prodRes = await database.client
      .from("products")
      .insert({
        organization_id: orgId,
        category_id: catMap[item.cat] || null,
        sku: item.sku,
        name: item.name,
        description: "รายการสาธิตสำหรับทดสอบระบบ Aevo",
        base_price_minor: item.price,
        currency: "THB",
        status: "ACTIVE",
        is_demo_data: true
      })
      .select("id")
      .single();

    if (prodRes.data?.id) {
      createdProductIds.push(String(prodRes.data.id));
      productsCreated++;
    }
  }

  // 3. Create Demo Venue & Resources
  const venueRes = await database.client
    .from("venues")
    .insert({
      organization_id: orgId,
      store_id: storeId,
      name: isSport ? "Aevo Badminton Court Arena (Demo)" : "Aevo Bistro & Lounge (Demo)",
      slug: `demo-venue-${Date.now().toString(36)}`,
      description: "สถานที่สาธิตสำหรับการทดลองฟังก์ชันการจองและ Waitlist",
      address: "ชั้น 1 อาคาร Aevo Center",
      timezone: "Asia/Bangkok",
      slot_duration_minutes: isSport ? 60 : 90,
      status: "ACTIVE",
      is_demo_data: true
    })
    .select("id")
    .single();

  let venueId = "";
  if (venueRes.data?.id) {
    venueId = String(venueRes.data.id);
    venuesCreated++;

    const resourceItems = isSport
      ? [
          { name: "สนาม 1 (Court 1)", type: "COURT", price: 25000 },
          { name: "สนาม 2 (Court 2)", type: "COURT", price: 25000 },
          { name: "สนาม 3 (Court 3)", type: "COURT", price: 25000 },
          { name: "สนาม VIP (Air Condition)", type: "COURT", price: 40000 }
        ]
      : [
          { name: "โต๊ะ 1 (Indoor Window)", type: "TABLE", price: 0 },
          { name: "โต๊ะ 2 (Indoor Center)", type: "TABLE", price: 0 },
          { name: "โต๊ะ VIP (Private Room)", type: "ROOM", price: 100000 },
          { name: "โต๊ะ Outdoor Terrace", type: "TABLE", price: 0 }
        ];

    for (const r of resourceItems) {
      const rRes = await database.client.from("bookable_resources").insert({
        organization_id: orgId,
        venue_id: venueId,
        name: r.name,
        resource_type: r.type,
        capacity: 4,
        base_price_minor: r.price,
        status: "ACTIVE",
        is_demo_data: true
      }).select("id").single();

      if (rRes.data?.id) {
        resourcesCreated++;

        // Add 1 demo booking for first resource
        if (resourcesCreated === 1) {
          const now = new Date();
          const start = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
          const end = new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();

          await database.client.from("bookings").insert({
            organization_id: orgId,
            venue_id: venueId,
            resource_id: rRes.data.id,
            customer_name: "คุณสมศักดิ์ มั่นคง (ลูกค้าสาธิต)",
            customer_phone: "089-123-4567",
            start_at: start,
            end_at: end,
            status: "CONFIRMED",
            amount_minor: r.price,
            checkin_code: "DEMO-88",
            notes: "จองทดสอบผ่านระบบ Onboarding",
            is_demo_data: true
          });
          bookingsCreated++;
        }
      }
    }
  }

  // 4. Create 1 Demo Order
  if (createdProductIds.length >= 2) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const seq = String(Math.floor(10000 + Math.random() * 90000));
    const orderNumber = `SO-${today}-${seq}`;
    const subtotal = demoProducts[0].price + demoProducts[1].price;

    const orderRes = await database.client
      .from("orders")
      .insert({
        organization_id: orgId,
        store_id: storeId,
        order_number: orderNumber,
        channel: "POS",
        order_type: "POS",
        fulfillment_type: "DINE_IN",
        status: "COMPLETED",
        payment_status: "PAID",
        currency: "THB",
        subtotal_minor: subtotal,
        discount_minor: 0,
        tax_minor: 0,
        total_minor: subtotal,
        customer_name: "คุณวิภาวรรณ (Demo)",
        version: 1,
        is_demo_data: true
      })
      .select("id")
      .single();

    if (orderRes.data?.id) {
      ordersCreated++;
      const orderId = String(orderRes.data.id);

      await database.client.from("order_items").insert([
        {
          order_id: orderId,
          line_number: 1,
          product_id: createdProductIds[0],
          sku: demoProducts[0].sku,
          product_name: demoProducts[0].name,
          unit_price_minor: demoProducts[0].price,
          quantity: 1,
          subtotal_minor: demoProducts[0].price
        },
        {
          order_id: orderId,
          line_number: 2,
          product_id: createdProductIds[1],
          sku: demoProducts[1].sku,
          product_name: demoProducts[1].name,
          unit_price_minor: demoProducts[1].price,
          quantity: 1,
          subtotal_minor: demoProducts[1].price
        }
      ]);
    }
  }

  return {
    organizationId: orgId,
    storeId,
    categoriesCreated,
    productsCreated,
    venuesCreated,
    resourcesCreated,
    ordersCreated,
    bookingsCreated,
    isDemoData: true
  };
}

export async function clearDemoData(
  database: Database,
  orgId: string,
  storeId?: string | null
): Promise<{ deletedCounts: Record<string, number> }> {
  const counts: Record<string, number> = {};

  // Bookings
  const bRes = await database.client
    .from("bookings")
    .delete()
    .eq("organization_id", orgId)
    .eq("is_demo_data", true)
    .select("id");
  counts.bookings = bRes.data?.length ?? 0;

  // Order items for demo orders
  const orders = await database.client
    .from("orders")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_demo_data", true);

  const orderIds = (orders.data ?? []).map((o: Row) => String(o.id));
  if (orderIds.length > 0) {
    await database.client.from("order_items").delete().in("order_id", orderIds);
  }

  // Orders
  const oRes = await database.client
    .from("orders")
    .delete()
    .eq("organization_id", orgId)
    .eq("is_demo_data", true)
    .select("id");
  counts.orders = oRes.data?.length ?? 0;

  // Bookable Resources
  const brRes = await database.client
    .from("bookable_resources")
    .delete()
    .eq("organization_id", orgId)
    .eq("is_demo_data", true)
    .select("id");
  counts.resources = brRes.data?.length ?? 0;

  // Venues
  const vRes = await database.client
    .from("venues")
    .delete()
    .eq("organization_id", orgId)
    .eq("is_demo_data", true)
    .select("id");
  counts.venues = vRes.data?.length ?? 0;

  // Products
  const pRes = await database.client
    .from("products")
    .delete()
    .eq("organization_id", orgId)
    .eq("is_demo_data", true)
    .select("id");
  counts.products = pRes.data?.length ?? 0;

  // Categories
  const cRes = await database.client
    .from("categories")
    .delete()
    .eq("organization_id", orgId)
    .eq("is_demo_data", true)
    .select("id");
  counts.categories = cRes.data?.length ?? 0;

  return { deletedCounts: counts };
}

export async function getSetupChecklist(
  database: Database,
  orgId: string,
  storeId?: string | null
): Promise<SetupChecklistSummary> {
  const [orgRes, storeRes, prodCountRes, memberCountRes, appCountRes, venueCountRes] =
    await Promise.all([
      database.client
        .from("organizations")
        .select("name, business_type, onboarding_status")
        .eq("id", orgId)
        .maybeSingle(),
      database.client
        .from("stores")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("status", "ACTIVE"),
      database.client
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("status", "ACTIVE"),
      database.client
        .from("memberships")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("status", "ACTIVE"),
      database.client
        .from("organization_entitlements")
        .select("feature_key", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("is_enabled", true)
        .in("feature_key", ["pos", "kiosk", "booking", "advanced_analytics", "odoo_integration"]),
      database.client
        .from("venues")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("status", "ACTIVE")
    ]);

  const hasOrg = Boolean(orgRes.data?.name && orgRes.data?.business_type);
  const storeCount = storeRes.count ?? 0;
  const prodCount = prodCountRes.count ?? 0;
  const memberCount = memberCountRes.count ?? 0;
  const appCount = appCountRes.count ?? 0;
  const venueCount = venueCountRes.count ?? 0;

  const items: SetupChecklistItem[] = [
    {
      id: "org_setup",
      title: "Organization Setup",
      description: "ตั้งค่าข้อมูลธุรกิจ บริษัท และสกุลเงินหลัก",
      category: "REQUIRED",
      status: hasOrg ? "COMPLETED" : "IN_PROGRESS",
      percent: hasOrg ? 100 : 50,
      actionUrl: "#onboarding-org"
    },
    {
      id: "store_setup",
      title: "Store Setup",
      description: "สร้างสาขาแรก กำหนดโหมดหน้าร้าน (POS, Kiosk, Booking)",
      category: "REQUIRED",
      status: storeCount > 0 ? "COMPLETED" : "PENDING",
      percent: storeCount > 0 ? 100 : 0,
      actionUrl: "#onboarding-store"
    },
    {
      id: "app_selection",
      title: "Select & Enable Apps",
      description: "เปิดใช้งานแอปที่ต้องการตามแพ็กเกจและสิทธิ์ขององค์กร",
      category: "RECOMMENDED",
      status: appCount > 0 ? "COMPLETED" : "PENDING",
      percent: appCount > 0 ? 100 : 0,
      actionUrl: "#onboarding-apps"
    },
    {
      id: "products_setup",
      title: "Add Products & Services",
      description: "เพิ่มสินค้า เมนู หรือบริการ หรือกดสร้างข้อมูลตัวอย่าง",
      category: "RECOMMENDED",
      status: prodCount >= 3 ? "COMPLETED" : prodCount > 0 ? "IN_PROGRESS" : "PENDING",
      percent: prodCount >= 3 ? 100 : prodCount > 0 ? 50 : 0,
      actionUrl: "#onboarding-products"
    },
    {
      id: "booking_resources",
      title: "Setup Booking & Resources",
      description: "ตั้งค่าโต๊ะ สนาม หรือห้อง พร้อมระบบ Waitlist",
      category: "OPTIONAL",
      status: venueCount > 0 ? "COMPLETED" : "PENDING",
      percent: venueCount > 0 ? 100 : 0,
      actionUrl: "#onboarding-booking"
    },
    {
      id: "staff_invite",
      title: "Invite Staff",
      description: "เชิญพนักงานและผู้จัดการสาขาพร้อมกำหนดสิทธิ์ Role",
      category: "RECOMMENDED",
      status: memberCount > 1 ? "COMPLETED" : "PENDING",
      percent: memberCount > 1 ? 100 : 0,
      actionUrl: "#staff"
    },
    {
      id: "line_integration",
      title: "Connect LINE Official",
      description: "เชื่อมต่อ LINE OA สำหรับแจ้งเตือนการจองและบัตรคิว",
      category: "OPTIONAL",
      status: "PENDING",
      percent: 0,
      actionUrl: "#integrations-line"
    },
    {
      id: "odoo_integration",
      title: "Connect Odoo ERP",
      description: "เชื่อมต่อ Odoo Bridge สำหรับ Sync สินค้า สต๊อก และใบแจ้งหนี้",
      category: "OPTIONAL",
      status: "PENDING",
      percent: 0,
      actionUrl: "#integrations-odoo"
    }
  ];

  const totalPoints = items.reduce((sum, item) => sum + item.percent, 0);
  const totalProgressPercent = Math.round(totalPoints / items.length);
  const completedCount = items.filter((i) => i.status === "COMPLETED").length;

  return {
    items,
    totalProgressPercent,
    completedCount,
    totalCount: items.length,
    isReady: hasOrg && storeCount > 0
  };
}

export async function completeOnboardingSession(
  database: Database,
  sessionId: string
): Promise<OnboardingSessionSummary> {
  const sessionRes = await database.client
    .from("onboarding_sessions")
    .select("organization_id, completed_steps")
    .eq("id", sessionId)
    .single();
  if (sessionRes.error || !sessionRes.data) {
    throwDatabaseError(sessionRes.error, "load onboarding session for completion");
    throw new Error("Onboarding session not found");
  }
  const orgId = sessionRes.data.organization_id ? String(sessionRes.data.organization_id) : null;

  const completed = new Set<string>(
    Array.isArray(sessionRes.data?.completed_steps)
      ? sessionRes.data.completed_steps
      : []
  );
  completed.add("COMPLETE");

  if (orgId) {
    await database.client
      .from("organizations")
      .update({ onboarding_status: "COMPLETED" })
      .eq("id", orgId);
  }

  const updateSessionRes = await database.client
    .from("onboarding_sessions")
    .update({
      current_step: "COMPLETE",
      completed_steps: Array.from(completed),
      is_completed: true,
      updated_at: new Date().toISOString()
    })
    .eq("id", sessionId)
    .select("*")
    .single();

  if (updateSessionRes.error) {
    throwDatabaseError(updateSessionRes.error, "complete onboarding session");
  }

  return mapOnboardingSession(updateSessionRes.data as Row);
}
