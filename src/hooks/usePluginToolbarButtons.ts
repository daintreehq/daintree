import { useState, useEffect } from "react";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import type { PluginToolbarButtonId } from "@shared/types/toolbar";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

export interface PluginToolbarButtonState {
  buttonIds: PluginToolbarButtonId[];
  configs: Map<string, ToolbarButtonConfig>;
  isRegistered: (id: string) => boolean;
}

export function usePluginToolbarButtons(): PluginToolbarButtonState {
  const [configs, setConfigs] = useState<Map<string, ToolbarButtonConfig>>(new Map());

  useEffect(() => {
    safeFireAndForget(
      window.electron.plugin.toolbarButtons().then((buttons) => {
        const map = new Map<string, ToolbarButtonConfig>();
        for (const btn of buttons) {
          map.set(btn.id, btn);
        }
        setConfigs(map);
      }),
      { context: "Loading plugin toolbar buttons" }
    );
  }, []);

  const buttonIds = Array.from(configs.keys()) as PluginToolbarButtonId[];
  const isRegistered = (id: string) => id.startsWith("plugin.") && configs.has(id);

  return { buttonIds, configs, isRegistered };
}
