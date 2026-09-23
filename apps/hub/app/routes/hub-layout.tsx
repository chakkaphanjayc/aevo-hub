import { useEffect, useState, type ReactNode } from "react";
import { Button, CommandMenu, PermissionDeniedState, StatusBadge } from "@aevocado/design-system";
import { NavLink, Outlet, redirect, useLoaderData, useNavigate, useNavigation, useOutletContext } from "react-router";
import type { LoaderFunctionArgs, ShouldRevalidateFunctionArgs } from "react-router";
import { isAccessAllowed } from "@aevocado/app-access";
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
  if (formMethod && formMethod !== "GET") return false;
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

function HubShell({ data, children }: { data: HubLoaderData; children: ReactNode }) {
  const navigation = useNavigation();
  const navigate = useNavigate();
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const principal = data.me.principal;
  const organizationLabel = principal?.organizationId ?? "No organization selected";
  const displayName = data.me.user.displayName || data.me.user.email;

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandMenuOpen(true);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  return (
    <div className="aevo-hub-shell">
      <a className="aevo-skip-link" href="#main-content">Skip to content</a>
      <aside className="aevo-hub-sidebar" aria-label="Hub navigation">
        <a className="aevo-hub-brand" href={data.homeUrl}>
          <span className="aevo-hub-mark" aria-hidden="true">A</span>
          <span>
            <strong>Aevo Hub</strong>
            <small>Control plane</small>
          </span>
        </a>
        <div className="aevo-context-card" aria-label="Current organization">
          <span>Organization context</span>
          <strong title={organizationLabel}>{organizationLabel}</strong>
          <span>{principal?.role ?? "Authenticated account"}</span>
        </div>
        <nav className="aevo-hub-nav">
          <a href={data.homeUrl}>Home</a>
          <NavLink to="/" end>Overview</NavLink>
          <NavLink to="/settings">Organization settings</NavLink>
          <NavLink to="/stores">Stores &amp; branches</NavLink>
          <NavLink to="/security">Account security</NavLink>
        </nav>
        <div className="aevo-hub-sidebar-footer">
          <span>{displayName}</span>
          <span>Authenticated application session</span>
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
