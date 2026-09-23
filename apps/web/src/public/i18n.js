const STORAGE_KEY = "aevo.hub.locale";
const USER_STORAGE_PREFIX = "aevo.hub.locale.user.";

export const supportedLocales = ["en", "th"];
export const localeLabels = {
  en: "English",
  th: "ไทย"
};

const translations = {
  en: {
    "language.label": "Language",
    "language.english": "English",
    "language.thai": "ไทย",
    "common.back": "Back",
    "common.cancel": "Cancel",
    "common.close": "Close",
    "common.save": "Save",
    "common.signIn": "Sign in",
    "common.signOut": "Sign out",
    "common.loading": "Loading…",
    "common.open": "Open",
    "common.manage": "Manage",
    "nav.overview": "Overview",
    "nav.organizationWorkspace": "Organization workspace",
    "nav.stores": "Stores & branches",
    "nav.team": "Team & access",
    "nav.apps": "App subscriptions",
    "nav.billing": "Billing & subscription",
    "nav.settings": "Settings",
    "nav.applications": "Applications",
    "nav.hardware": "Hardware & terminals",
    "nav.billingPlans": "Billing & plans",
    "nav.manageOrganization": "Manage organization",
    "nav.organizationSettings": "Organization settings",
    "nav.workspace": "Workspace",
    "nav.business": "Business",
    "nav.brandSettings": "Brand settings",
    "nav.storeWorkspace": "Store workspace",
    "nav.operations": "Operations",
    "nav.storePulse": "Store pulse",
    "nav.posRegister": "POS register",
    "nav.selfKiosk": "Self kiosk",
    "nav.bookings": "Bookings & venues",
    "nav.storeDevices": "Store devices",
    "nav.storeSettings": "Store settings",
    "nav.pinned": "Pinned",
    "nav.currentScope": "Current scope:",
    "nav.secureWorkspace": "Secure scoped workspace",
    "settings.language.eyebrow": "User preference",
    "settings.language.title": "Language",
    "settings.language.description": "Choose the interface language for this account. It is saved to your profile and used on your next visit.",
    "auth.login.title": "Welcome back",
    "auth.login.subtitle": "Sign in to manage your stores and applications.",
    "auth.login.email": "Email address",
    "auth.login.password": "Password",
    "auth.login.forgot": "Forgot password?",
    "auth.login.submit": "Sign in →",
    "auth.login.noAccount": "Don't have an account?",
    "auth.login.register": "Create a free account →",
    "auth.login.back": "← Back to Aevo Hub home",
    "auth.register.title": "Create your Aevo ID",
    "auth.register.subtitle": "Manage your stores, apps, and business operations from one place.",
    "auth.register.name": "Full name",
    "auth.register.email": "Email address",
    "auth.register.password": "Password",
    "auth.register.confirm": "Confirm password",
    "auth.register.terms": "I agree to Aevo Hub’s Terms of Service and Privacy Policy.",
    "auth.register.namePlaceholder": "e.g. Alex Morgan",
    "auth.register.passwordPlaceholder": "At least 8 characters",
    "auth.register.confirmPlaceholder": "Enter the password again",
    "auth.register.submit": "Create account →",
    "auth.register.hasAccount": "Already have an account?",
    "auth.register.signIn": "Sign in →",
    "auth.register.back": "← Back to Aevo Hub home",
    "auth.forgot.eyebrow": "Aevo Hub / Account security",
    "auth.forgot.title": "Reset your password",
    "auth.forgot.description": "Enter your account email and we’ll send a one-time password reset link if the account exists.",
    "auth.forgot.email": "Email address",
    "auth.forgot.submit": "Send reset link",
    "auth.forgot.back": "← Back to sign in",
    "auth.reset.eyebrow": "Aevo Hub / Account security",
    "auth.reset.title": "Choose a new password",
    "auth.reset.description": "This one-time recovery link expires automatically. Your existing Aevo Hub sessions will be signed out after the change.",
    "auth.reset.password": "New password",
    "auth.reset.confirm": "Confirm password",
    "auth.reset.submit": "Update password",
    "auth.reset.back": "← Back to sign in",
    "landing.signIn": "Sign in",
    "landing.register": "Create account",
    "landing.openOrganize": "Open Organize →",
    "landing.openWorkspace": "Open Store Workspace →",
    "landing.signOut": "Sign out",
    "organize.title": "Organization workspace",
    "organize.chooseStore": "Choose a store →",
    "organize.openStore": "Open selected store →",
    "organize.setup": "Setup & readiness →",
    "organize.organizationSettings": "Organization settings",
    "organize.newOrganization": "+ New organization",
    "nav.setup": "Setup & readiness",
    "nav.profile": "Profile",
    "setup.objectives.title": "Start with your objectives",
    "setup.objectives.description": "Choose the work Aevo Hub should support first.",
    "setup.organization.title": "Tell us about the organization",
    "setup.organization.description": "These defaults keep every store and module aligned.",
    "setup.store.title": "Add the first store",
    "setup.store.description": "Give your team a clear operating context.",
    "setup.apps.title": "Choose the apps to enable",
    "setup.apps.description": "Select the modules this organization should have ready.",
    "setup.resources.title": "Shape the starting catalog",
    "setup.resources.description": "Add production catalog records from the workspace or configure booking resources.",
    "setup.staff.title": "Bring in the team",
    "setup.staff.description": "Invite a manager or teammate and keep access intentional.",
    "setup.complete.title": "Ready for the workspace",
    "setup.complete.description": "Review the live checks, then open your operational home.",
    "organize.settings": "Settings",
    "organize.page.overview.title": "Organization workspace.",
    "organize.page.overview.description": "Review every organization you can access, then choose one organization and enter its stores & branches.",
    "organize.page.profile.title": "Your organization.",
    "organize.page.profile.description": "Keep your business identity, locations, people, and applications in one place.",
    "organize.page.stores.title": "Stores & branches.",
    "organize.page.stores.description": "Manage the physical locations that operate under this organization.",
    "organize.page.team.title": "Team & access.",
    "organize.page.team.description": "Invite people and keep access aligned with their responsibilities.",
    "organize.page.apps.title": "App subscriptions.",
    "organize.page.apps.description": "Choose the modules each store needs to run the business.",
    "organize.page.billing.title": "Billing & Subscription.",
    "organize.page.billing.description": "Commercial plan tier, server-resolved entitlements, quota usage, and Stripe portal.",
    "organize.page.settings.title": "Scoped settings.",
    "organize.page.settings.description": "Choose organization settings or one store / branch before changing configuration.",
    "workspace.title": "Store workspace",
    "workspace.settings": "Settings",
    "admin.title": "Platform administration",
    "admin.signOut": "Sign out"
  },
  th: {
    "language.label": "ภาษา",
    "language.english": "English",
    "language.thai": "ไทย",
    "common.back": "ย้อนกลับ",
    "common.cancel": "ยกเลิก",
    "common.close": "ปิด",
    "common.save": "บันทึก",
    "common.signIn": "เข้าสู่ระบบ",
    "common.signOut": "ออกจากระบบ",
    "common.loading": "กำลังโหลด…",
    "common.open": "เปิด",
    "common.manage": "จัดการ",
    "nav.overview": "ภาพรวม",
    "nav.organizationWorkspace": "พื้นที่องค์กร",
    "nav.stores": "ร้านค้าและสาขา",
    "nav.team": "ทีมและสิทธิ์",
    "nav.apps": "แอปที่ใช้งาน",
    "nav.billing": "การเรียกเก็บเงินและแพ็กเกจ",
    "nav.settings": "การตั้งค่า",
    "nav.applications": "แอปพลิเคชัน",
    "nav.hardware": "ฮาร์ดแวร์และเทอร์มินัล",
    "nav.billingPlans": "การเรียกเก็บเงินและแพ็กเกจ",
    "nav.manageOrganization": "จัดการองค์กร",
    "nav.organizationSettings": "ตั้งค่าองค์กร",
    "nav.workspace": "พื้นที่ทำงาน",
    "nav.business": "ธุรกิจ",
    "nav.brandSettings": "การตั้งค่าแบรนด์",
    "nav.storeWorkspace": "พื้นที่จัดการร้านค้า",
    "nav.operations": "การปฏิบัติงาน",
    "nav.storePulse": "ภาพรวมร้านค้า",
    "nav.posRegister": "เครื่อง POS",
    "nav.selfKiosk": "ตู้สั่งซื้อด้วยตนเอง",
    "nav.bookings": "การจองและสถานที่",
    "nav.storeDevices": "อุปกรณ์ร้านค้า",
    "nav.storeSettings": "ตั้งค่าร้านค้า",
    "nav.pinned": "รายการปักหมุด",
    "nav.currentScope": "ขอบเขตปัจจุบัน:",
    "nav.secureWorkspace": "พื้นที่ทำงานแบบจำกัดสิทธิ์",
    "settings.language.eyebrow": "การตั้งค่าผู้ใช้",
    "settings.language.title": "ภาษา",
    "settings.language.description": "เลือกภาษาของหน้าจอสำหรับบัญชีนี้ ระบบจะบันทึกไว้ในโปรไฟล์และใช้ในครั้งถัดไป",
    "auth.login.title": "ยินดีต้อนรับกลับ",
    "auth.login.subtitle": "เข้าสู่ระบบเพื่อจัดการร้านค้าและแอปของคุณ",
    "auth.login.email": "อีเมล",
    "auth.login.password": "รหัสผ่าน",
    "auth.login.forgot": "ลืมรหัสผ่าน?",
    "auth.login.submit": "เข้าสู่ระบบ →",
    "auth.login.noAccount": "ยังไม่มีบัญชี?",
    "auth.login.register": "สมัครบัญชีฟรี →",
    "auth.login.back": "← กลับสู่หน้าหลัก Aevo Hub",
    "auth.register.title": "สร้าง Aevo ID",
    "auth.register.subtitle": "จัดการร้านค้า แอป และการดำเนินงานธุรกิจจากที่เดียว",
    "auth.register.name": "ชื่อเต็ม",
    "auth.register.email": "อีเมล",
    "auth.register.password": "รหัสผ่าน",
    "auth.register.confirm": "ยืนยันรหัสผ่าน",
    "auth.register.terms": "ฉันยอมรับข้อกำหนดการใช้งานและนโยบายความเป็นส่วนตัวของ Aevo Hub",
    "auth.register.namePlaceholder": "เช่น สมชาย วงศ์สว่าง",
    "auth.register.passwordPlaceholder": "อย่างน้อย 8 ตัวอักษร",
    "auth.register.confirmPlaceholder": "พิมพ์รหัสผ่านอีกครั้ง",
    "auth.register.submit": "สร้างบัญชี →",
    "auth.register.hasAccount": "มีบัญชีอยู่แล้ว?",
    "auth.register.signIn": "เข้าสู่ระบบ →",
    "auth.register.back": "← กลับสู่หน้าหลัก Aevo Hub",
    "auth.forgot.eyebrow": "Aevo Hub / ความปลอดภัยบัญชี",
    "auth.forgot.title": "รีเซ็ตรหัสผ่าน",
    "auth.forgot.description": "กรอกอีเมลของบัญชี ระบบจะส่งลิงก์รีเซ็ตรหัสผ่านแบบใช้ครั้งเดียวหากพบบัญชีนี้",
    "auth.forgot.email": "อีเมล",
    "auth.forgot.submit": "ส่งลิงก์รีเซ็ต",
    "auth.forgot.back": "← กลับไปเข้าสู่ระบบ",
    "auth.reset.eyebrow": "Aevo Hub / ความปลอดภัยบัญชี",
    "auth.reset.title": "ตั้งรหัสผ่านใหม่",
    "auth.reset.description": "ลิงก์กู้คืนนี้ใช้ได้ครั้งเดียวและหมดอายุอัตโนมัติ เซสชัน Aevo Hub เดิมจะถูกออกจากระบบหลังเปลี่ยนรหัสผ่าน",
    "auth.reset.password": "รหัสผ่านใหม่",
    "auth.reset.confirm": "ยืนยันรหัสผ่าน",
    "auth.reset.submit": "อัปเดตรหัสผ่าน",
    "auth.reset.back": "← กลับไปเข้าสู่ระบบ",
    "landing.signIn": "เข้าสู่ระบบ",
    "landing.register": "สร้างบัญชี",
    "landing.openOrganize": "เปิด Organize →",
    "landing.openWorkspace": "เปิด Store Workspace →",
    "landing.signOut": "ออกจากระบบ",
    "organize.title": "พื้นที่จัดการองค์กร",
    "organize.chooseStore": "เลือกร้านค้า →",
    "organize.openStore": "เปิดร้านค้าที่เลือก →",
    "organize.setup": "ตั้งค่าและตรวจความพร้อม →",
    "organize.organizationSettings": "ตั้งค่าองค์กร",
    "organize.newOrganization": "+ สร้างองค์กร",
    "nav.setup": "ตั้งค่าและตรวจความพร้อม",
    "nav.profile": "โปรไฟล์",
    "setup.objectives.title": "เริ่มจากเป้าหมายของคุณ",
    "setup.objectives.description": "เลือกงานที่ต้องการให้ Aevo Hub รองรับก่อน",
    "setup.organization.title": "บอกเราเกี่ยวกับองค์กร",
    "setup.organization.description": "ค่าเริ่มต้นเหล่านี้ช่วยให้ทุกสาขาและโมดูลสอดคล้องกัน",
    "setup.store.title": "เพิ่มร้านค้าแรก",
    "setup.store.description": "กำหนดบริบทการทำงานที่ชัดเจนให้ทีม",
    "setup.apps.title": "เลือกแอปที่ต้องการเปิดใช้",
    "setup.apps.description": "เลือกโมดูลที่องค์กรนี้ต้องพร้อมใช้งาน",
    "setup.resources.title": "เตรียมแคตตาล็อกเริ่มต้น",
    "setup.resources.description": "เพิ่มข้อมูลจริงจาก workspace หรือกำหนดทรัพยากรสำหรับการจอง",
    "setup.staff.title": "เพิ่มทีมของคุณ",
    "setup.staff.description": "เชิญผู้จัดการหรือสมาชิกทีมและกำหนดสิทธิ์อย่างเหมาะสม",
    "setup.complete.title": "พร้อมเข้าสู่ workspace",
    "setup.complete.description": "ตรวจสอบสถานะล่าสุด แล้วเปิดพื้นที่ทำงานของคุณ",
    "organize.settings": "การตั้งค่า",
    "organize.page.overview.title": "พื้นที่จัดการองค์กร",
    "organize.page.overview.description": "ดูองค์กรที่คุณเข้าถึงได้ เลือกองค์กร แล้วเข้าสู่ร้านค้าและสาขาภายในองค์กรนั้น",
    "organize.page.profile.title": "องค์กรของคุณ",
    "organize.page.profile.description": "จัดการข้อมูลธุรกิจ สถานที่ ทีม และแอปพลิเคชันไว้ในที่เดียว",
    "organize.page.stores.title": "ร้านค้าและสาขา",
    "organize.page.stores.description": "จัดการสถานที่จริงที่ดำเนินงานภายใต้องค์กรนี้",
    "organize.page.team.title": "ทีมและสิทธิ์",
    "organize.page.team.description": "เชิญสมาชิกและกำหนดสิทธิ์ให้เหมาะกับความรับผิดชอบ",
    "organize.page.apps.title": "แอปที่ใช้งาน",
    "organize.page.apps.description": "เลือกโมดูลที่แต่ละร้านต้องใช้ในการดำเนินงาน",
    "organize.page.billing.title": "การเรียกเก็บเงินและแพ็กเกจ",
    "organize.page.billing.description": "ดูแพ็กเกจ สิทธิ์การใช้งาน โควตา และ Stripe billing portal",
    "organize.page.settings.title": "การตั้งค่าแบบมีขอบเขต",
    "organize.page.settings.description": "เลือกการตั้งค่าระดับองค์กรหรือร้านค้าก่อนเปลี่ยนแปลงข้อมูล",
    "workspace.title": "พื้นที่จัดการร้านค้า",
    "workspace.settings": "การตั้งค่า",
    "admin.title": "การจัดการแพลตฟอร์ม",
    "admin.signOut": "ออกจากระบบ"
  }
};

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function userStorageKey(userId) {
  return userId ? `${USER_STORAGE_PREFIX}${encodeURIComponent(userId)}` : STORAGE_KEY;
}

