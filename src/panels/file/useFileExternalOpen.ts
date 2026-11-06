import { useCallback, useEffect, useRef, useState } from "react";
import type { BuiltInRuntimeActionId } from "@shared/config/actionIds";
import type { RevealCopy } from "@/components/FileViewer/revealCopy";
import { actionService } from "@/services/ActionService";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { logError } from "@/utils/logger";

// Which surface a toolbar action aims the current file at. `reveal` is always
// offered; `browser`/`editor` is the mode-dependent open button; `file-browser`
// is Daintree's own tree, offered only for a file inside a known worktree.
// `default-app` is the PDF error state's way out — the same OS-default handoff
// as `browser`, named for what it opens rather than for HTML.
export type ExternalTarget = "reveal" | "browser" | "editor" | "file-browser" | "default-app";

const EXTERNAL_ACTIONS = {
  reveal: "file.showItemInFolder",
  browser: "file.openInBrowser",
  editor: "file.openInEditor",
  "file-browser": "worktree.openFileBrowser",
  "default-app": "file.openInBrowser",
} as const satisfies Record<ExternalTarget, BuiltInRuntimeActionId>;

// Button label comes from `revealCopy()` (platform-named); the failure banner's
// title, retry name and dismiss name are resolved together with it so the three
// can't drift. Browser/editor wording is static — only reveal is platform-bound.
export function externalTargetCopy(
  target: ExternalTarget,
  reveal: RevealCopy
): { errorTitle: string; retryAriaLabel: string; dismissAriaLabel: string } {
  switch (target) {
    case "reveal":
      return {
        errorTitle: reveal.errorTitle,
        retryAriaLabel: reveal.retryAriaLabel,
        dismissAriaLabel: "Dismiss file manager error",
      };
    case "browser":
      return {
        errorTitle: "Couldn't open in browser",
        retryAriaLabel: "Retry opening in browser",
        dismissAriaLabel: "Dismiss browser error",
      };
    case "editor":
      return {
        errorTitle: "Couldn't open in editor",
        retryAriaLabel: "Retry opening in editor",
        dismissAriaLabel: "Dismiss editor error",
      };
    case "file-browser":
      return {
        errorTitle: "Couldn't open file browser",
        retryAriaLabel: "Retry opening file browser",
        dismissAriaLabel: "Dismiss file browser error",
      };
    case "default-app":
      return {
        errorTitle: "Couldn't open in default app",
        retryAriaLabel: "Retry opening in default app",
        dismissAriaLabel: "Dismiss default app error",
      };
  }
}

// Module scope so the hook below stays compilable: a statement-level `finally`
// bails React Compiler for the whole enclosing hook.
async function settleAfter<T>(work: Promise<T>, settle: () => void): Promise<T> {
  try {
    return await work;
  } finally {
    settle();
  }
}

export interface ExternalOpenError {
  message: string;
  target: ExternalTarget;
}

export interface FileExternalOpen {
  externalError: ExternalOpenError | null;
  dismissExternalError: () => void;
  /**
   * Resolves true once the action succeeded — for a remote window's reveal,
   * once main has copied the host path — so the control can confirm it.
   */
  handleOpenExternal: (target: ExternalTarget) => Promise<boolean>;
  /** Whether the target behind the standing failure banner is being retried. */
  isErrorTargetPending: boolean;
  showRetrySpinner: boolean;
}

/**
 * The pane's hand-offs to other surfaces — the OS file manager, the browser,
 * the external editor, Daintree's own file tree — and the inline failure each
 * one can leave behind.
 */
