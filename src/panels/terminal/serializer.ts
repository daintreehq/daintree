import type { TerminalInstance } from "@shared/types/panel";
import type { TerminalSnapshot } from "@shared/types/project";

export function serializePtyPanel(t: TerminalInstance): Partial<TerminalSnapshot> {
  return {
    type: t.type,
    agentId: t.agentId,
    cwd: t.cwd,
    command: t.command?.trim() || undefined,
    ...(t.createdAt !== undefined && { createdAt: t.createdAt }),
    ...(t.exitBehavior !== undefined && { exitBehavior: t.exitBehavior }),
    ...(t.agentSessionId && { agentSessionId: t.agentSessionId }),
    ...(t.agentLaunchFlags?.length && { agentLaunchFlags: t.agentLaunchFlags }),
    ...(t.agentModelId && { agentModelId: t.agentModelId }),
    ...(t.agentState && { agentState: t.agentState }),
    ...(t.lastStateChange !== undefined && { lastStateChange: t.lastStateChange }),
  };
}
