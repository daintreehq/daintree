import crypto from "crypto";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { type ProcessEntry, type CopyTreeProgressCallback } from "./types.js";
import type { WorkspaceHostProcess } from "../WorkspaceHostProcess.js";
import type { CopyTreeOptions, CopyTreeResult, FileTreeNode } from "../../../shared/types/ipc.js";

export interface WorkspaceCopyTreeClientDeps {
  resolveHostForPath: (targetPath: string) => WorkspaceHostProcess | undefined;
  iterateEntries: () => IterableIterator<ProcessEntry>;
}

export class WorkspaceCopyTreeClient {
  private resolveHostForPath: (targetPath: string) => WorkspaceHostProcess | undefined;
  private iterateEntries: () => IterableIterator<ProcessEntry>;

  readonly copyTreeProgressCallbacks = new Map<string, CopyTreeProgressCallback>();
  readonly activeCopyTreeOperations = new Map<string, string>(); // operationId → rootPath

  constructor(deps: WorkspaceCopyTreeClientDeps) {
    this.resolveHostForPath = deps.resolveHostForPath;
    this.iterateEntries = deps.iterateEntries;
  }

  async generateContext(
    rootPath: string,
    options?: CopyTreeOptions,
    onProgress?: CopyTreeProgressCallback
  ): Promise<CopyTreeResult> {
    const host = this.resolveHostForPath(rootPath);
    if (!host) throw new Error("No workspace host for path");

    const requestId = host.generateRequestId();
    const operationId = crypto.randomUUID();

    if (onProgress) {
      this.copyTreeProgressCallbacks.set(operationId, onProgress);
    }
    this.activeCopyTreeOperations.set(operationId, rootPath);

    try {
      const result = await host.sendWithResponse<{ result: CopyTreeResult }>(
        {
          type: "copytree:generate",
          requestId,
          operationId,
          rootPath,
          options,
        },
        120000
      );
      return result.result;
    } finally {
      this.copyTreeProgressCallbacks.delete(operationId);
      this.activeCopyTreeOperations.delete(operationId);
    }
  }

  cancelContext(operationId: string): void {
    const rootPath = this.activeCopyTreeOperations.get(operationId);
    if (rootPath) {
      const host = this.resolveHostForPath(rootPath);
      host?.send({ type: "copytree:cancel", operationId });
    }

    this.copyTreeProgressCallbacks.delete(operationId);
    this.activeCopyTreeOperations.delete(operationId);
  }

  async testConfig(
    rootPath: string,
    options?: CopyTreeOptions
  ): Promise<import("../../../shared/types/index.js").CopyTreeTestConfigResult> {
    const host = this.resolveHostForPath(rootPath);
    if (!host) {
      return {
        includedFiles: 0,
        includedSize: 0,
        error: "No workspace host for path",
      };
    }

    const requestId = host.generateRequestId();
    const operationId = crypto.randomUUID();

    this.activeCopyTreeOperations.set(operationId, rootPath);

    try {
      const result = await host.sendWithResponse<{
        result: import("../../../shared/types/index.js").CopyTreeTestConfigResult;
      }>(
        {
          type: "copytree:test-config",
          requestId,
          operationId,
          rootPath,
          options,
        },
        120000
      );
      return result.result;
    } catch (error) {
      return {
        includedFiles: 0,
        includedSize: 0,
        error: formatErrorMessage(error, "Failed to generate context"),
      };
    } finally {
      this.activeCopyTreeOperations.delete(operationId);
    }
  }

  /**
   * List a directory as the context sees it — a CopyTree dry run decides what
   * is in, so the listing and the generated bundle can't disagree (#11439).
   *
   * Tracked in `activeCopyTreeOperations` like the other CopyTree work so a
   * cancel-all reclaims a listing still walking the tree.
   */
  async getContextFileTree(
    rootPath: string,
    dirPath?: string,
    options?: CopyTreeOptions,
    includeExcluded?: boolean
  ): Promise<FileTreeNode[]> {
    const host = this.resolveHostForPath(rootPath);
    if (!host) throw new Error("No workspace host for path");

    const requestId = host.generateRequestId();
    const operationId = crypto.randomUUID();

    this.activeCopyTreeOperations.set(operationId, rootPath);

    try {
      const result = await host.sendWithResponse<{
        nodes: FileTreeNode[];
        error?: string;
      }>(
        {
          type: "copytree:get-file-tree",
          requestId,
          operationId,
          worktreePath: rootPath,
          dirPath,
          options,
          includeExcluded,
        },
        120000
      );

      if (result.error) {
        throw new Error(result.error);
      }
      return result.nodes;
    } finally {
      this.activeCopyTreeOperations.delete(operationId);
    }
  }

  cancelAllContext(): void {
    for (const operationId of this.activeCopyTreeOperations.keys()) {
      for (const entry of this.iterateEntries()) {
        entry.host.send({ type: "copytree:cancel", operationId });
      }
    }
    this.copyTreeProgressCallbacks.clear();
    this.activeCopyTreeOperations.clear();
  }

  dispose(): void {
    this.copyTreeProgressCallbacks.clear();
    this.activeCopyTreeOperations.clear();
  }
}
