import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { StoreApplicationAccessSummary, StoreSummary } from "@aevocado/contracts";
import { Button, CommandMenu, Dialog, Input, PermissionDeniedState, Select, Spinner, StatusBadge } from "@aevocado/design-system";
import { Form, Link, Outlet, redirect, useLocation, useLoaderData, useMatches, useNavigate, useNavigation, useOutletContext } from "react-router";
import type { LoaderFunctionArgs, ShouldRevalidateFunctionArgs } from "react-router";
import { isAccessAllowed } from "@aevocado/app-access";
import { createHubClientDataCache, syncHubManifest } from "../lib/client-data-cache";
import { requireHubAccess } from "../lib/auth.server";
import type { HubLoaderData } from "../lib/auth.shared";

export async function loader({ request }: LoaderFunctionArgs): Promise<HubLoaderData> {
  const pathname = new URL(request.url).pathname;
  const returnPath = pathname === "/modern" || pathname.startsWith("/modern/") ? pathname : "/modern";
  const data = await requireHubAccess(request, returnPath);

  // A newly registered identity is authenticated before it has an
  // organization membership. That is an onboarding state, not a permanent
  // Hub denial. Keep all other access decisions fail-closed and visible.
  if (data.access.reason === "MEMBERSHIP_REQUIRED" && !data.me.principal) {
    const onboardingUrl = new URL("/modern/onboarding", request.url);
    onboardingUrl.searchParams.set("next", "/modern");
    throw redirect(onboardingUrl.toString());
  }

  return data;
}

export function shouldRevalidate({
  formMethod,
  currentUrl,
  nextUrl,
  defaultShouldRevalidate
}: ShouldRevalidateFunctionArgs): boolean {
  // The Hub shell contains identity and navigation context. Child loaders and
  // actions perform their own server-side access checks, so do not repeat the
  // shell's auth round-trip for every internal menu navigation or mutation.
  // Explicit revalidation still refreshes the shell state when requested.
  if (formMethod && formMethod !== "GET") {
    // Refresh the shell's store index after store-scoped mutations so a newly
    // created, duplicated, renamed, or archived store is immediately usable
    // from the context picker. Organization-only mutations do not need this
    // extra round trip.
    return currentUrl.pathname.includes("/stores") || nextUrl.pathname.includes("/stores");
  }
  if (currentUrl.pathname !== nextUrl.pathname || currentUrl.search !== nextUrl.search) return false;
  return defaultShouldRevalidate;
}

function AccessDenied({ data }: { data: HubLoaderData }) {
  const reason = data.access.reason.replaceAll("_", " ").toLowerCase();
  return (
    <main className="aevo-error-page">
      <PermissionDeniedState
        title="This account cannot open Aevo Hub"
        description={`The server checked the signed-in identity, organization membership, and Hub application assignment. The current decision is: ${reason}.`}
        action={<div className="aevo-page-heading__actions"><a className="aevo-button aevo-button--secondary" href={data.homeUrl}>Home</a><a className="aevo-button aevo-button--secondary" href="/modern">Return to Aevo Hub</a></div>}
      />
    </main>
  );
}

function ScopeIcon({ scope }: { scope: "organization" | "store" }) {
  return scope === "organization" ? (
    <svg className="aevo-scope-switcher__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 20h16M6 20V8l6-4 6 4v12M9 11h1m4 0h1M9 15h1m4 0h1" />
    </svg>
  ) : (
    <svg className="aevo-scope-switcher__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 10.5 12 4l9 6.5V20H3v-9.5ZM8 20v-5h8v5M7 10h.01M12 10h.01M17 10h.01" />
    </svg>
  );
}

function SearchIcon() {
  return <svg className="aevo-scope-switcher__search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></svg>;
}

function ChevronIcon() {
  return <svg className="aevo-scope-switcher__chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m7 9 5-5 5 5M7 15l5 5 5-5" /></svg>;
}

function readClientCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  const value = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function CheckIcon() {
  return <svg className="aevo-scope-switcher__check" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 12 4 4L19 6" /></svg>;
}

function PlusIcon() {
  return <svg className="aevo-scope-switcher__plus" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" /></svg>;
}

function storeStatus(store: StoreSummary): { label: string; active: boolean } {
  const active = (store.status ?? "ACTIVE").toUpperCase() === "ACTIVE";
  return { label: active ? "Active" : "Closed", active };
}

