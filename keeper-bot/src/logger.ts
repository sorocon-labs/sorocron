/**
 * Keeper log output. LOG_FORMAT=json emits one JSON object per line for log
 * shippers (Loki, CloudWatch, Datadog); anything else keeps the readable
 * `[timestamp] message` format.
 */
export type Level = "info" | "warn" | "error";

export function formatLine(format: string, level: Level, message: string, now: Date): string {
  if (format === "json") {
    return JSON.stringify({ time: now.toISOString(), level, msg: message });
  }
  return `[${now.toISOString()}] ${level === "info" ? "" : `${level.toUpperCase()} `}${message}`;
}

export function createLogger(format = process.env.LOG_FORMAT ?? "text") {
  const write = (level: Level) => (message: string) => {
    const line = formatLine(format, level, message, new Date());
    if (level === "error") console.error(line);
    else console.log(line);
  };
  return { info: write("info"), warn: write("warn"), error: write("error") };
}
