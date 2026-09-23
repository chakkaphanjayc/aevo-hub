import type { ReactNode } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse } from "react-router";
import { PermissionDeniedState, StatusBadge } from "@aevocado/design-system";
import "@aevocado/design-system/tokens.css";
import "@aevocado/design-system/styles.css";
import "./app.css";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#f6f8f5" />
        <title>Aevo Admin · Platform control plane</title>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: { error: unknown }) {
  if (isRouteErrorResponse(error) && error.status === 403) {
    return (
      <main className="admin-error-page">
        <PermissionDeniedState
          title="บัญชีนี้ไม่มีสิทธิ์เข้า Aevo Admin"
          description="Aevo Admin ใช้ platform role แยกจากสิทธิ์ขององค์กรและร้านค้า กรุณาใช้บัญชี platform operator ที่ได้รับอนุญาต"
          action={<a className="aevo-button aevo-button--secondary" href="/login">กลับไปหน้าเข้าสู่ระบบ</a>}
        />
      </main>
    );
  }

  const message = error instanceof Error ? error.message : "The Aevo Admin control plane could not load.";
  return (
    <main className="admin-error-page">
      <section className="aevo-state aevo-state--error" role="alert">
        <StatusBadge tone="warning">Temporary error</StatusBadge>
        <h1>Aevo Admin is temporarily unavailable</h1>
        <p>{message}</p>
        <a className="aevo-button aevo-button--secondary" href="/">Try again</a>
      </section>
    </main>
  );
}
