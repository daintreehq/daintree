import { z } from "zod";
import { CHANNELS } from "../channels.js";
import { ValidationError } from "../validationError.js";
import type { HandlerDependencies } from "../types.js";
import { appAgentService } from "../../services/AppAgentService.js";
import type { AppAgentConfig } from "../../../shared/types/appAgent.js";
import { AppAgentConfigSchema } from "../../../shared/types/appAgent.js";
import { typedHandle } from "../utils.js";

export function registerAppAgentHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleGetConfig = async () => {
    return appAgentService.getConfig();
  };
  handlers.push(typedHandle(CHANNELS.APP_AGENT_GET_CONFIG, handleGetConfig));

  const handleSetConfig = async (config: Partial<AppAgentConfig>) => {
    const configResult = AppAgentConfigSchema.partial().safeParse(config);
    if (!configResult.success) {
      console.error("Invalid app agent config:", z.prettifyError(configResult.error));
      throw new ValidationError(CHANNELS.APP_AGENT_SET_CONFIG);
    }

    appAgentService.setConfig(configResult.data);
    return appAgentService.getConfig();
  };
  handlers.push(typedHandle(CHANNELS.APP_AGENT_SET_CONFIG, handleSetConfig));

  const handleHasApiKey = async () => {
    return appAgentService.hasApiKey();
  };
  handlers.push(typedHandle(CHANNELS.APP_AGENT_HAS_API_KEY, handleHasApiKey));

  const handleTestApiKey = async (apiKey: string) => {
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      throw new Error("Invalid API key");
    }
    return appAgentService.testApiKey(apiKey.trim());
  };
  handlers.push(typedHandle(CHANNELS.APP_AGENT_TEST_API_KEY, handleTestApiKey));

  const handleTestModel = async (model: string) => {
    if (!model || typeof model !== "string" || !model.trim()) {
      throw new Error("Invalid model");
    }
    return appAgentService.testModel(model.trim());
  };
  handlers.push(typedHandle(CHANNELS.APP_AGENT_TEST_MODEL, handleTestModel));

  return () => handlers.forEach((cleanup) => cleanup());
}
