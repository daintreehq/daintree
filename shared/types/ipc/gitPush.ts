export interface PushProgressEvent {
  cwd: string;
  stage: string;
  progress: number | null;
  processed: number | null;
  total: number | null;
  targetBranch?: string;
}

export interface GitPushPayload {
  cwd: string;
  setUpstream?: boolean;
  /** Client-minted operation id; absent means the Host mints its own. */
  opId?: string;
}
