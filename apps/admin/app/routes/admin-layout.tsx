import { useState } from "react";
import { Activity, BadgeCheck, BarChart3, Boxes, Building2, CreditCard, Gauge, LayoutDashboard, LogOut, ShieldCheck, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PlatformPermission } from "@aevocado/api-contract";
import { Button, StatusBadge } from "@aevocado/design-system";
import { NavLink, Outlet, useLoaderData, useNavigation } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { requireAdminAccess } from "../lib/auth.server";
import { hasAdminPermission, type AdminLoaderData } from "../lib/auth.shared";

export async function loader({ request }: LoaderFunctionArgs): Promise<AdminLoaderData> {
  return requireAdminAccess(request);
}

interface NavigationItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end: boolean;
  requires?: PlatformPermission;
}

const navigationItems: NavigationItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/applications", label: "Applications", icon: Boxes, end: false },
  { to: "/organizations", label: "Organizations", icon: Building2, end: false },
  { to: "/subscriptions", label: "Subscriptions", icon: CreditCard, end: false },
  { to: "/users", label: "Users & access", icon: Users, end: false },
  { to: "/moderation", label: "TraceDee moderation", icon: ShieldCheck, end: false, requires: "content.moderate" },
  { to: "/projections", label: "TraceDee scoring", icon: BarChart3, end: false, requires: "system.jobs" },
  { to: "/reputation", label: "TraceDee reputation", icon: BadgeCheck, end: false, requires: "system.jobs" },
  { to: "/ranking", label: "TraceDee ranking", icon: Gauge, end: false, requires: "system.jobs" },
  { to: "/system", label: "System health", icon: Activity, end: false }
];

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  const value = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function logout(): Promise<void> {
    setBusy(true);
    setMessage("");
    try {
      const csrf = readCookie("aevo_admin_csrf");
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          ...(csrf ? { "x-csrf-token": csrf } : {})
        }
      });
      if (!response.ok) throw new Error("ออกจากระบบไม่สำเร็จ");
      window.location.assign("/login");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ออกจากระบบไม่สำเร็จ");
      setBusy(false);
    }
  }

  return (
    <div className="admin-sidebar-footer__logout">
      <Button type="button" variant="ghost" onClick={() => void logout()} busy={busy} busyLabel="กำลังออกจากระบบ…">
        <LogOut size={15} aria-hidden="true" />
        ออกจากระบบ
      </Button>
      {message ? <span role="alert">{message}</span> : null}
    </div>
  );
}

export default function AdminLayout() {
  const data = useLoaderData() as AdminLoaderData;
  const navigation = useNavigation();
  const displayName = data.me.user.displayName || data.me.user.email;

  return (
    <div className="admin-shell">
      <a className="aevo-skip-link" href="#admin-main-content">Skip to content</a>
      <aside className="admin-sidebar" aria-label="Aevo Admin navigation">
        <NavLink className="admin-brand admin-brand--sidebar" to="/">
          <span className="admin-brand__mark" aria-hidden="true">A</span>
          <span><strong>Aevo Admin</strong><small>Platform control plane</small></span>
        </NavLink>
        <div className="admin-context-card">
          <span>Privileged boundary</span>
          <strong>{data.access.platformRole ?? "Platform role"}</strong>
          <span>Cross-application operations</span>
        </div>
        <nav className="admin-nav">
          {navigationItems.filter((item) => !item.requires || hasAdminPermission(data, item.requires)).map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end ?? false}>
              <Icon size={16} strokeWidth={2} aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="admin-sidebar-footer">
          <span className="admin-sidebar-footer__identity">{displayName}</span>
          <span>Admin app session verified</span>
          <LogoutButton />
        </div>
      </aside>
      <div className="admin-main">
        <header className="admin-topbar">
          <div>
            <p>Aevo Admin · server-checked platform boundary</p>
            <span className="admin-topbar__hint">ควบคุมแอป, องค์กร, entitlement และระบบกลางจากจุดเดียว</span>
          </div>
          <div className="admin-topbar__actions">
            {navigation.state !== "idle" ? <StatusBadge tone="warning" role="status">กำลังโหลด</StatusBadge> : <StatusBadge tone="success" role="status">Connected</StatusBadge>}
            <span className="admin-role-badge">{data.access.platformRole ?? "Platform operator"}</span>
          </div>
        </header>
        <main id="admin-main-content" className="admin-content">
          <div className="admin-content__inner"><Outlet /></div>
        </main>
      </div>
    </div>
  );
}
