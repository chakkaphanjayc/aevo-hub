# 🚀 Aevo Hub — Central Gateway & Ecosystem Orchestrator

ศูนย์กลางบัญชี ผู้ใช้ องค์กร ร้านค้า สมาชิก สิทธิ์ (RBAC) การสมัครบริการ (Subscriptions) และ **Canonical API Gateway** สำหรับทุกแอปพลิเคชันในระบบนิเวศ Aevo (`aevo-pos`, `aevo-kiosk`, `aevo-booking`, `aevo-crm`, `aevo-odoo-bridge`) เชื่อมต่อกับ Supabase กลางตัวเดียว พร้อม Universal Query Platform สำหรับค้นหา นำเข้า และส่งออกข้อมูลแบบ tenant-safe

---

## 🏗 Architecture Overview

```mermaid
flowchart TB
    subgraph Apps["Ecosystem Applications"]
        POS["Aevo POS (Cashier)"]
        KIOSK["Aevo Kiosk / KDS"]
        BOOKING["Aevo Booking (Venues)"]
        ODOO["Aevo-Odoo Bridge"]
        WEB["Aevo Hub Web Console"]
    end

    subgraph Gateway["Aevo Hub Gateway (Port 4000)"]
        S1["Surface 1: Hub & Subscriptions (/api/v1/hub/*)"]
        S2["Surface 2: Staff & Operations (/api/v1/staff/*)"]
        S3["Surface 3: Public QR Ordering (/api/v1/public/*)"]
        S4["Surface 4: Hardware & Devices (/api/v1/device/*)"]
        QUERY_EP["Universal Query Platform (/api/v1/query/*)"]
    end

    subgraph Database["Central Supabase Database"]
        PG["PostgreSQL 17"]
        AUTH["Supabase Auth"]
        STORAGE["Supabase Storage"]
        RT["Supabase Realtime"]
    end

    POS -->|@aevo/hub-client + Supabase access token| Gateway
    KIOSK -->|HTTP + Device Token| Gateway
    BOOKING -->|@aevo/hub-client + Supabase access token| Gateway
    ODOO -->|Server-managed access token| Gateway
    WEB -->|HTTP + HttpOnly session cookie| Gateway

    Gateway -->|Supabase PostgREST + RLS| PG
    Gateway -->|supabase-js Client| AUTH
    Gateway -->|Realtime Channels| RT
```

---

## 📦 Project Structure

```text
/Users/jayc/Project/aevo-ecosystem/aevo-hub
├── apps/
│   ├── gateway/                 # Elysia.js Canonical API Gateway (Port 4000)
│   │   ├── src/
│   │   │   ├── index.ts         # Gateway server entrypoint
│   │   │   ├── app.ts           # Canonical surfaces + Query Platform
│   │   │   ├── http.ts          # HTTP request/response helpers
│   │   │   └── rate-limit.ts    # Fixed window rate limiters
│   └── web/                     # Aevo Hub Web Portal (Port 4321)
│       └── src/
│           ├── server.ts        # Portal web server
│           └── public/
│               ├── workspace.html # Operational dashboard
│               ├── organize.html  # Organization and store management
│               ├── admin.html     # Protected platform administration
│               └── auth.js        # Cookie session + CSRF client helper
├── packages/
│   ├── contracts/               # Shared interfaces, permissions, role matrices
│   ├── db/                      # Supabase client, domain repositories & Query Platform
│   └── sdk/                     # @aevo/hub-client (Universal Gateway Client SDK)
├── scripts/
│   ├── migrate.ts               # Standalone SQL migration runner (PostgreSQL 17)
│   ├── sql.ts                   # CLI arbitrary SQL query runner
│   └── seed.ts                  # Seeds 7 ecosystem apps, demo org, and store
├── supabase/
│   └── migrations/              # Versioned SQL migration files
└── test/
    └── gateway.test.ts          # End-to-end integration tests for all 4 surfaces
```

---

## ⚡ Quick Start

### 1. ติดตั้ง Dependencies
```bash
bun install
```

### 2. ตั้งค่า Environment Variables
ไฟล์ `.env` ถูกตั้งค่าเชื่อมต่อกับ Supabase ให้พร้อมใช้งานทันที:
```ini
DATABASE_URL=postgresql://postgres:<password>@<db-host>:5432/postgres?sslmode=require
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_<server-only-key>
SESSION_COOKIE_SECRET=<long-random-secret>
CSRF_COOKIE_NAME=aevo_csrf
PLATFORM_ADMIN_EMAILS=platform-admin@example.com
API_PORT=4000
WEB_PORT=4321
```

