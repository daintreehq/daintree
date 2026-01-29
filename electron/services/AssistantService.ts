import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type ModelMessage } from "ai";
import { store } from "../store.js";
import type { StreamChunk, AssistantMessage } from "../../shared/types/assistant.js";

const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

const SYSTEM_PROMPT = `You are Canopy's AI assistant. You help users with software development tasks, answer questions about code, and provide guidance on using the Canopy IDE.

Guidelines:
- Be concise and helpful
- When discussing code, use markdown code blocks with appropriate language tags
- If you need more context, ask clarifying questions
- Provide actionable suggestions when possible`;

export class AssistantService {
  private fireworks: ReturnType<typeof createOpenAI> | null = null;
  private activeStreams = new Map<string, AbortController>();

  constructor() {
    this.initializeProvider();
  }

  private initializeProvider(): void {
    const config = store.get("appAgentConfig");
    if (config.apiKey) {
      const baseUrl = config.baseUrl || FIREWORKS_BASE_URL;
      this.fireworks = createOpenAI({
        apiKey: config.apiKey,
        baseURL: baseUrl,
      });
    } else {
      this.fireworks = null;
    }
  }

  hasApiKey(): boolean {
    const config = store.get("appAgentConfig");
    return !!config.apiKey;
  }

  updateApiKey(): void {
    this.initializeProvider();
  }

  async streamMessage(
    sessionId: string,
    messages: AssistantMessage[],
    onChunk: (chunk: StreamChunk) => void
  ): Promise<void> {
    const config = store.get("appAgentConfig");

    if (!config.apiKey) {
      onChunk({
        type: "error",
        error: "API key not configured. Please add your Fireworks API key in Settings.",
      });
      onChunk({ type: "done" });
      return;
    }

    if (!this.fireworks) {
      this.initializeProvider();
    }

    if (!this.fireworks) {
      onChunk({
        type: "error",
        error: "Failed to initialize AI provider.",
      });
      onChunk({ type: "done" });
      return;
    }

    // Cancel any existing stream for this session to prevent leaks
    const existingController = this.activeStreams.get(sessionId);
    if (existingController) {
      existingController.abort();
      this.activeStreams.delete(sessionId);
    }

    const controller = new AbortController();
    this.activeStreams.set(sessionId, controller);

    try {
      const modelMessages: ModelMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages.map(
          (msg): ModelMessage => ({
            role: msg.role === "user" ? "user" : "assistant",
            content: msg.content,
          })
        ),
      ];

      const result = streamText({
        model: this.fireworks(config.model),
        messages: modelMessages,
        abortSignal: controller.signal,
      });

      for await (const textPart of result.textStream) {
        if (controller.signal.aborted) {
          onChunk({ type: "done", finishReason: "cancelled" });
          return;
        }
        onChunk({ type: "text", content: textPart });
      }

      // Only get finish reason if not aborted
      if (!controller.signal.aborted) {
        const finalResult = await result;
        const finishReason = await finalResult.finishReason;
        onChunk({
          type: "done",
          finishReason: finishReason ?? undefined,
        });
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        onChunk({ type: "done", finishReason: "cancelled" });
        return;
      }

      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      console.error("[AssistantService] Stream error:", errorMessage);
      onChunk({
        type: "error",
        error: errorMessage,
      });
      onChunk({ type: "done" });
    } finally {
      // Only delete if this controller is still the active one
      if (this.activeStreams.get(sessionId) === controller) {
        this.activeStreams.delete(sessionId);
      }
    }
  }

  cancel(sessionId: string): void {
    const controller = this.activeStreams.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(sessionId);
    }
  }

  cancelAll(): void {
    for (const [sessionId, controller] of this.activeStreams) {
      controller.abort();
      this.activeStreams.delete(sessionId);
    }
  }
}

export const assistantService = new AssistantService();
