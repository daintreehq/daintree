import { ipcMain, type BrowserWindow, type WebContents } from "electron";
import { CHANNELS } from "../channels.js";
import { assistantService } from "../../services/AssistantService.js";
import {
  type AssistantChunkPayload,
  SendMessageRequestSchema,
  type StreamChunk,
} from "../../../shared/types/assistant.js";
import type { ActionManifestEntry, ActionContext } from "../../../shared/types/actions.js";
import {
  initTerminalStateListenerBridge,
  destroyTerminalStateListenerBridge,
} from "../../services/assistant/TerminalStateListenerBridge.js";

const MAX_MESSAGES = 100;
const MAX_MESSAGE_LENGTH = 50000;

function sendToWebContents(
  webContents: WebContents,
  channel: string,
  payload: AssistantChunkPayload
): void {
  if (!webContents.isDestroyed()) {
    try {
      webContents.send(channel, payload);
    } catch (error) {
      console.error("[AssistantHandlers] Failed to send chunk:", error);
    }
  }
}

export function registerAssistantHandlers(mainWindow: BrowserWindow): () => void {
  const emitChunkToRenderer = (sessionId: string, chunk: StreamChunk): void => {
    sendToWebContents(mainWindow.webContents, CHANNELS.ASSISTANT_CHUNK, {
      sessionId,
      chunk,
    });
  };

  initTerminalStateListenerBridge(emitChunkToRenderer);

  const destroyedListener = () => {
    assistantService.clearAllSessions();
    destroyTerminalStateListenerBridge();
  };

  const navigationListener = () => {
    assistantService.clearAllSessions();
  };

  ipcMain.handle(CHANNELS.ASSISTANT_SEND_MESSAGE, async (event, payload: unknown) => {
    // Validate payload
    const validation = SendMessageRequestSchema.safeParse(payload);
    if (!validation.success) {
      console.error("[AssistantHandlers] Invalid payload:", validation.error);
      const sessionId =
        typeof payload === "object" && payload !== null && "sessionId" in payload
          ? String((payload as Record<string, unknown>).sessionId)
          : "unknown";
      sendToWebContents(event.sender, CHANNELS.ASSISTANT_CHUNK, {
        sessionId,
        chunk: {
          type: "error",
          error: "Invalid request: " + validation.error.message,
        },
      });
      sendToWebContents(event.sender, CHANNELS.ASSISTANT_CHUNK, {
        sessionId,
        chunk: { type: "done" },
      });
      return;
    }

    const { sessionId, messages, actions, context } = validation.data;

    // Size limits to prevent DoS
    if (messages.length > MAX_MESSAGES) {
      sendToWebContents(event.sender, CHANNELS.ASSISTANT_CHUNK, {
        sessionId,
        chunk: {
          type: "error",
          error: `Too many messages (max ${MAX_MESSAGES})`,
        },
      });
      sendToWebContents(event.sender, CHANNELS.ASSISTANT_CHUNK, {
        sessionId,
        chunk: { type: "done" },
      });
      return;
    }

    for (const msg of messages) {
      if (msg.content.length > MAX_MESSAGE_LENGTH) {
        sendToWebContents(event.sender, CHANNELS.ASSISTANT_CHUNK, {
          sessionId,
          chunk: {
            type: "error",
            error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)`,
          },
        });
        sendToWebContents(event.sender, CHANNELS.ASSISTANT_CHUNK, {
          sessionId,
          chunk: { type: "done" },
        });
        return;
      }
    }

    // Cancel stream if sender is destroyed
    const senderDestroyedListener = () => {
      assistantService.cancel(sessionId);
    };
    event.sender.once("destroyed", senderDestroyedListener);

    await assistantService.streamMessage(
      sessionId,
      messages,
      (chunk) => {
        sendToWebContents(event.sender, CHANNELS.ASSISTANT_CHUNK, {
          sessionId,
          chunk,
        });
      },
      actions as ActionManifestEntry[] | undefined,
      context as ActionContext | undefined
    );

    // Cleanup listener if stream completed normally
    if (!event.sender.isDestroyed()) {
      event.sender.removeListener("destroyed", senderDestroyedListener);
    }
  });

  ipcMain.handle(CHANNELS.ASSISTANT_CANCEL, (_event, sessionId: string) => {
    assistantService.cancel(sessionId);
  });

  ipcMain.handle(CHANNELS.ASSISTANT_CLEAR_SESSION, (_event, sessionId: string) => {
    assistantService.clearSession(sessionId);
  });

  ipcMain.handle(CHANNELS.ASSISTANT_HAS_API_KEY, () => {
    return assistantService.hasApiKey();
  });

  // Cleanup on webContents destroy to prevent orphaned streams
  mainWindow.webContents.on("destroyed", destroyedListener);

  // Cleanup when project switches
  mainWindow.webContents.on("did-start-navigation", navigationListener);

  return () => {
    destroyTerminalStateListenerBridge();
    ipcMain.removeHandler(CHANNELS.ASSISTANT_SEND_MESSAGE);
    ipcMain.removeHandler(CHANNELS.ASSISTANT_CANCEL);
    ipcMain.removeHandler(CHANNELS.ASSISTANT_CLEAR_SESSION);
    ipcMain.removeHandler(CHANNELS.ASSISTANT_HAS_API_KEY);
    mainWindow.webContents.removeListener("destroyed", destroyedListener);
    mainWindow.webContents.removeListener("did-start-navigation", navigationListener);
  };
}
