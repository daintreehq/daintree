import type {
  CopyTreeOptions,
  CopyTreeResult,
  CopyTreeProgress,
  CopyTreeRunSource,
  CopyTreeTestConfigOptions,
  CopyTreeTestConfigResult,
  FileTreeNode,
} from "@shared/types";

/**
 * `source` names the surface that asked for the run so the project's copy-tree
 * history can record it (#11732). It is optional on purpose — it has no effect
 * on the generated bundle, and a caller that omits it is recorded as `unknown`
 * rather than mislabelled.
 */
export const copyTreeClient = {
  generate: (
    worktreeId: string,
    options?: CopyTreeOptions,
    includeContent?: boolean,
    source?: CopyTreeRunSource
  ): Promise<CopyTreeResult> => {
    return window.electron.copyTree.generate(worktreeId, options, includeContent, source);
  },

  generateAndCopyFile: (
    worktreeId: string,
    options?: CopyTreeOptions,
    source?: CopyTreeRunSource
  ): Promise<CopyTreeResult> => {
    return window.electron.copyTree.generateAndCopyFile(worktreeId, options, source);
  },

  injectToTerminal: (
    terminalId: string,
    worktreeId: string,
    options?: CopyTreeOptions,
    injectionId?: string,
    source?: CopyTreeRunSource
  ): Promise<CopyTreeResult> => {
    return window.electron.copyTree.injectToTerminal(
      terminalId,
      worktreeId,
      options,
      injectionId,
      source
    );
  },

  isAvailable: (): Promise<boolean> => {
    return window.electron.copyTree.isAvailable();
  },

  cancel: (injectionId?: string): Promise<void> => {
    return window.electron.copyTree.cancel(injectionId);
  },

  getFileTree: (
    worktreeId: string,
    dirPath?: string,
    includeExcluded?: boolean
  ): Promise<FileTreeNode[]> => {
    return window.electron.copyTree.getFileTree(worktreeId, dirPath, includeExcluded);
  },

  testConfig: (
    worktreeId: string,
    options?: CopyTreeTestConfigOptions
  ): Promise<CopyTreeTestConfigResult> => {
    return window.electron.copyTree.testConfig(worktreeId, options);
  },

  onProgress: (callback: (progress: CopyTreeProgress) => void): (() => void) => {
    return window.electron.copyTree.onProgress(callback);
  },
} as const;
