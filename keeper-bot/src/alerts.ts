/**
 * Webhook alerts for keeper operators (#74).
 *
 * Posts to a Discord, Slack or generic JSON webhook when something needs a
 * human: the keeper or a channel account is low on XLM, the keeper's stake
 * no longer qualifies it to execute, the RPC server keeps failing, or the
 * keeper's runs keep failing. Each alert key fires at most once per
 * cooldown, so a persistent problem doesn't flood the channel, and a
 * webhook failure is logged, never thrown into the keeper loop.
 */
import type { Logger } from "./logger.js";

export type AlertKind = "low_balance" | "low_stake" | "keeper_ineligible" | "rpc_down" | "runs_failing";

export interface Alert {
  kind: AlertKind;
  severity: "warning" | "critical";
  message: string;
  details?: Record<string, unknown>;
}

export type WebhookFormat = "discord" | "slack" | "generic";

export interface AlerterOptions {
  url: string;
  format?: WebhookFormat;
  cooldownMs?: number;
  /** Prefixed to every message, e.g. the keeper's name or network. */
  source?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  log?: Logger;
}

const ICON: Record<Alert["severity"], string> = { warning: "[warning]", critical: "[critical]" };

/** The JSON body each webhook flavour expects. */
export function webhookBody(alert: Alert, format: WebhookFormat, source = "sorocron-keeper"): unknown {
  const text = `${ICON[alert.severity]} ${source}: ${alert.message}`;
  const details = alert.details
    ? Object.entries(alert.details)
        .map(([k, v]) => `${k}: ${typeof v === "bigint" ? v.toString() : String(v)}`)
        .join("\n")
    : "";
  switch (format) {
    case "discord":
      return { content: details ? `${text}\n\`\`\`\n${details}\n\`\`\`` : text };
    case "slack":
      return { text: details ? `${text}\n\`\`\`${details}\`\`\`` : text };
    default:
      return {
        source,
        kind: alert.kind,
        severity: alert.severity,
        message: alert.message,
        details: JSON.parse(
          JSON.stringify(alert.details ?? {}, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
        ),
        time: new Date().toISOString(),
      };
  }
}

export class Alerter {
  private lastSent = new Map<string, number>();
  /** Alerts actually posted, for metrics. */
  sent = 0;

  constructor(private readonly options: AlerterOptions) {}

  get enabled(): boolean {
    return Boolean(this.options.url);
  }

  /**
   * Posts the alert unless the same `key` (default: its kind) fired within
   * the cooldown. Returns whether it was posted.
   */
  async notify(alert: Alert, key: string = alert.kind): Promise<boolean> {
    if (!this.enabled) return false;
    const now = (this.options.now ?? Date.now)();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < (this.options.cooldownMs ?? 3_600_000)) return false;
    this.lastSent.set(key, now);
    try {
      const res = await (this.options.fetch ?? globalThis.fetch)(this.options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(webhookBody(alert, this.options.format ?? "generic", this.options.source)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.sent += 1;
      return true;
    } catch (err) {
      this.options.log?.(`alert webhook failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** Lets an alert fire again immediately once its problem is resolved. */
  clear(key: string): void {
    this.lastSent.delete(key);
  }
}
