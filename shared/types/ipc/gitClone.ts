export interface CloneRepoOptions {
  url: string;
  parentPath: string;
  folderName: string;
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
}
