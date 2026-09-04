# Brand vibe — digital ecology

Daintree is named after the rainforest. The product is a "digital ecology" — agents, branches, terminals and projects living and growing inside one environment. This doc captures the visual language we lean on so anything custom we draw (illustrations, marketing, the brand mark) reads as one family.

This is a brand-vibe note, not the icon spec. The app's UI icons are Lucide, not a bespoke set — see `src/components/icons/README.md` for the authoritative, current icon policy. The metaphor below still guides _which_ Lucide icons we reach for and how we'd draw an illustration, but Daintree no longer commissions custom app-concept glyphs (that set was removed in `540019a07`).

## The metaphor in one paragraph

A Daintree project is a small living system. Worktrees are branches off a trunk. Agents are inhabitants — quiet, organic, intelligent — that grow alongside the code. Activity is sap and pulse. Broadcasts are signals travelling through a canopy. The work feels alive because the environment is alive.

## Motifs

These are the recurring visual cues for custom artwork (illustrations, marketing, brand mark). Use them sparingly — at most one per piece, never as decoration:

- **Branches and stems** — vertical or curved single strokes terminating in a node or a container. Used wherever something derives from something else (worktrees, recipes, agent runs).
- **Leaves** — almond or droplet shapes. Used as the "organic life" cue. Not decorative — usually doing real work in the silhouette.
- **Pulses and waves** — single-stroke heartbeats and concentric arcs. Used for activity and signal.
- **Containers with growth** — rounded rectangles fed by a branch or stem, not bare rectangles. The thing is always part of a system, not isolated.
- **Nodes** — small filled or outlined circles at the start of stems and branches. The "origin" or "seed" of a structure.

## What we don't draw

- **Robots, antennae, mechanical bodies.** AI in Daintree is organic, not mechanical. If we wanted a bot icon we would use Lucide's `bot` directly.
- **Faces, eyes-as-features, anthropomorphic creatures.** The ecology is living but not personified.
- **Decorative leaves or flourishes.** Every element earns its place by doing structural work in the piece.
- **Dense textures, gradients, fills.** Line only, single stroke weight — this is a software UI, not a botanical illustration.

## How this lands in the icon set

The app's icons are Lucide, full stop. There is no commissioned Daintree glyph set — the bespoke app-concept icons were removed in `540019a07` and each product concept now resolves to the nearest stock Lucide icon, aliased once in `src/components/icons/index.ts` so callsites stay short:

| Concept | Lucide icon |
| --- | --- |
| Agent | `Plug` (an integration that plugs into the host) |
| Origin / first step (main worktree, first launch) | `Sprout` |
| Worktree | `FolderGit2` |
| Worktree overview | `Layers` |
| Project pulse / live activity | `Activity` |
| Terminal recipe | `Workflow` |
| Watch alert | `BellDot` |
| Copy tree | `Folders` |

The metaphor still does work here: it's why agents read as a `Plug` rather than a `Bot`, why origin is a `Sprout`, why pulse is an `Activity` heartbeat. When a new concept needs an icon, pick the closest Lucide icon that carries the ecology cue and add it to the alias list — don't draw a new glyph.

The only bespoke SVG components left in `src/components/icons/` are the brand mark (`DaintreeIcon`), the MCP mark (`McpServerIcon`, which mirrors the official MCP logo), the multi-dot agent-state indicator (`AgentStateCircles`), and the third-party brand marks under `brands/` — a large set covering the supported agent CLIs plus the languages, runtimes and tools the process detector surfaces. Bespoke components are reserved for real brand marks with recognition value, never for app concepts.

Three files there are plumbing rather than artwork: `BrandMark.tsx` and `BrandSurface.tsx` (the ink/backdrop system described below) and `pluginIconRegistry.ts` (how a plugin contributes an icon).

### Brand-mark ink is computed, never authored

Third-party marks carry vendor hexes from `AgentConfig.color`, so they are the one colour family the semantic palette cannot reach — and the one place where "just pick a colour" would break contrast on some theme. Never hand a colour to a brand glyph. The SVG stays on `currentColor`, `BrandMark` publishes a rest ink and an active ink, and `resolveBrandMarkInk` (`src/lib/brandIcon.ts`) derives both against the backdrop the mark is actually painted on: active is the brand colour untouched where it clears its contrast floors and the smallest move along its own hue line where it does not; rest is that colour drawn back _away from the backdrop_, so hovering reads as a bloom of colour rather than a wash-out. `BrandSurface` is how the backdrop is known.

The full rules — the ceiling that keeps a resting mark from outshouting the controls beside it, the achromatic-brand carve-out, and the crossfade sampling — are in [../themes/interaction-state-recipes.md](../themes/interaction-state-recipes.md#brand-mark-states). Treat that as the spec; this section exists so the brand side of the house knows the ink is not a design decision made per mark.

## Where the metaphor still applies

Illustrations and marketing — anything outside the Lucide-driven UI icon set — are where "digital ecology" has room to breathe. There the same rules hold: line over fill, motif over decoration, every element doing structural work. If you're drawing for a landing page or an empty-state hero, the motifs above are the vocabulary; the brand mark (`DaintreeIcon`) is the anchor.

## Adjacent reference

- Authoritative current icon policy: `src/components/icons/README.md`.
- Icon rules that bind in the app (monochrome, no opacity dimming, solid tokens over slash-alpha): [`.claude/rules/design-system.md`](../../.claude/rules/design-system.md) and [../themes/theme-tokens.md](../themes/theme-tokens.md#text-tokens).
- Brand-mark ink and backdrop system: [../themes/interaction-state-recipes.md](../themes/interaction-state-recipes.md#brand-mark-states).
- Theme hero artwork, which is the other place the metaphor is drawn rather than described: `.claude/skills/daintree-theme-creator/resources/theme-preview-images.md`.
- Lucide construction rules (grid, stroke, optical alignment), useful when judging which stock icon fits or when drawing a brand mark: <https://lucide.dev/contribute/icon-design-guide>