export function normalizeLocale(value) {
  const normalized = String(value || "").trim().toLowerCase().split(/[-_]/)[0];
  return supportedLocales.includes(normalized) ? normalized : null;
}

export function detectLocale() {
  const candidates = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator.language];
  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }
  return "en";
}

function readStoredLocale(userId) {
  const store = storage();
  if (!store) return null;
  try {
    const scoped = userId ? normalizeLocale(store.getItem(userStorageKey(userId))) : null;
    return scoped || normalizeLocale(store.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStoredLocale(locale, userId) {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, locale);
    if (userId) store.setItem(userStorageKey(userId), locale);
  } catch {
    // Private browsing and embedded webviews can make localStorage unavailable.
  }
}

function dictionaryValue(locale, key, fallback = "") {
  return translations[locale]?.[key] || translations.en[key] || fallback || key;
}

function isElementScope(value) {
  return value && typeof value.querySelectorAll === "function";
}

export function createI18n({ apiFetch } = {}) {
  let locale = readStoredLocale() || detectLocale();
  let activeUserId = null;

  function setDocumentLocale() {
    document.documentElement.lang = locale;
    document.documentElement.dir = "ltr";
  }

  function t(key, fallback = "") {
    return dictionaryValue(locale, key, fallback);
  }

  function mountSelector(root) {
    const selectId = `${root.id || "aevo-locale"}-select`;
    root.innerHTML = `<label class="locale-switcher-label" for="${selectId}">${t("language.label")}</label>
      <select class="locale-switcher-select" id="${selectId}" aria-label="${t("language.label")}">
        <option value="en">${t("language.english")}</option>
        <option value="th">${t("language.thai")}</option>
      </select>`;
    const select = root.querySelector("select");
    if (!select) return;
    select.value = locale;
    select.addEventListener("change", () => {
      void setLocale(select.value);
    });
  }

  function mountSelectors(scope = document) {
    if (!isElementScope(scope)) return;
    const roots = [];
    if (scope.matches?.("[data-locale-switcher]")) roots.push(scope);
    roots.push(...scope.querySelectorAll("[data-locale-switcher]"));
    roots.forEach((root) => mountSelector(root));
  }

  function translate(scope = document) {
    if (!isElementScope(scope)) return;
    scope.querySelectorAll("[data-i18n]").forEach((node) => {
      const key = node.dataset.i18n;
      if (!key) return;
      const value = t(key, node.textContent || "");
      if (node.dataset.i18nHtml === "true") node.innerHTML = value;
      else node.textContent = value;
    });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
      node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder || ""));
    });
    scope.querySelectorAll("[data-i18n-title]").forEach((node) => {
      node.setAttribute("title", t(node.dataset.i18nTitle || ""));
    });
    scope.querySelectorAll("[data-i18n-aria-label]").forEach((node) => {
      node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel || ""));
    });
    setDocumentLocale();
    mountSelectors(scope);
    document.dispatchEvent(new CustomEvent("aevo:locale-changed", { detail: { locale } }));
  }

  async function persistLocale() {
    if (!activeUserId || !apiFetch) return;
    try {
      await apiFetch("/api/v1/me/preferences", {
        method: "PATCH",
        body: JSON.stringify({ locale })
      });
    } catch (error) {
      // A client-side locale is still useful when the profile request is
      // temporarily unavailable. The next authenticated page retries it.
      if (error?.status !== 401) console.warn("Unable to persist locale preference", error);
    }
  }

  async function init(options = {}) {
    const hasPreference = Object.prototype.hasOwnProperty.call(options, "preference");
    if (options.userId) activeUserId = options.userId;

    let preference = options.preference;
    if (activeUserId && !hasPreference && apiFetch) {
      try {
        preference = (await apiFetch("/api/v1/me/preferences"))?.preferences;
      } catch (error) {
        if (error?.status !== 401) console.warn("Unable to load locale preference", error);
      }
    }

    const serverLocale = normalizeLocale(preference?.locale);
    locale = serverLocale || readStoredLocale(activeUserId) || detectLocale();
    writeStoredLocale(locale, activeUserId);
    translate(document);

    // Locale persistence is secondary to rendering the workspace. Do not
    // block the first authenticated paint on a profile write, especially when
    // the local Core API is still warming up or the preference table is not
    // ready yet.
    if (activeUserId && !serverLocale) void persistLocale();
    return locale;
  }

  async function setLocale(nextLocale) {
    const next = normalizeLocale(nextLocale);
    if (!next) return locale;
    locale = next;
    writeStoredLocale(locale, activeUserId);
    translate(document);
    // Keep the selector responsive while the preference is persisted in the
    // background. The next page load will reconcile from the server.
    void persistLocale();
    return locale;
  }

  return {
    init,
    setLocale,
    t,
    translate,
    mountSelectors,
    getLocale: () => locale,
    getIntlLocale: () => (locale === "th" ? "th-TH" : "en-US")
  };
}
