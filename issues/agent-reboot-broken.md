# Agent reboot functionality is broken due to terminal auto-close

## Summary
Agent terminals are automatically closed when they complete, preventing the reboot functionality from working correctly. When a user attempts to reboot an agent, it just closes the terminal instead of restarting it.

## Current Behavior
When an agent process completes (exit code 0):
1. The agent state transitions to `completed` via `AgentStateMachine`
2. `TerminalProcess` emits agent completion via `AgentStateService.emitAgentCompleted`
3. The terminal client's `onExit` handler fires (src/store/terminalStore.ts:428)
4. The terminal is auto-trashed, which eventually removes it permanently
5. Any subsequent reboot attempt has no terminal to operate on

**Affected Files:**
- [`electron/services/AgentStateMachine.ts`](https://github.com/gregpriday/canopy-electron/blob/main/electron/services/AgentStateMachine.ts#L62-L65) - Transitions to `completed` on exit code 0
- [`electron/services/pty/TerminalProcess.ts`](https://github.com/gregpriday/canopy-electron/blob/main/electron/services/pty/TerminalProcess.ts#L1268) - Emits completion event
- [`src/store/terminalStore.ts`](https://github.com/gregpriday/canopy-electron/blob/main/src/store/terminalStore.ts#L428-L453) - Auto-trashes on exit
- [`src/components/Terminal/TerminalContextMenu.tsx`](https://github.com/gregpriday/canopy-electron/blob/main/src/components/Terminal/TerminalContextMenu.tsx#L276-L278) - Restart menu action

## Expected Behavior
Completed agent terminals should remain open (in a "completed" state) so they can be:
1. Reviewed for their final output
2. Rebooted/restarted when needed
3. Manually closed by the user when no longer needed

## Problem Statement
The auto-close behavior conflicts with agent workflow expectations:
- Users lose access to completed agent output
- The reboot/restart action becomes impossible to use
- There's no way to review what an agent did after completion
- Agent terminals behave inconsistently with regular terminals

## Context
Agent terminals are managed through several layers:
1. **State Machine** (`AgentStateMachine.ts`) - Tracks agent lifecycle states
2. **Process Management** (`TerminalProcess.ts`) - Handles pty process lifecycle
3. **Terminal Store** (`terminalStore.ts`) - Manages terminal UI state and cleanup
4. **UI Actions** (`TerminalContextMenu.tsx`) - User-facing restart/reboot actions

The restart guard system (`restartExitSuppression.ts`) prevents exit handling during intentional restarts, but doesn't help with the completed state problem.

## Deliverables

### Code Changes
**Files to Modify:**
- [`src/store/terminalStore.ts`](https://github.com/gregpriday/canopy-electron/blob/main/src/store/terminalStore.ts#L428-L453) - Modify `onExit` handler to skip auto-trash for completed agents
- [`electron/services/pty/TerminalProcess.ts`](https://github.com/gregpriday/canopy-electron/blob/main/electron/services/pty/TerminalProcess.ts#L1263-L1272) - Review exit handling logic for agents

**Potential approach:**
1. Check if the terminal is an agent terminal with `completed` state
2. Skip auto-trash for completed agents
3. Allow manual close/trash via context menu or explicit action
4. Ensure restart/reboot functionality can spawn new process in same terminal slot

### Tests
- Add test coverage for completed agent terminal behavior
- Verify restart/reboot works after agent completion
- Ensure regular terminals still auto-close as expected

## Tasks
- [ ] Modify `onExit` handler in [`terminalStore.ts:428`](https://github.com/gregpriday/canopy-electron/blob/main/src/store/terminalStore.ts#L428) to preserve completed agent terminals
- [ ] Ensure restart functionality works with preserved completed terminals
- [ ] Add visual indicator for completed agent state (if not already present)
- [ ] Test edge cases (failed agents, killed agents, regular terminals)
- [ ] Update tests to cover new behavior

## Acceptance Criteria
- [ ] Agent terminals remain open after completing successfully
- [ ] Reboot/restart actions work on completed agent terminals
- [ ] Users can manually close completed agent terminals
- [ ] Regular (non-agent) terminals maintain current auto-close behavior
- [ ] Failed agent terminals behave appropriately (auto-close or stay open)
- [ ] Tests pass for agent terminal lifecycle

## Edge Cases & Risks
**Edge Cases:**
- Failed agents (exit code != 0) - should they also stay open?
- Agents killed mid-execution - should maintain current behavior
- Regular terminals - must not be affected by this change
- Trash TTL expiry - completed agents in trash should still be cleaned up

**Risks:**
- Terminal accumulation if users don't manually close completed agents
- Memory usage if many completed agents stay open
- Potential state confusion if completed terminal gets into unexpected state

## Dependencies
None - this is a standalone fix to terminal lifecycle management.
