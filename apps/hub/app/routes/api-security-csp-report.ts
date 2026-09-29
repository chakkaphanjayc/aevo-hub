import type { ActionFunctionArgs } from "react-router";

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  // CSP/Trusted Types reports are diagnostic only. Do not persist or echo
  // browser-controlled report fields from this unauthenticated endpoint.
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
