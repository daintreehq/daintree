import { z } from "zod";

export const AssistantMessageRoleSchema = z.enum(["user", "assistant"]);
export type AssistantMessageRole = z.infer<typeof AssistantMessageRoleSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultSchema = z.object({
  toolCallId: z.string(),
  result: z.unknown(),
  error: z.string().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const AssistantMessageSchema = z.object({
  id: z.string(),
  role: AssistantMessageRoleSchema,
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  toolResults: z.array(ToolResultSchema).optional(),
  createdAt: z.string(),
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

export const StreamChunkTypeSchema = z.enum(["text", "tool_call", "tool_result", "error", "done"]);
export type StreamChunkType = z.infer<typeof StreamChunkTypeSchema>;

export const StreamChunkSchema = z.object({
  type: StreamChunkTypeSchema,
  content: z.string().optional(),
  toolCall: ToolCallSchema.optional(),
  toolResult: ToolResultSchema.optional(),
  error: z.string().optional(),
  finishReason: z.string().optional(),
});
export type StreamChunk = z.infer<typeof StreamChunkSchema>;

export const SendMessageRequestSchema = z.object({
  sessionId: z.string(),
  messages: z.array(AssistantMessageSchema),
  context: z
    .object({
      projectId: z.string().optional(),
      activeWorktreeId: z.string().optional(),
      focusedTerminalId: z.string().optional(),
    })
    .optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export interface AssistantChunkPayload {
  sessionId: string;
  chunk: StreamChunk;
}

export const ASSISTANT_MODELS = [
  { id: "accounts/fireworks/models/llama-v3p1-70b-instruct", name: "Llama 3.1 70B (Balanced)" },
  {
    id: "accounts/fireworks/models/llama-v3p1-405b-instruct",
    name: "Llama 3.1 405B (Highest Quality)",
  },
  { id: "accounts/fireworks/models/kimi-k2p5", name: "Kimi K2.5 (Default)" },
] as const;
