import { Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { Breadcrumbs, StatusBadge } from "@aevocado/design-system";
import { hasHubPermission } from "../lib/auth.shared";
import {
  SettingsPermissionDenied,
  StoreSection,
  type SettingsActionResult,
  type SettingsLoaderData
} from "./settings";

export { action, loader } from "./settings";

export default function StoresRoute() {
  const data = useLoaderData() as SettingsLoaderData;
  const actionData = useActionData() as SettingsActionResult | undefined;
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  if (data.permissionDenied || !data.organization) {
    return <SettingsPermissionDenied permission={data.permissionDenied} />;
  }

  const canManage = hasHubPermission(data.hub, "organization.manage") || hasHubPermission(data.hub, "store.create");
  const updated = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get("updated");

  return (
    <>
      <Breadcrumbs className="aevo-page-breadcrumb" items={[{ label: "Hub", href: "/" }, { label: "Stores & branches" }]} />
      <section className="aevo-page-heading">
        <div>
          <StatusBadge tone="success">Server-checked store access</StatusBadge>
          <h1>Stores &amp; branches</h1>
          <p>Manage branch records and the public store profiles exposed to Aevo Go. Store scope and mutations are enforced by Core API authorization.</p>
        </div>
        <Link className="aevo-button aevo-button--secondary" to="/settings">Organization settings</Link>
      </section>
      {actionData?.ok === false ? <div className="aevo-inline-alert aevo-inline-alert--error" role="alert">{actionData.message}</div> : updated ? <div className="aevo-inline-alert" role="status">Saved {updated} successfully.</div> : null}
      {isSubmitting ? <div className="aevo-loading-strip" role="status">Saving securely…</div> : null}
      <StoreSection data={data} canManage={canManage} busy={isSubmitting} />
    </>
  );
}
