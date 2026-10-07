import { describe, expect, it } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { schedule, type Job, type Keeper, type KeeperStats } from "@sorocron/sdk";
import {
  SoroCronProvider,
  useJob,
  useJobsByOwner,
  useKeeperStatus,
  useNextRun,
  type SoroCronClient,
} from "./index.js";

const now = () => BigInt(Math.floor(Date.now() / 1000));

function job(id: bigint, overrides: Partial<Job> = {}): Job {
  return {
    id,
    owner: "GOWNER",
    target: "CTARGET",
    function: "bump",
    args: [],
    interval: 3_600n,
    schedule: schedule.interval(),
    next_run: now() + 600n,
    fee_per_run: 10n,
    max_fee_per_run: 0n,
    balance: 100n,
    max_runs: 0,
    runs: 0,
    end_at: 0n,
    active: true,
    failures: 0,
    ...overrides,
  };
}

/** A fake registry whose jobs the test can change between polls. */
function fakeClient() {
  const jobs = new Map<bigint, Job>([
    [1n, job(1n)],
    [2n, job(2n, { owner: "GOTHER" })],
    [3n, job(3n)],
  ]);
  const keepers = new Map<string, { info: Keeper; stats: KeeperStats }>();
  let calls = 0;
  const client: SoroCronClient = {
    getJob: async (id) => {
      calls++;
      return jobs.get(id);
    },
    allJobs: async () => [...jobs.values()],
    jobsByOwner: async (owner) => [...jobs.values()].filter((j) => j.owner === owner).map((j) => j.id),
    getKeeper: async (k) => keepers.get(k)?.info,
    keeperStats: async (k) => keepers.get(k)?.stats,
    config: async () => {
      throw new Error("unused");
    },
    isDue: async () => false,
  };
  return { client, jobs, keepers, calls: () => calls };
}

const wrapper =
  (client: SoroCronClient, refreshMs = 50) =>
  ({ children }: { children: ReactNode }) => (
    <SoroCronProvider client={client} refreshMs={refreshMs}>
      {children}
    </SoroCronProvider>
  );

describe("useJob", () => {
  it("loads a job and keeps it fresh", async () => {
    const f = fakeClient();
    const { result } = renderHook(() => useJob(1n), { wrapper: wrapper(f.client) });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data?.runs).toBe(0));

    f.jobs.set(1n, job(1n, { runs: 5 }));
    await waitFor(() => expect(result.current.data?.runs).toBe(5));
    expect(result.current.loading).toBe(false);
  });

  it("returns null for a missing job and does nothing without an id", async () => {
    const f = fakeClient();
    const missing = renderHook(() => useJob(99n), { wrapper: wrapper(f.client) });
    await waitFor(() => expect(missing.result.current.data).toBeNull());

    missing.unmount();

    const quiet = fakeClient();
    const idle = renderHook(() => useJob(undefined), { wrapper: wrapper(quiet.client) });
    await new Promise((r) => setTimeout(r, 120));
    expect(idle.result.current.data).toBeUndefined();
    expect(quiet.calls()).toBe(0);
  });

  it("refresh() reloads immediately", async () => {
    const f = fakeClient();
    const { result } = renderHook(() => useJob(1n, 60_000), { wrapper: wrapper(f.client) });
    await waitFor(() => expect(result.current.data?.balance).toBe(100n));
    f.jobs.set(1n, job(1n, { balance: 7n }));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.data?.balance).toBe(7n));
  });
});

describe("useJobsByOwner", () => {
  it("returns only the owner's jobs", async () => {
    const f = fakeClient();
    const { result } = renderHook(() => useJobsByOwner("GOWNER"), { wrapper: wrapper(f.client) });
    await waitFor(() => expect(result.current.data?.map((j) => j.id)).toEqual([1n, 3n]));
  });
});

describe("useKeeperStatus", () => {
  it("reports stake, eligibility and unbonding", async () => {
    const f = fakeClient();
    f.keepers.set("GK", {
      info: { stake: 500n, unbonding_at: 1_234n, executions: 3, total_lateness: 9n, missed: 1, slashed: 50n },
      stats: { stake: 500n, executions: 3, average_lateness: 3n, missed: 1, slashed: 50n, eligible: false },
    });
    const { result } = renderHook(() => useKeeperStatus("GK"), { wrapper: wrapper(f.client) });
    await waitFor(() => expect(result.current.data?.withdrawableAt).toBe(1_234n));
    expect(result.current.data).toMatchObject({ eligible: false, stats: { missed: 1 } });

    const none = renderHook(() => useKeeperStatus("GNOBODY"), { wrapper: wrapper(f.client) });
    await waitFor(() => expect(none.result.current.data).toEqual({ keeper: null, stats: null, eligible: false, withdrawableAt: undefined }));
  });
});

describe("useNextRun", () => {
  it("counts down and describes the schedule", () => {
    const soon = job(1n, { next_run: now() + 90n, schedule: schedule.daily(12, 0), interval: 86_400n });
    const { result } = renderHook(() => useNextRun(soon));
    expect(result.current?.status).toBe("scheduled");
    expect(result.current?.label).toMatch(/^in 1m (29|30)s$/);
    expect(result.current?.schedule).toBe("daily at 12:00 UTC");

    const late = renderHook(() => useNextRun(job(2n, { next_run: now() - 120n })));
    expect(late.result.current?.label).toBe("due 2m ago");
  });
});

describe("two lines of React", () => {
  function NextRunBadge({ id }: { id: bigint }) {
    const { data: job } = useJob(id);
    return <span>{useNextRun(job)?.label ?? "loading"}</span>;
  }

  it("renders a live job status", async () => {
    const f = fakeClient();
    render(
      <SoroCronProvider client={f.client}>
        <NextRunBadge id={1n} />
      </SoroCronProvider>,
    );
    await waitFor(() => expect(screen.getByText(/^in \d+m/)).toBeTruthy());
  });

  it("explains a missing provider", () => {
    expect(() => renderHook(() => useJob(1n))).toThrow(/inside <SoroCronProvider>/);
  });
});
