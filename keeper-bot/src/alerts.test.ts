import { describe, expect, it } from "vitest";
import { Alerter, webhookBody, type Alert } from "./alerts.js";

const lowBalance: Alert = {
  kind: "low_balance",
  severity: "warning",
  message: "GABC has 1.20 XLM, below 5",
  details: { account: "GABC", balance: 12_000_000n },
};

function recorder(status = 200) {
  const posts: { url: string; body: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(null, { status });
  }) as unknown as typeof globalThis.fetch;
  return { posts, fetch };
}

describe("webhookBody", () => {
  it("speaks Discord, Slack and plain JSON", () => {
    const discord = webhookBody(lowBalance, "discord", "keeper") as { content: string };
    expect(discord.content).toContain("[warning] keeper: GABC has 1.20 XLM");
    expect(discord.content).toContain("balance: 12000000");

    const slack = webhookBody(lowBalance, "slack", "keeper") as { text: string };
    expect(slack.text).toContain("[warning] keeper:");

    const generic = webhookBody(lowBalance, "generic", "keeper") as Record<string, unknown>;
    expect(generic).toMatchObject({
      source: "keeper",
      kind: "low_balance",
      severity: "warning",
      details: { account: "GABC", balance: "12000000" },
    });
  });
});

describe("Alerter", () => {
  it("posts structured alerts and respects the cooldown per key", async () => {
    const { posts, fetch } = recorder();
    let now = 0;
    const alerter = new Alerter({ url: "https://hooks.example/x", format: "generic", cooldownMs: 60_000, fetch, now: () => now });

    expect(await alerter.notify(lowBalance)).toBe(true);
    expect(await alerter.notify(lowBalance)).toBe(false); // within cooldown
    expect(await alerter.notify({ ...lowBalance, kind: "rpc_down", severity: "critical" })).toBe(true);
    now = 60_000;
    expect(await alerter.notify(lowBalance)).toBe(true);

    expect(posts).toHaveLength(3);
    expect(posts[1].body).toMatchObject({ kind: "rpc_down", severity: "critical" });
    expect(alerter.sent).toBe(3);
  });

  it("clearing a key lets it fire again right away", async () => {
    const { posts, fetch } = recorder();
    const alerter = new Alerter({ url: "https://hooks.example/x", fetch });
    await alerter.notify(lowBalance, "low_balance:GABC");
    alerter.clear("low_balance:GABC");
    await alerter.notify(lowBalance, "low_balance:GABC");
    expect(posts).toHaveLength(2);
  });

  it("never throws when the webhook fails, and is off without a URL", async () => {
    const logs: string[] = [];
    const { fetch } = recorder(500);
    const failing = new Alerter({ url: "https://hooks.example/x", fetch, log: (m) => logs.push(m) });
    expect(await failing.notify(lowBalance)).toBe(false);
    expect(logs[0]).toContain("HTTP 500");

    const off = new Alerter({ url: "" });
    expect(off.enabled).toBe(false);
    expect(await off.notify(lowBalance)).toBe(false);
  });
});
