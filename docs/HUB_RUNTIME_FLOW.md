# Aevo Hub local runtime flow

เอกสารนี้เป็น source of truth สำหรับ Hub หลัง cutover ใน development
โดยมี web surface เดียวคือ Modern Console ที่ `:4330`.

## Runtime boundary

| Surface | URL | Owner | หน้าที่ |
| --- | --- | --- | --- |
| Modern Console | `http://localhost:4330/modern` | `apps/hub` React Router Framework Mode | canonical authenticated Hub workspace |
| Edge API | `http://localhost:4000` | `aevo-edge-gateway` | browser API boundary, CORS, signing และ forwarding |
| Accounts | `http://localhost:8787` | `aevo-accounts` Worker | identity provider broker |
| Core API | `http://127.0.0.1:5099` | `aevo-core-api` | app sessions, authorization, tenant data และ contracts |

Hub ไม่มี public-home server, API gateway, static HTML adapter หรือ route
compatibility process แล้ว `:4321` จึงไม่ใช่ส่วนหนึ่งของ Hub local runtime
อีกต่อไป. `aevo-digital-sing` อยู่นอกขอบเขตนี้.

## Flow การเริ่มระบบ

```text
Modern Console :4330
        │ browser /api/* ผ่าน Vite proxy
        ▼
Edge Gateway :4000 ───────► Core API :5099
                                  │
                                  └──► Accounts :8787 สำหรับ identity
```

คำสั่ง `cd aevo-hub && bun run dev` เริ่มเฉพาะสี่ service นี้:

1. Accounts `:8787`
2. Core API `:5099`
3. Edge Gateway `:4000`
4. Modern Console `:4330`

## Canonical routes

ทุก route ใช้ React Router basename `/modern`:

```text
/modern
/modern/login
/modern/forgot-password
/modern/reset-password
/modern/onboarding
/modern/settings
/modern/stores
/modern/stores/:storeId
/modern/security
```

`/modern` เป็นจุดเริ่มต้นเดียวทั้งก่อนและหลัง login. ปุ่ม Home ใน shell จะ
กลับมายัง `AEVO_HUB_HOME_URL` ซึ่ง local default คือ `http://localhost:4330`;
การ redirect ของ worker จะพาเข้าสู่ `/modern` โดยไม่สร้าง origin ที่สอง.

## Scope-aware workspace navigation

Shell แสดง `Organization context` เป็น interactive popover ที่อ่านรายการ Store
จาก Core API แบบ tenant-scoped แทน native `<select>`. Popover มี search แบบ
real-time, keyboard navigation (`Cmd/Ctrl+K`, `↑`, `↓`, `Enter`, `Esc`),
สถานะ Active/Closed ของแต่ละสาขา และ action สร้าง Store ผ่าน Core action เดิม.
ค่า `Organization` จะพากลับไปยังภาพรวมองค์กร; การเลือก Store จะพาไปยัง
`/modern/stores/:storeId` และทุก tab ใน route นี้จะโหลดและเขียนข้อมูลของ Store
นั้นเท่านั้น.

เมนูด้านซ้ายเปลี่ยนตาม scope ที่เลือก:

- Organization scope แสดง Overview, Businesses & locations, Applications,
  Team & access, Analytics, Integrations, Billing, Audit & security และ
  Organization settings.
- Store scope แสดง Overview, Apps & features, Products & catalog และ Branch
  settings ของ Store นั้น พร้อมกลุ่ม `Enabled apps` ที่สร้างจากรายการ binding
  `ACTIVE` ที่ Core ส่งกลับมาเท่านั้น. รายการของแต่ละแอปจะเปิด drawer สำหรับ
  typed configuration เบื้องต้นของ Store นั้น และไม่ปนกับ Organization settings.
  Team & shifts, Devices & terminals และ Analytics จะแสดงเป็น `Soon` จนกว่า
  Core จะมี contract/read model ของส่วนนั้น.
