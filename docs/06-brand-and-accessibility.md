# Brixo — Brand System & Accessibility (v0.4)

## Brand
| Element | Specification |
|---|---|
| Name | **Brixo** in prose; **BRIXO** in the wordmark (Montserrat 800) |
| Tagline | *See Beyond the Property.* — full stop in brand orange |
| Mark | Single-stroke navy house on orange foundation bricks, three rising purple bars (growth). Source SVG: `src/components/Brand.tsx` (also the favicon) |
| Core palette | Navy `#0B0F1C` · Orange `#F07415` (foundations) · Purple `#5E3BF6` (growth & AI) · Paper `#F6F7F9` · Grid `#E6E9EF` · Muted `#5B6070` |
| Blueprint palette (dark theme & X-ray) | Ground `#0A1633` · Grid `#15295A` · Line `#7FD4FF` · Guide `#3F6FBF` · Orange `#FF9A4D` · Purple `#A996FF` |
| Type | Montserrat (display 800, UI 500–700) · JetBrains Mono (figures, labels: 11px, uppercase, 0.14em tracking) |
| Surface | Paper with a 40px drafting grid; white cards with 1px grid-line borders; 10px button radius |
| Signature interaction | **X-ray lens** (`src/components/XRay.tsx`): drag over a home to reveal its blueprint annotated with live engine figures (loft, kitchen, EPC, value, ground risk); "See through" toggle reveals all |
| Section labels | Drawing-sheet numbering: `01 / FIND`, `02 / DO`, `03 / FOR YOU`… |

### Colour roles (enforced by tokens in `src/styles.css`)
* **Navy** = primary actions and text. Primary buttons are navy with white text.
* **Orange** = foundations/highlight. Orange *fills* always carry **navy** text (6.6:1). Orange *text* on light surfaces uses `--accent-ink #B24D00` (4.95:1). White on orange (2.9:1) is never used.
* **Purple** = growth and anything the AI says (AI tags, Ask button, assistant panels, focus rings).
* Status colours (teal/gold/blue/red) are only used with text or icons, never colour alone.

## Accessibility — WCAG 2.2 AA
**Automated audit:** axe-core run against **21 routes × light/dark × desktop (1280px)/mobile (390px) = 84 page views** with tags `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa` → **0 violations** (Nov 2026). Script: see "Re-running the audit" below.

Fixed during the audit: low-contrast buttons/labels on navy panels, keyboard access to scrollable tables and code blocks, unlabelled selects and inputs in tables, a low-contrast widget caption.

**Built-in measures**
* All text pairings ≥ 4.5:1 (large text ≥ 3:1) in both themes; focus ring 3px purple (`#5E3BF6`, 5.7:1 on paper) / cyan in Blueprint.
* Skip link ("Skip to main content"), landmarks (`header`, `nav` with labels, `main#main`, `footer`), one `h1` per page.
* Modal sheets (Ask, Menu): `role="dialog"` + `aria-modal`, focus moved in, Tab trapped, Escape closes, focus returned to the opener.
* Touch targets ≥ 44px for primary controls, ≥ 36px for chips (WCAG 2.2 target size ≥ 24px).
* `prefers-reduced-motion`: animations/transitions disabled; X-ray lens stops auto-moving and is controlled by the user or the "See through" button.
* X-ray graphics are `aria-hidden`; the same annotations are exposed as a list for screen readers; the toggle uses `aria-pressed`.
* Charts always have numeric labels or tables; deal grades use letters, not colour alone.
* `lang="en-GB"`, `theme-color` per scheme, safe-area insets for iOS home indicator.

**Still to do (manual)**
* Screen-reader walkthroughs with VoiceOver (iOS/macOS) and NVDA (Windows); 200% / 400% zoom and reflow checks; usability sessions with disabled users.
* Accessible names for every chart region; live-region announcements for search result counts.
* Publish an accessibility statement (required for many public-sector and enterprise customers).

### Re-running the audit
```bash
npm run build
npx vite preview --port 4173 &
npm run a11y        # scripts/a11y-audit.cjs — prints violations or NO VIOLATIONS
```