export function useFileExternalOpen({
  panelId,
  filePath,
  relativeFilePath,
  revealWorktreeId,
}: {
  panelId: string;
  filePath: string | undefined;
  relativeFilePath: string;
  revealWorktreeId: string;
}): FileExternalOpen {
  // dispatch() resolves an ActionDispatchResult and never rejects, so a failed
  // open used to vanish entirely (#11114). Surface it inline on the pane that
  // owns the button rather than through a global toast. `target` rides along so
  // Retry re-aims at what actually failed, even after a mode toggle.
  const [externalError, setExternalError] = useState<ExternalOpenError | null>(null);
  // Tracked per target, not as one flag: revealing successfully says nothing
  // about a missing editor, so the two must not clear or spin for each other.
  const [pendingTargets, setPendingTargets] = useState<readonly ExternalTarget[]>([]);
  // Bumped only by the reset below, so a still-running action is invalidated by
  // the file changing under it — never by a sibling button starting.
  const externalGenerationRef = useRef(0);
  // Synchronous re-entry guard: state can't stop a double-click in one tick.
  const externalInFlightRef = useRef<Set<ExternalTarget>>(new Set());

  // A result that lands after the pane switched files (or panels) belongs to the
  // old file: drop it, and clear any banner the old file left behind. Keyed on
  // the file alone, never the resolved worktree: this resets *every* target at
  // once, so folding topology churn in here would let a new nested worktree
  // erase a pending editor launch and its failure banner.
  useEffect(() => {
    externalGenerationRef.current += 1;
    externalInFlightRef.current.clear();
    setExternalError(null);
    setPendingTargets([]);
  }, [panelId, filePath]);

  const handleOpenExternal = useCallback(
    async (target: ExternalTarget): Promise<boolean> => {
      if (!filePath) return false;
      // File-browser carries worktree-scoped args and reveal opts into the
      // guarded out-of-root fallback; browser/editor stay path-only. Built
      // before the pending flip so a missing scope can't leave the button
      // spinning on a dispatch that was never going to happen.
      let args: unknown;
      if (target === "file-browser") {
        if (!revealWorktreeId) return false;
        args = {
          worktreeId: revealWorktreeId,
          // `toWorktreeRelative` hands back its input unchanged for a path that
          // *is* the root (the only such case here — containment is already
          // proven by revealWorktreeId), and the action would then trim
          // "/repo" down to a bogus "repo" child. Undefined opens the root.
          revealPath:
            relativeFilePath && relativeFilePath !== filePath ? relativeFilePath : undefined,
          revealKind: "file",
        };
      } else if (target === "reveal") {
        // Sent on every reveal, in-root or not: `effectiveRootPath` already
        // falls back to the file's own parent, so this pane deliberately
        // displays files no project owns, and reveal was the last surface in it
        // still asking the project registry for permission (#11934). The action
        // decides whether the fallback is needed — a second copy of the
        // containment rule has no business living in the renderer.
        args = { path: filePath, allowOutsideRoots: true };
      } else {
        args = { path: filePath };
      }
      if (externalInFlightRef.current.has(target)) return false;
      externalInFlightRef.current.add(target);
      const generation = externalGenerationRef.current;
      setPendingTargets((current) => (current.includes(target) ? current : [...current, target]));
      return settleAfter(
        actionService
          .dispatch(EXTERNAL_ACTIONS[target], args, { source: "user" })
          .then((result) => {
            // The file (or panel) changed while this was in flight: the result
            // describes a file the pane no longer shows, so it touches no
            // banner. A success still reports, since the copy it made is real.
            if (externalGenerationRef.current !== generation) return result.ok;
            if (result.ok) {
              // Clears only its own failure — a sibling's banner stands until
              // that button's own retry succeeds.
              setExternalError((current) => (current?.target === target ? null : current));
              return true;
            }
            logError(`[FilePane] ${EXTERNAL_ACTIONS[target]} failed`, result.error);
            setExternalError({ message: result.error.message, target });
            return false;
          }),
        () => {
          // Releasing on settlement keeps a rejection from wedging the button;
          // the generation check leaves a reset's clean slate alone.
          if (externalGenerationRef.current === generation) {
            externalInFlightRef.current.delete(target);
            setPendingTargets((current) => current.filter((t) => t !== target));
          }
        }
      );
    },
    [filePath, relativeFilePath, revealWorktreeId]
  );

  const dismissExternalError = useCallback(() => setExternalError(null), []);

  const isErrorTargetPending =
    externalError !== null && pendingTargets.includes(externalError.target);
  // Below the Doherty threshold a spinner is just a flash; `disabled` still
  // blocks a double submit from the first millisecond.
  const showRetrySpinner = useDohertyGate(isErrorTargetPending);

  return {
    externalError,
    dismissExternalError,
    handleOpenExternal,
    isErrorTargetPending,
    showRetrySpinner,
  };
}
