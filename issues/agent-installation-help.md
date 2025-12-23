# Add OS-specific installation help for agents

## Summary
When an agent CLI isn’t installed, Canopy already detects this (`which/where`) and shows “Click to install”, but there is no in-app guidance for how to install the CLI. As we add more agents, we should include basic installation help per OS in each agent’s configuration and render it inside **Settings → Agents**.

## Current State (as of today)
- Agent definitions live in `shared/config/agentRegistry.ts` (`AGENT_REGISTRY`) and are consumed by both renderer and main process.
- CLI availability is checked in `electron/services/CliAvailabilityService.ts` by calling `which`/`where` for each agent’s `command`.
- UI currently surfaces “CLI not found” in a few places, but does not provide install steps:
  - Settings status list: `src/components/Settings/GeneralTab.tsx`
  - Launcher/tooltips: `src/components/Layout/AgentButton.tsx`, `src/components/Terminal/ContentGrid.tsx`
  - Agent settings UI: `src/components/Settings/AgentSettings.tsx` (config only; no availability/install guidance)

## Goals
- Provide “what to do next” when an agent CLI is missing: OS-specific install steps + official docs link.
- Keep install help data close to the agent definition so adding a new agent includes install guidance by default.
- Avoid running installation commands automatically; provide copy-to-clipboard and clear warnings.
- Make it easy to update/extend without touching UI code (via the planned JSON agent configuration).

## Non-goals
- Automatically install CLIs, elevate privileges, or run shell commands on the user’s behalf.
- Guarantee correctness of third-party installation commands beyond what’s in config (we link to official docs).
- Complex dependency troubleshooting (Node/Python versions, PATH issues) beyond a small “Troubleshooting” hint.

## Proposed UX
**Settings → Agents**
- For the selected agent, show a status row near the header:
  - `Ready` if CLI found, otherwise `Not installed`.
  - Button: `Re-check` (calls refresh availability).
- If `Not installed`, show an “Installation” section:
  - A short OS-specific set of steps (macOS / Windows / Linux), based on the user’s OS.
  - One or more copyable commands.
  - Link button: `Open install docs` (opens `install.docsUrl` in browser).
  - Small warning text: “Commands run in your system shell; review before running.”
- Fallback behavior:
  - If no OS match: show a “Generic” block.
  - If no config present: show only an “Open install docs” link (or hide section).

**Launch surfaces**
- No major change required initially: existing “Click to install” continues to route users to Settings → Agents.
- Optional follow-up: when user clicks “Click to install” for a specific agent, open Settings → Agents with that agent pre-selected.

## Data Model (for the planned JSON agent configuration)
Add an optional `install` field to each agent config entry.

### Suggested shape
```ts
type AgentInstallOS = "macos" | "windows" | "linux" | "generic";

interface AgentInstallBlock {
  /** Short human label, e.g. "Homebrew" / "npm" */
  label?: string;
  /** Text steps; renderer may render as Markdown or simple paragraphs */
  steps?: string[];
  /** Commands to copy (no execution) */
  commands?: string[];
  /** Optional extra notes/warnings */
  notes?: string[];
}

interface AgentInstallHelp {
  docsUrl?: string;
  byOs?: Partial<Record<AgentInstallOS, AgentInstallBlock[]>>;
  /** Optional troubleshooting hints shown after blocks */
  troubleshooting?: string[];
}
```

### Minimal JSON example
```json
{
  "id": "claude",
  "name": "Claude",
  "command": "claude",
  "color": "#CC785C",
  "iconId": "claude",
  "supportsContextInjection": true,
  "install": {
    "docsUrl": "https://example.com/claude-cli-install",
    "byOs": {
      "macos": [
        {
          "label": "Homebrew",
          "commands": ["brew install <package>"]
        }
      ],
      "windows": [
        {
          "label": "npm",
          "commands": ["npm install -g <package>"]
        }
      ],
      "linux": [
        {
          "label": "npm",
          "commands": ["npm install -g <package>"]
        }
      ]
    },
    "troubleshooting": ["Restart Canopy after installation to re-check PATH."]
  }
}
```

Notes:
- `byOs` supports multiple blocks per OS to represent multiple install paths (brew vs npm vs package manager).
- Commands are strings for simple “copy” affordances; any formatting (code blocks) stays in UI.
- Use placeholders only in docs/spec; actual config should point at official package names and official install docs.

## OS Detection
Use a simple OS mapping in the renderer:
- macOS: `navigator.platform` includes `MAC`
- Windows: `navigator.platform` includes `WIN`
- Linux: default to `linux` if not mac/windows (or add a main-process `system.getPlatform()` API for accuracy)

## Implementation Notes (high level)
- Extend `shared/config/agentRegistry`’s `AgentConfig` type to include `install?: AgentInstallHelp`.
- Add install UI to `src/components/Settings/AgentSettings.tsx`:
  - Fetch CLI availability via `cliAvailabilityClient.get()` (and `refresh()` for the `Re-check` button).
  - Determine OS and select the appropriate install blocks from agent config.
  - Render commands with copy-to-clipboard and a docs link (use existing `window.electron.system.openExternal`).
- Consider adding a lightweight “availability badge” to agent selector pills (optional; present in other surfaces already).
- Follow-up: if agent configs move to JSON, keep the `install` field in the JSON schema and load it into `AGENT_REGISTRY`.

## Acceptance Criteria
- When an agent CLI is missing, Settings → Agents shows an Installation section with OS-appropriate steps (or a generic fallback).
- The Installation section includes at least one copyable command when configured.
- A `Re-check` action updates the availability state without restarting the app.
- No automatic command execution; install help is informational only.
- Agents without `install` metadata still render correctly (no crashes; graceful fallback).

## Risks / Edge Cases
- “Installed but not on PATH” will still show missing; troubleshooting should mention PATH + restarting.
- Windows executable names may vary (`.cmd`, `.exe`); install help should not assume a single binary beyond `command`.
- Some agents require auth/setup after install; include notes per agent (e.g., “Run `<cmd> auth login`”).
