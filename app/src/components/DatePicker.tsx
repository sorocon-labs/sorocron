import { useEffect, useMemo, useRef, useState } from "react";
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

export function formatDateTime(d: Date): string {
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Date and time picker in local time, replacing <input type="datetime-local">.
 * Times snap to 5 minutes; past days can't be chosen.
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
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const days = useMemo(() => {
    const first = new Date(month);
    const offset = (first.getDay() + 6) % 7; // Monday first
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [month]);

  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const hour = value ? String(value.getHours()).padStart(2, "0") : "12";
  const minute = value ? String(Math.floor(value.getMinutes() / 5) * 5).padStart(2, "0") : "00";

  const set = (day: Date, h = hour, m = minute) => {
    onChange(new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(h), Number(m)));
  };

  return (
    <div className="datepicker" ref={root}>
      <div className="datepicker-row">
        <button
          type="button"
          className={`input datepicker-trigger ${value ? "" : "placeholder"}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={label}
          onClick={() => setOpen((o) => !o)}
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
            <span>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Next month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            >
              <Icon name="chevronRight" size={16} />
            </button>
          </div>
          <div className="cal-grid" role="grid">
            {WEEKDAYS.map((d) => (
              <span key={d} className="cal-dow" role="columnheader">
                {d}
              </span>
            ))}
            {days.map((d) => {
              const outside = d.getMonth() !== month.getMonth();
              const past = d < startOfToday;
              const selected = value && sameDay(d, value);
              return (
                <button
                  key={d.toISOString()}
                  type="button"
                  role="gridcell"
                  className={`cal-day ${outside ? "outside" : ""} ${selected ? "selected" : ""} ${sameDay(d, today) ? "today" : ""}`}
                  disabled={past}
                  aria-selected={!!selected}
                  aria-label={d.toLocaleDateString(undefined, { dateStyle: "full" })}
                  onClick={() => set(d)}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          <div className="cal-time">
            <span>Time</span>
            <Select label="Hour" value={hour} options={HOURS} onChange={(h) => set(value ?? startOfToday, h, minute)} />
            <span className="colon">:</span>
            <Select label="Minute" value={minute} options={MINUTES} onChange={(m) => set(value ?? startOfToday, hour, m)} />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
