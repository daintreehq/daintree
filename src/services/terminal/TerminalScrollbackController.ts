import { type ManagedTerminal, SCROLLBACK_REDUCE_COOLDOWN_MS } from "./types";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { logDebug, logInfo } from "@/utils/logger";

function getValidScrollbackBase(value: number | undefined): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function readScrollback(managed: ManagedTerminal): number {
  return managed.terminal.options.scrollback ?? 0;
}

function writeScrollback(managed: ManagedTerminal, lines: number): void {
  managed.terminal.options.scrollback = lines;
}

// Lines a scrollback write would have to evict, measured on the buffer the
// setter actually trims. While the alternate screen is up `buffer.active` is
// only `rows` tall, so measuring it reports zero eviction even though xterm
// still resizes — and trims — the normal buffer underneath. reduceScrollback
// bails on isAltBuffer before it measures, so active and normal always agree
// there; restoreScrollback checks that guard further in and must not. #11673
function retainedScrollback(managed: ManagedTerminal): number {
  return Math.max(0, managed.terminal.buffer.normal.length - managed.terminal.rows);
}

export interface ReduceScrollbackOptions {
  /**
   * Bypass the per-terminal cooldown — only the cooldown; the interaction
   * guards always hold. No production caller passes it: the memory-pressure
   * reduce (reduceScrollbackHidden) honours the cooldown, and a profile
   * downshift goes through restoreScrollback.
   */
  force?: boolean;
}

export function reduceScrollback(
  managed: ManagedTerminal,
  targetLines: number,
  options: ReduceScrollbackOptions = {}
): void {
  if (managed.isFocused) return;
  if (managed.isUserScrolledBack) return;
  if (managed.isAltBuffer) return;
  if (managed.terminal.hasSelection()) return;

  if (!options.force) {
    const lastReduceAt = managed.lastScrollbackReduceAt;
    if (lastReduceAt !== undefined && Date.now() - lastReduceAt < SCROLLBACK_REDUCE_COOLDOWN_MS) {
      return;
    }
  }

  const currentScrollback = readScrollback(managed);
  if (currentScrollback <= targetLines) return;

  const scrollbackUsed = managed.terminal.buffer.active.length - managed.terminal.rows;
  writeScrollback(managed, targetLines);
  managed.lastScrollbackReduceAt = Date.now();

  if (scrollbackUsed > targetLines) {
    logInfo("Terminal scrollback reduced under memory pressure", {
      targetLines,
      scrollbackUsed,
      previousScrollback: currentScrollback,
      rows: managed.terminal.rows,
      kind: managed.kind,
      force: options.force === true,
    });
  }
}

export interface RestoreScrollbackOptions {
  /**
   * Only apply the policy where it lowers the limit. For hidden panes in a
   * bulk re-derive: raising one would undo a memory-pressure reduce while
   * nobody can see the pane, and its reveal restores capacity anyway.
   */
  shrinkOnly?: boolean;
}

export function restoreScrollback(
  managed: ManagedTerminal,
  options: RestoreScrollbackOptions = {}
): void {
  const { scrollbackLines } = useScrollbackStore.getState();
  const { performanceMode } = usePerformanceModeStore.getState();

  if (performanceMode) {
    // Deliberate user downshift — apply it unconditionally, past the guards.
    // The automatic profile re-derive (restoreScrollbackAll) skips this mode
    // so it never spreads that to terminals the user didn't toggle.
    writeScrollback(managed, PERFORMANCE_MODE_SCROLLBACK);
    return;
  }

  const isAgent = Boolean(managed.runtimeAgentId);
  const projectScrollback = !isAgent
    ? getValidScrollbackBase(
        useProjectSettingsStore.getState().settings?.terminalSettings?.scrollbackLines
      )
    : undefined;
  const globalScrollback = getValidScrollbackBase(scrollbackLines) ?? 0;
  const targetLines = getScrollbackForType(isAgent, projectScrollback ?? globalScrollback);

  // Growth (agent promotion, resource-tier upgrade) is non-destructive — always
  // apply it. A shrink, though, synchronously and irreversibly evicts the
  // oldest buffer lines in xterm (same primitive as reduceScrollback). When
  // this "restore" would actually drop history — an agent→plain demotion
  // during a detection flap where the plain target is smaller than the agent
  // ceiling, or a resource-profile downshift lowering the agent ceiling under
  // every open pane at once — apply the same protections as reduceScrollback
  // so a focused, selecting, or scrolled-back user doesn't lose scrollback to
  // transient flapping. #10911, #11673
  const currentScrollback = readScrollback(managed);
  if (options.shrinkOnly && targetLines >= currentScrollback) return;
  if (targetLines < currentScrollback) {
    const scrollbackUsed = retainedScrollback(managed);
    const wouldEvict = scrollbackUsed > targetLines;
    if (wouldEvict) {
      if (managed.isFocused) return;
      if (managed.isUserScrolledBack) return;
      if (managed.isAltBuffer) return;
      if (managed.terminal.hasSelection()) return;

      // Both a clamp and a destructive reduce rewrite options.scrollback, and
      // either recreates xterm's CircularList — so they share one cooldown. An
      // agent-detection flap raises the ceiling on every promotion, which would
      // otherwise let a re-clamp through on every demotion.
      const lastReduceAt = managed.lastScrollbackReduceAt;
      if (lastReduceAt !== undefined && Date.now() - lastReduceAt < SCROLLBACK_REDUCE_COOLDOWN_MS) {
        return;
      }

      // A pane the user can see is not a safe place to drop history, but the
      // ceiling can still come down to the lines already retained: nothing on
      // screen is lost and the buffer stops growing toward the old ceiling, so
      // a resource-profile downshift still takes effect. Deliberately below the
      // four guards above: those are live interaction states, where clamping to
      // capacity would start rolling history out from under a selection or a
      // scrolled-back reader on the next line of output. Mere visibility
      // carries no such reading position. #11673
      if (managed.isVisible) {
        const safeTarget = Math.max(targetLines, scrollbackUsed);
        if (safeTarget < currentScrollback) {
          writeScrollback(managed, safeTarget);
          managed.lastScrollbackReduceAt = Date.now();
          logDebug("Terminal scrollback ceiling clamped to retained history", {
            requestedTarget: targetLines,
            appliedTarget: safeTarget,
            previousScrollback: currentScrollback,
            kind: managed.kind,
          });
        }
        return;
      }
    }

    writeScrollback(managed, targetLines);
    if (wouldEvict) {
      managed.lastScrollbackReduceAt = Date.now();
      logInfo("Terminal scrollback ceiling lowered, evicting history", {
        targetLines,
        scrollbackUsed,
        previousScrollback: currentScrollback,
        rows: managed.terminal.rows,
        kind: managed.kind,
      });
    }
    return;
  }

  writeScrollback(managed, targetLines);
}
