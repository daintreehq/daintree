export interface CloneRepoOptions {
  url: string;
  parentPath: string;
  folderName: string;
  shallowClone?: boolean;
}

export interface CloneRepoProgressEvent {
  stage: string;
  progress: number;
  message: string;
  timestamp: number;
}

export interface CloneRepoResult {
  success: boolean;
  clonedPath?: string;
  error?: string;
  cancelled?: boolean;
}
