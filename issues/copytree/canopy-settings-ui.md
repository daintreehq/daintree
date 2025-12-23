# Canopy Settings: CopyTree Configuration UI

## Context
Users need to control how much context Canopy sends to agents, especially for large repositories. This requires a dedicated settings interface to configure the new "Smart Truncation" features of CopyTree.

## Goal
Add a configuration section (likely in **Project Settings**) to manage CopyTree behavior, with a way to test/preview the results.

## Location
**Project Settings Dialog** (`src/components/Project/ProjectSettingsDialog.tsx`)
*   Add a new tab or section: **"Context & Agents"** (or just "Context").

## UI Requirements

### 1. Size Constraints
*   **Max Context Size:** Slider or Input (e.g., 2MB, 5MB, 10MB, Unlimited).
    *   *Tooltip:* "The maximum amount of text sent to the agent."
*   **Max File Size:** Input (e.g., 100KB). Files larger than this are skipped or truncated.

### 2. Truncation Strategy
*   **Strategy Dropdown:**
    *   "All Files (Fail if too large)"
    *   "Newest Files First" (Recommended)
*   **Truncation Behavior:** Checkbox "Truncate large files instead of skipping" (uses the `truncateLargeFiles` core feature).

### 3. Pattern Overrides
*   **"Always Include" (Globs):** Textarea for patterns (e.g., `README.md`, `docs/**/*.md`). These files are prioritized even if they are old.
*   **"Always Exclude" (Globs):** Textarea for patterns to hide from the agent (e.g., `package-lock.json`, `*.svg`).

### 4. "Test Configuration" (Dry Run)
*   Button: **"Test Context Generation"**
*   Action: Calls a new IPC endpoint (wrapping `copytree.dryRun()`).
*   Output:
    *   "Included: 45 files (2.1 MB)"
    *   "Excluded: 120 files (Age), 3 files (Size)"
    *   *Optional:* A simplified list/tree showing which files made the cut.

## Data Model & Persistence
*   Persist these settings in `ProjectSettings` (`settings.json` in the project's userData).
*   Update `CopyTreeService` (Electron) to read these settings from the `ProjectStore` before generating context.

## IPC Changes
*   Update `copytree:generate` (or add `copytree:generate-with-config`) to accept overrides.
*   Add `copytree:test-config` (for the dry run).

## Acceptance Criteria
*   User can restrict context size to a specific limit (e.g., 1MB).
*   User can verify which files are included via the Test button.
*   "Newest First" strategy correctly drops older files when the limit is hit.
*   "Always Include" files are present even if old.
