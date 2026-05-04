import crypto from "crypto";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { type ProcessEntry, type CopyTreeProgressCallback } from "./types.js";
import type { WorkspaceHostProcess } from "../WorkspaceHostProcess.js";
import type { CopyTreeOptions, CopyTreeResult } from "../../../shared/types/ipc.js";

export interface WorkspaceCopyTreeClientDeps {
  resolveHostForPath: (targetPath: string) => WorkspaceHostProcess | undefined;
  iterateEntries: () => IterableIterator<ProcessEntry>;
}

export class WorkspaceCopyTreeClient {
  private resolveHostForPath: (targetPath: string) => WorkspaceHostProcess | undefined;
  private iterateEntries: () => IterableIterator<ProcessEntry>;

  readonly copyTreeProgressCallbacks = new Map<string, CopyTreeProgressCallback>();
  readonly activeCopyTreeOperations = new Map<string, string>();

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
    this.activeCopyTreeOperations.set(operationId, requestId);

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
    for (const entry of this.iterateEntries()) {
      entry.host.send({ type: "copytree:cancel", operationId });
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
        excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
        error: "No workspace host for path",
      };
    }

    const requestId = host.generateRequestId();
    try {
      const result = await host.sendWithResponse<{
        result: import("../../../shared/types/index.js").CopyTreeTestConfigResult;
      }>(
        {
          type: "copytree:test-config",
          requestId,
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
        excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
        error: formatErrorMessage(error, "Failed to generate context"),
      };
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
