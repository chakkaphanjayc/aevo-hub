import type { ReactNode } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import "@aevocado/design-system/tokens.css";
import "@aevocado/design-system/styles.css";
import "./app.css";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#f6f8f5" />
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
  const message = error instanceof Error ? error.message : "The Hub shell could not load.";
  return (
    <main className="aevo-error-page">
      <section className="aevo-state aevo-state--error" role="alert">
        <span className="aevo-status aevo-status--warning">Temporary error</span>
        <h1>Hub is temporarily unavailable</h1>
        <p>{message}</p>
        <a className="aevo-button aevo-button--secondary" href="/modern">Return to Aevo Hub</a>
      </section>
    </main>
  );
}
