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
 *
 * `name` is the run's display label (#11734) and is history metadata for the
 * same reason: it names the run for a human without changing what gets built,
 * which is why it sits here rather than in `CopyTreeOptions`. Both trail every
 * generation argument, so existing callers keep their current arity.
 */
export const copyTreeClient = {
  generate: (
    worktreeId: string,
    options?: CopyTreeOptions,
    includeContent?: boolean,
    source?: CopyTreeRunSource,
    name?: string
  ): Promise<CopyTreeResult> => {
    return window.electron.copyTree.generate(worktreeId, options, includeContent, source, name);
  },

  generateAndCopyFile: (
    worktreeId: string,
    options?: CopyTreeOptions,
    source?: CopyTreeRunSource,
    name?: string
  ): Promise<CopyTreeResult> => {
    return window.electron.copyTree.generateAndCopyFile(worktreeId, options, source, name);
  },

  injectToTerminal: (
    terminalId: string,
    worktreeId: string,
    options?: CopyTreeOptions,
    injectionId?: string,
    source?: CopyTreeRunSource,
    name?: string
  ): Promise<CopyTreeResult> => {
    return window.electron.copyTree.injectToTerminal(
      terminalId,
      worktreeId,
      options,
      injectionId,
      source,
      name
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
