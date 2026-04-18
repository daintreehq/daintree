import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import type { HandlerDependencies } from "../types.js";
import { typedHandle } from "../utils.js";

export function registerGlobalEnvHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleGetEnv = async (): Promise<Record<string, string>> => {
    return store.get("globalEnvironmentVariables") ?? {};
  };
  handlers.push(typedHandle(CHANNELS.GLOBAL_ENV_GET, handleGetEnv));

  const handleSetEnv = async (payload: { variables: Record<string, string> }): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    const { variables } = payload;
    if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
      throw new Error("Invalid variables object");
    }
    for (const [key, value] of Object.entries(variables)) {
      if (typeof key !== "string" || typeof value !== "string") {
        throw new Error("All environment variable keys and values must be strings");
      }
    }
    return store.set("globalEnvironmentVariables", variables);
  };
  handlers.push(typedHandle(CHANNELS.GLOBAL_ENV_SET, handleSetEnv));

  return () => handlers.forEach((cleanup) => cleanup());
}
