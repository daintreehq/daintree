# Add `agent --help` output in agent settings

## Summary
In **Settings → Agents**, add a second block that displays the selected agent’s `--help` output. This helps users discover which CLI flags are available for the existing “Custom Arguments” field.

## Current State
- Agents are defined in `shared/config/agentRegistry.ts` with `command`, `name`, `usageUrl`, etc.
- Settings UI (`src/components/Settings/AgentSettings.tsx`) allows `customFlags` but doesn’t provide flag discovery.
- Main process already checks CLI presence using `execFileSync(which/where, [command])` in `electron/services/CliAvailabilityService.ts`.
- There is currently no IPC/API to run an agent command and return stdout/stderr.

## Goals
- Show help text for the selected agent when available, without leaving Canopy.
- Make output copyable and easy to scan (monospace, scrollable).
- Be safe: only run trusted binaries from the agent registry; no shell execution.
- Avoid spamming processes: cache results and expose a manual refresh.

## Non-goals
- Running arbitrary commands or user-provided binaries.
- Deep parsing/structuring of flags (first iteration can display raw help output).
- Installing the agent; this issue is informational only (pairs well with installation-help spec).

## Proposed UX
In `src/components/Settings/AgentSettings.tsx`, for the active agent:
- Add a “Help Output” section below “Custom Arguments”.
- If CLI is not installed: show a short message (“CLI not found”) and link to install/docs if available.
- If installed:
  - Button row: `Load` (first time), `Refresh`, `Copy`.
  - Render output in a fixed-height scroll container (monospace) with truncation indicator if needed.
  - If command fails (non-zero exit): still display captured output, plus a small error banner.

## Data / Config
Not all CLIs use the same help flags. Add optional help metadata to the agent config:

```ts
interface AgentHelpConfig {
  /** Arguments used to print help output */
  args: string[]; // default ["--help"]
  /** Optional title override for UI */
  title?: string;
}

interface AgentConfig {
  // existing fields...
  help?: AgentHelpConfig;
}
```

If agents move to JSON config, keep `help.args` there.

## IPC / Main Process Design
Add a single IPC method that returns the help output for a specific agent id:
- Request: `{ agentId: string }`
- Response: `{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }`

Implementation notes:
- Must use `execFile` (not `exec`), never invoke a shell.
- Only allow `agentId` that exists in `AGENT_REGISTRY`; resolve `command` and `help.args` exclusively from config.
- Reuse the same command validation as `CliAvailabilityService` (allow only `[a-zA-Z0-9._-]`).
- Add hard limits:
  - timeout (e.g., 2s–5s)
  - max output size (e.g., 256KB combined) with truncation
- Always return partial output even on failure/timeout.

Caching:
- Cache per agent in main process (in-memory) with timestamp.
- Optional TTL (e.g., 10 minutes) and `refresh` flag for explicit refresh.

## Security Considerations
- Do not accept arbitrary commands or arguments from the renderer.
- No environment leakage: run with a minimal environment if feasible, or at least don’t pass secrets explicitly.
- Output may contain ANSI escapes; renderer should sanitize/strip ANSI sequences before rendering.
- Ensure output rendering is text-only (no HTML injection).

## Acceptance Criteria
- For an installed agent, Settings → Agents can show its `--help` output (or configured help args).
- Output is cached and can be manually refreshed.
- Missing CLI shows a clear message; no crashes.
- IPC rejects unknown agent ids and invalid commands.
- Large outputs are truncated with a visible indicator; UI remains responsive.

## Follow-ups (optional)
- Parse help output into a searchable list of flags and descriptions.
- Add a “Insert flag” UX to append a selected flag into “Custom Arguments”.
- Combine with OS-specific installation help when CLI is missing.
