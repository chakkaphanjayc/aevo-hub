import type { LoaderFunctionArgs } from "react-router";
import { proxyHubApi } from "../lib/auth.server";

export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  return proxyHubApi(request, "/api/v1/sync/manifest");
}
