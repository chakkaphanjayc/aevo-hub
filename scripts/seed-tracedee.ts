import { SQL } from "bun";

const databaseUrl = process.env.DATABASE_URL?.trim();
const seedUserId = process.env.TRACEDEE_SEED_USER_ID?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required to seed TraceDee");
if (!seedUserId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(seedUserId)) {
  throw new Error("TRACEDEE_SEED_USER_ID must be an existing auth.users UUID");
}

const db = new SQL(databaseUrl);

const places = [
  {
    id: "31de3a36-54b7-4e14-bc31-0a1a8d5e1001",
    slug: "tracedee-sanam-luang-walk",
    name: "Sanam Luang sunset walk",
    area: "Rattanakosin",
    category: "Walk",
    tags: ["sunset", "slow-travel", "heritage"],
    description: "เดินช้า ๆ ผ่านพื้นที่เก่า เมืองเปิดกว้าง และแสงเย็นที่ไม่ต้องเร่งรีบ",
    latitude: 13.7563,
    longitude: 100.4925
  },
  {
    id: "31de3a36-54b7-4e14-bc31-0a1a8d5e1002",
    slug: "tracedee-talad-noi-coffee",
    name: "Talad Noi coffee stop",
    area: "Talat Noi",
    category: "Cafe",
    tags: ["coffee", "neighborhood", "photo-walk"],
    description: "คาเฟ่เล็ก ๆ สำหรับพักระหว่างเดินดู texture ของย่านเก่า",
    latitude: 13.7324,
    longitude: 100.5137
  },
  {
    id: "31de3a36-54b7-4e14-bc31-0a1a8d5e1003",
    slug: "tracedee-charoenkrung-gallery",
    name: "Charoenkrung gallery loop",
    area: "Charoenkrung",
    category: "Gallery",
    tags: ["art", "design", "city-break"],
    description: "ลูปสั้น ๆ สำหรับดูงานศิลป์และแวะพักในย่านสร้างสรรค์",
    latitude: 13.7259,
    longitude: 100.5140
  }
] as const;

const traces = [
  {
    id: "41de3a36-54b7-4e14-bc31-0a1a8d5e2001",
    slug: "slow-bangkok-sunset",
    title: "Slow Bangkok: sunset without a rush",
    description: "สามจุดแวะสำหรับวันที่อยากเดินช้าลง มองเมืองให้ชัดขึ้น และจบด้วยแสงเย็นริมแม่น้ำ",
    area: "Rattanakosin",
    tags: ["slow-travel", "sunset", "heritage"],
    coverPlaceId: places[0].id,
    minutes: 210,
    budgetMinor: 65000,
    publishedOffset: "2 days"
  },
  {
    id: "41de3a36-54b7-4e14-bc31-0a1a8d5e2002",
    slug: "old-town-coffee-and-texture",
    title: "Old town coffee & texture",
    description: "เชื่อมกาแฟ ย่านเก่า และงานออกแบบไว้ในเส้นทางเดียว เหมาะกับเช้าวันหยุดที่ไม่ต้องวางแผนเยอะ",
    area: "Talat Noi",
    tags: ["coffee", "neighborhood", "photo-walk"],
    coverPlaceId: places[1].id,
    minutes: 165,
    budgetMinor: 48000,
    publishedOffset: "1 day"
  }
] as const;

