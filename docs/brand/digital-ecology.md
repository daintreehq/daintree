# Brand vibe — digital ecology

Daintree is named after the rainforest. The product is a "digital ecology" —
agents, branches, terminals and projects living and growing inside one
environment. This doc captures the visual language we lean on so anything
custom we draw (icons, illustrations, marketing) reads as one family.

## The metaphor in one paragraph

A Daintree project is a small living system. Worktrees are branches off a
trunk. Agents are inhabitants — quiet, organic, intelligent — that grow
alongside the code. Activity is sap and pulse. Broadcasts are signals
travelling through a canopy. The work feels alive because the environment
is alive.

## Motifs

These are the recurring visual cues. Use them sparingly — at most one per
icon, never as decoration:

- **Branches and stems** — vertical or curved single strokes terminating in
  a node or a container. Used wherever something derives from something else
  (worktrees, recipes, agent runs).
- **Leaves** — almond or droplet shapes. Used as the "organic life" cue.
  Not decorative — usually doing real work in the silhouette.
- **Pulses and waves** — single-stroke heartbeats and concentric arcs. Used
  for activity and signal.
- **Containers with growth** — rounded rectangles fed by a branch or stem,
  not bare rectangles. The thing is always part of a system, not isolated.
- **Nodes** — small filled or outlined circles at the start of stems and
  branches. The "origin" or "seed" of a structure.

## What we don't draw

- **Robots, antennae, mechanical bodies.** AI in Daintree is organic, not
  mechanical. If we wanted a bot icon we would use Lucide's `bot` directly.
- **Faces, eyes-as-features, anthropomorphic creatures.** The ecology is
  living but not personified.
- **Decorative leaves or flourishes.** Every element earns its place by
  doing structural work in the icon.
- **Dense textures, gradients, fills.** Line only, single stroke weight —
  this is a software UI, not a botanical illustration.

## How this lands in the icon set

Custom icons should look like they belong in the Lucide icon pack — same
24×24 grid, 2px stroke, round caps and joins, `currentColor`. The "digital
ecology" cue is a quiet through-line, not a stylistic departure. If you
removed every Lucide icon from a toolbar and left only Daintree's customs,
they should still feel like one consistent family.

The current commission set leans into this in three groups:

- **Living things** — Daintree Agent (brain with a leaf cue).
- **Branching systems** — Worktree, Worktree Overview (branches into
  containers).
- **Pulses and signals** — Project Pulse, Broadcast Terminal (waves and
  arcs travelling outward).

The remaining icons (Copy Tree, Terminal Recipe, Watch Alert) carry the
ecology cue more lightly — through stems, growth, and observation rather
than overt botanical detail.

## Contribution intent

Where possible, custom icons we commission are **drawn to be contributable
upstream to Lucide**. That sets a high bar: each concept must be generally
useful (not Daintree-specific branding), each construction must satisfy
Lucide's design guide exactly, and each name must be kebab-case and
descriptive of the _concept_, not of Daintree's product surface (e.g.
`git-worktree`, not `daintree-worktree`).

This shapes our briefs in three ways:

- We pick **general concepts** that already have demand outside Daintree
  (git worktrees, terminal broadcast, eye-with-alert, clipboard-with-tree).
- We **avoid product-specific motifs** (no Daintree wordmarks, no rainforest
  scenes inside the glyph) — the "digital ecology" theme lives in the
  _choice_ of concept, not in a watermark.
- We default to **Lucide's compositional grammar** even where it costs us
  brand distinctiveness — these icons must blend, not stand out.

## Adjacent reference

For construction rules (grid, stroke, optical alignment, naming):
<https://lucide.dev/contribute/icon-design-guide>

For the contribution process itself:
<https://lucide.dev/guide/developers/contribute>