interface ScopeSwitcherProps {
  stores: StoreSummary[];
  currentStore?: StoreSummary;
  organizationId: string;
  open: boolean;
  focusSearchRequest: number;
  onOpenChange: (open: boolean) => void;
  onSelect: (storeId: string | null) => void;
  onCreateStore: () => void;
}

function ScopeSwitcher({
  stores,
  currentStore,
  organizationId,
  open,
  focusSearchRequest,
  onOpenChange,
  onSelect,
  onCreateStore
}: ScopeSwitcherProps) {
  const switcherRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [switchingTo, setSwitchingTo] = useState<string | null | undefined>(undefined);
  const navigation = useNavigation();

  useEffect(() => {
    if (navigation.state === "idle") {
      setSwitchingTo(undefined);
    }
  }, [navigation.state]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredStores = useMemo(() => {
    if (!normalizedQuery) return stores;
    return stores.filter((store) => `${store.name} ${store.code} ${store.timezone}`.toLowerCase().includes(normalizedQuery));
  }, [normalizedQuery, stores]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
      setSwitchingTo(undefined);
      return;
    }
    setActiveIndex(0);
    searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [focusSearchRequest, open]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!switcherRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onOpenChange, open]);

  function selectScope(storeId: string | null) {
    setSwitchingTo(storeId);
    onSelect(storeId);
    setTimeout(() => {
      onOpenChange(false);
    }, 120);
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, filteredStores.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectScope(activeIndex === 0 ? null : filteredStores[activeIndex - 1]?.id ?? null);
    }
  }

  const currentScopeName = currentStore?.name ?? "Organization";
  const currentScopeType = currentStore ? "Store scope" : "Organization scope";
  const currentScopeIdentity = currentStore
    ? `${currentStore.code} · ${currentStore.timezone}`
    : `${organizationId} · all stores`;

  return (
    <div className="aevo-context-switcher" ref={switcherRef}>
      <button
        className="aevo-context-trigger"
        type="button"
        aria-expanded={open}
        aria-controls="hub-context-popover"
        aria-haspopup="dialog"
        aria-label={`Switch context. Current ${currentScopeType}: ${currentScopeName}`}
        onClick={() => onOpenChange(!open)}
      >
        <div className="aevo-context-trigger__header">
          <span className="aevo-context-trigger__eyebrow">Current context</span>
          <span className={`aevo-context-trigger__pill ${currentStore ? "is-store" : ""}`}>{currentScopeType}</span>
        </div>
        <div className="aevo-context-trigger__body">
          <span className="aevo-context-trigger__icon"><ScopeIcon scope={currentStore ? "store" : "organization"} /></span>
          <div className="aevo-context-trigger__copy">
            <strong title={currentScopeName}>{currentScopeName}</strong>
            <span>{currentScopeIdentity}</span>
          </div>
          <ChevronIcon />
        </div>
      </button>

      {open ? (
        <div className="aevo-scope-switcher" id="hub-context-popover" role="dialog" aria-label="Switch organization or store context">
          <div className="aevo-scope-switcher__header">
            <div><strong>Switch workspace</strong><span>Choose where your next action applies.</span></div>
            <button className="aevo-scope-switcher__close" type="button" onClick={() => onOpenChange(false)} aria-label="Close context switcher">×</button>
          </div>
          <div className="aevo-scope-switcher__search">
            <SearchIcon />
            <Input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => { setQuery(event.currentTarget.value); setActiveIndex(0); }}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search stores or branch codes"
              aria-label="Search stores or branch codes"
              role="combobox"
              aria-expanded="true"
              aria-controls="hub-context-options"
              aria-autocomplete="list"
              aria-activedescendant={`hub-context-option-${activeIndex}`}
            />
            <kbd>⌘K</kbd>
          </div>
          <div className="aevo-scope-switcher__options" id="hub-context-options" role="listbox" aria-label="Available contexts">
            <span className="aevo-scope-switcher__section-label">Organization</span>
            <button
              className={`aevo-scope-switcher__option ${activeIndex === 0 ? "is-highlighted" : ""} ${switchingTo === null ? "is-switching" : ""}`}
              id="hub-context-option-0"
              type="button"
              role="option"
              aria-selected={!currentStore}
              aria-busy={switchingTo === null || undefined}
              disabled={switchingTo !== undefined}
              onMouseEnter={() => setActiveIndex(0)}
              onClick={() => selectScope(null)}
            >
              <span className="aevo-scope-switcher__option-icon">
                {switchingTo === null ? <Spinner size={16} /> : <ScopeIcon scope="organization" />}
              </span>
              <span className="aevo-scope-switcher__option-copy">
                <strong>Organization</strong>
                <span>{switchingTo === null ? "Switching workspace…" : "Global control plane · all stores"}</span>
              </span>
              <span className="aevo-context-trigger__pill">Global</span>
              {!currentStore && switchingTo !== null ? <CheckIcon /> : null}
            </button>

            <div className="aevo-scope-switcher__section-heading"><span>Stores &amp; branches</span><span>{filteredStores.length}</span></div>
            {filteredStores.length > 0 ? filteredStores.map((store, index) => {
              const status = storeStatus(store);
              const optionIndex = index + 1;
              const isSelected = currentStore?.id === store.id;
              const isSwitching = switchingTo === store.id;
              return (
                <button
                  className={`aevo-scope-switcher__option ${activeIndex === optionIndex ? "is-highlighted" : ""} ${isSwitching ? "is-switching" : ""}`}
                  id={`hub-context-option-${optionIndex}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  aria-busy={isSwitching || undefined}
                  disabled={switchingTo !== undefined}
                  onMouseEnter={() => setActiveIndex(optionIndex)}
                  onClick={() => selectScope(store.id)}
                  key={store.id}
                >
                  <span className="aevo-scope-switcher__option-icon">
                    {isSwitching ? <Spinner size={16} /> : <ScopeIcon scope="store" />}
                  </span>
                  <span className="aevo-scope-switcher__option-copy">
                    <strong>{store.name}</strong>
                    <span>{isSwitching ? "Switching workspace…" : `${store.code} · ${store.timezone}`}</span>
                  </span>
                  <span className={`aevo-scope-switcher__status ${status.active ? "is-active" : ""}`}><i aria-hidden="true" />{status.label}</span>
                  {isSelected && !isSwitching ? <CheckIcon /> : null}
                </button>
              );
            }) : <p className="aevo-scope-switcher__empty">No stores match “{query}”.</p>}
          </div>
          <div className="aevo-scope-switcher__footer">
            <span>⌘K focuses search · ↑↓ navigate · Enter select</span>
            <button type="button" onClick={onCreateStore}><PlusIcon />Create new store</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface SidebarNavItem {
  label: string;
  to?: string;
  description?: string;
  unavailable?: boolean;
  kind?: "application";
}

interface SidebarNavGroup {
  label: string;
  items: SidebarNavItem[];
  emptyLabel?: string;
}

const storeApplicationCodes = ["PLAY", "POS", "KIOSK", "QUEUE"] as const;

function isStoreApplicationAccessSummary(value: unknown): value is StoreApplicationAccessSummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoreApplicationAccessSummary>;
  return (
    typeof candidate.organizationId === "string" &&
    typeof candidate.storeId === "string" &&
    typeof candidate.applicationCode === "string" &&
    storeApplicationCodes.includes(candidate.applicationCode as (typeof storeApplicationCodes)[number]) &&
    typeof candidate.applicationName === "string" &&
    (candidate.status === "ACTIVE" || candidate.status === "DISABLED") &&
    typeof candidate.applicationActive === "boolean"
  );
}

function readEnabledStoreApplications(
  matches: ReturnType<typeof useMatches>,
  storeId?: string
): StoreApplicationAccessSummary[] {
  if (!storeId) return [];

  for (const match of matches) {
    if (!match.loaderData || typeof match.loaderData !== "object") continue;
    const data = match.loaderData as { store?: unknown; applications?: unknown };
    if (!data.store || typeof data.store !== "object" || (data.store as { id?: unknown }).id !== storeId) continue;
    if (!Array.isArray(data.applications)) return [];
    return data.applications.filter(isStoreApplicationAccessSummary).filter(
      (application) => application.status === "ACTIVE" && application.applicationActive
    );
  }

  return [];
}

function storeApplicationPath(storeId: string, applicationCode: StoreApplicationAccessSummary["applicationCode"]): string {
  return `/stores/${encodeURIComponent(storeId)}/apps/${encodeURIComponent(applicationCode)}`;
}

function isSidebarItemActive(to: string, location: ReturnType<typeof useLocation>): boolean {
  const target = new URL(to, "https://aevo.local");
  if (target.pathname !== location.pathname) return false;
  if (target.hash) return target.hash === location.hash;
  if (target.search) return target.search === location.search;
  if (location.hash) return false;
  const currentParams = new URLSearchParams(location.search);
  return !currentParams.has("view");
}

function SidebarNavigation({
  currentStore,
  storeApplications,
  location
}: {
  currentStore?: StoreSummary;
  storeApplications: StoreApplicationAccessSummary[];
  location: ReturnType<typeof useLocation>;
}) {
  const navigation = useNavigation();
  const [pendingTo, setPendingTo] = useState<string | null>(null);

  useEffect(() => {
    if (navigation.state === "idle") {
      setPendingTo(null);
    }
  }, [navigation.state]);

  const storeBase = currentStore ? `/stores/${encodeURIComponent(currentStore.id)}` : "";
  const groups: SidebarNavGroup[] = currentStore ? [
    {
      label: currentStore.name,
      items: [
        { label: "Overview", to: storeBase, description: "Store health and daily activity" },
        { label: "Apps & features", to: `${storeBase}?view=apps`, description: "Enable apps and manage store-level settings" },
        { label: "Products & catalog", to: `${storeBase}?view=catalog`, description: "Store availability and menus" },
        { label: "Team & shifts", description: "Branch roster and shift operations", unavailable: true },
        { label: "Devices & terminals", description: "Registered hardware", unavailable: true },
        { label: "Analytics", description: "Branch performance", unavailable: true },
        { label: "Branch settings", to: `${storeBase}?view=settings`, description: "Address, hours, and local defaults" }
      ]
    },
    {
      label: "Enabled apps",
      items: storeApplications.map((application) => ({
        label: application.applicationName,
        to: storeApplicationPath(currentStore.id, application.applicationCode),
        description: `View ${application.applicationName} status and important details for this store`,
        kind: "application" as const
      })),
      emptyLabel: "No apps enabled for this store yet."
    }
  ] : [
    {
      label: "Organization",
      items: [
        { label: "Overview", to: "/", description: "Cross-store control plane" },
        { label: "Businesses & locations", to: "/stores", description: "Store directory and branches" },
        { label: "Applications", to: "/settings#applications", description: "Installed apps and catalog" },
        { label: "Team & access", to: "/settings#team-heading", description: "Members and assignments" },
        { label: "Analytics", to: "/#analytics-heading", description: "Cross-store performance" },
        { label: "Integrations", to: "/settings#integrations-heading", description: "Connected providers" },
        { label: "Billing", to: "/settings#billing-heading", description: "Entitlements and subscription" },
        { label: "Audit & security", to: "/security", description: "Account security and sessions" },
        { label: "Organization settings", to: "/settings", description: "Legal profile and defaults" }
      ]
    }
  ];

  return <nav className="aevo-hub-nav" aria-label={currentStore ? "Store console navigation" : "Organization control plane navigation"}>
    {groups.map((group, groupIndex) => <section className="aevo-hub-nav__group" aria-labelledby={`${currentStore ? "store" : "organization"}-navigation-label-${groupIndex}`} key={group.label}>
      <span className="aevo-hub-nav__label" id={`${currentStore ? "store" : "organization"}-navigation-label-${groupIndex}`}>{group.label}</span>
      {group.items.map((item) => item.unavailable ? (
        <span className="aevo-hub-nav__item is-disabled" aria-disabled="true" title={`${item.label} is not available in this build`} key={item.label}><span>{item.label}</span><small>Soon</small></span>
      ) : (
        <Link
          className={`${item.kind === "application" ? "aevo-hub-nav__app-link" : ""} ${item.to && isSidebarItemActive(item.to, location) ? "is-active" : ""} ${pendingTo === item.to ? "is-pending" : ""}`.trim()}
          to={item.to ?? "/"}
          prefetch="intent"
          title={item.description}
          aria-current={item.to && isSidebarItemActive(item.to, location) ? "page" : undefined}
          aria-busy={pendingTo === item.to || undefined}
          key={item.label}
          onClick={() => {
            if (item.to && !isSidebarItemActive(item.to, location)) {
              setPendingTo(item.to);
            }
          }}
        >
          <span className="aevo-hub-nav__link-copy"><span>{item.label}</span>{item.kind === "application" ? <small>App workspace</small> : null}</span>
          {item.kind === "application" ? <span className="aevo-hub-nav__app-marker" aria-hidden="true">↗</span> : null}
          {pendingTo === item.to ? <span className="aevo-nav-spinner" aria-hidden="true" /> : null}
        </Link>
      ))}
      {group.items.length === 0 && group.emptyLabel ? <p className="aevo-hub-nav__empty">{group.emptyLabel}</p> : null}
    </section>)}
    <section className="aevo-hub-nav__group" aria-labelledby="account-navigation-label">
      <span className="aevo-hub-nav__label" id="account-navigation-label">Account</span>
      <Link
        className={`${isSidebarItemActive("/security", location) ? "is-active" : ""} ${pendingTo === "/security" ? "is-pending" : ""}`.trim()}
        to="/security"
        prefetch="intent"
        title="Manage password and passkeys"
        aria-current={isSidebarItemActive("/security", location) ? "page" : undefined}
        aria-busy={pendingTo === "/security" || undefined}
        onClick={() => {
          if (!isSidebarItemActive("/security", location)) {
            setPendingTo("/security");
          }
        }}
      >
        <span>Account security</span>
        {pendingTo === "/security" ? <span className="aevo-nav-spinner" aria-hidden="true" /> : null}
      </Link>
    </section>
  </nav>;
}

function CreateStoreDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting" && navigation.formData?.get("intent") === "create-store";
  return (
    <Dialog open={open} title="Create a new store" description="Create a branch in the current organization. Core will validate the store scope before saving." onClose={onClose}>
      <Form method="post" action="/stores" className="aevo-form-grid">
        <input type="hidden" name="intent" value="create-store" />
        <label>Store name<Input name="storeName" maxLength={160} required autoFocus disabled={isSubmitting} /></label>
        <label>Store code<Input name="storeCode" maxLength={32} placeholder="ARI001" required disabled={isSubmitting} /></label>
        <label>Mode<Select name="storeMode" defaultValue="POS" disabled={isSubmitting}><option>POS</option><option>KIOSK</option><option>BOOKING</option><option>POS_BOOKING</option><option>CUSTOM</option></Select></label>
        <label>Timezone<Input name="storeTimezone" defaultValue="Asia/Bangkok" maxLength={64} required disabled={isSubmitting} /></label>
        <label>Currency<Input name="storeCurrency" defaultValue="THB" maxLength={8} required disabled={isSubmitting} /></label>
        <div className="aevo-form-actions aevo-field--wide">
          <Button variant="primary" type="submit" busy={isSubmitting} busyLabel="Creating store…">Create store</Button>
          <Button variant="ghost" type="button" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
        </div>
      </Form>
    </Dialog>
  );
}

function HubShell({ data, children }: { data: HubLoaderData; children: ReactNode }) {
  const navigation = useNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const matches = useMatches();
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [scopeSwitcherOpen, setScopeSwitcherOpen] = useState(false);
  const [scopeSearchFocusRequest, setScopeSearchFocusRequest] = useState(0);
  const [createStoreOpen, setCreateStoreOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutMessage, setLogoutMessage] = useState("");
  const principal = data.me.principal;
  const organizationId = data.access.organizationId ?? principal?.organizationId ?? "—";
  const clientCache = useMemo(
    () => createHubClientDataCache(data.me.user.id, data.access.organizationId ?? principal?.organizationId, data.access.storeId),
    [data.me.user.id, data.access.organizationId, data.access.storeId, principal?.organizationId]
  );
  const storeMatch = location.pathname.match(/\/stores\/([^/]+)/u);
  const currentStoreId = storeMatch ? decodeURIComponent(storeMatch[1]) : "";
  const currentStore = data.stores.find((store) => store.id === currentStoreId);
  const storeApplications = readEnabledStoreApplications(matches, currentStore?.id);
  const displayName = data.me.user.displayName || data.me.user.email;

  useEffect(() => {
    void syncHubManifest(clientCache).catch(() => undefined);
  }, [clientCache]);

  const logout = async (): Promise<void> => {
    setLogoutBusy(true);
    setLogoutMessage("");
    try {
      const csrf = readClientCookie("aevo_csrf");
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "x-aevo-app": "HUB",
          ...(csrf ? { "x-csrf-token": csrf } : {})
        }
      });
      if (!response.ok) throw new Error("ออกจากระบบไม่สำเร็จ");
      await clientCache.logoutCleanup();
      window.location.assign("/modern/login");
    } catch (error) {
      setLogoutMessage(error instanceof Error ? error.message : "ออกจากระบบไม่สำเร็จ");
      setLogoutBusy(false);
    }
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (scopeSwitcherOpen) setScopeSearchFocusRequest((request) => request + 1);
        else setCommandMenuOpen(true);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [scopeSwitcherOpen]);

  return (
    <div className="aevo-hub-shell">
      {navigation.state !== "idle" ? <div className="aevo-top-progress-bar" role="progressbar" aria-label="Loading workspace" /> : null}
      <a className="aevo-skip-link" href="#main-content">Skip to content</a>
      <aside className="aevo-hub-sidebar" aria-label="Hub navigation">
        <a className="aevo-hub-brand" href={data.homeUrl}>
          <span className="aevo-hub-mark" aria-hidden="true">A</span>
          <span>
            <strong>Aevo Hub</strong>
            <small>Control plane</small>
          </span>
        </a>
        <ScopeSwitcher
          stores={data.stores}
          currentStore={currentStore}
          organizationId={organizationId}
          open={scopeSwitcherOpen}
          focusSearchRequest={scopeSearchFocusRequest}
          onOpenChange={setScopeSwitcherOpen}
          onSelect={(storeId) => navigate(storeId ? `/stores/${encodeURIComponent(storeId)}` : "/")}
          onCreateStore={() => { setScopeSwitcherOpen(false); setCreateStoreOpen(true); }}
        />
        <SidebarNavigation currentStore={currentStore} storeApplications={storeApplications} location={location} />
        <div className="aevo-hub-sidebar__utility">
          <a href={data.homeUrl}>Aevo home</a>
          {currentStore ? <Link to="/stores" prefetch="intent">All stores &amp; branches</Link> : null}
        </div>
        <div className="aevo-hub-sidebar-footer">
          <span>{displayName}</span>
          <span>Authenticated application session</span>
          <Button variant="ghost" type="button" onClick={() => void logout()} busy={logoutBusy} busyLabel="กำลังออกจากระบบ…">
            ออกจากระบบ
          </Button>
          {logoutMessage ? <span role="alert">{logoutMessage}</span> : null}
        </div>
      </aside>
      <div className="aevo-hub-main">
        <header className="aevo-hub-topbar">
          <p>Aevo Hub · server-checked application access</p>
          <div className="aevo-hub-topbar__actions">
            <Button variant="ghost" type="button" onClick={() => setCommandMenuOpen(true)} aria-keyshortcuts="Control+K">Commands <kbd>⌘K</kbd></Button>
            {navigation.state !== "idle" ? <StatusBadge tone="warning" role="status">Loading</StatusBadge> : <StatusBadge tone="success" role="status">Connected</StatusBadge>}
          </div>
          <CommandMenu
            open={commandMenuOpen}
            onClose={() => setCommandMenuOpen(false)}
            items={[
              { id: "overview", label: "Open overview", description: "Return to the Hub workspace", onSelect: () => { setCommandMenuOpen(false); navigate("/"); } },
              { id: "settings", label: "Open organization settings", description: "Manage organization, stores, and assignments", onSelect: () => { setCommandMenuOpen(false); navigate("/settings"); } },
              { id: "stores", label: "Open stores and branches", description: "Manage stores, branches, and public profiles", onSelect: () => { setCommandMenuOpen(false); navigate("/stores"); } },
              { id: "security", label: "Open account security", description: "Manage password and passkeys", onSelect: () => { setCommandMenuOpen(false); navigate("/security"); } },
            ]}
          />
        </header>
        <main id="main-content" className="aevo-hub-content">{children}</main>
      </div>
      <CreateStoreDialog open={createStoreOpen} onClose={() => setCreateStoreOpen(false)} />
    </div>
  );
}

export default function HubLayout() {
  const data = useLoaderData() as HubLoaderData;
  if (!isAccessAllowed(data.access)) return <AccessDenied data={data} />;
  return <HubShell data={data}><Outlet context={data} /></HubShell>;
}

export function useHubLoaderData(): HubLoaderData {
  return useOutletContext<HubLoaderData>();
}
