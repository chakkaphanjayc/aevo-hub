import { SQL } from "bun";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required to seed the database");
const db = new SQL(databaseUrl);

const defaultApps = [
  {
    id: "pos",
    name: "Aevo POS",
    description: "Point of Sale สำหรับแคชเชียร์และหน้าร้าน จัดการออเดอร์ บิล และรอบกะ",
    icon: "pos",
    pricing_model: "PER_BRANCH",
    base_price_monthly_minor: 49900,
    status: "ACTIVE",
    features: JSON.stringify(["ขายหน้าร้าน (Cashier)", "รับชำระเงินหลายรูปแบบ", "ระบบรอบกะเงินสด", "พิมพ์ใบเสร็จ"])
  },
  {
    id: "kiosk",
    name: "Aevo Kiosk & KDS",
    description: "ระบบจอสั่งอาหารด้วยตนเอง และหน้าจอห้องครัวแสดงผลออเดอร์เรียลไทม์",
    icon: "kiosk",
    pricing_model: "PER_DEVICE",
    base_price_monthly_minor: 39900,
    status: "ACTIVE",
    features: JSON.stringify(["ตู้ Self-Ordering Kiosk", "จอแสดงผลออเดอร์ในครัว KDS", "จอเรียกคิวลูกค้า (Queue Display)"])
  },
  {
    id: "booking",
    name: "Aevo Booking",
    description: "ระบบจองสนาม แบดมินตัน ฟุตบอล ห้องประชุม และทรัพยากร พร้อมตารางเวลา",
    icon: "booking",
    pricing_model: "PER_VENUE",
    base_price_monthly_minor: 59900,
    status: "ACTIVE",
    features: JSON.stringify(["ตารางจองสนามแบบ Timeline", "ระบบคิวรอ (Waitlist)", "เช็คอินด้วย QR", "แจ้งเตือน LINE"])
  },
  {
    id: "crm",
    name: "Aevo CRM & Loyalty",
    description: "ระบบสมาชิก สะสมแต้ม คูปองส่วนลด และการตลาดลูกค้าสัมพันธ์",
    icon: "crm",
    pricing_model: "PER_ORG",
    base_price_monthly_minor: 29900,
    status: "ACTIVE",
    features: JSON.stringify(["สะสมแต้มสมาชิก", "คูปองและโปรโมชั่น", "วิเคราะห์พฤติกรรมลูกค้า"])
  },
  {
    id: "inventory",
    name: "Aevo Inventory",
    description: "ระบบจัดการสต๊อกสินค้า วัตถุดิบ สูตรอาหาร (BOM) และการตัดสต๊อกอัตโนมัติ",
    icon: "inventory",
    pricing_model: "PER_BRANCH",
    base_price_monthly_minor: 49900,
    status: "ACTIVE",
    features: JSON.stringify(["ตัดสต๊อกตามสูตร Realtime", "แจ้งเตือนวัตถุดิบใกล้หมด", "รับเข้า-โอนย้ายสต๊อกระหว่างสาขา"])
  },
  {
    id: "odoo_connector",
    name: "Odoo 19 Bridge",
    description: "เชื่อมต่อข้อมูลการขาย บัญชี ลูกค้า และสต๊อกสินค้าเข้าสู่ระบบ Odoo 19 ERP อัตโนมัติ",
    icon: "odoo",
    pricing_model: "PER_ORG",
    base_price_monthly_minor: 89900,
    status: "ACTIVE",
    features: JSON.stringify(["ซิงค์ Sale Order อัตโนมัติ", "ซิงค์ใบกำกับภาษีและผังบัญชี", "รองรับ Outbox Resilient Queue"])
  },
  {
    id: "digital_sign",
    name: "Aevo Digital Signage",
    description: "จัดการจอโฆษณา ป้ายเมนูดิจิทัล และโปรโมชั่นหน้าร้านผ่าน Cloud",
    icon: "screen",
    pricing_model: "PER_DEVICE",
    base_price_monthly_minor: 19900,
    status: "ACTIVE",
    features: JSON.stringify(["เปลี่ยนเมนูและราคาอัตโนมัติ", "ตั้งเวลาเล่นโปรโมชั่น", "เชื่อมต่อข้อมูลสินค้าจากแคตตาล็อก"])
  }
];

async function seed() {
  console.log(`[Seed] Seeding default ecosystem apps to Supabase...`);

  for (const app of defaultApps) {
    await db.unsafe(
      `INSERT INTO apps (id, name, description, icon, pricing_model, base_price_monthly_minor, status, features)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         icon = EXCLUDED.icon,
         pricing_model = EXCLUDED.pricing_model,
         base_price_monthly_minor = EXCLUDED.base_price_monthly_minor,
         status = EXCLUDED.status,
         features = EXCLUDED.features;`,
      [app.id, app.name, app.description, app.icon, app.pricing_model, app.base_price_monthly_minor, app.status, app.features]
    );
  }

  console.log(`[Seed] Seeded ${defaultApps.length} ecosystem apps.`);

  // Ensure demo organization exists
  const existingOrg = await db.unsafe(`SELECT id, name FROM organizations LIMIT 1;`) as any[];
  let orgId = existingOrg[0]?.id;

  if (!orgId) {
    console.log(`[Seed] Creating default demonstration organization...`);
    const newOrg = await db.unsafe(`
      INSERT INTO organizations (name, slug, status)
      VALUES ('Aevo Corporation', 'aevo-corp', 'ACTIVE')
      RETURNING id;
    `) as any[];
    orgId = newOrg[0].id;
  }

  console.log(`[Seed] Active organization ID: ${orgId}`);

  // Ensure flagship store exists
  const existingStore = await db.unsafe(`SELECT id, code FROM stores WHERE organization_id = $1 LIMIT 1;`, [orgId]) as any[];
  let storeId = existingStore[0]?.id;

  if (!storeId) {
    console.log(`[Seed] Creating default flagship store...`);
    const newStore = await db.unsafe(`
      INSERT INTO stores (organization_id, name, code, timezone, status)
      VALUES ($1, 'Aevo Siam Flagship', 'BKK-01', 'Asia/Bangkok', 'ACTIVE')
      RETURNING id;
    `, [orgId]) as any[];
    storeId = newStore[0].id;
  }

  console.log(`[Seed] Active store ID: ${storeId}`);

  // Seed the canonical organization plan and its server-resolved entitlements.
  await db.unsafe(`
    INSERT INTO subscriptions (organization_id, plan_id, provider, status)
    VALUES ($1, 'starter', 'MANUAL', 'TRIALING')
    ON CONFLICT (organization_id) DO NOTHING;
  `, [orgId]);
  await db.unsafe(`
    INSERT INTO organization_entitlements (organization_id, feature_key, is_enabled, custom_override, limit_value)
    SELECT $1, feature_key, is_enabled, false, limit_value
    FROM plan_entitlements
    WHERE plan_id = 'starter'
    ON CONFLICT (organization_id, feature_key) DO NOTHING;
  `, [orgId]);

  console.log(`[Seed] Successfully finished seeding Aevo Hub data!`);
  await db.close();
}

if (import.meta.main) {
  seed().catch((err) => {
    console.error("[Seed] Seed failed:", err);
    process.exit(1);
  });
}
