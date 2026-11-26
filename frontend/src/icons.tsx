// Stroke icons (SF Symbols stand-ins) used across the kit. No sparkle or wand shapes.
const P: Record<string, string> = {
  model: "M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5",
  cube: "M12 3l8 4.5v9L12 21l-8-4.5v-9z",
  lineage: "M3 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M3 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M17 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0 M7 6c5 0 5 6 10 6 M7 18c5 0 5-6 10-6",
  play: "M7 5l12 7-12 7z",
  stop: "M7 7h10v10H7z",
  tests: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M8.5 12l2.5 2.5 4.5-5",
  book: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z M4 19V5 M8 7h7",
  db: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  plug: "M9 3v5 M15 3v5 M6 8h12v3a6 6 0 0 1-12 0z M12 17v4",
  box: "M4 8h16v11H4z M9 8V5h6v3",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  file: "M6 3h8l4 4v14H6z M14 3v4h4",
  branch: "M6 4v12 M6 20a2 2 0 1 0 0-4a2 2 0 1 0 0 4z M18 8a2 2 0 1 0 0-4a2 2 0 1 0 0 4z M18 8c0 5-12 4-12 8",
  check: "M5 12.5l4.5 4.5L19 7",
  x: "M6 6l12 12 M18 6L6 18",
  warn: "M12 4l9 16H3z M12 10v4 M12 17h.01",
  info: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 11v5 M12 8h.01",
  minus: "M5 12h14",
  plus: "M12 5v14M5 12h14",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M20 20l-4-4",
  clock: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 7v5l3 2",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7 M20 5v6h-6",
  download: "M12 4v11 M7 10l5 5 5-5 M5 20h14",
  gear: "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M4.9 19.1L7 17 M17 7l2.1-2.1",
  code: "M9 7l-5 5 5 5 M15 7l5 5-5 5",
  sidebar: "M4 5h16v14H4z M9 5v14",
  chart: "M4 20V4 M4 20h16 M8 16v-4 M12 16V8 M16 16v-6",
  table: "M4 5h16v14H4z M4 10h16 M4 15h16 M10 5v14",
  wifiOff: "M3 3l18 18 M8.5 16.5a5 5 0 0 1 7 0 M5 12.5a10 10 0 0 1 4-2.3 M19 12.5a10 10 0 0 0-3-2 M12 20h.01",
  key: "M15 7a4 4 0 1 0 0 0.01 M12.2 9.8L4 18v2h3v-2h2v-2h2l1.8-1.8",
  terminal: "M4 5h16v14H4z M7 9l3 3-3 3 M12 15h5",
  globe: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18",
  user: "M12 12a4 4 0 1 0 0-8a4 4 0 1 0 0 8z M4 21c1-4 4-6 8-6s7 2 8 6",
  users: "M9 11a3.5 3.5 0 1 0 0-7a3.5 3.5 0 1 0 0 7z M2.5 20c.8-3.4 3.3-5 6.5-5s5.7 1.6 6.5 5 M16 4.5a3.5 3.5 0 0 1 0 6.5 M18 15c2 .6 3.2 2.2 3.5 5",
  card: "M3 6h18v12H3z M3 10h18 M7 15h4",
  logout: "M10 5H5v14h5 M14 8l4 4-4 4 M18 12H9",
  chevron: "M9 6l6 6-6 6",
  back: "M15 6l-6 6 6 6",
  chevronDown: "M6 9l6 6 6-6",
  zoomIn: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M20 20l-4-4 M8 11h6 M11 8v6",
  zoomOut: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M20 20l-4-4 M8 11h6",
  fit: "M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5",
  save: "M5 4h11l3 3v13H5z M8 4v5h7V4 M8 20v-6h8v6",
  trash: "M5 7h14 M10 7V4h4v3 M7 7l1 13h8l1-13",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  seed: "M4 5h16v14H4z M4 10h16 M10 10v9",
  snapshot: "M4 8h3l2-3h6l2 3h3v11H4z M12 10a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z",
  exposure: "M4 20V4 M4 20h16 M8 16v-4 M12 16V8 M16 16v-6",
  command: "M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z",
  pencil: "M4 20h4L19 9l-4-4L4 16z M14 6l4 4",
  sun: "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.4 1.4 M17.6 17.6L19 19 M5 19l1.4-1.4 M17.6 6.4L19 5",
  upload: "M12 20V9 M7 14l5-5 5 5 M5 4h14",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  pipeline: "M2 12h9 M8 8l4 4-4 4 M14 6c0-1.1 1.8-2 4-2s4 .9 4 2-1.8 2-4 2-4-.9-4-2z M14 6v12c0 1.1 1.8 2 4 2s4-.9 4-2V6",
  sql: "M4 5h16v14H4z M7 10l3 2-3 2 M12 14h5",
  calendar: "M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4",
  tools: "M14.5 6.5a4 4 0 0 0-5 5L3 18l3 3 6.5-6.5a4 4 0 0 0 5-5l-2.5 2.5-3-3z",
  api: "M8 7l-5 5 5 5 M16 7l5 5-5 5 M13 4l-2 16",
  copy: "M8 8h11v12H8z M5 16V4h11",
};

export type IconName = keyof typeof P;

export function I({ n, size, className = "", style }: { n: IconName | string; size?: 14 | 18 | 20 | 28 | 40; className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={`i ${size ? "s" + size : ""} ${className}`} viewBox="0 0 24 24" aria-hidden="true" style={style}>
      <path d={P[n] ?? P.cube} />
    </svg>
  );
}

export const typeIcon: Record<string, IconName> = {
  model: "cube",
  seed: "seed",
  snapshot: "snapshot",
  source: "db",
  exposure: "exposure",
  pipeline: "pipeline",
  test: "tests",
  analysis: "file",
  metric: "chart",
  semantic_model: "cube",
};

export function Chev() {
  return (
    <svg className="chev" viewBox="0 0 9 13" aria-hidden="true">
      <path d="M1 5l3.5-3.5L8 5M1 8l3.5 3.5L8 8" />
    </svg>
  );
}

export function AppMark({ size = 28 }: { size?: number }) {
  return <img src="/icon.svg" width={size} height={size} alt="" style={{ borderRadius: size * 0.22, display: "block", flex: "none" }} />;
}
