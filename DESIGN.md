# Heimdall design system

Light-first **industrial operator console**. Optimized for dense ops work, not marketing chrome.

## Principles

1. Problems first — fleet home surfaces failures before vanity stats.
2. Hairline structure — use borders and alignment, not card stacks or heavy shadows.
3. Status dots, not pill spam — one small status indicator beats a row of badges.
4. One accent — signal teal only; no purple gradients, no glow effects.
5. Readable density — tables and monospace IDs welcome; whitespace is purposeful, not sparse.

## Typography

- UI: **IBM Plex Sans**
- Data / IDs / commands: **IBM Plex Mono**
- Avoid Inter, Roboto, Arial, and system-default stacks for primary UI.

## Color

| Token | Hex | Use |
| --- | --- | --- |
| Background | `#F4F6F8` | App canvas (light, cool gray) |
| Surface | `#FFFFFF` | Panels / tables |
| Foreground | `#161616` | Primary text |
| Muted | `#525252` | Secondary text |
| Border | `#C6C6C6` | Hairline rules |
| Signal | `#007D79` | Accent / interactive focus |
| Signal soft | `#9EF0F0` | Soft highlight only |
| OK | `#198038` | Healthy |
| Warn | `#B28600` | Degraded |
| Danger | `#DA1E28` | Critical |

Do not default to dark mode. Prefer a subtle grid/gradient atmosphere over a flat white slab.

## Layout

- First viewport of product surfaces: brand mark + one clear operational headline + short support line + primary action.
- No hero marketing cards, floating badges, or stat strips in Phase 0 stubs.
- Sections have one job, one headline, usually one supporting sentence.

## Components (later phases)

Primitives will come from shadcn/ui, restyled to these tokens. Prefer sharp corners and hairline borders over rounded-full pills.
