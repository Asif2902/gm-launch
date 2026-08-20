type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVEL_ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), message];
  if (context && Object.keys(context).length > 0) {
    parts.push(
      Object.entries(context)
        .map(([key, value]) => `${key}=${typeof value === "bigint" ? value.toString() : value}`)
        .join(" "),
    );
  }
  const line = parts.join(" ");
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => emit("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => emit("error", message, context),
};
