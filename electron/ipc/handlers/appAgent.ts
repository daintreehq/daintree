import { CHANNELS } from "../channels.js";
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
    if (!config || typeof config !== "object") {
      throw new Error("Invalid config");
    }

    const configResult = AppAgentConfigSchema.partial().safeParse(config);
    if (!configResult.success) {
      throw new Error(`Invalid config: ${configResult.error.message}`);
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
    if (!apiKey || typeof apiKey !== "string") {
      throw new Error("Invalid API key");
    }
    return appAgentService.testApiKey(apiKey.trim());
  };
  handlers.push(typedHandle(CHANNELS.APP_AGENT_TEST_API_KEY, handleTestApiKey));

  const handleTestModel = async (model: string) => {
    if (!model || typeof model !== "string") {
      throw new Error("Invalid model");
    }
    return appAgentService.testModel(model.trim());
  };
  handlers.push(typedHandle(CHANNELS.APP_AGENT_TEST_MODEL, handleTestModel));

  return () => handlers.forEach((cleanup) => cleanup());
}
