type HubLogLevel = "debug" | "info" | "warn" | "error";

const priority: Record<HubLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function configuredLevel(): HubLogLevel {
  const value = process.env.AEVO_HUB_LOG_LEVEL?.trim().toLowerCase();
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

function safeContext(context: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context).filter(([key]) => !/password|token|secret|cookie|authorization/i.test(key))
  );
}

export function logHubEvent(
  level: HubLogLevel,
  event: string,
  context: Record<string, unknown> = {}
): void {
  if (priority[level] < priority[configuredLevel()]) return;
  const output = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    app_name: "aevocado-hub-web",
    app_version: process.env.APP_VERSION?.trim() || "development",
    environment: process.env.NODE_ENV === "production" ? "production" : "development",
    ...safeContext(context)
  });
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
}

export function hubSlowRequestThresholdMs(): number {
  const value = Number(process.env.AEVO_HUB_SLOW_REQUEST_MS ?? 750);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 750;
}
