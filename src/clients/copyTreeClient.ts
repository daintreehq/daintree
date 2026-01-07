import type {
  CopyTreeOptions,
  CopyTreeResult,
  CopyTreeProgress,
  FileTreeNode,
} from "@shared/types";

export const copyTreeClient = {
  generate: (worktreeId: string, options?: CopyTreeOptions): Promise<CopyTreeResult> => {
    return window.electron.copyTree.generate(worktreeId, options);
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

  getFileTree: (worktreeId: string, dirPath?: string): Promise<FileTreeNode[]> => {
    return window.electron.copyTree.getFileTree(worktreeId, dirPath);
  },

  onProgress: (callback: (progress: CopyTreeProgress) => void): (() => void) => {
    return window.electron.copyTree.onProgress(callback);
  },
} as const;
