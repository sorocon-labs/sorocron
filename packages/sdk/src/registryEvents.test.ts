/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { fetchEvents } from "./events.js";
import { EVENT_SPECS, decodeEvent, type FieldKind } from "./registryEvents.js";

const KEEPER = "GA3MGO7TF2Y4KIUEMD7CHD4KMHLVOF5WF7R2UBI4LTPVAG7KSDNVNF53";
const CONTRACT = "CDQPGH3YKV22VYFCZ4WUSOWFBM26PZDCTATCNBRUKLOUYAIJWDCQ6PE4";
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Events and their fields as the contract interface snapshot declares them. */
function interfaceEvents(): Map<string, { topics: string[]; data: string[] }> {
  const src = readFileSync(new URL("../../../contracts/interfaces/registry.rs", import.meta.url), "utf8");
  const events = new Map<string, { topics: string[]; data: string[] }>();
  const pattern = /#\[soroban_sdk::contractevent\(topics = \["([a-z_]+)"\][^\]]*\]\s*#\[derive[^\]]*\]\s*pub struct \w+ \{([\s\S]*?)\}/g;
  for (const [, name, body] of src.matchAll(pattern)) {
    const topics: string[] = [];
    const data: string[] = [];
    for (const [, topic, field] of body.matchAll(/(#\[topic\]\s*)?pub (\w+):/g)) (topic ? topics : data).push(field);
    events.set(name, { topics, data });
  }
  return events;
}

/** A sample value of each kind, as the contract would encode it and as the decoder should return it. */
function sample(kind: FieldKind, i: number): { scval: xdr.ScVal; expected: unknown } {
  switch (kind) {
    case "u64":
      return { scval: nativeToScVal(1_000n + BigInt(i), { type: "u64" }), expected: 1_000n + BigInt(i) };
    case "i128":
      return { scval: nativeToScVal(-5n * 10n ** 20n + BigInt(i), { type: "i128" }), expected: -5n * 10n ** 20n + BigInt(i) };
    case "u32":
      return { scval: nativeToScVal(7 + i, { type: "u32" }), expected: 7 + i };
    case "bool":
      return { scval: xdr.ScVal.scvBool(i % 2 === 0), expected: i % 2 === 0 };
    case "address":
      return { scval: Address.fromString(i % 2 ? CONTRACT : KEEPER).toScVal(), expected: i % 2 ? CONTRACT : KEEPER };
    case "bytes":
      return { scval: xdr.ScVal.scvBytes(new Uint8Array(32).fill(i) as never), expected: new Uint8Array(32).fill(i) };
    case "option_address":
      return { scval: Address.fromString(KEEPER).toScVal(), expected: KEEPER };
  }
}

describe("typed registry events (#134)", () => {
  it("knows every event and field the contract interface declares", () => {
    const declared = interfaceEvents();
    expect(declared.size).toBeGreaterThan(30);
    const hint = "rerun `python scripts/gen-events.py` after changing events.rs";
    for (const [name, fields] of declared) {
      const spec = EVENT_SPECS[name];
      expect(spec, `${name} is missing: ${hint}`).toBeDefined();
      expect({ topics: spec.topics.map(([f]) => f), data: spec.data.map(([f]) => f) }, `${name}'s fields changed: ${hint}`).toEqual(fields);
    }
    expect(Object.keys(EVENT_SPECS).sort(), `events were removed: ${hint}`).toEqual([...declared.keys()].sort());
  });

  it("decodes every event from real XDR", async () => {
    for (const [name, spec] of Object.entries(EVENT_SPECS)) {
      const expected: Record<string, unknown> = { type: name, ledger: 42, closedAt: "2026-10-16T05:00:00Z", txHash: "abc", id: "0042-1" };
      const topic: xdr.ScVal[] = [xdr.ScVal.scvSymbol(name)];
      spec.topics.forEach(([field, kind], i) => {
        const { scval, expected: value } = sample(kind, i);
        topic.push(scval);
        expected[camel(field)] = value;
      });
      const entries = spec.data.map(([field, kind], i) => {
        const { scval, expected: value } = sample(kind, i + 3);
        expected[camel(field)] = value;
        return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(field), val: scval });
      });
      const server = {
        getEvents: async () => ({
          events: [{ topic, value: xdr.ScVal.scvMap(entries), ledger: 42, ledgerClosedAt: "2026-10-16T05:00:00Z", txHash: "abc", id: "0042-1" }],
          latestLedger: 42,
          cursor: "c",
        }),
      };
      const page = await fetchEvents(server as never, CONTRACT, { startLedger: 1 });
      expect(decodeEvent(page.events[0]), name).toEqual(expected);
    }
  });

  it("decodes a missing treasury as undefined", () => {
    const e = decodeEvent({
      name: "protocol_fee_set",
      topics: [],
      data: { protocol_fee_bps: 250, treasury: null },
      ledger: 1,
      closedAt: "",
      txHash: "",
      id: "1",
    });
    expect(e).toMatchObject({ type: "protocol_fee_set", protocolFeeBps: 250, treasury: undefined });
  });

  it("leaves events from a newer registry undecoded", () => {
    expect(decodeEvent({ name: "something_new", topics: [], data: {}, ledger: 1, closedAt: "", txHash: "", id: "1" })).toBeUndefined();
    // A known event whose fields changed: undefined, not a throw.
    expect(decodeEvent({ name: "job_funded", topics: [3n], data: { from: KEEPER }, ledger: 1, closedAt: "", txHash: "", id: "1" })).toBeUndefined();
  });
});
