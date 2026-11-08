/** BRIXO identity: a building block whose "O" is a lens — See Beyond the Property. */
export function BrixoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--ink)" />
      <path d="M6 12.5h20M6 19.5h20M13 5v7.5M20 12.5v7M11 19.5V27" stroke="var(--paper)" strokeOpacity=".22" strokeWidth="1.4" />
      <circle cx="20.5" cy="20" r="6.2" fill="var(--accent)" />
      <circle cx="20.5" cy="20" r="2.6" fill="var(--ink)" />
      <circle cx="22" cy="18.5" r="1" fill="#fff" />
    </svg>
  );
}

export function BrixoWordmark() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, letterSpacing: '0.04em' }}>
      <BrixoMark />
      <span>BRIX<span style={{ display: 'inline-block', width: '0.78em', height: '0.78em', border: '0.17em solid var(--accent)', borderRadius: '50%', verticalAlign: '-0.05em', marginLeft: '0.04em' }} aria-label="O" /></span>
    </span>
  );
}
