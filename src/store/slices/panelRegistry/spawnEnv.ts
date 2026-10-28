import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import { projectClient, globalEnvClient } from "@/clients";
import { logWarn } from "@/utils/logger";
import { mergeTerminalLaunchEnv } from "@shared/utils/terminalLaunchOptions";

/** Global env under project env under the caller's launch env; never rejects. */
export function startSpawnEnvFetch(
  options: AddPanelOptions,
  isReconnect: boolean,
  capturedProjectId: string | undefined
): Promise<Record<string, string> | undefined> {
  if (isReconnect) return Promise.resolve(options.env);
  try {
    return Promise.all([
      globalEnvClient.get().catch((error: unknown) => {
        logWarn("[TerminalStore] Failed to fetch global environment variables", { error });
        return {} as Record<string, string>;
      }),
      capturedProjectId
        ? projectClient.getSettings(capturedProjectId).then(
            (s) => s?.environmentVariables ?? ({} as Record<string, string>),
            (error: unknown) => {
              logWarn("[TerminalStore] Failed to fetch project environment variables", {
                error,
              });
              return {} as Record<string, string>;
            }
          )
        : Promise.resolve({} as Record<string, string>),
    ]).then(
      ([globalEnvVars, projectEnvVars]) =>
        mergeTerminalLaunchEnv(globalEnvVars, projectEnvVars, options.env),
      (error: unknown) => {
        logWarn("[TerminalStore] Failed to fetch environment variables", { error });
        return options.env;
      }
    );
  } catch (error) {
    logWarn("[TerminalStore] Failed to fetch environment variables", { error });
    return Promise.resolve(options.env);
  }
}