- รายการที่ยังไม่มี route หรือ contract จะไม่ถูกทำเป็นลิงก์หลอก และการสลับ
  scope ไม่เปลี่ยน authorization decision ใน browser; ทุก loader/action ยังคง
  ตรวจ scope ซ้ำที่ Core.

- `/modern/settings` แก้เฉพาะข้อมูล Organization, team, integrations,
  assignments และ entitlement ระดับองค์กร.
- `/modern/stores/:storeId` แก้ identity, public profile, applications,
  typed app configuration และ catalog ของ Store ที่เลือก.
- Store mutations จะ revalidate รายการใน context picker เพื่อให้ Store ที่
  สร้างหรือ duplicate ใหม่เลือกได้ทันที.
- Context picker เป็น navigation aid เท่านั้น; Core API ยังคงตรวจ membership,
  permission, organization scope และ store scope ซ้ำในทุก loader/action.

## Authentication and authorization

1. Route loader เรียก `GET /api/auth/me` และ
   `GET /api/v1/access?application=HUB` ผ่าน Edge.
2. Anonymous request ไป `/modern/login` พร้อม safe relative return path.
3. Password identity ถูก broker โดย Accounts; provider OAuth จะเปิดได้ต่อเมื่อ
   versioned start/callback contract ถูก deploy ครบ. Core API ออก opaque
   app-scoped Hub session cookie. ค่าเริ่มต้นเป็น browser-session cookie และ
   checkbox `จดจำอุปกรณ์นี้` จะส่ง `rememberMe` ให้ Accounts/Core เพื่อออก
   persistent cookie ที่ถูกเก็บถึง absolute timeout 30 วัน ขณะที่ idle timeout
   ฝั่ง Core อยู่ที่ 7 วัน (ปรับได้ที่ Core ด้วยค่าที่ถูก clamp ไม่เกิน 30 วัน).
4. Hub server loader ส่ง cookie เดิมกลับผ่าน Core client และไม่อ่าน bearer
   token ใน browser.
5. Core API ตัดสิน membership, application assignment, organization/store
   scope, role, permission, subscription/entitlement และ store app access.
   การตรวจ entitlement ใช้กับ app เชิงพาณิชย์ทั้ง launch decision และ app
   session resolution; Hub ตรวจ app อื่นได้แบบ read-only เท่านั้นและไม่ได้รับ
   cookie ของ app นั้น.
6. CSRF token ใช้กับ cookie-session mutation และ child route ทำ access check
   ฝั่ง server ซ้ำตามขอบเขตของ route.

ระบบไม่ใช้ localStorage/sessionStorage สำหรับ token หรือ password. การเลือก
remember ถูกเก็บเป็น boolean ใน Core session row เท่านั้น; logout, password
recovery/password change และ session revocation ยังคงยกเลิก session ฝั่ง server
ได้ตามปกติ. ไม่ควรเลือกบนเครื่องสาธารณะ.

## Workforce app launch

ปุ่มเปิด Aevo Play/POS จาก Hub ไม่ใช้ URL ของแอปเป็นสิทธิ์อีกต่อไป. Hub
ส่ง `POST /api/v1/hub/applications/:applicationCode/launch` ไปยัง Core API
พร้อม `storeId` เมื่อเริ่มจาก Store workspace. Core ตรวจ registry,
membership, application assignment, store binding, entitlement และ signed
handshake/readiness ของ target API ก่อนออก launch URL ไปยัง
`/api/auth/start` ของแอปนั้น. แอปจะสร้าง flow cookie ของตัวเองและเดินต่อผ่าน
Accounts พร้อม one-time code, state และ PKCE.

