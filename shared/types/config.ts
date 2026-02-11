import type { KeyMapConfig } from "./keymap.js";

// Panel Grid Layout Configuration

/** Layout strategy for panel grid */
export type PanelLayoutStrategy = "automatic" | "fixed-columns" | "fixed-rows";

/** Configuration for panel grid layout */
export interface PanelGridConfig {
  /** Layout strategy to use */
  strategy: PanelLayoutStrategy;
  /** Constraint value for fixed-columns/fixed-rows strategies */
  value: number;
}

// Opener Configuration

/** External file opener config */
export interface OpenerConfig {
  /** Command to execute (editor name or path) */
  cmd: string;
  /** Arguments to pass to command */
  args: string[];
}

/** Configuration for file openers with pattern matching */
export interface OpenersConfig {
  /** Fallback opener used when no patterns match */
  default: OpenerConfig;
  /** Extension-based opener mapping (e.g., { '.md': { cmd: 'typora', args: [] } }) */
  byExtension: Record<string, OpenerConfig>;
  /** Glob pattern-based opener mapping */
  byGlob: Record<string, OpenerConfig>;
}

// Quick Links Configuration

/** Quick link for external tools */
export interface QuickLink {
  /** Display label for the link */
  label: string;
  /** URL to open in default browser */
  url: string;
  /** Optional keyboard shortcut number (1-9) for Cmd+{num} access */
  shortcut?: number;
  /** Optional slash command name (e.g., "gemini" for /gemini) */
  command?: string;
}

/** Configuration for the quick links feature */
export interface QuickLinksConfig {
  /** Enable/disable the quick links feature (default: true) */
  enabled: boolean;
  /** Configured links */
  links: QuickLink[];
}

// Monitor Configuration

/** Worktree monitor polling intervals (tunable for monorepos/resource constraints) */
export interface MonitorConfig {
  /** Polling interval for active worktree in ms (default: 2000, min: 500, max: 60000) */
  pollIntervalActive?: number;
  /** Polling interval for background worktrees in ms (default: 10000, min: 5000, max: 300000) */
  pollIntervalBackground?: number;
  /** Maximum polling interval when idle in ms (default: 30000) */
  pollIntervalMax?: number;
  /** Enable adaptive backoff based on Git operation duration (default: true) */
  adaptiveBackoff?: boolean;
  /** Number of consecutive failures before circuit breaker triggers (default: 3) */
  circuitBreakerThreshold?: number;
  /** Enable git file watching for instant updates (default: true) */
  gitWatchEnabled?: boolean;
  /** Debounce time for file watch events in ms (default: 300) */
  gitWatchDebounceMs?: number;
}

/** Agent note feature config (agents write status to .git/canopy/note) */
export interface NoteConfig {
  /** Enable/disable the AI note feature (default: true) */
  enabled?: boolean;
  /** Override the note filename (default: 'canopy/note') */
  filename?: string;
}

// Dev Server Configuration

/** Dev server management config */
export interface DevServerConfig {
  /** Custom dev server command (e.g., "npm run start:frontend") */
  command?: string;
  /** Auto-start servers on application launch (default: false) */
  autoStart?: boolean;
  /** Enable/disable dev server feature (default: false, must be explicitly enabled) */
  enabled?: boolean;
  /** Custom commands for specific projects */
  customCommands?: Record<string, string>;
}

// UI Configuration

/** UI behavior and appearance */
export interface UIConfig {
  /** Action to perform on left click ('open' opens file, 'select' selects it) */
  leftClickAction?: "open" | "select";
  /** Use compact mode for denser information display */
  compactMode?: boolean;
  /** Highlight the active path in the tree */
  activePathHighlight?: boolean;
  /** Color for active path highlight */
  activePathColor?: "cyan" | "blue" | "green";
}

/** Configuration for worktree features */
export interface WorktreesConfig {
  /** Master toggle for worktree features */
  enable: boolean;
  /** Show/hide worktree indicator in header */
  showInHeader: boolean;
}

/** Configuration for git-related display */
export interface GitDisplayConfig {
  /** Style for git status indicators ('letter' = M/A/D, 'glyph' = colored dots) */
  statusStyle?: "letter" | "glyph";
  /** Enable folder heat coloring based on changes */
  folderHeatMap?: boolean;
  /** Intensity of heat map coloring */
  heatMapIntensity?: "subtle" | "normal" | "intense";
}

// Main Configuration Interface

/** Complete app configuration */
export interface CanopyConfig {
  /** Default editor command */
  editor: string;
  /** Arguments to pass to the editor */
  editorArgs: string[];
  /** Theme mode */
  theme: "auto" | "dark" | "light";
  /** Optional path to custom theme JSON file */
  customTheme?: string;
  /** Show hidden files in file tree */
  showHidden: boolean;
  /** Show git status indicators */
  showGitStatus: boolean;
  /** Show file sizes */
  showFileSize: boolean;
  /** Show last modified times */
  showModifiedTime: boolean;
  /** Respect .gitignore rules */
  respectGitignore: boolean;
  /** Additional ignore patterns */
  customIgnores: string[];
  /** Default settings for copytree operations */
  copytreeDefaults: {
    /** Output format */
    format: string;
    /** Use as reference mode */
    asReference: boolean;
  };
  /** File opener configurations */
  openers?: OpenersConfig;
  /** Enable automatic refresh on file changes */
  autoRefresh: boolean;
  /** Debounce time for refresh in ms */
  refreshDebounce: number;
  /** Use polling instead of native file watching */
  usePolling: boolean;
  /** Indentation size for tree display */
  treeIndent: number;
  /** Maximum depth for tree display (null for unlimited) */
  maxDepth: number | null;
  /** Sort files by this property */
  sortBy: "name" | "size" | "modified" | "type";
  /** Sort direction */
  sortDirection: "asc" | "desc";
  /** UI-related configuration */
  ui?: UIConfig;
  /** Worktree feature configuration */
  worktrees?: WorktreesConfig;
  /** Git display configuration */
  git?: GitDisplayConfig;
  /** Keyboard shortcuts configuration */
  keys?: KeyMapConfig;
  /** Quick links configuration */
  quickLinks?: QuickLinksConfig;
  /** Dev server configuration */
  devServer?: DevServerConfig;
  /** Monitor polling configuration */
  monitor?: MonitorConfig;
  /** Agent note display feature */
  note?: NoteConfig;
  /** CopyTree configuration */
  copytree?: {
    defaultProfile?: string;
    extraArgs?: string[];
  };
  /** Keymap configuration */
  keymap?: {
    preset?: "standard" | "vim";
    overrides?: Record<string, string>;
  };
}
