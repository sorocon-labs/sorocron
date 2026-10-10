import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { useState } from "react";
import { BY_STATUS } from "../test/fixtures";
import { JobDetail } from "../pages/JobDetail";
import { Jobs } from "../pages/Jobs";
import { NewJob } from "../pages/NewJob";
import { DatePicker } from "./DatePicker";
import { Modal } from "./Modal";
import { Select } from "./Select";

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
  useWallet: () => ({ account: "GA3MGO7TF2Y4KIUEMD7CHD4KMHLVOF5WF7R2UBI4LTPVAG7KSDNVNF53", promptConnect: vi.fn() }),
}));

/**
 * Accessibility violations in the document. jsdom can't compute colors, so
 * contrast is checked against the theme tokens instead (see styles.css), and
 * page fragments rendered on their own aren't inside landmarks.
 */
async function violations(): Promise<string[]> {
  const result = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

afterEach(cleanup);

describe("no axe violations", () => {
  state.registry = { jobs: Object.values(BY_STATUS), loading: false, refresh: vi.fn(), cron: { createJob: vi.fn() } };

  it("on every step of the New Job form", async () => {
    render(<NewJob />);
    expect(await violations()).toEqual([]);
    fireEvent.change(screen.getByLabelText("Contract"), { target: { value: "CDQPGH3YKV22VYFCZ4WUSOWFBM26PZDCTATCNBRUKLOUYAIJWDCQ6PE4" } });
    fireEvent.change(screen.getByLabelText("Function"), { target: { value: "increment" } });
    for (let step = 2; step <= 4; step++) {
      fireEvent.click(screen.getByRole("button", { name: /^Continue/ }));
      screen.getByText(`Step ${step} of 4`);
      expect(await violations(), `step ${step}`).toEqual([]);
    }
  });

  it("on the Jobs and Job detail pages", async () => {
    render(<Jobs />);
    expect(await violations()).toEqual([]);
    cleanup();
    render(<JobDetail id={BY_STATUS.failing.id} />);
    expect(await violations()).toEqual([]);
  });

  it("with a select, a date picker and a dialog open", async () => {
    render(
      <>
        <Select label="Unit" value="a" options={OPTIONS} onChange={() => undefined} />
        <DatePicker label="First run" value={null} onChange={() => undefined} placeholder="Immediately" />
        <Modal open onClose={() => undefined} title="Fund job" description="Add XLM to the job's balance.">
          <button type="button">Fund</button>
        </Modal>
      </>,
    );
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Unit" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "First run" }));
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getByRole("grid")).toBeTruthy();
    expect(await violations()).toEqual([]);
  });
});

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Bravo" },
  { value: "c", label: "Charlie" },
];

function ControlledSelect({ onChange }: { onChange: (v: string) => void }) {
  const [value, setValue] = useState("a");
  return (
    <Select
      label="Unit"
      value={value}
      options={OPTIONS}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe("keyboard", () => {
  it("operates the select without a mouse", () => {
    const onChange = vi.fn();
    render(<ControlledSelect onChange={onChange} />);
    const box = screen.getByRole("combobox", { name: "Unit" });
    box.focus();

    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(box, { key: "End" });
    expect(box.getAttribute("aria-activedescendant")).toMatch(/-2$/);
    fireEvent.keyDown(box, { key: "Home" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("b");
    expect(box.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(box);

    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "c" });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box.getAttribute("aria-expanded")).toBe("false");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("moves through the calendar with arrow keys and returns focus on Escape", () => {
    const onChange = vi.fn();
    render(<DatePicker label="First run" value={null} onChange={onChange} placeholder="Immediately" />);
    const trigger = screen.getByRole("button", { name: "First run" });
    fireEvent.click(trigger);

    const today = new Date();
    const key = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const focusedDay = () => (document.activeElement as HTMLElement).dataset.day;
    expect(focusedDay()).toBe(key(today));

    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    expect(focusedDay()).toBe(key(tomorrow));
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(focusedDay()).toBe(key(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 8)));
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    fireEvent.keyDown(grid, { key: "ArrowLeft" });
    fireEvent.keyDown(grid, { key: "ArrowLeft" }); // yesterday is in the past: stays on today
    expect(focusedDay()).toBe(key(today));

    fireEvent.keyDown(grid, { key: "PageDown" });
    const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, today.getDate());
    expect(focusedDay()).toBe(key(nextMonth));
    fireEvent.click(document.activeElement!);
    expect((onChange.mock.calls[0][0] as Date).getDate()).toBe(nextMonth.getDate());

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("grid")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes the dialog with Escape and gives focus back to what opened it", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Modal open={open} onClose={() => setOpen(false)} title="Cancel job">
            <button type="button">Confirm</button>
          </Modal>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "Cancel job" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
