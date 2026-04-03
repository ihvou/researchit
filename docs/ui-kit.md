# Researchit UI Kit

## Direction
- Aesthetic: ultra-minimal technical instrument.
- References: Linear, Oxide Computer, Stripe docs, Vercel dashboard.
- Prohibitions: no gradients, no illustration-heavy UI, no pill-shaped controls, no blue CTA emphasis.

## Foundations
- Typography:
  - UI text: `IBM Plex Sans`.
  - Data and labels: `IBM Plex Mono` for compact codes and numeric emphasis.
- Shape:
  - Control radius: `2px`.
  - Borders are primary separators; shadows are avoided.
- Motion:
  - Subtle only (`~120ms` color/border transitions).
  - No decorative animation beyond loading spinners.

## Color Tokens
- `--ck-bg`: `#f3f3f2`
- `--ck-surface`: `#ffffff`
- `--ck-surface-soft`: `#f7f7f6`
- `--ck-line`: `#d5d5d2`
- `--ck-line-strong`: `#b8b8b4`
- `--ck-text`: `#121212`
- `--ck-muted`: `#4b4b48`
- `--ck-muted-soft`: `#73736f`
- `--ck-accent`: `#121212`
- `--ck-accent-ink`: `#ffffff`
- `--ck-accent-soft`: `#ececeb`

## Interaction Rules
- Primary actions: dark fill (`--ck-accent`) with white text.
- Secondary actions: white or soft surface with 1px neutral border.
- Focus: 1px dark outline with small offset.
- Status states: text/label driven (Done, In progress, Pending, Blocked), not saturated color coding.

## Component Conventions
- Tabs: thin underline on active state, muted inactive labels.
- Badges/chips: rectangular micro-labels, neutral backgrounds, no color-semantic “success/warn” styling.
- Confidence marker: compact mono labels (`H`, `M`, `L`) with neutral borders.
- Evidence/source links: dark text links with underline on hover.
- Export templates: same grayscale palette and radius system as in-app UI.
