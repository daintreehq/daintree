export interface PanelContribution {
  id: string;
  name: string;
  iconId: string;
  color: string;
  hasPty: boolean;
  canRestart: boolean;
  canConvert: boolean;
  showInPalette: boolean;
}

export interface PluginManifest {
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  main?: string;
  renderer?: string;
  contributes: {
    panels: PanelContribution[];
  };
}

export interface LoadedPluginInfo {
  manifest: PluginManifest;
  dir: string;
  resolvedRenderer?: string;
  loadedAt: number;
}
