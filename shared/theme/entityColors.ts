export const PANEL_KIND_BRAND_COLORS = {
  terminal: "var(--theme-activity-idle)",
  agent: "var(--theme-accent-primary)",
  browser: "var(--theme-category-blue)",
  notes: "var(--theme-category-amber)",
  "dev-preview": "var(--theme-category-violet)",
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
