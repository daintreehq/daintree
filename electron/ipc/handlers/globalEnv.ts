import { defineIpcNamespace, op } from "../define.js";
import { GLOBAL_ENV_METHOD_CHANNELS } from "./globalEnv.preload.js";
import { store } from "../../store.js";

async function handleGet(): Promise<Record<string, string>> {
  return store.get("globalEnvironmentVariables") ?? {};
}

async function handleSet(payload: { variables: Record<string, string> }): Promise<void> {
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
}

export const globalEnvNamespace = defineIpcNamespace({
  name: "globalEnv",
  ops: {
    get: op(GLOBAL_ENV_METHOD_CHANNELS.get, handleGet),
    set: op(GLOBAL_ENV_METHOD_CHANNELS.set, handleSet),
  },
});

export function registerGlobalEnvHandlers(): () => void {
  return globalEnvNamespace.register();
}
