# Icons

Daintree's UI runs on Lucide icons via `lucide-react`. The few files in this
directory are exceptions to that rule.

## Layout

- `DaintreeIcon.tsx` — the product logo. Brand mark only; not a UI action icon.
- `AgentStateCircles.tsx` — the multi-dot agent-state indicator. Not a single
  glyph; it's a small state-indicator component that lives next to the icon
  set because it's drawn from the same SVG conventions.
- `brands/` — third-party brand marks (language runtimes, package managers,
  AI agents, MCP). These follow each brand's official mark and are kept
  bespoke for recognition.
- `index.ts` — the barrel. Exports the brand marks plus a curated set of
  Lucide icons used as Daintree concept aliases (`Plug` for agents, `Sprout`
  for first-agent setup, `FolderGit2` for worktrees, `Folders` for worktree
  overview, `Workflow` for terminal recipes, `BellDot` for watch alerts,
  `Folders` for copy-tree, `Layers` for worktree overview, `Activity` for project pulse). Re-exporting
  through the barrel keeps callsites short and gives us a single place to
  swap if a metaphor changes.

## Conventions

- Use Lucide's existing icons. Only add a bespoke component to `brands/` if
  it's a real third-party brand mark with recognition value.
- For Daintree-specific concepts, pick the closest Lucide icon and add it to
  the alias list in `index.ts`. We don't draw bespoke icons for app concepts.
- Always set `aria-hidden="true"` unless the icon is the sole label for an
  interactive control, in which case use `aria-label` instead.

## Style reference

Lucide's design system documents the construction rules:
<https://lucide.dev/contribute/icon-design-guide>
