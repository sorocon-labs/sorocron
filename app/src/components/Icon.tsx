/**
 * Hand-drawn icon set on a 20px grid with one stroke weight, so every icon
 * in the app matches. Add new glyphs here rather than pulling in a library.
 */
const PATHS = {
  overview: "M3 3h6v6H3zM11 3h6v4h-6zM11 9h6v8h-6zM3 11h6v6H3z",
  jobs: "M4 5h12M4 10h12M4 15h7",
  user: "M10 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM3.5 17c.8-3 3.4-4.5 6.5-4.5s5.7 1.5 6.5 4.5",
  plus: "M10 4v12M4 10h12",
  keeper: "M10 2.5 16 5v4.5c0 3.8-2.6 6.6-6 8-3.4-1.4-6-4.2-6-8V5zM7.5 10l1.8 1.8L13 8",
  registry: "M4 4.5h12v4H4zM4 11.5h12v4H4zM6.5 6.5h.01M6.5 13.5h.01",
  clock: "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM10 6v4l2.5 1.5",
  wallet: "M3 6.5h14v9H3zM3 6.5 13 3.5v3M13.5 11h.01",
  copy: "M7 7h9v9H7zM4 13V4h9",
  check: "M4.5 10.5 8 14l7.5-8",
  close: "M5 5l10 10M15 5 5 15",
  chevronDown: "M5.5 8 10 12.5 14.5 8",
  chevronLeft: "M12 5.5 7.5 10l4.5 4.5",
  chevronRight: "M8 5.5 12.5 10 8 14.5",
  arrowRight: "M4 10h12M11.5 5.5 16 10l-4.5 4.5",
  arrowLeft: "M16 10H4M8.5 5.5 4 10l4.5 4.5",
  external: "M8 4H4v12h12v-4M11 3h6v6M17 3l-8 8",
  search: "M9 15.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM14 14l3.5 3.5",
  pause: "M7 4.5v11M13 4.5v11",
  play: "M6.5 4.5v11l9-5.5z",
  trash: "M4 6h12M8 6V4h4v2M5.5 6l.8 10h7.4l.8-10",
  coin: "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM12.5 7.5c-.4-.9-1.4-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.1 0-2.1-.6-2.5-1.5M10 4.5v11",
  bolt: "M11 2.5 4.5 11H10l-1 6.5L15.5 9H10z",
  calendar: "M3.5 5h13v11.5h-13zM3.5 8.5h13M7 3v3.5M13 3v3.5",
  menu: "M3.5 6h13M3.5 10h13M3.5 14h13",
  sun: "M10 13.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM10 2v1.5M10 16.5V18M2 10h1.5M16.5 10H18M4.3 4.3l1.1 1.1M14.6 14.6l1.1 1.1M4.3 15.7l1.1-1.1M14.6 5.4l1.1-1.1",
  moon: "M16.5 11.5A6.5 6.5 0 0 1 8.5 3.5a6.5 6.5 0 1 0 8 8Z",
  alert: "M10 3 17.5 16.5h-15zM10 8.5v3.5M10 14.5h.01",
  info: "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM10 9v5M10 6.5h.01",
  logout: "M8 3.5H4v13h4M12 6.5 15.5 10 12 13.5M15.5 10H7.5",
  shield: "M10 2.5 16 5v4.5c0 3.8-2.6 6.6-6 8-3.4-1.4-6-4.2-6-8V5z",
  book: "M4 4h5a2 2 0 0 1 2 2v10a1.5 1.5 0 0 0-1.5-1.5H4zM16 4h-5a2 2 0 0 0-2 2v10a1.5 1.5 0 0 1 1.5-1.5H16z",
  code: "M7 6 3 10l4 4M13 6l4 4-4 4",
  minus: "M4 10h12",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`icon ${className ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The SoroCron mark: a clock face whose hand is a forward arrow. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="logo">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="currentColor" />
      <circle cx="12" cy="12" r="6.25" fill="none" stroke="var(--logo-ink)" strokeWidth="1.8" />
      <path d="M12 8.5V12l2.6 1.6" fill="none" stroke="var(--logo-ink)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
