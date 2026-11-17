import { useState, useEffect, useCallback, useSyncExternalStore } from "react";
import { isElectronAvailable } from "./useElectron";
import type {
  Artifact,
  ArtifactDetectedPayload,
  ApplyPatchResult,
  SaveArtifactResult,
} from "@shared/types";
import { artifactClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { getPanelStoreSnapshot } from "@/store/storeAccessors";
import { logErrorWithContext } from "@/utils/errorContext";
import { logDebug } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";

const artifactStore = new Map<string, Artifact[]>();
const listeners = new Set<(terminalId: string, artifacts: Artifact[]) => void>();
const refState = { count: 0, unsubscribe: null as (() => void) | null };

// Each artifact holds its full content string, so a long agent session would
// otherwise grow a terminal's entry without bound. Keep the newest N; the
// oldest are dropped FIFO. Explicit teardown (removeArtifactsForTerminal)
// remains the primary cleanup path.
export const MAX_ARTIFACTS_PER_TERMINAL = 50;

function notifyListeners(terminalId: string, artifacts: Artifact[]) {
  listeners.forEach((listener) => listener(terminalId, artifacts));
}

/**
 * Holds the shared `onDetected` IPC subscription for one mounted owner and
 * returns its release; the last release drops the subscription.
 */
function acquireDetection(): () => void {
  refState.count++;

  if (refState.count === 1 && !refState.unsubscribe) {
    refState.unsubscribe = artifactClient.onDetected((payload: ArtifactDetectedPayload) => {
      appendArtifacts(payload.terminalId, payload.artifacts);
    });
  }

  return () => {
    refState.count--;

    if (refState.count === 0 && refState.unsubscribe) {
      refState.unsubscribe();
      refState.unsubscribe = null;
    }
  };
}

/**
 * Whether this view keeps artifacts for a terminal: its panel is registered
 * here and not in the trash. Main broadcasts detections to every view and can
 * deliver one after its panel is gone (#10023); asking the live registry on
 * arrival turns those away without remembering any retired id (#17577). A
 * renderer with no panel registry wired runs no teardown either, so it keeps
 * every packet.
 */
function acceptsArtifactsFor(terminalId: string): boolean {
  const panelsById = getPanelStoreSnapshot()?.panelsById;
  if (!panelsById) return true;
  return Object.hasOwn(panelsById, terminalId) && panelsById[terminalId]!.location !== "trash";
}

/**
 * Append detected artifacts for a terminal, honoring the registry gate and
 * the per-terminal cap. Single implementation shared by the production
 * `onDetected` handler and `__test_simulateArtifactDetected` so the two paths
 * cannot drift. Returns false when the terminal's panel isn't live here.
 */
function appendArtifacts(terminalId: string, artifacts: Artifact[]): boolean {
  if (!acceptsArtifactsFor(terminalId)) {
    return false;
  }
  // An empty batch must not create a Map entry or notify listeners.
  if (artifacts.length === 0) {
    return true;
  }
  const currentArtifacts = artifactStore.get(terminalId) || [];
  const merged = [...currentArtifacts, ...artifacts];
  const newArtifacts =
    merged.length > MAX_ARTIFACTS_PER_TERMINAL ? merged.slice(-MAX_ARTIFACTS_PER_TERMINAL) : merged;
  artifactStore.set(terminalId, newArtifacts);
  notifyListeners(terminalId, newArtifacts);
  return true;
}

/**
 * Drop the per-terminal entry from the module-level artifact store and notify
 * any still-mounted listeners with an empty array. Called from the `panelIds`
 * and `trashedTerminals` subscribers in `rendererStoreOrchestrator.ts` so
 * force-removed panels (browser/dev-preview, worktree teardown shrinking
 * `panelIds` without a PTY exit, and the user-close trash path that doesn't
 * shrink `panelIds`) do not leak their content strings for the lifetime of
 * the renderer.
 * Safe to call for unknown ids (`Map.delete` is a no-op) and safe to call
 * twice. Mirrors the shape of `unregisterInputController` and
 * `useResourceMonitoringStore.removePanel` so the orchestrator's teardown
 * loop remains the single convergence point.
 */
export function removeArtifactsForTerminal(terminalId: string): void {
  artifactStore.delete(terminalId);
  notifyListeners(terminalId, []);
}

/** Reset all module-level state. Only for test isolation. */
export function __test_resetArtifactStore(): void {
  artifactStore.clear();
  listeners.clear();
  refState.count = 0;
  if (refState.unsubscribe) {
    refState.unsubscribe();
    refState.unsubscribe = null;
  }
}

/** Test-only: seed the module-level store for a terminal id. */
export function __test_seedArtifactStore(terminalId: string, items: Artifact[]): void {
  artifactStore.set(terminalId, [...items]);
}

/** Test-only: current size of the module-level store. */
export function __test_getArtifactStoreSize(): number {
  return artifactStore.size;
}

/** Test-only: peek the seeded entry for a terminal id. */
export function __test_getArtifactsFor(terminalId: string): Artifact[] | undefined {
  return artifactStore.get(terminalId);
}

/** Test-only: simulate a main-process `ARTIFACT_DETECTED` IPC landing in
 *  the renderer's `onDetected` handler, through the same registry gate the
 *  production handler uses against packets for torn-down terminals. */
export function __test_simulateArtifactDetected(
  terminalId: string,
  artifacts: Artifact[]
): boolean {
  return appendArtifacts(terminalId, artifacts);
}

/** Test-only: subscribe a listener to the artifact store. Returns unsubscribe. */
export function __test_subscribeArtifactStore(
  listener: (terminalId: string, artifacts: Artifact[]) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type SaveArtifactOutcome =
  | { status: "saved"; filePath: string }
  | { status: "cancelled" }
  | { status: "failed"; error: string };

interface BulkProgress {
  action: "copy" | "save" | "apply";
  current: number;
  total: number;
}

interface BulkResult {
  succeeded: number;
  failed: number;
  failures: Array<{ artifact: Artifact; error: string }>;
  modifiedFiles?: string[];
}

function sortArtifacts(artifacts: Artifact[], mode: "filename" | "extraction"): Artifact[] {
  if (mode === "extraction") {
    return [...artifacts].sort((a, b) => {
      if (a.extractedAt !== b.extractedAt) {
        return a.extractedAt - b.extractedAt;
      }
      return a.id.localeCompare(b.id);
    });
  }
  return [...artifacts].sort((a, b) => {
    const aName = a.filename || a.id;
    const bName = b.filename || b.id;
    const nameCmp = aName.localeCompare(bName);
    if (nameCmp !== 0) return nameCmp;
    return a.id.localeCompare(b.id);
  });
}

/** The order a bulk apply runs in — the order the agent wrote the patches. */
export function orderPatchesForApply(patches: Artifact[]): Artifact[] {
  return sortArtifacts(patches, "extraction");
}

/**
 * Whether a terminal has artifacts, for a pane that loads the artifact overlay
 * only once one arrives. It owns detection exactly as `useArtifacts` does, so a
 * terminal with no overlay yet still collects its first batch.
 */
export function useHasArtifacts(terminalId: string): boolean {
  useEffect(() => {
    if (!isElectronAvailable()) return;
    return acquireDetection();
  }, []);

  const subscribe = useCallback(
    (onChange: () => void) => {
      const listener = (tid: string) => {
        if (tid === terminalId) onChange();
      };
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    [terminalId]
  );

  return useSyncExternalStore(subscribe, () => (artifactStore.get(terminalId)?.length ?? 0) > 0);
}

export function useArtifacts(terminalId: string, worktreeId?: string, cwd?: string) {
  const [artifacts, setArtifacts] = useState<Artifact[]>(() => artifactStore.get(terminalId) || []);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);

  useEffect(() => {
    if (!isElectronAvailable()) return;
    return acquireDetection();
  }, []);

  useEffect(() => {
    const listener = (tid: string, arts: Artifact[]) => {
      if (tid === terminalId) {
        setArtifacts(arts);
      }
    };

    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }, [terminalId]);
  const copyToClipboard = useCallback(
    async (artifact: Artifact) => {
      if (typeof navigator === "undefined" || !navigator.clipboard) {
        logErrorWithContext(new Error("Clipboard API not available"), {
          operation: "copy_to_clipboard",
          component: "useArtifacts",
          errorType: "validation",
          details: { artifactId: artifact.id, terminalId },
        });
        return false;
      }

      try {
        setActionInProgress(artifact.id);
        await navigator.clipboard.writeText(artifact.content);
        return true;
      } catch (error) {
        logErrorWithContext(error, {
          operation: "copy_to_clipboard",
          component: "useArtifacts",
          details: { artifactId: artifact.id, artifactType: artifact.type, terminalId },
        });
        return false;
      } finally {
        setActionInProgress(null);
      }
    },
    [terminalId]
  );

  const saveToFile = useCallback(
    async (artifact: Artifact): Promise<SaveArtifactOutcome> => {
      if (!isElectronAvailable()) {
        return { status: "failed", error: "Saving needs the desktop app" };
      }

      try {
        setActionInProgress(artifact.id);

        let suggestedFilename = artifact.filename;
        if (!suggestedFilename) {
          const ext = artifact.language ? `.${artifact.language}` : ".txt";
          suggestedFilename = `artifact-${Date.now()}${ext}`;
        }

        const actionResult = await actionService.dispatch<SaveArtifactResult | null>(
          "artifact.saveToFile",
          { content: artifact.content, suggestedFilename, cwd },
          { source: "user" }
        );
        if (!actionResult.ok) {
          throw new Error(actionResult.error.message);
        }
        const result = actionResult.result;

        // The save dialog resolves null when the user backs out of it.
        return result ? { status: "saved", filePath: result.filePath } : { status: "cancelled" };
      } catch (error) {
        logErrorWithContext(error, {
          operation: "save_artifact_to_file",
          component: "useArtifacts",
          details: {
            artifactId: artifact.id,
            filename: artifact.filename,
            cwd,
            terminalId,
            worktreeId,
          },
        });
        return { status: "failed", error: formatErrorMessage(error, "Failed to save artifact") };
      } finally {
        setActionInProgress(null);
      }
    },
    [cwd, terminalId, worktreeId]
  );

  const applyPatch = useCallback(
    async (
      artifact: Artifact
    ): Promise<{ success: true; modifiedFiles: string[] } | { success: false; error: string }> => {
      if (!isElectronAvailable() || artifact.type !== "patch") {
        logErrorWithContext(new Error("Invalid artifact type or Electron not available"), {
          operation: "apply_patch",
          component: "useArtifacts",
          errorType: "validation",
          details: { artifactId: artifact.id, artifactType: artifact.type, terminalId, worktreeId },
        });
        return { success: false, error: "Invalid artifact type or Electron not available" };
      }

      if (!worktreeId || !cwd) {
        logErrorWithContext(new Error("No worktree context available"), {
          operation: "apply_patch",
          component: "useArtifacts",
          errorType: "validation",
          details: { artifactId: artifact.id, terminalId, worktreeId, cwd },
        });
        return { success: false, error: "No worktree context available" };
      }

      try {
        setActionInProgress(artifact.id);

        const actionResult = await actionService.dispatch<ApplyPatchResult>(
          "artifact.applyPatch",
          { patchContent: artifact.content, cwd },
          { source: "user" }
        );
        if (!actionResult.ok) {
          throw new Error(actionResult.error.message);
        }
        return { success: true, modifiedFiles: actionResult.result.modifiedFiles };
      } catch (error) {
        logErrorWithContext(error, {
          operation: "apply_patch",
          component: "useArtifacts",
          details: { artifactId: artifact.id, worktreeId, cwd, terminalId },
        });
        return {
          success: false,
          error: formatErrorMessage(error, "Failed to apply patch"),
        };
      } finally {
        setActionInProgress(null);
      }
    },
    [worktreeId, cwd, terminalId]
  );

  const clearArtifacts = useCallback(() => {
    // User-initiated "Clear all" on a live terminal, which keeps detecting new
    // artifacts afterwards.
    artifactStore.delete(terminalId);
    notifyListeners(terminalId, []);
    setArtifacts([]);
  }, [terminalId]);

  const canApplyPatch = useCallback(
    (artifact: Artifact) => {
      return artifact.type === "patch" && !!worktreeId && !!cwd;
    },
    [worktreeId, cwd]
  );

  const copyAll = useCallback(
    async (includeAllTypes: boolean = false): Promise<BulkResult> => {
      const targetArtifacts = includeAllTypes
        ? artifacts
        : artifacts.filter((a) => a.type === "code");

      if (targetArtifacts.length === 0) {
        return { succeeded: 0, failed: 0, failures: [] };
      }

      if (typeof navigator === "undefined" || !navigator.clipboard) {
        return {
          succeeded: 0,
          failed: targetArtifacts.length,
          failures: targetArtifacts.map((artifact) => ({
            artifact,
            error: "Clipboard API not available",
          })),
        };
      }

      const sorted = sortArtifacts(targetArtifacts, "filename");

      const sections = sorted.map((artifact) => {
        const header = artifact.filename || artifact.language || artifact.type;
        const separator = "=".repeat(60);
        return `${separator}\n${header}\n${separator}\n${artifact.content}`;
      });

      const combined = sections.join("\n\n");

      try {
        setBulkProgress({ action: "copy", current: sorted.length, total: sorted.length });
        await navigator.clipboard.writeText(combined);
        return { succeeded: sorted.length, failed: 0, failures: [] };
      } catch (error) {
        return {
          succeeded: 0,
          failed: sorted.length,
          failures: [{ artifact: sorted[0]!, error: String(error) }],
        };
      } finally {
        setBulkProgress(null);
      }
    },
    [artifacts]
  );

  const saveAll = useCallback(async (): Promise<BulkResult> => {
    if (!isElectronAvailable() || artifacts.length === 0) {
      return { succeeded: 0, failed: 0, failures: [] };
    }

    const sorted = sortArtifacts(artifacts, "filename");
    const result: BulkResult = { succeeded: 0, failed: 0, failures: [] };

    try {
      for (let i = 0; i < sorted.length; i++) {
        const artifact = sorted[i]!;
        setBulkProgress({ action: "save", current: i + 1, total: sorted.length });

        try {
          let suggestedFilename = artifact.filename;
          if (!suggestedFilename) {
            const ext = artifact.language ? `.${artifact.language}` : ".txt";
            suggestedFilename = `artifact-${Date.now()}-${i}${ext}`;
          }

          const actionResult = await actionService.dispatch<SaveArtifactResult | null>(
            "artifact.saveToFile",
            { content: artifact.content, suggestedFilename, cwd },
            { source: "user" }
          );
          if (!actionResult.ok) {
            throw new Error(actionResult.error.message);
          }
          const saveResult = actionResult.result;

          if (saveResult?.filePath) {
            result.succeeded++;
          } else if (saveResult === null) {
            // Treat null as user cancellation - skip remaining saves
            logDebug("[useArtifacts] Save cancelled by user, stopping bulk save");
            break;
          } else {
            result.failed++;
            result.failures.push({ artifact, error: "Save operation returned false" });
          }
        } catch (error) {
          logErrorWithContext(error, {
            operation: "bulk_save_artifact",
            component: "useArtifacts",
            details: { artifactId: artifact.id, filename: artifact.filename, cwd, terminalId },
          });
          result.failed++;
          result.failures.push({
            artifact,
            error: formatErrorMessage(error, "Failed to save artifact"),
          });
        }
      }
    } finally {
      setBulkProgress(null);
    }

    return result;
  }, [artifacts, cwd, terminalId]);

  // `patchesToApply` lets the caller pass the exact snapshot its confirm dialog
  // previewed, so patches detected while the dialog was open are not applied
  // unseen. It is applied in the order given: that order is the one previewed.
  const applyAllPatches = useCallback(
    async (patchesToApply?: Artifact[]): Promise<BulkResult> => {
      if (!isElectronAvailable() || !worktreeId || !cwd) {
        return {
          succeeded: 0,
          failed: 0,
          failures: [],
        };
      }

      const patches = (patchesToApply ?? artifacts).filter((a) => a.type === "patch");
      if (patches.length === 0) {
        return { succeeded: 0, failed: 0, failures: [] };
      }

      const sorted = patchesToApply ? patches : orderPatchesForApply(patches);
      const result: BulkResult = { succeeded: 0, failed: 0, failures: [], modifiedFiles: [] };
      const modifiedFilesSet = new Set<string>();

      try {
        for (let i = 0; i < sorted.length; i++) {
          const artifact = sorted[i]!;
          setBulkProgress({ action: "apply", current: i + 1, total: sorted.length });

          try {
            const actionResult = await actionService.dispatch<ApplyPatchResult>(
              "artifact.applyPatch",
              { patchContent: artifact.content, cwd },
              { source: "user" }
            );
            if (!actionResult.ok) {
              throw new Error(actionResult.error.message);
            }
            const applyResult = actionResult.result;

            result.succeeded++;
            applyResult.modifiedFiles.forEach((f) => modifiedFilesSet.add(f));
          } catch (error) {
            logErrorWithContext(error, {
              operation: "bulk_apply_patch",
              component: "useArtifacts",
              details: { artifactId: artifact.id, worktreeId, cwd, terminalId },
            });
            result.failed++;
            result.failures.push({
              artifact,
              error: formatErrorMessage(error, "Failed to apply patch"),
            });
          }
        }
      } finally {
        setBulkProgress(null);
      }

      result.modifiedFiles = Array.from(modifiedFilesSet);
      return result;
    },
    [artifacts, worktreeId, cwd, terminalId]
  );

  return {
    artifacts,
    actionInProgress,
    bulkProgress,
    hasArtifacts: artifacts.length > 0,
    copyToClipboard,
    saveToFile,
    applyPatch,
    clearArtifacts,
    canApplyPatch,
    copyAll,
    saveAll,
    applyAllPatches,
  };
}
