# Project setting: user-provided icon/logo for grid empty state

## Summary
The panel grid empty state currently uses the Canopy logo (`CanopyIcon`) as the primary visual.
We want this to become a fallback, and instead encourage each project to provide its own SVG icon/logo
that will display in the empty state.

This reinforces a core product philosophy: when the UI needs branding, prefer the user’s project over Canopy.

## Current Behavior
- Empty state always renders `CanopyIcon`:
  - `src/components/Terminal/ContentGrid.tsx` (`EmptyState` component)
- The empty-state title is already project/worktree-forward:
  - It uses `activeWorktreeName || "Canopy"` as the heading.
- “Project Settings” exists and already persists per-project settings:
  - Renderer hook: `src/hooks/useProjectSettings.ts`
  - Settings UI: `src/components/Project/ProjectSettingsDialog.tsx`
  - Main persistence: `electron/services/ProjectStore.ts` writes `settings.json` under `app.getPath("userData")/projects/{projectId}/`
  - IPC channels exist: `project:get-settings`, `project:save-settings` (`electron/ipc/handlers/project.ts`)

## Desired Behavior
- If the current project has a custom SVG icon configured:
  - Render that icon in the grid empty state instead of the Canopy logo.
- If no icon is configured:
  - Keep the Canopy logo as a fallback, but add a clear call-to-action to set a project icon.
- The icon is a project-level setting (per repo/project ID), not global.

## UX Proposal

### Project Settings (primary place to set it)
Add a “Project Icon (SVG)” section to `Project Settings` (likely in the existing “Project Identity” section):
- Preview of the configured icon at the size used in the empty state.
- `Choose SVG…` button (file picker) and/or drag-and-drop target.
- `Remove` action to clear the icon.
- Inline validation/error messaging.
- Guidance text (short): “Shown in the grid empty state. SVG only.”

Implementation notes:
- Prefer a standard `<input type="file" accept="image/svg+xml">` in the renderer over a new IPC dialog.
  - The renderer can read the file via `File.text()` / `FileReader` without Node access.
  - This avoids adding a new IPC surface area.

### Empty State (encouragement + fallback)
In `src/components/Terminal/ContentGrid.tsx` empty state:
- If project icon exists: show icon.
- If not: show `CanopyIcon` but add a secondary line/CTA:
  - Button: `Add project icon` → opens Project Settings directly.
    - There is already an app-wide pattern: `window.dispatchEvent(new CustomEvent("canopy:open-project-settings"))`
      (used in `src/components/Layout/Toolbar.tsx`).

## Data Model & Persistence

### Option A (recommended): store the SVG in `ProjectSettings`
Extend `ProjectSettings` in `shared/types/domain.ts`:
```ts
export interface ProjectSettings {
  runCommands: RunCommand[];
  environmentVariables?: Record<string, string>;
  excludedPaths?: string[];
  projectIconSvg?: string; // raw SVG text (sanitized/validated)
}
```

Pros:
- Already a “project setting” boundary.
- Already persisted to disk per project via `ProjectStore.saveProjectSettings`.
- Avoids modifying the global `Project` list payload stored in `electron-store`.

Cons:
- Storing raw SVG text can increase the size of `settings.json` (mitigate with size limits).

### Storage size limits
Recommended constraints:
- Max SVG text size: 100–250 KB.
- Reject empty SVGs.
- Keep original text after validation/sanitization for best fidelity.

### Main process changes
Update `electron/services/ProjectStore.ts`:
- In `getProjectSettings`, include `projectIconSvg` when present.
- In `saveProjectSettings`, no structural change needed beyond accepting the new field.

Update IPC validation in `electron/ipc/handlers/project.ts`:
- Today it only checks `typeof settings === "object"`.
- Add stricter validation (recommended):
  - Add a Zod schema for project settings (or a minimal runtime check) to ensure `projectIconSvg` is a string when present and not over the size limit.

## Rendering & Security Considerations (SVG)
SVGs can carry active content (scripts, `foreignObject`, external references). Rendering strategy should minimize risk:

