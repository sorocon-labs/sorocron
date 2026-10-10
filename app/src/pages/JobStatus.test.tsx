import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { JobStatus } from "@sorocron/sdk";
import { BY_STATUS, LABEL } from "../test/fixtures";
import { JobDetail } from "./JobDetail";
import { Jobs } from "./Jobs";

const state = vi.hoisted(() => ({ registry: {} as Record<string, unknown> }));

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
vi.mock("../state/wallet", () => ({
  useWallet: () => ({ account: undefined, promptConnect: vi.fn() }),
}));

const STATUSES = Object.keys(BY_STATUS) as JobStatus[];

function withJobs() {
  state.registry = { jobs: Object.values(BY_STATUS), loading: false, refresh: vi.fn() };
}

afterEach(cleanup);

describe("Jobs page", () => {
  it("labels every job with its status", () => {
    withJobs();
    render(<Jobs />);
    for (const status of STATUSES) {
      const row = screen.getByRole("link", { name: new RegExp(`^Job ${BY_STATUS[status].id},`) });
      expect(within(row).getByText(LABEL[status]), status).toBeTruthy();
    }
  });

  it("lists every status under a filter other than All", () => {
    withJobs();
    render(<Jobs />);
    const shown = new Set<string>();
    for (const filter of ["Due", "Scheduled", "Attention", "Inactive"]) {
      fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${filter}`) }));
      for (const row of screen.queryAllByRole("link", { name: /^Job \d+,/ })) shown.add(row.getAttribute("aria-label")!);
    }
    for (const status of STATUSES) {
      expect([...shown].some((label) => label.startsWith(`Job ${BY_STATUS[status].id},`)), status).toBe(true);
    }
  });
});

describe("Job detail page", () => {
  it.each(STATUSES)("shows a %s job's status", (status) => {
    withJobs();
    render(<JobDetail id={BY_STATUS[status].id} />);
    expect(screen.getAllByText(LABEL[status]).length).toBeGreaterThan(0);
  });

  it("explains a job that doesn't exist", () => {
    withJobs();
    render(<JobDetail id={999n} />);
    expect(screen.getByText("This job doesn't exist")).toBeTruthy();
  });
});
