import type {
  CopyTreeOptions,
  CopyTreeResult,
  CopyTreeProgress,
  CopyTreeTestConfigOptions,
  CopyTreeTestConfigResult,
  FileTreeNode,
} from "@shared/types";

export const copyTreeClient = {
  generate: (
    worktreeId: string,
    options?: CopyTreeOptions,
    includeContent?: boolean
  ): Promise<CopyTreeResult> => {
    return window.electron.copyTree.generate(worktreeId, options, includeContent);
  },

  generateAndCopyFile: (worktreeId: string, options?: CopyTreeOptions): Promise<CopyTreeResult> => {
    return window.electron.copyTree.generateAndCopyFile(worktreeId, options);
  },

  injectToTerminal: (
    terminalId: string,
    worktreeId: string,
    options?: CopyTreeOptions,
    injectionId?: string
  ): Promise<CopyTreeResult> => {
    return window.electron.copyTree.injectToTerminal(terminalId, worktreeId, options, injectionId);
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
