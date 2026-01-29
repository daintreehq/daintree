export type MessageRole = "user" | "assistant";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "pending" | "success" | "error";
  result?: unknown;
}

export interface AssistantMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
}

export interface StreamingState {
  content: string;
  toolCalls: ToolCall[];
}