### 3. รัน Database Migrations & Seed
```bash
# รันไฟล์ Migrations ทั้งหมดเข้าสู่ Supabase
bun run db:migrate

# ตรวจสอบหรือรันคำสั่ง SQL ผ่าน CLI
bun run db:query "SELECT id, name, pricing_model FROM apps;"

# Seed ข้อมูลเริ่มต้น (7 แอป, องค์กร และสาขา)
bun run db:seed
```

### 4. รัน API Gateway & Web Portal
```bash
# รัน Canonical API Gateway (Port 4000)
bun run dev:gateway

# รัน Aevo Hub Web Portal (Port 4321)
bun run dev:web
```

---

## 📡 Canonical API Gateway Surfaces

Gateway แบ่งพื้นผิว API ออกเป็น 4 ส่วนอย่างชัดเจน พร้อมความปลอดภัยและสิทธิ์:

### Surface 1: Aevo Hub Platform Management (`/api/v1/hub/*`)
- `GET /api/v1/hub/me` — ข้อมูลผู้ใช้ สิทธิ์ และองค์กรปัจจุบัน
- `GET /api/v1/hub/apps` — รายการแอปทั้งหมดในระบบนิเวศ (POS, Kiosk, Booking, CRM, Inventory, Odoo, etc.)
- `GET /api/v1/hub/organizations` — รายการองค์กรของผู้ใช้
- `POST /api/v1/hub/organizations` — สร้างองค์กรใหม่
- `GET /api/v1/hub/stores` — รายชื่อสาขาในองค์กร
- `POST /api/v1/hub/stores` — สร้างสาขาใหม่
- `GET /api/v1/hub/subscriptions` — projection ของ plan และ entitlement ระดับองค์กร แยกตามแอปที่ catalog รองรับ
- `POST /api/v1/hub/billing/portal` — เข้าสู่ Stripe Customer Portal เพื่อจัดการบิลและการชำระเงิน
- `GET /api/v1/query/models` — metadata และ capabilities ของโมเดลที่ค้นหาได้
- `POST /api/v1/query/execute` — รัน Query AST ที่ตรวจสอบแล้วภายใต้ organization/store scope
- `POST /api/v1/query/imports` — preview/validate import job แบบ idempotent
- `POST /api/v1/query/exports` — export CSV/JSON จาก Query AST เดียวกัน

### Surface 2: Staff & Operations (`/api/v1/staff/*`)
- `GET /api/v1/staff/context` — ข้อมูลบริบทแคชเชียร์ ร้านค้า และรอบกะปัจจุบัน
- `GET /api/v1/staff/catalog` — สินค้า หมวดหมู่ ท็อปปิ้ง สำหรับหน้าร้าน
- `POST /api/v1/staff/orders` — สร้างออเดอร์ใหม่จากหน้าร้าน POS
- `POST /api/v1/staff/orders/:orderId/pay` — บันทึกการชำระเงิน (Cash, PromptPay, External Card)
- `POST /api/v1/staff/cash-sessions/open` — เปิดรอบกะเงินสด
- `POST /api/v1/staff/cash-sessions/close` — ปิดรอบกะและตรวจนับเงินสด
- `POST /api/v1/staff/reports/closing/daily` — สร้างรายงานสรุปยอดขายประจำวัน (Daily Closing)

### Surface 3: Public Consumer (`/api/v1/public/*`)
- `GET /api/v1/public/stores/:storeCode/menu` — เมนูและสินค้าสำหรับลูกค้าสแกน QR
- `POST /api/v1/public/stores/:storeCode/orders` — ลูกค้าสั่งอาหารด้วยตนเองผ่านมือถือ
- `GET /api/v1/public/orders/track/:token` — ตรวจสอบสถานะการปรุงและการจัดเตรียมออเดอร์
- `GET /api/v1/public/venues/:venueSlug/availability` — ตรวจสอบช่วงเวลาสนามที่ว่าง
- `POST /api/v1/public/venues/:venueSlug/bookings` — ลูกค้าจองสนามออนไลน์

### Surface 4: Hardware & Device Terminals (`/api/v1/device/*`)
- `POST /api/v1/device/pair` — จับคู่อุปกรณ์หน้าร้าน (Kiosk, POS Terminal, จอ KDS ในครัว) ด้วย Pairing Code 8 หลัก
- `GET /api/v1/device/context` — ข้อมูลสาขาและโหมดของเครื่อง
- `GET /api/v1/device/preparation` — รายการคิวเตรียมอาหารในห้องครัว (KDS)

---

## 💻 How External Apps Connect (`aevo-pos`, `aevo-booking`, etc.)

แอปภายนอกสามารถเชื่อมต่อผ่าน Gateway Client SDK `@aevo/hub-client` หรือ HTTP Requests:

