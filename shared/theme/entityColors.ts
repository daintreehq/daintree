export const AGENT_BRAND_COLORS = {
  claude: "#CC785C",
  gemini: "#4285F4",
  codex: "#e4e4e7",
  opencode: "#10b981",
} as const;

export const PANEL_KIND_BRAND_COLORS = {
  terminal: "#6b7280",
  agent: AGENT_BRAND_COLORS.claude,
  browser: "#3b82f6",
  notes: "#f59e0b",
  "dev-preview": "#8b5cf6",
} as const;

export const BRANCH_TYPE_COLOR_CLASSES = {
  feature: {
    bg: "bg-category-teal/12",
    border: "border-category-teal/28",
    text: "text-category-teal",
  },
  bugfix: {
    bg: "bg-status-danger/12",
    border: "border-status-danger/28",
    text: "text-status-danger",
  },
  neutral: {
    bg: "bg-border-default/20",
    border: "border-border-default",
    text: "text-text-secondary",
  },
  warm: {
    bg: "bg-category-amber/12",
    border: "border-category-amber/28",
    text: "text-category-amber",
  },
} as const;
