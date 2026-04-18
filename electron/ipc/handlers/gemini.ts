import { CHANNELS } from "../channels.js";
import { getGeminiConfigService } from "../../services/gemini/GeminiConfigService.js";
import { typedHandle } from "../utils.js";

export function registerGeminiHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleGeminiGetStatus = async () => {
    const service = getGeminiConfigService();
    return service.getStatus();
  };
  handlers.push(typedHandle(CHANNELS.GEMINI_GET_STATUS, handleGeminiGetStatus));

  const handleGeminiEnableAlternateBuffer = async () => {
    const service = getGeminiConfigService();
    await service.enableAlternateBuffer();
    return { success: true };
  };
  handlers.push(
    typedHandle(CHANNELS.GEMINI_ENABLE_ALTERNATE_BUFFER, handleGeminiEnableAlternateBuffer)
  );

  return () => handlers.forEach((cleanup) => cleanup());
}