### วิธีที่ 1: ใช้ Gateway Client SDK (`@aevo/hub-client`)

```typescript
import { createAevoClient } from "@aevo/hub-client";

// กำหนดการเชื่อมต่อไปยัง Aevo Gateway
const aevo = createAevoClient({
  baseUrl: process.env.PUBLIC_API_URL || "http://localhost:4000",
  accessToken: process.env.SUPABASE_ACCESS_TOKEN,
  organizationId: "b7c16dab-2e9f-495e-a871-6a59f8590fd0",
  storeId: "cf616454-2a48-43da-815e-99e26421c679"
});

// 1. ดึงรายการแอปและการสมัครสมาชิก
const apps = await aevo.hub.listApps();
console.log("Ecosystem Apps:", apps);

// 2. ดึงแคตตาล็อกสินค้าสำหรับแคชเชียร์
const catalog = await aevo.staff.getCatalog();

// 3. สร้างออเดอร์
const { order, queueTicket } = await aevo.staff.createOrder({
  storeId: "cf616454-2a48-43da-815e-99e26421c679",
  channel: "POS",
  fulfillmentType: "DINE_IN",
  items: [
    { productId: "prod-1", quantity: 2 }
  ]
});

// 4. ค้นหาข้อมูลผ่าน Query AST ที่ปลอดภัยและ tenant-scoped
const products = await aevo.query.execute({
  query: {
    version: 1,
    model: "product.product",
    where: { type: "condition", field: "name", operator: "contains", value: "white" },
    fields: ["sku", "name", "base_price_minor"],
    pagination: { limit: 50, offset: 0 }
  }
});
console.log("Products:", products.rows);
```

### วิธีที่ 2: ใช้ HTTP Fetch Direct

```bash
# 1. ดูรายการแอปในระบบนิเวศ
curl -s http://localhost:4000/api/v1/hub/apps

# 2. ค้นหาข้อมูลผ่าน Query AST (ส่ง access token จาก server-side client)
curl -s -X POST http://localhost:4000/api/v1/query/execute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -d '{"query":{"version":1,"model":"res.store","fields":["code","name"],"pagination":{"limit":50,"offset":0}}}'

# 3. จับคู่ตู้ Kiosk
curl -s -X POST http://localhost:4000/api/v1/device/pair \
  -H "Content-Type: application/json" \
  -d '{"pairingCode": "12345678"}'
```

---

## 🧪 Testing & Verification

รันชุดการทดสอบแบบ End-to-End ครอบคลุม session, tenant boundary, canonical surfaces และ Query Platform:

```bash
# รัน Typecheck ตรวจสอบความถูกต้องของ Type ทั้งระบบ
bun run typecheck

# รัน Integration Test Suite (session, tenant, gateway, and security flows)
bun test
```

ผลลัพธ์การทดสอบ:
```text
The suite verifies the canonical application-session cookie flow, CSRF-protected
mutations, tenant isolation, platform/admin separation, onboarding, and all
gateway surfaces.
```

---

## 🌐 Web Console

เมื่อรัน `bun run dev:web`:
- **Workspace (`http://localhost:4321/workspace`)**: พื้นที่ปฏิบัติการสำหรับแอป อุปกรณ์ และการเรียกเก็บเงิน
- **Organization (`http://localhost:4321/organize`)**: จัดการโปรไฟล์ สาขา สมาชิก และสิทธิ์การเข้าถึง
- **Query Workbench (`http://localhost:4321/workspace`)**: ค้นหาและบันทึกมุมมองข้อมูลผ่าน Query AST

การเปลี่ยน schema ใช้ versioned migrations (`bun run db:migrate`) และการตรวจสอบฐานข้อมูลใช้ CLI เท่านั้น ไม่มี arbitrary SQL endpoint หรือ SQL console ในเว็บ/SDK

### Authentication

เว็บพอร์ทัลใช้ `HttpOnly` opaque session cookie และ CSRF cookie ที่อ่านได้เฉพาะสำหรับส่งกลับเป็น header ในคำขอที่แก้ไขข้อมูล ส่วน Supabase access/refresh tokens จะถูกเข้ารหัสและเก็บไว้เฉพาะใน `app_sessions` บนเซิร์ฟเวอร์เท่านั้น

รองรับ login, refresh rotation, logout, password recovery, idle/absolute session expiry และการดูหรือ revoke session รายตัว/ทั้งหมดผ่าน `/api/auth/sessions` และ `/api/auth/sessions/revoke-all`.

ต้องรัน migration ใหม่ `20260918150000_app_sessions.sql` ก่อนเปิดใช้งาน login/session ใน deployment ใหม่หรือ deployment เดิม
