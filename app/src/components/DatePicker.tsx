import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "./Icon";
import { Select, type Option } from "./Select";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const HOURS: Option<string>[] = Array.from({ length: 24 }, (_, h) => {
  const v = String(h).padStart(2, "0");
  return { value: v, label: v };
});
const MINUTES: Option<string>[] = Array.from({ length: 12 }, (_, i) => {
  const v = String(i * 5).padStart(2, "0");
  return { value: v, label: v };
});

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export function formatDateTime(d: Date): string {
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Date and time picker in local time, replacing <input type="datetime-local">.
 * Times snap to 5 minutes; past days can't be chosen. Keyboard: arrows move
 * a day or a week, Home and End go to the start or end of the week, Page Up
 * and Page Down change month, Enter picks the day, Escape closes.
 */
export function DatePicker({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: Date | null;
  onChange: (value: Date | null) => void;
  label: string;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => {
    const base = value ?? new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [focused, setFocused] = useState(() => value ?? new Date());
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  // Set when the focused day should take keyboard focus after the next render.
  const moveFocus = useRef(false);

  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  };

  const show = () => {
    const start = value && value >= startOfToday ? value : startOfToday;
    setFocused(start);
    setMonth(new Date(start.getFullYear(), start.getMonth(), 1));
    moveFocus.current = true;
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !moveFocus.current) return;
    moveFocus.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${dayKey(focused)}"]`)?.focus();
  }, [open, focused, month]);

  const days = useMemo(() => {
    const first = new Date(month);
    const offset = (first.getDay() + 6) % 7; // Monday first
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [month]);
  const weeks = Array.from({ length: 6 }, (_, w) => days.slice(w * 7, w * 7 + 7));

  const hour = value ? String(value.getHours()).padStart(2, "0") : "12";
  const minute = value ? String(Math.floor(value.getMinutes() / 5) * 5).padStart(2, "0") : "00";

  const set = (day: Date, h = hour, m = minute) => {
    onChange(new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(h), Number(m)));
  };

  const onGridKey = (e: ReactKeyboardEvent) => {
    const weekday = (focused.getDay() + 6) % 7;
    const moves: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focused, -1),
      ArrowRight: () => addDays(focused, 1),
      ArrowUp: () => addDays(focused, -7),
      ArrowDown: () => addDays(focused, 7),
      Home: () => addDays(focused, -weekday),
      End: () => addDays(focused, 6 - weekday),
      PageUp: () => new Date(focused.getFullYear(), focused.getMonth() - 1, focused.getDate()),
      PageDown: () => new Date(focused.getFullYear(), focused.getMonth() + 1, focused.getDate()),
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    const next = move();
    if (next < startOfToday) return;
    setFocused(next);
    if (next.getMonth() !== month.getMonth() || next.getFullYear() !== month.getFullYear()) {
      setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
    }
    moveFocus.current = true;
  };

  const monthLabel = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="datepicker" ref={root}>
      <div className="datepicker-row">
        <button
          ref={trigger}
          type="button"
          className={`input datepicker-trigger ${value ? "" : "placeholder"}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={value ? `${label}: ${formatDateTime(value)}` : label}
          onClick={() => (open ? close(false) : show())}
        >
          <Icon name="calendar" size={16} />
          <span>{value ? formatDateTime(value) : placeholder}</span>
        </button>
        {value && (
          <button type="button" className="icon-btn" aria-label={`Clear ${label}`} onClick={() => onChange(null)}>
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      {open && (
        <div className="datepicker-pop" role="dialog" aria-label={label}>
          <div className="cal-head">
            <button
              type="button"
              className="icon-btn"
              aria-label="Previous month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            >
              <Icon name="chevronLeft" size={16} />
            </button>
            <span aria-live="polite">{monthLabel}</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Next month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            >
              <Icon name="chevronRight" size={16} />
            </button>
          </div>
          <div className="cal-grid" role="grid" aria-label={monthLabel} ref={grid} onKeyDown={onGridKey}>
            <div role="row">
              {WEEKDAYS.map((d) => (
                <span key={d} className="cal-dow" role="columnheader">
                  {d}
                </span>
              ))}
            </div>
            {weeks.map((week) => (
              <div role="row" key={dayKey(week[0])}>
                {week.map((d) => {
                  const outside = d.getMonth() !== month.getMonth();
                  const past = d < startOfToday;
                  const selected = value && sameDay(d, value);
                  return (
                    <button
                      key={dayKey(d)}
                      type="button"
                      role="gridcell"
                      data-day={dayKey(d)}
                      tabIndex={sameDay(d, focused) ? 0 : -1}
                      className={`cal-day ${outside ? "outside" : ""} ${selected ? "selected" : ""} ${sameDay(d, today) ? "today" : ""}`}
                      disabled={past}
                      aria-selected={!!selected}
                      aria-label={d.toLocaleDateString(undefined, { dateStyle: "full" })}
                      onClick={() => {
                        setFocused(d);
                        set(d);
                      }}
                    >
                      {d.getDate()}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="cal-time">
            <span>Time</span>
            <Select label="Hour" value={hour} options={HOURS} onChange={(h) => set(value ?? startOfToday, h, minute)} />
            <span className="colon">:</span>
            <Select label="Minute" value={minute} options={MINUTES} onChange={(m) => set(value ?? startOfToday, hour, m)} />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => close(true)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
