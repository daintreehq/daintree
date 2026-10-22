export interface HibernationProjectHibernatedPayload {
  projectId: string;
  projectName: string;
  reason: "memory-pressure" | "user-initiated";
  terminalsKilled: number;
  timestamp: number;
}
