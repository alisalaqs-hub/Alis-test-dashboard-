/**
 * Streetkey identity: a key whose blade is a street of six houses, with an
 * orange locator dot in the bow. Wordmark "streetkey" with "key" in orange.
 * Colours follow theme tokens so the mark works in the Night (dark) theme.
 */
const HOUSES = [
  '172,125 172,95 193,72 214,95 214,125', '220,125 220,85 241,60 262,85 262,125', '268,125 268,96 289,74 310,96 310,125',
  '316,125 316,80 337,52 358,80 358,125', '364,125 364,92 385,68 406,92 406,125', '412,125 412,86 433,62 454,86 454,125',
];
export function StreetkeyMark({ height = 26, title }: { height?: number; title?: string }) {
  return (
    <svg viewBox="30 40 480 140" height={height} width={(height * 480) / 140} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title} style={{ display: 'block', flex: 'none' }}>
      <circle cx="90" cy="110" r="57" fill="none" stroke="var(--ink)" strokeWidth="26" />
      <path d="M140 125 H500 V172 H470 V151 H445 V166 H425 V151 H140 Z" fill="var(--ink)" />
      <rect x="342" y="44" width="8" height="28" fill="var(--ink)" />
      {HOUSES.map((p) => <polygon key={p} points={p} fill="var(--ink)" />)}
      <circle cx="90" cy="110" r="15" fill="var(--accent)" />
    </svg>
  );
}
/** Compact square mark (key bow + dot) for tight spaces. */
export function StreetkeyBow({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" style={{ display: 'block', flex: 'none' }}>
      <circle cx="32" cy="32" r="21" fill="none" stroke="var(--ink)" strokeWidth="10" />
      <circle cx="32" cy="32" r="7" fill="var(--accent)" />
    </svg>
  );
}
export function StreetkeyWordmark({ tagline = false }: { tagline?: boolean }) {
  return (
    <span className="wordmark-lockup">
      <StreetkeyMark height={tagline ? 34 : 24} />
      <span className="wordmark-words" aria-hidden="true">
        <span className="wordmark">street<span className="k">key</span></span>
        {tagline && <span className="wordmark-tag">See Beyond the Property<span className="dot">.</span></span>}
      </span>
    </span>
  );
}