const stops = [
  ["51de3a36-54b7-4e14-bc31-0a1a8d5e3001", traces[0].id, places[0].id, 0, "เริ่มจากพื้นที่เปิดโล่ง เดินดูเมืองและเลือกจังหวะของตัวเอง", 60, "WALK", 0],
  ["51de3a36-54b7-4e14-bc31-0a1a8d5e3002", traces[0].id, places[1].id, 1, "พักกาแฟและเก็บรายละเอียดเล็ก ๆ ของย่านเก่า", 60, "RIDE_HAIL", 25000],
  ["51de3a36-54b7-4e14-bc31-0a1a8d5e3003", traces[0].id, places[2].id, 2, "ปิดท้ายด้วยงานออกแบบและแสงเย็นของเมือง", 90, "WALK", 40000],
  ["51de3a36-54b7-4e14-bc31-0a1a8d5e3011", traces[1].id, places[1].id, 0, "เริ่มเช้าด้วยกาแฟและมุมถ่ายรูปที่ไม่ต้องรีบ", 55, "WALK", 25000],
  ["51de3a36-54b7-4e14-bc31-0a1a8d5e3012", traces[1].id, places[2].id, 1, "ดูงานออกแบบแล้วปล่อยให้ย่านพาเดินต่อ", 70, "WALK", 23000],
  ["51de3a36-54b7-4e14-bc31-0a1a8d5e3013", traces[1].id, places[0].id, 2, "จบด้วยการเดินช้า ๆ และสรุปสิ่งที่ชอบในวันนี้", 40, "RIDE_HAIL", 0]
] as const;

async function seed(): Promise<void> {
  for (const place of places) {
    await db.unsafe(
      `insert into public.tracedee_places
        (id, source_kind, slug, name, area, category, topic_tags, description, latitude, longitude, moderation_status, metadata)
       values ($1, 'EXTERNAL', $2, $3, $4, $5, array[$6, $7, $8]::text[], $9, $10, $11, 'VISIBLE', $12::jsonb)
       on conflict (slug) do update set
         name = excluded.name, area = excluded.area, category = excluded.category,
         topic_tags = excluded.topic_tags, description = excluded.description,
         latitude = excluded.latitude, longitude = excluded.longitude,
         moderation_status = excluded.moderation_status, metadata = excluded.metadata`,
      [place.id, place.slug, place.name, place.area, place.category, ...place.tags, place.description, place.latitude, place.longitude, JSON.stringify({ seed: "tracedee-phase-0", source: "development" })]
    );
  }

  for (const trace of traces) {
    await db.unsafe(
      `insert into public.tracedee_traces
        (id, creator_id, slug, title, description, status, visibility, revision, cover_place_id, area, topic_tags, estimated_minutes, estimated_budget_minor, published_at)
       values ($1, $2, $3, $4, $5, 'PUBLISHED', 'PUBLIC', 1, $6, $7, array[$8, $9, $10]::text[], $11, $12, timezone('utc', now()) - ($13 || ' ago')::interval)
       on conflict (slug) do update set
         title = excluded.title, description = excluded.description, status = excluded.status,
         visibility = excluded.visibility, revision = excluded.revision, cover_place_id = excluded.cover_place_id,
         area = excluded.area, topic_tags = excluded.topic_tags, estimated_minutes = excluded.estimated_minutes,
         estimated_budget_minor = excluded.estimated_budget_minor, published_at = excluded.published_at`,
      [trace.id, seedUserId, trace.slug, trace.title, trace.description, trace.coverPlaceId, trace.area, ...trace.tags, trace.minutes, trace.budgetMinor, trace.publishedOffset]
    );
  }

  for (const [id, traceId, placeId, position, note, durationMinutes, transportMode, budgetMinor] of stops) {
    await db.unsafe(
      `insert into public.tracedee_trace_stops
        (id, trace_id, place_id, position, note, duration_minutes, transport_mode, budget_minor)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do update set
         trace_id = excluded.trace_id, place_id = excluded.place_id, position = excluded.position,
         note = excluded.note, duration_minutes = excluded.duration_minutes,
         transport_mode = excluded.transport_mode, budget_minor = excluded.budget_minor`,
      [id, traceId, placeId, position, note, durationMinutes, transportMode, budgetMinor]
    );
  }

  console.log(`[TraceDee seed] ${places.length} places, ${traces.length} traces, ${stops.length} stops ready`);
  await db.close();
}

if (import.meta.main) {
  seed().catch((error) => {
    console.error("[TraceDee seed] failed:", error);
    process.exit(1);
  });
}
