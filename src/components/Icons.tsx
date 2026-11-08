/** Minimal stroke icon set (24px grid). */
const P: Record<string, string> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  home: 'M4 11l8-7 8 7v9H4zM9 20v-6h6v6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  pound: 'M16 6.5A3.5 3.5 0 0 0 9.5 8v4M7 12h7M8 19h9M9.5 12c0 3-1.5 5-2.5 7',
  tools: 'M14 6l4 4-9 9H5v-4zM16 4l4 4',
  palette: 'M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-1.5-1-2.5S14 15 15 15h2a4 4 0 0 0 4-4c0-4.4-4-8-9-8zM7.5 11.5h.01M10 7.5h.01M15 7.5h.01',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  key: 'M14 10a4 4 0 1 0-3.5 4L9 16H7v2H5v2H3v-3l7-7',
  building: 'M4 21V5l8-2v18M12 8h8v13M8 8h.01M8 12h.01M8 16h.01M16 12h.01M16 16h.01M2 21h20',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 8.5h.01',
  pin: 'M12 21s-6-5.5-6-11a6 6 0 1 1 12 0c0 5.5-6 11-6 11zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  x: 'M6 6l12 12M18 6L6 18',
  crane: 'M6 21V4h12l-4 4M6 7h10M16 7v6M14 13h4v3h-4zM3 21h8',
  briefcase: 'M4 8h16v12H4zM9 8V5h6v3M4 13h16',
};
export function Icon({ name, size = 22, stroke = 1.8 }: { name: keyof typeof P | string; size?: number; stroke?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={P[name] ?? P.search} /></svg>;
}
