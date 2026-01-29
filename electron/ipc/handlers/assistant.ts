import { ipcMain, type BrowserWindow, type WebContents } from "electron";
import { CHANNELS } from "../channels.js";
import { assistantService } from "../../services/AssistantService.js";
import {
  type AssistantMessage,
  type AssistantChunkPayload,
  SendMessageRequestSchema,
} from "../../../shared/types/assistant.js";

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
  const destroyedListener = () => {
    assistantService.cancelAll();
  };

  const navigationListener = () => {
    assistantService.cancelAll();
  };

  ipcMain.handle(
    CHANNELS.ASSISTANT_SEND_MESSAGE,
    async (
      event,
      payload: {
        sessionId: string;
        messages: AssistantMessage[];
        context?: {
          projectId?: string;
          activeWorktreeId?: string;
          focusedTerminalId?: string;
        };
      }
    ) => {
      // Validate payload
      const validation = SendMessageRequestSchema.safeParse(payload);
      if (!validation.success) {
        console.error("[AssistantHandlers] Invalid payload:", validation.error);
        sendToWebContents(event.sender, CHANNELS.ASSISTANT_CHUNK, {
          sessionId: payload.sessionId || "unknown",
          chunk: {
            type: "error",
            error: "Invalid request: " + validation.error.message,
          },
        });
        sendToWebContents(event.sender, CHANNELS.ASSISTANT_CHUNK, {
          sessionId: payload.sessionId || "unknown",
          chunk: { type: "done" },
        });
        return;
      }

      const { sessionId, messages } = validation.data;

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

      await assistantService.streamMessage(sessionId, messages, (chunk) => {
        sendToWebContents(event.sender, CHANNELS.ASSISTANT_CHUNK, {
          sessionId,
          chunk,
        });
      });

      // Cleanup listener if stream completed normally
      if (!event.sender.isDestroyed()) {
        event.sender.removeListener("destroyed", senderDestroyedListener);
      }
    }
  );

  ipcMain.handle(CHANNELS.ASSISTANT_CANCEL, (_event, sessionId: string) => {
    assistantService.cancel(sessionId);
  });

  ipcMain.handle(CHANNELS.ASSISTANT_HAS_API_KEY, () => {
    return assistantService.hasApiKey();
  });

  // Cleanup on webContents destroy to prevent orphaned streams
  mainWindow.webContents.on("destroyed", destroyedListener);

  // Cleanup when project switches
  mainWindow.webContents.on("did-start-navigation", navigationListener);

  return () => {
    ipcMain.removeHandler(CHANNELS.ASSISTANT_SEND_MESSAGE);
    ipcMain.removeHandler(CHANNELS.ASSISTANT_CANCEL);
    ipcMain.removeHandler(CHANNELS.ASSISTANT_HAS_API_KEY);
    mainWindow.webContents.removeListener("destroyed", destroyedListener);
    mainWindow.webContents.removeListener("did-start-navigation", navigationListener);
  };
}
