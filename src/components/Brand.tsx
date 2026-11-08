/**
 * Brixo identity (brand v2): a house drawn as a single navy stroke, standing on
 * orange foundation bricks, with three rising purple bars — "see beyond the property".
 * Colours come from theme tokens so the mark adapts to the Blueprint (dark) theme.
 */
export function BrixoMark({ size = 30, title }: { size?: number; title?: string }) {
  return (
    <svg viewBox="170 70 445 500" width={size * 0.89} height={size} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title} style={{ display: 'block', flex: 'none' }}>
      <polygon points="178,445 230,415 345,415 345,477 178,477" fill="var(--accent)" />
      <rect x="370" y="415" width="150" height="62" fill="var(--accent)" />
      <rect x="178" y="500" width="92" height="60" fill="var(--accent)" />
      <rect x="293" y="500" width="157" height="60" fill="var(--accent)" />
      <polygon points="178,415 178,233.9 399.9,79.4 605,219.6 605,499.8 544.8,560 488,560 488,498 519.2,498 543,474.2 543,252.4 400.1,154.7 240,266.1 240,383" fill="var(--ink)" />
      <polygon points="285,343 343,322 343,392 285,392" fill="var(--ai)" />
      <polygon points="365,301 422,280 422,392 365,392" fill="var(--ai)" />
      <polygon points="445,262 502,238 502,392 445,392" fill="var(--ai)" />
    </svg>
  );
}

export function BrixoWordmark({ tagline = false }: { tagline?: boolean }) {
  return (
    <span className="wordmark-lockup">
      <BrixoMark size={tagline ? 44 : 30} />
      <span className="wordmark-words">
        <span className="wordmark">BRIXO</span>
        {tagline && <span className="wordmark-tag">See Beyond the Property<span className="dot">.</span></span>}
      </span>
    </span>
  );
}