ดังนั้นการทดสอบปุ่ม `Open full app` จาก drawer ของแอป หรือปุ่ม `Open Aevo Play`
และ `Open Aevo POS` ใน app card ต้องเปิด API ของ target app และตั้ง
`AEVO_HANDSHAKE_SHARED_SECRET` ให้ตรงกับ Core ก่อน. ถ้า target API ไม่พร้อม
Hub จะแสดง readiness failure และจะไม่ redirect แบบ direct URL. Kiosk และ
Queue ยังแสดงสถานะ callback unavailable จนกว่าจะมี runtime callback ที่ deploy
ได้จริง. Aevo Go ยังคงใช้ customer SSO flow ของตัวเองและไม่อยู่ใน workforce
launch control นี้.

ถ้า launch ถูกปฏิเสธด้วย assignment, store binding หรือ entitlement Hub จะ
คงผู้ใช้ไว้ใน Store workspace พร้อมแสดง error ที่อ่านได้และลิงก์ไปยัง Team &
access, entitlement settings หรือ app settings ตามสาเหตุ แทนการ redirect เงียบ
จนผู้ใช้ไม่ทราบว่าต้องแก้จุดใด.

401 ก่อน login เป็นพฤติกรรมปกติ. หลัง login ที่ถูกต้องควรเห็น `200` จาก
`/api/auth/me` และ access decision เป็น `ALLOWED`.

Passkey UI ถูก guard ด้วย `AEVO_PASSKEY_ENABLED` และ local default เป็น
`false` จนกว่า Accounts/Core จะ publish WebAuthn options, verification และ
management routes ใน versioned contract. OAuth provider UI ก็ถูก guard ด้วย
`AEVO_OAUTH_ENABLED` และ local default เป็น `false` จนกว่า route จะพร้อมจริง
เช่นกัน จึงไม่ควรเห็นปุ่มที่เรียก endpoint ที่ยังไม่มี; password และ recovery
เป็น flow หลักใน local cutover.

## การทดสอบ local

```bash
cd /Users/jayc/Project/aevo-ecosystem/aevo-hub
bun run dev
```

เปิด `http://localhost:4330/modern` แล้วทดสอบตามลำดับ:

```text
/modern
/modern/settings
/modern/stores
/modern/stores/<store-id>
/modern/security
```

ตรวจ boundary แบบ read-only ได้ด้วย:

```bash
curl -fsS http://localhost:4000/health
curl -fsS http://127.0.0.1:5099/health/live
curl -fsS http://localhost:4330/modern
```

หากพบ `5xx` หรือ `502` ให้ตรวจ Core → Accounts และ Edge → Core ก่อน. หาก
พบ `401` หลัง login ให้ตรวจ app cookie `HUB`, origin `:4330`, และ Core
session projection. ไม่มี `/organize`, `/workspace`, `/setup` หรือ
`/api/v1/query/models` เป็น Hub compatibility route อีกต่อไป.

เมื่อต้องการทดสอบ workforce launch ให้เปิด Play/POS เพิ่มจาก repository
ของแอป แล้วเปิด store ใน `/modern/stores/:storeId?view=apps`, enable app,
ทดสอบ connection และกด `Open`. การ enable store app ไม่ได้แทนที่ member
assignment หรือ subscription entitlement; ทั้งสามเงื่อนไขยังถูกตรวจใน Core
ทุกครั้งที่ launch และ exchange.

## Ownership rule

- Modern Hub เป็น owner ของ UI และ server-side API client.
- Edge เป็น ingress เท่านั้น ไม่ใช่ domain owner.
- Core API เป็น owner ของ contracts, sessions, authorization และ tenant data.
- Core API/Infrastructure เป็น owner ของ migration ledger และเป็นผู้เดียวที่
  apply control-plane migrations; local onboarding เขียนผ่าน Core canonical
  organization/store/installation projections เท่านั้น.
- Accounts เป็น owner ของ identity-provider interaction.
- Core API/Infrastructure เป็นผู้เดียวที่ apply database migrations.
- Supabase migration files ที่ยังอยู่ใน Hub เป็น app-domain history เท่านั้น;
  retired control-plane migration files ถูกลบแล้ว. Hub launcher ไม่ apply และ
  ไม่เขียน migration.
