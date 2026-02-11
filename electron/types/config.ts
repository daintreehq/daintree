/**
 * Configuration runtime values for Canopy Command Center
 *
 * Type definitions are imported from @shared/types.
 * This file contains only the DEFAULT_CONFIG constant.
 */

import type { CanopyConfig } from "../../shared/types/index.js";

export type {
  OpenerConfig,
  OpenersConfig,
  QuickLink,
  QuickLinksConfig,
  MonitorConfig,
  NoteConfig,
  DevServerConfig,
  UIConfig,
  WorktreesConfig,
  GitDisplayConfig,
  CanopyConfig,
} from "../../shared/types/index.js";

export const DEFAULT_CONFIG: CanopyConfig = {
  editor: "code",
  editorArgs: ["-r"],
  theme: "auto",
  showHidden: false,
  showGitStatus: true,
  showFileSize: false,
  showModifiedTime: false,
  respectGitignore: true,
  customIgnores: [
    "**/.git/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.DS_Store",
    "**/coverage/**",
    "**/__pycache__/**",
  ],
  copytreeDefaults: {
    format: "xml",
    asReference: true,
  },
  openers: {
    default: { cmd: "code", args: ["-r"] },
    byExtension: {},
    byGlob: {},
  },
  autoRefresh: true,
  refreshDebounce: 100,
  usePolling: true,
  treeIndent: 2,
  maxDepth: null,
  sortBy: "name",
  sortDirection: "asc",
  ui: {
    leftClickAction: "open",
    compactMode: true,
    activePathHighlight: true,
    activePathColor: "cyan",
  },
  worktrees: {
    enable: true,
    showInHeader: true,
  },
  git: {
    statusStyle: "glyph",
    folderHeatMap: true,
    heatMapIntensity: "normal",
  },
  quickLinks: {
    enabled: true,
    links: [],
  },
  devServer: {
    enabled: false,
    autoStart: false,
  },
  monitor: {
    pollIntervalActive: 2000,
    pollIntervalBackground: 10000,
    pollIntervalMax: 30000,
    adaptiveBackoff: true,
    circuitBreakerThreshold: 3,
    gitWatchEnabled: true,
    gitWatchDebounceMs: 300,
  },
  note: {
    enabled: true,
    filename: "canopy/note",
  },
};