Recommended approach:
- Render via `<img>` using a data URL instead of inlining SVG markup into the DOM.
  - `img` rendering prevents script execution from the SVG in modern browsers.

Additional recommended validation before saving:
- Parse the text and reject if it contains:
  - `<script`, `<foreignObject`, event handler attributes like `onload=`, `onclick=`, etc.
  - External references: `href="http`, `xlink:href="http`, `url(http` (conservative)
- Ensure the root element is `<svg`.

Renderer helper (suggested):
- `src/lib/svg.ts` with:
  - `validateProjectSvg(svgText: string): { ok: true; svg: string } | { ok: false; error: string }`
  - `svgToDataUrl(svgText: string): string`

## Implementation Guide (step-by-step)

### 1) Types
- [ ] Add `projectIconSvg?: string` to `ProjectSettings` in `shared/types/domain.ts`.
- [ ] Ensure `shared/types/index.ts` exports remain correct (if needed).

### 2) Main process persistence
- [ ] Update `electron/services/ProjectStore.ts` `getProjectSettings` to include `projectIconSvg`.
- [ ] (Recommended) Add validation in `electron/ipc/handlers/project.ts` for `project:save-settings` payload.
  - At minimum: enforce `typeof projectIconSvg === "string"` and length limit.

### 3) Project settings UI
- [ ] Add a “Project Icon (SVG)” control to `src/components/Project/ProjectSettingsDialog.tsx`.
  - Load from `settings.projectIconSvg` into local state when initializing.
  - On file selection:
    - Read text, validate, set preview, and persist via `saveSettings({ ...settings, projectIconSvg })`.
  - Add `Remove` to persist `projectIconSvg: undefined`.
- [ ] Keep UX aligned with existing “Project Identity” styling (cards, small helper copy).

### 4) Empty state rendering
- [ ] Get the current project ID via `useProjectStore((s) => s.currentProject)` (or plumb it in from `AppLayout`).
- [ ] Fetch the project icon:
  - Preferred: add a lightweight hook that only loads `project:get-settings` (no runner detection), e.g. `useProjectBranding(projectId)` or `useProjectSettings({ includeDetectedRunners: false })`.
  - Avoid calling the existing `useProjectSettings` as-is from the empty state if it will always trigger `detectRunners`, since the empty state can render frequently.
- [ ] In `src/components/Terminal/ContentGrid.tsx`, replace the fixed `CanopyIcon` with:
  - custom project icon (if present) rendered via `<img src={dataUrl}>`
  - otherwise `CanopyIcon` fallback
- [ ] Add an “Add project icon” CTA when missing:
  - dispatch `canopy:open-project-settings` (or pass a callback down from `AppLayout` if preferred).

### 5) Testing
- [ ] Add unit tests for SVG validation/data URL generation (`src/lib/__tests__/svg.test.ts`).
  - Valid SVG accepted
  - Oversized SVG rejected
  - `<script>` rejected
  - `foreignObject` rejected
- [ ] Add a lightweight component test (optional) verifying fallback vs custom rendering if the repo patterns already include React component tests.

## Acceptance Criteria
- [ ] Empty state shows the project’s configured SVG icon when set.
- [ ] Empty state falls back to the Canopy icon when unset.
- [ ] Empty state encourages configuration when unset (CTA to Project Settings).
- [ ] Project icon persists per project and survives app restart.
- [ ] SVG handling is safe-by-default (no inline execution, basic validation).
- [ ] `npm test` and `npm run check` pass.

## Edge Cases & Notes
- Project switched while settings fetch is in flight:
  - Ensure the empty state doesn’t briefly flash the wrong icon (use the “latest request” guard pattern used in `useProjectSettings.ts`).
- Worktree selected but project icon missing:
  - Still show worktree name as the heading; icon is project-level.
- Export/import:
  - If project settings are ever exported in the future, include the icon field.
- Future enhancement:
  - Allow using a repo file (e.g. `.canopy/icon.svg`) rather than storing the SVG in app userData.
    - This would make the icon shareable across machines, but needs careful path security and file watching.
