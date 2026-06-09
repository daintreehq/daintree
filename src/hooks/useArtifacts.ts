import { useState, useEffect, useCallback } from "react";
import { isElectronAvailable } from "./useElectron";
import type {
  Artifact,
  ArtifactDetectedPayload,
  ApplyPatchResult,
  SaveArtifactResult,
} from "@shared/types";
import { artifactClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { logErrorWithContext } from "@/utils/errorContext";
import { logDebug } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";

// Cap the per-terminal artifact store so a long-lived terminal can't grow it
// without bound (each artifact carries 1–10KB of content). The dock paginates
// and sorts by recency, so dropping the oldest beyond the cap is invisible.
const MAX_ARTIFACTS_PER_TERMINAL = 150;

const artifactStore = new Map<string, Artifact[]>();
const listeners = new Set<(terminalId: string, artifacts: Artifact[]) => void>();
const refState = { count: 0, unsubscribe: null as (() => void) | null };

// Tombstone for terminal ids that have been torn down. While an id is
// tombstoned, the `onDetected` IPC handler refuses to re-insert into the
// store — this closes the millisecond-scale race where a packet already
// queued by the main process lands on a now-removed terminal. The tombstone
// is cleared by the per-terminal mount effect so a re-spawn that happens to
// reuse the same id (e.g. fast re-spawn in the same worktree) isn't
// permanently blackholed.
const removedTerminals = new Set<string>();

function notifyListeners(terminalId: string, artifacts: Artifact[]) {
  listeners.forEach((listener) => listener(terminalId, artifacts));
}

/**
 * Drop the per-terminal entry from the module-level artifact store, add the
 * id to the removed-ids tombstone, and notify any still-mounted listeners
 * with an empty array. Called from the `panelIds` and `trashedTerminals`
 * subscribers in `rendererStoreOrchestrator.ts` so force-removed panels
 * (browser/dev-preview, worktree teardown shrinking `panelIds` without a
 * PTY exit, and the user-close trash path that doesn't shrink `panelIds`)
 * do not leak their content strings for the lifetime of the renderer.
 * Safe to call for unknown ids (`Map.delete` is a no-op) and safe to call
 * twice. Mirrors the shape of `unregisterInputController` and
 * `useResourceMonitoringStore.removePanel` so the orchestrator's teardown
 * loop remains the single convergence point.
 */
export function removeArtifactsForTerminal(terminalId: string): void {
  artifactStore.delete(terminalId);
  removedTerminals.add(terminalId);
  notifyListeners(terminalId, []);
}

/** Reset all module-level state. Only for test isolation. */
export function __test_resetArtifactStore(): void {
  artifactStore.clear();
  listeners.clear();
  removedTerminals.clear();
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

/** Test-only: peek the removed-ids tombstone. */
export function __test_isTombstoned(terminalId: string): boolean {
  return removedTerminals.has(terminalId);
}

/** Test-only: simulate a main-process `ARTIFACT_DETECTED` IPC landing in
 *  the renderer's `onDetected` handler. Honors the tombstone — the same
 *  contract the production handler uses to guard against in-flight packets
 *  on torn-down terminals (#10023). */
export function __test_simulateArtifactDetected(
  terminalId: string,
  artifacts: Artifact[]
): boolean {
  if (removedTerminals.has(terminalId)) {
    return false;
  }
  const currentArtifacts = artifactStore.get(terminalId) || [];
  const newArtifacts = [...currentArtifacts, ...artifacts].slice(-MAX_ARTIFACTS_PER_TERMINAL);
  artifactStore.set(terminalId, newArtifacts);
  notifyListeners(terminalId, newArtifacts);
  return true;
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

export function useArtifacts(terminalId: string, worktreeId?: string, cwd?: string) {
  const [artifacts, setArtifacts] = useState<Artifact[]>(() => artifactStore.get(terminalId) || []);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);

  useEffect(() => {
    if (!isElectronAvailable()) return;

    refState.count++;

    if (refState.count === 1 && !refState.unsubscribe) {
      refState.unsubscribe = artifactClient.onDetected((payload: ArtifactDetectedPayload) => {
        // Drop packets for terminal ids that have been torn down — closes the
        // millisecond-scale race where a packet already queued by the main
        // process lands on a now-removed terminal (#10023).
        if (removedTerminals.has(payload.terminalId)) return;
        const currentArtifacts = artifactStore.get(payload.terminalId) || [];
        const newArtifacts = [...currentArtifacts, ...payload.artifacts].slice(
          -MAX_ARTIFACTS_PER_TERMINAL
        );
        artifactStore.set(payload.terminalId, newArtifacts);

        notifyListeners(payload.terminalId, newArtifacts);
      });
    }

    return () => {
      refState.count--;

      if (refState.count === 0 && refState.unsubscribe) {
        refState.unsubscribe();
        refState.unsubscribe = null;
      }
    };
  }, []);

  useEffect(() => {
    // A re-spawn that reuses this `terminalId` must not be permanently
    // blackholed by the tombstone left behind by the previous teardown
    // (#10023). Clear it on every per-terminal mount; the tombstone is
    // bounded by the user's working set and re-cleared on each new mount.
    removedTerminals.delete(terminalId);

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
    async (artifact: Artifact) => {
      if (!isElectronAvailable()) return null;

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

        return result;
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
        return null;
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
    // User-initiated "Clear all" on a LIVE mounted terminal. Unlike teardown,
    // this must NOT tombstone the id — the terminal is still running and must
    // keep detecting new artifacts. (The mount effect only clears the
    // tombstone on `[terminalId]` change, which a button click does not
    // trigger, so tombstoning here would blackhole the rest of the session.)
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
  // previewed, so patches detected while the dialog was open are not applied unseen.
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

      const sorted = sortArtifacts(patches, "extraction");
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
