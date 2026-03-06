export interface AppColorSchemeTokens {
  // Brand layer
  "canopy-bg": string;
  "canopy-sidebar": string;
  "canopy-border": string;
  "canopy-text": string;
  "canopy-accent": string;
  "canopy-success": string;
  surface: string;
  "surface-highlight": string;
  "grid-bg": string;
  "canopy-focus": string;

  // Semantic status layer
  "status-success": string;
  "status-warning": string;
  "status-error": string;
  "status-info": string;

  // Semantic state layer
  "state-active": string;
  "state-idle": string;
  "state-working": string;
  "state-waiting": string;

  // Server layer
  "server-running": string;
  "server-stopped": string;
  "server-starting": string;
  "server-error": string;

  // Terminal integration
  "terminal-selection": string;
}

export interface AppColorScheme {
  id: string;
  name: string;
  type: "dark" | "light";
  builtin: boolean;
  tokens: AppColorSchemeTokens;
}

export interface AppThemeConfig {
  colorSchemeId: string;
  customSchemes?: string;
}
