export type MessageRole = "user" | "assistant" | "event";

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
