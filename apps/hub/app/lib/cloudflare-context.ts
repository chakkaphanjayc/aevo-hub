import { createContext } from "react-router";

export interface AevoAppEnv {
  ASSETS?: Fetcher;
  AEVO_APP_CODE?: string;
  AEVO_ENVIRONMENT?: string;
  AEVO_CORE_API_URL?: string;
  AEVO_API_URL?: string;
}

export type AevoWorkerExecutionContext = Pick<ExecutionContext, "waitUntil" | "passThroughOnException">;

export interface AevoWorkerContext {
  env: AevoAppEnv;
  ctx: AevoWorkerExecutionContext;
  request: Request;
}

export const aevoWorkerContext = createContext<AevoWorkerContext>();
