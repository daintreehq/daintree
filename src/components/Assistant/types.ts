export type MessageRole = "user" | "assistant" | "event";

export type AgentStateChangeTrigger =
  | "input"
  | "output"
  | "heuristic"
  | "ai-classification"
  | "timeout"
  | "exit"
  | "activity";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "pending" | "success" | "error";
  result?: unknown;
  error?: string;
}

export interface EventMetadata {
  eventType: string;
  listenerId?: string;
  terminalId?: string;
  worktreeId?: string;
  oldState?: string;
  newState?: string;
  trigger?: AgentStateChangeTrigger;
  confidence?: number;
}

export interface AssistantMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  eventMetadata?: EventMetadata;
}

export interface StreamingState {
  content: string;
  toolCalls: ToolCall[];
}
