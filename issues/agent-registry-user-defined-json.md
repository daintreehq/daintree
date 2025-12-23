# Agents: User-Defined Agent Registry (JSON) + Manager UI

## Context
Agents are currently registry-driven (`shared/config/agentRegistry.ts`) with per-agent enable/flags settings (`shared/types/agentSettings.ts`, `src/components/Settings/AgentSettings.tsx`). However, the registry is build-time and limited to a fixed set of agent IDs.

## Goal
Support “most agents” by allowing users to add agent definitions via JSON, while keeping security and IPC boundaries tight.

## Proposal
1. Add a persisted “user agent registry”:
   - A JSON schema for `AgentConfig`-like entries: `{ id, name, command, color, iconId, supportsContextInjection, ... }`.
   - Merge strategy: `effectiveRegistry = builtInRegistry + userRegistry` (user can override display name/color/icon but not core safety policies unless explicitly allowed).
2. Add an “Agents Manager” section in Settings:
   - List built-in + user agents.
   - Enable/disable toggles (existing).
   - “Add agent…” button with JSON paste + validation + preview.
   - “Remove” for user agents.
   - Icon chooser: limited set of Lucide icons + “generic agent” fallback.
3. Keep the runtime model centered on `agentId` (not legacy `TerminalType`) so new agents can be launched without type changes.

## Technical Notes
- `CliAvailabilityService` should use the effective registry (built-in + user) when checking installed commands.
- Validate commands defensively (existing service already rejects suspicious command strings).
- Avoid exposing arbitrary execution beyond what’s already possible: agents still run as terminal commands, but the UI should make it explicit that “user agents run local commands”.

## Acceptance Criteria
- User can add a new agent via JSON, enable it, and launch it from the UI.
- Availability checks reflect the newly added agent command.
- Built-in agents remain stable and continue to have official icons/colors by default.

