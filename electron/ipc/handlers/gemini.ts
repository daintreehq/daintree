import { getGeminiConfigService } from "../../services/gemini/GeminiConfigService.js";
import { defineIpcNamespace, op } from "../define.js";
import { GEMINI_METHOD_CHANNELS } from "./gemini.preload.js";

async function handleGeminiGetStatus(): Promise<{
  exists: boolean;
  alternateBufferEnabled: boolean;
  error?: string;
}> {
  const service = getGeminiConfigService();
  return service.getStatus();
}

async function handleGeminiEnableAlternateBuffer(): Promise<{ success: boolean }> {
  const service = getGeminiConfigService();
  await service.enableAlternateBuffer();
  return { success: true };
}

export const geminiNamespace = defineIpcNamespace({
  name: "gemini",
  ops: {
    getStatus: op(GEMINI_METHOD_CHANNELS.getStatus, handleGeminiGetStatus),
    enableAlternateBuffer: op(
      GEMINI_METHOD_CHANNELS.enableAlternateBuffer,
      // @ts-expect-error: handler returns {success: true} — pending migration to throw AppError on failure and return void on success. See #6020.
      handleGeminiEnableAlternateBuffer
    ),
  },
});

export function registerGeminiHandlers(): () => void {
  return geminiNamespace.register();
}
