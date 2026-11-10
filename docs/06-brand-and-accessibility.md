# Streetkey — Brand System & Accessibility (v0.6)

## Brand (v3 · Streetkey)
| Element | Specification |
|---|---|
| Name | **Streetkey** in prose; **streetkey** in the wordmark, Plus Jakarta Sans 800, with **key** in orange |
| Tagline | *See Beyond the Property.* — full stop in orange. Hero line: “Find a home. Unlock the whole street.” |
| Mark | A key whose blade is a short street of four houses, with an orange locator dot in the bow (`src/components/Brand.tsx`). Compact bow-and-dot mark for favicon and tight spaces. |
| Palette | Navy `#0E1424` · Orange `#F07415` (the key) · Window glow `#FFC24B` (insight) · Warm paper `#F7F5F0` · Night blue `#34437A` (insights/AI on light) |
| Night theme (dark) | From the logo's night street: ground `#121A33`, surface `#1A2446`, text `#F7F5F0`, orange `#FF8A3D`, glow `#FFC24B` |
| Type | Plus Jakarta Sans only (self-hosted, variable 200–800). Figures use tabular numerals. Labels: 11.5px, 700, uppercase, 0.16em tracking. |
| Shapes | 12px buttons, 16px cards and search, fully rounded pills and tags |
| Insight pill | Navy pill, amber icon (from the logo's house tags) — used for anything Streetkey's AI or engines tell you |
| Header logo (interactive) | Key-and-street mark + wordmark, wordmark baseline aligned to the key's street line (`StreetkeyWordmark` in `src/components/Brand.tsx`). Hover/focus turns the key and lights the windows in sequence; the locator dot follows the pointer; Night theme lights the windows; clicking it on the home page unlocks the hero street. Reduced motion: no turn, no tracking. |
| Hero background | `src/components/JourneyScene.tsx`: the whole homepage hero is a living street, drawn as a fine-line architectural elevation of a Victorian terrace, that plays a home buyer's story on a loop behind the search: Look (the locator dot hops between homes for sale, prices pop up) → Buy (offer accepted, SOLD board, first-time-buyer stamp duty) → Move in (removal van, keys; the buyers walk along the pavement, up the path and in through their front door, then the lights come on) → Live (Outstanding school, train to the City with commute time) → Grow (renovation and loft, value after works, EPC pathway). Each chapter lasts 3.6 s. Every figure comes from the engines and demo listings. Interactive: hover a house for its price or sold price, click to open it, pointer parallax; the header logo restarts it. Callouts are placed clear of the search panel and of each other; on phones they show just the headline figure. Night theme = the street at dusk. A small pause/play button sits in the top-right corner (WCAG 2.2.2); reduced motion starts paused with no movement (no walking: the buyers are simply indoors); it also pauses off-screen; a visually hidden summary describes the story for screen readers. Phones/tablets: the street runs as a band under the search. |
| Product visual | “Look inside” lens on a listing (`src/components/XRay.tsx`) revealing its plans with live figures |

### Colour roles
* **Navy** = text, primary surfaces, insight pills.
* **Orange** = the key and primary actions. Orange fills carry **navy** text (6.3:1); orange as text on light uses `--accent-ink #B24D00` (4.87:1). White on orange is never used.
* **Glow amber** = insight highlights on navy (11.4:1).
* Focus ring: navy 3px (light), glow amber (Night) — the brand file's orange outline fails 3:1 on paper.

## Accessibility — WCAG 2.2 AA
**Automated audit:** axe-core run against **21 routes × light/dark × desktop (1280px)/mobile (390px) = 84 page views** with tags `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa` → **0 violations** (Nov 2026). Script: see "Re-running the audit" below.

Fixed during the audit: low-contrast buttons/labels on navy panels, keyboard access to scrollable tables and code blocks, unlabelled selects and inputs in tables, a low-contrast widget caption.

Fixed after the AI features were added (Nov 2026): text links in AI panels (`.linkish`) now mix 88% `--accent-ink` with ink (5.3:1 on `--surface-2`, 5.6:1 on paper); the "High" risk pill (`.ai-risk.high`) mixes 85% danger with ink (was 4.47:1); AI buttons stay focusable while working so focus never drops to the page; results are announced in a live region; signed-out prompts return people to where they were after signing in, with what they typed kept. The homepage street animation has a pause button (WCAG 2.2.2) and starts paused for people who prefer reduced motion.

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
