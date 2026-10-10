import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TESTNET, describeSchedule, schedule } from "@sorocron/sdk";
import { NewJob } from "./NewJob";

const state = vi.hoisted(() => ({
  registry: {} as Record<string, unknown>,
  wallet: {} as Record<string, unknown>,
}));

vi.mock("../state/registry", async () => {
  const { TESTNET } = await import("@sorocron/sdk");
  return {
    NETWORK: TESTNET,
    useRegistry: () => state.registry,
    useNow: () => 1_800_000_000n,
    describe: (err: unknown) => String(err),
  };
});
vi.mock("../state/wallet", () => ({ useWallet: () => state.wallet }));

const TARGET = TESTNET.contracts.registry;
let createJob: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createJob = vi.fn(async () => ({ hash: "abc", result: 42n }));
  state.registry = { cron: { createJob }, config: undefined, refresh: vi.fn() };
  state.wallet = { account: "GA3MGO7TF2Y4KIUEMD7CHD4KMHLVOF5WF7R2UBI4LTPVAG7KSDNVNF53", promptConnect: vi.fn() };
});
afterEach(cleanup);

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const next = () => fireEvent.click(screen.getByRole("button", { name: /^Continue/ }));
const onStep = (n: number) => screen.getByText(`Step ${n} of 4`);

describe("New job form", () => {
  it("won't continue past an invalid call", () => {
    render(<NewJob />);
    next();
    onStep(1);
    expect(screen.getByText("Enter a contract address starting with C.")).toBeTruthy();
    expect(screen.getByText("Letters, digits and underscores, up to 32 characters.")).toBeTruthy();

    type("Contract", TARGET);
    type("Function", "increment");
    fireEvent.click(screen.getByRole("button", { name: "Add argument" }));
    type("Argument 0 value", "not a number");
    next();
    onStep(1);

    type("Argument 0 value", "7");
    next();
    onStep(2);
  });

  it("checks the schedule and funding", () => {
    render(<NewJob />);
    type("Contract", TARGET);
    type("Function", "increment");
    next();

    type("Run every", "0");
    next();
    expect(screen.getByText("Enter a number above zero.")).toBeTruthy();
    type("Run every", "2");
    next();
    onStep(3);

    type("Fee per run", "-1");
    type("Runs to prepay", "0");
    next();
    expect(screen.getByText("Prepay at least one run.")).toBeTruthy();
    onStep(3);
  });

  it("schedules the job it reviewed, with the right deposit", async () => {
    render(<NewJob />);
    type("Contract", TARGET);
    type("Function", "increment");
    fireEvent.click(screen.getByRole("button", { name: "Add argument" }));
    type("Argument 0 value", "7");
    next();
    type("Run every", "2");
    next();
    type("Fee per run", "0.5");
    type("Runs to prepay", "10");
    next();
    onStep(4);

    const every2h = describeSchedule({ schedule: schedule.interval(), interval: 7_200n });
    expect(screen.getByText(every2h.charAt(0).toUpperCase() + every2h.slice(1))).toBeTruthy();
    expect(screen.getByText("increment(1 argument)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Schedule job" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Deposit 5 XLM" }));
    });

    expect(createJob).toHaveBeenCalledTimes(1);
    const [params, deposit] = createJob.mock.calls[0];
    expect(deposit).toBe(50_000_000n);
    expect(params).toMatchObject({
      target: TARGET,
      function: "increment",
      interval: 7_200n,
      fee_per_run: 5_000_000n,
      max_fee_per_run: 0n,
      max_runs: 0,
      start_at: 0n,
      end_at: 0n,
    });
    expect(params.args).toHaveLength(1);
    expect(await screen.findByText("Open job #42")).toBeTruthy();
  });

  it("asks for a wallet instead of scheduling without one", () => {
    state.wallet = { account: undefined, promptConnect: vi.fn() };
    render(<NewJob />);
    type("Contract", TARGET);
    type("Function", "increment");
    next();
    next();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Connect to schedule" }));
    expect(state.wallet.promptConnect).toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });
});
