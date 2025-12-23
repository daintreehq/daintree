# Custom Panels: First Wave

## Context
Canopy already has a panel kind registry (`shared/config/panelKindRegistry.ts`) and a panel component registry (`src/registry/panelComponentRegistry.ts`). The store supports “non-PTY panels” as first-class entities (`src/store/slices/terminalRegistrySlice.ts`).

## Goal
Make it easy to add new panel types without touching core layout code, and ship a small “first wave” of high-value panels.

## Proposal
1. Standardize a minimal contract for non-PTY panels:
   - `panelKindRegistry.registerPanelKind({ id, name, iconId, color, hasPty: false, ... })`
   - `panelComponentRegistry.registerPanelComponent(kind, { component })`
   - A per-panel state store slice (like `src/store/browserStateStore.ts`) keyed by `panelId`.
2. Add a lightweight “Panel Palette” entry point:
   - Similar to the terminal palette, but for panel kinds (built-in + extensions).
3. First-wave candidates:
   - **Notes Panel (First-Class):** A durable, in-repo markdown scratchpad using `react-md-editor`. Features "Send to Agent" actions and a central "Notebook" entry point in the toolbar for restoring sessions.
   - **Git Activity Panel:** A timeline feed of recent repository events.

## Technical Notes
- Prefer keeping panel kinds in `shared` so both renderer and main can reason about capabilities and titles.
- For panels that need background data (git, watchers), add a scoped IPC API that returns pre-validated data rather than letting panels shell out.

## Acceptance Criteria
- A new non-PTY panel can be added by:
  - registering a kind,
  - registering a component,
  - storing its state keyed by `panelId`,
  - and launching it via a palette/menu entry.

