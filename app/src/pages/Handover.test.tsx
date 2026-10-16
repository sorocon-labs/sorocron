import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { UpgradeBanner } from "../components/UpgradeBanner";
import { NOW, OWNER, job } from "../test/fixtures";
import { JobDetail } from "./JobDetail";
import { MyJobs } from "./Jobs";

const OTHER = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";

const state = vi.hoisted(() => ({
  registry: {} as Record<string, unknown>,
  account: undefined as string | undefined,
}));

vi.mock("../state/registry", async () => {
  const { TESTNET } = await import("@sorocron/sdk");
  const { NOW } = await import("../test/fixtures");
  return {
    NETWORK: TESTNET,
    useRegistry: () => state.registry,
    useNow: () => NOW,
    describe: (err: unknown) => String(err),
  };
});
vi.mock("../state/wallet", () => ({ useWallet: () => ({ account: state.account, promptConnect: vi.fn() }) }));

let cron: { proposeJobOwner: ReturnType<typeof vi.fn>; acceptJobOwner: ReturnType<typeof vi.fn>; fundJob: ReturnType<typeof vi.fn> };

function setup({ account, handovers = new Map<bigint, string>() }: { account?: string; handovers?: Map<bigint, string> }) {
  cron = {
    proposeJobOwner: vi.fn(async () => ({ hash: "h1", result: undefined })),
    acceptJobOwner: vi.fn(async () => ({ hash: "h2", result: undefined })),
    fundJob: vi.fn(),
  };
  state.account = account;
  state.registry = { jobs: [job(1, { balance: 50_000_000n })], loading: false, refresh: vi.fn(), cron, handovers };
}

async function violations(): Promise<string[]> {
  const result = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const dialog = () => screen.getByRole("dialog");

beforeEach(() => setup({}));
afterEach(cleanup);

describe("job handover (#131)", () => {
  it("lets the owner offer the job to another address", async () => {
    setup({ account: OWNER });
    render(<JobDetail id={1n} />);
    fireEvent.click(screen.getByRole("button", { name: "Transfer" }));
    expect(within(dialog()).getByText(/gets the job's 5 XLM balance and history once they accept/)).toBeTruthy();

    const input = within(dialog()).getByLabelText("New owner");
    fireEvent.change(input, { target: { value: "not an address" } });
    expect(within(dialog()).getByText("Enter an account (G…) or contract (C…) address.")).toBeTruthy();
    fireEvent.change(input, { target: { value: OWNER } });
    expect(within(dialog()).getByText("That's the current owner.")).toBeTruthy();
    expect((within(dialog()).getByRole("button", { name: "Offer job" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: OTHER } });
    expect(await violations()).toEqual([]);
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Offer job" }));
    });
    expect(cron.proposeJobOwner).toHaveBeenCalledWith(1n, OTHER);
    expect(await screen.findByText("Offer sent. The job moves once they accept.")).toBeTruthy();
  });

  it("shows the owner a pending handover they can withdraw", async () => {
    setup({ account: OWNER, handovers: new Map([[1n, OTHER]]) });
    render(<JobDetail id={1n} />);
    const region = screen.getByRole("region", { name: "Job handover" });
    expect(region.textContent).toMatch(/Handing over to .*until they accept/);
    expect(await violations()).toEqual([]);

    fireEvent.click(within(region).getByRole("button", { name: "Withdraw offer" }));
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Withdraw offer" }));
    });
    expect(cron.proposeJobOwner).toHaveBeenCalledWith(1n, OWNER);
  });

  it("asks the new owner to accept", async () => {
    setup({ account: OTHER, handovers: new Map([[1n, OTHER]]) });
    render(<JobDetail id={1n} />);
    const region = screen.getByRole("region", { name: "Job handover" });
    expect(region.textContent).toMatch(/is handing this job to you, with its 5 XLM balance/);
    // Not the owner yet: no owner actions.
    expect(screen.queryByRole("button", { name: "Transfer" })).toBeNull();
    expect(await violations()).toEqual([]);

    fireEvent.click(within(region).getByRole("button", { name: "Accept job" }));
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "Accept job" }));
    });
    expect(cron.acceptJobOwner).toHaveBeenCalledWith(1n);
  });

  it("doesn't show a handover to anyone else", () => {
    setup({ account: "GBQYH7PZOVFHG3DPJG2DFQYDUL3HMIGT2MG4UETNHAEPPKCOKEDAWZGL", handovers: new Map([[1n, OTHER]]) });
    render(<JobDetail id={1n} />);
    expect(screen.queryByRole("region", { name: "Job handover" })).toBeNull();
  });

  it("lists jobs waiting for the connected account on My jobs", async () => {
    setup({ account: OTHER, handovers: new Map([[1n, OTHER]]) });
    render(<MyJobs />);
    const card = screen.getByRole("heading", { name: "Waiting for you to accept" }).closest("section")!;
    expect(card.textContent).toMatch(/Job #1, job1\(\) with 5 XLM/);
    expect(within(card).getByRole("link", { name: "Review and accept" }).getAttribute("href")).toBe("#/jobs/1");
    expect(await violations()).toEqual([]);
  });
});

describe("upgrade banner (#131)", () => {
  const upgrade = (availableAt: bigint) => ({ wasm_hash: new Uint8Array(32).fill(0x1f), proposed_at: NOW - 60n, available_at: availableAt });

  it("shows an announced upgrade with a countdown", async () => {
    state.registry = { pendingUpgrade: upgrade(NOW + 5_400n) };
    render(<UpgradeBanner />);
    const banner = screen.getByRole("region", { name: "Announced registry upgrade" });
    expect(banner.textContent).toMatch(/code 1f1f1f1f…1f1f1f1f was announced\. It can be applied in 1h 30m\./);
    expect(banner.textContent).toMatch(/keepers can unbond before then/);
    expect(await violations()).toEqual([]);
  });

  it("says when the upgrade can be applied now, and hides with none pending", () => {
    state.registry = { pendingUpgrade: upgrade(NOW - 1n) };
    const { rerender } = render(<UpgradeBanner />);
    expect(screen.getByText(/The admin can apply it now\./)).toBeTruthy();
    state.registry = { pendingUpgrade: undefined };
    rerender(<UpgradeBanner />);
    expect(screen.queryByRole("region")).toBeNull();
  });
});
