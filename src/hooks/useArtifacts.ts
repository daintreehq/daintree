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

const artifactStore = new Map<string, Artifact[]>();
const listeners = new Set<(terminalId: string, artifacts: Artifact[]) => void>();
let listenerRefCount = 0;
let ipcUnsubscribe: (() => void) | null = null;

function notifyListeners(terminalId: string, artifacts: Artifact[]) {
  listeners.forEach((listener) => listener(terminalId, artifacts));
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

    listenerRefCount++;

    if (listenerRefCount === 1 && !ipcUnsubscribe) {
      ipcUnsubscribe = artifactClient.onDetected((payload: ArtifactDetectedPayload) => {
        const currentArtifacts = artifactStore.get(payload.terminalId) || [];
        const newArtifacts = [...currentArtifacts, ...payload.artifacts];
        artifactStore.set(payload.terminalId, newArtifacts);

        notifyListeners(payload.terminalId, newArtifacts);
      });
    }

    return () => {
      listenerRefCount--;

      if (listenerRefCount === 0 && ipcUnsubscribe) {
        ipcUnsubscribe();
        ipcUnsubscribe = null;
      }
    };
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
  const copyToClipboard = useCallback(async (artifact: Artifact) => {
    if (!navigator.clipboard) {
      console.error("Clipboard API not available");
      return false;
    }

    try {
      setActionInProgress(artifact.id);
      await navigator.clipboard.writeText(artifact.content);
      return true;
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
      return false;
    } finally {
      setActionInProgress(null);
    }
  }, []);

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
        console.error("Failed to save artifact:", error);
        return null;
      } finally {
        setActionInProgress(null);
      }
    },
    [cwd]
  );

  const applyPatch = useCallback(
    async (artifact: Artifact) => {
      if (!isElectronAvailable() || artifact.type !== "patch") {
        return { success: false, error: "Invalid artifact type or Electron not available" };
      }

      if (!worktreeId || !cwd) {
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
        const result = actionResult.result;

        return result;
      } catch (error) {
        console.error("Failed to apply patch:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        setActionInProgress(null);
      }
    },
    [worktreeId, cwd]
  );

  const clearArtifacts = useCallback(() => {
    artifactStore.delete(terminalId);
    setArtifacts([]);
    notifyListeners(terminalId, []);
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
          failures: [{ artifact: sorted[0], error: String(error) }],
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
        const artifact = sorted[i];
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

          if (saveResult?.success) {
            result.succeeded++;
          } else {
            result.failed++;
            result.failures.push({ artifact, error: "Save operation returned false" });
          }
        } catch (error) {
          result.failed++;
          result.failures.push({
            artifact,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      setBulkProgress(null);
    }

    return result;
  }, [artifacts, cwd]);

  const applyAllPatches = useCallback(async (): Promise<BulkResult> => {
    if (!isElectronAvailable() || !worktreeId || !cwd) {
      return {
        succeeded: 0,
        failed: 0,
        failures: [],
      };
    }

    const patches = artifacts.filter((a) => a.type === "patch");
    if (patches.length === 0) {
      return { succeeded: 0, failed: 0, failures: [] };
    }

    const sorted = sortArtifacts(patches, "extraction");
    const result: BulkResult = { succeeded: 0, failed: 0, failures: [], modifiedFiles: [] };
    const modifiedFilesSet = new Set<string>();

    try {
      for (let i = 0; i < sorted.length; i++) {
        const artifact = sorted[i];
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

          if (applyResult.success) {
            result.succeeded++;
            if (applyResult.modifiedFiles) {
              applyResult.modifiedFiles.forEach((f) => modifiedFilesSet.add(f));
            }
          } else {
            result.failed++;
            result.failures.push({
              artifact,
              error: applyResult.error || "Patch application failed",
            });
          }
        } catch (error) {
          result.failed++;
          result.failures.push({
            artifact,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      setBulkProgress(null);
    }

    result.modifiedFiles = Array.from(modifiedFilesSet);
    return result;
  }, [artifacts, worktreeId, cwd]);

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

export default useArtifacts;
