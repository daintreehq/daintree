import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { getGeminiConfigService } from "../../services/gemini/GeminiConfigService.js";

export function registerGeminiHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleGeminiGetStatus = async () => {
    const service = getGeminiConfigService();
    return service.getStatus();
  };
  ipcMain.handle(CHANNELS.GEMINI_GET_STATUS, handleGeminiGetStatus);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GEMINI_GET_STATUS));

  const handleGeminiEnableAlternateBuffer = async () => {
    const service = getGeminiConfigService();
    await service.enableAlternateBuffer();
    return { success: true };
  };
  ipcMain.handle(CHANNELS.GEMINI_ENABLE_ALTERNATE_BUFFER, handleGeminiEnableAlternateBuffer);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GEMINI_ENABLE_ALTERNATE_BUFFER));

  return () => handlers.forEach((cleanup) => cleanup());
}
