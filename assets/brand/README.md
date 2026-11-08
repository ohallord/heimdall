# Heimdall brand — Bifrost Beacon (Concept B)

Dan-approved 2026-11-06. Palette and mark from `docs/oss-prep/brand/concept-B-brief.md` (Project store).

## Palette

| Token | Hex | Use |
| --- | --- | --- |
| Navy | `#0A1628` | Dark grounds, light-mark tower, wordmark on cream |
| Cream | `#F3EDE0` | Tower on dark, light grounds, dark wordmark text |
| Mustard | `#D4A017` | Innermost Bifrost arc |
| Teal | `#1AA6A0` | Middle arc, wordmark underline |
| Purple | `#5B2C8A` | Outermost Bifrost arc (favicon uses this arc only) |

## Masters (true SVG, no raster embeds)

| File | Purpose |
| --- | --- |
| `heimdall-mark.svg` | Full mark (tower + 3 arcs), transparent |
| `heimdall-mark-light.svg` | Full mark for light UI (navy tower) |
| `heimdall-mark-dark.svg` | Full mark for dark UI (cream tower) |
| `heimdall-mark-favicon.svg` | Tower + **outer purple arc only** |
| `heimdall-icon-app.svg` | Navy rounded-square app icon |
| `heimdall-wordmark-light.svg` | Cream header bar wordmark |
| `heimdall-wordmark-dark.svg` | Navy header bar wordmark |
| `heimdall-social-1280x640.svg` | Social / OG source |

## Derived

- `png/` — 16, 32, 48, 180, 192, 512 (from favicon or app icon as noted in build script)
- `favicon.ico` — multi-size ICO
- `heimdall-social-1280x640.png`
- `derived/brand-sheet.png` — rendered review sheet

Tagline from the concept sheet is optional and not required here.

Rebuild rasters: `node scripts/build-brand-assets.mjs`
