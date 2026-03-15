import type {
  AppColorScheme,
  AppColorSchemeTokens,
  AppThemeTokenKey,
  AppThemeValidationWarning,
} from "./types.js";

export const DEFAULT_APP_SCHEME_ID = "daintree";

const GITHUB_TOKENS: Pick<
  AppColorSchemeTokens,
  "github-open" | "github-merged" | "github-closed" | "github-draft"
> = {
  "github-open": "#3fb950",
  "github-merged": "#a371f7",
  "github-closed": "#f85149",
  "github-draft": "#8b949e",
};

export function createCanopyTokens(
  type: "dark" | "light",
  tokens: Partial<AppColorSchemeTokens> &
    Pick<
      AppColorSchemeTokens,
      | "surface-canvas"
      | "surface-sidebar"
      | "surface-panel"
      | "surface-panel-elevated"
      | "surface-grid"
      | "text-primary"
      | "text-secondary"
      | "text-muted"
      | "text-inverse"
      | "border-default"
      | "accent-primary"
      | "status-success"
      | "status-warning"
      | "status-danger"
      | "status-info"
      | "activity-active"
      | "activity-idle"
      | "activity-working"
      | "activity-waiting"
      | "terminal-selection"
      | "terminal-red"
      | "terminal-green"
      | "terminal-yellow"
      | "terminal-blue"
      | "terminal-magenta"
      | "terminal-cyan"
      | "terminal-bright-red"
      | "terminal-bright-green"
      | "terminal-bright-yellow"
      | "terminal-bright-blue"
      | "terminal-bright-magenta"
      | "terminal-bright-cyan"
      | "terminal-bright-white"
      | "syntax-comment"
      | "syntax-punctuation"
      | "syntax-number"
      | "syntax-string"
      | "syntax-operator"
      | "syntax-keyword"
      | "syntax-function"
      | "syntax-link"
      | "syntax-quote"
      | "syntax-chip"
    >
): AppColorSchemeTokens {
  const accentSoft =
    tokens["accent-soft"] ??
    (tokens["accent-primary"].startsWith("#")
      ? `rgba(${hexToRgbTriplet(tokens["accent-primary"])}, 0.18)`
      : `color-mix(in oklab, ${tokens["accent-primary"]} 18%, transparent)`);
  const accentMuted =
    tokens["accent-muted"] ??
    (tokens["accent-primary"].startsWith("#")
      ? `rgba(${hexToRgbTriplet(tokens["accent-primary"])}, 0.3)`
      : `color-mix(in oklab, ${tokens["accent-primary"]} 30%, transparent)`);

  const dark = type === "dark";

  return {
    ...GITHUB_TOKENS,
    "category-blue": tokens["category-blue"] ?? "oklch(0.7 0.13 250)",
    "category-purple": tokens["category-purple"] ?? "oklch(0.7 0.13 310)",
    "category-cyan": tokens["category-cyan"] ?? "oklch(0.72 0.11 215)",
    "category-green": tokens["category-green"] ?? "oklch(0.7 0.13 145)",
    "category-amber": tokens["category-amber"] ?? "oklch(0.73 0.14 75)",
    "category-orange": tokens["category-orange"] ?? "oklch(0.7 0.14 45)",
    "category-teal": tokens["category-teal"] ?? "oklch(0.7 0.11 185)",
    "category-indigo": tokens["category-indigo"] ?? "oklch(0.7 0.13 275)",
    "category-rose": tokens["category-rose"] ?? "oklch(0.7 0.14 5)",
    "category-pink": tokens["category-pink"] ?? "oklch(0.72 0.13 340)",
    "category-violet": tokens["category-violet"] ?? "oklch(0.7 0.13 295)",
    "category-slate": tokens["category-slate"] ?? "oklch(0.65 0.04 240)",
    "border-subtle":
      tokens["border-subtle"] ?? (dark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)"),
    "border-strong":
      tokens["border-strong"] ?? (dark ? "rgba(255, 255, 255, 0.14)" : "rgba(0, 0, 0, 0.12)"),
    "border-divider":
      tokens["border-divider"] ?? (dark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)"),
    "accent-foreground": tokens["accent-foreground"] ?? tokens["text-inverse"],
    "accent-soft": accentSoft,
    "accent-muted": accentMuted,
    "focus-ring":
      tokens["focus-ring"] ?? (dark ? "rgba(255, 255, 255, 0.18)" : "rgba(0, 0, 0, 0.15)"),
    "overlay-subtle":
      tokens["overlay-subtle"] ?? (dark ? "rgba(255, 255, 255, 0.02)" : "rgba(0, 0, 0, 0.02)"),
    "overlay-soft":
      tokens["overlay-soft"] ?? (dark ? "rgba(255, 255, 255, 0.03)" : "rgba(0, 0, 0, 0.03)"),
    "overlay-medium":
      tokens["overlay-medium"] ?? (dark ? "rgba(255, 255, 255, 0.04)" : "rgba(0, 0, 0, 0.04)"),
    "overlay-strong":
      tokens["overlay-strong"] ?? (dark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.05)"),
    "overlay-emphasis":
      tokens["overlay-emphasis"] ?? (dark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.08)"),
    "scrim-soft": tokens["scrim-soft"] ?? (dark ? "rgba(0, 0, 0, 0.2)" : "rgba(0, 0, 0, 0.12)"),
    "scrim-medium":
      tokens["scrim-medium"] ?? (dark ? "rgba(0, 0, 0, 0.45)" : "rgba(0, 0, 0, 0.30)"),
    "scrim-strong":
      tokens["scrim-strong"] ?? (dark ? "rgba(0, 0, 0, 0.62)" : "rgba(0, 0, 0, 0.45)"),
    "terminal-black": tokens["terminal-black"] ?? tokens["surface-canvas"],
    "terminal-white": tokens["terminal-white"] ?? tokens["text-primary"],
    "terminal-bright-black": tokens["terminal-bright-black"] ?? tokens["activity-idle"],
    ...tokens,
  };
}

const INTERNAL_LIGHT_FALLBACK_SCHEME: AppColorScheme = {
  id: "canopy-light-base",
  name: "Canopy Light Base",
  type: "light",
  builtin: true,
  tokens: createCanopyTokens("light", {
    "surface-canvas": "#f6f4ef",
    "surface-sidebar": "#ebe7de",
    "surface-panel": "#fffdf8",
    "surface-panel-elevated": "#fdfbf6",
    "surface-grid": "#f0ede5",
    "text-primary": "#1f2937",
    "text-secondary": "color-mix(in oklab, #1f2937 72%, #f6f4ef)",
    "text-muted": "#5f6b76",
    "text-inverse": "#10161b",
    "border-default": "#d8d2c6",
    "accent-primary": "#3F9366",
    "accent-foreground": "#08140e",
    "status-success": "#2f6f4f",
    "status-warning": "#85551a",
    "status-danger": "#94463e",
    "status-info": "#4b5f74",
    "activity-active": "#22c55e",
    "activity-idle": "#8b95a1",
    "activity-working": "#22c55e",
    "activity-waiting": "#d97706",
    "terminal-selection": "#dbe9de",
    "terminal-red": "#b42318",
    "terminal-green": "#1f8f58",
    "terminal-yellow": "#a16207",
    "terminal-blue": "#2563eb",
    "terminal-magenta": "#8b5cf6",
    "terminal-cyan": "#0f766e",
    "terminal-bright-red": "#dc2626",
    "terminal-bright-green": "#16a34a",
    "terminal-bright-yellow": "#ca8a04",
    "terminal-bright-blue": "#3b82f6",
    "terminal-bright-magenta": "#a855f7",
    "terminal-bright-cyan": "#0891b2",
    "terminal-bright-white": "#0f172a",
    "syntax-comment": "#6b7280",
    "syntax-punctuation": "#334155",
    "syntax-number": "#b45309",
    "syntax-string": "#15803d",
    "syntax-operator": "#0f766e",
    "syntax-keyword": "#7c3aed",
    "syntax-function": "#2563eb",
    "syntax-link": "#0369a1",
    "syntax-quote": "#64748b",
    "syntax-chip": "#0f766e",
    "category-blue": "oklch(0.62 0.14 250)",
    "category-purple": "oklch(0.64 0.14 310)",
    "category-cyan": "oklch(0.65 0.12 215)",
    "category-green": "oklch(0.63 0.13 145)",
    "category-amber": "oklch(0.68 0.14 75)",
    "category-orange": "oklch(0.66 0.15 45)",
    "category-teal": "oklch(0.64 0.11 185)",
    "category-indigo": "oklch(0.61 0.13 275)",
    "category-rose": "oklch(0.63 0.14 5)",
    "category-pink": "oklch(0.66 0.13 340)",
    "category-violet": "oklch(0.63 0.13 295)",
    "category-slate": "oklch(0.58 0.04 240)",
  }),
};

export const BUILT_IN_APP_SCHEMES: AppColorScheme[] = [
  {
    id: "daintree",
    name: "Daintree",
    type: "dark",
    builtin: true,
    tokens: createCanopyTokens("dark", {
      "surface-canvas": "#19191a",
      "surface-sidebar": "#131312",
      "surface-panel": "#1d1d1e",
      "surface-panel-elevated": "#2b2b2c",
      "surface-grid": "#0e0e0d",
      "text-primary": "#e4e4e7",
      "text-secondary": "color-mix(in oklab, #e4e4e7 65%, #19191a)",
      "text-muted": "#a1a1aa",
      "text-inverse": "#19191a",
      "border-default": "#282828",
      "accent-primary": "#3F9366",
      "status-success": "#5F8B6D",
      "status-warning": "#C59A4E",
      "status-danger": "#C8746C",
      "status-info": "#7B8C96",
      "activity-active": "#22c55e",
      "activity-idle": "#52525b",
      "activity-working": "#22c55e",
      "activity-waiting": "#fbbf24",
      "terminal-selection": "#1a2c22",
      "terminal-red": "#f87171",
      "terminal-green": "#10b981",
      "terminal-yellow": "#fbbf24",
      "terminal-blue": "#38bdf8",
      "terminal-magenta": "#a855f7",
      "terminal-cyan": "#22d3ee",
      "terminal-bright-red": "#fca5a5",
      "terminal-bright-green": "#34d399",
      "terminal-bright-yellow": "#fcd34d",
      "terminal-bright-blue": "#7dd3fc",
      "terminal-bright-magenta": "#c084fc",
      "terminal-bright-cyan": "#67e8f9",
      "terminal-bright-white": "#fafafa",
      "syntax-comment": "#707b90",
      "syntax-punctuation": "#c5d0f5",
      "syntax-number": "#efb36b",
      "syntax-string": "#95c879",
      "syntax-operator": "#8acfe1",
      "syntax-keyword": "#bc9cef",
      "syntax-function": "#84adf8",
      "syntax-link": "#72c1ea",
      "syntax-quote": "#adb5bb",
      "syntax-chip": "#7fd4cf",
      "focus-ring": "rgba(255, 255, 255, 0.18)",
      "category-blue": "oklch(0.7 0.13 250)",
      "category-purple": "oklch(0.7 0.13 310)",
      "category-cyan": "oklch(0.72 0.11 215)",
      "category-green": "oklch(0.7 0.13 145)",
      "category-amber": "oklch(0.73 0.14 75)",
      "category-orange": "oklch(0.7 0.14 45)",
      "category-teal": "oklch(0.7 0.11 185)",
      "category-indigo": "oklch(0.7 0.13 275)",
      "category-rose": "oklch(0.7 0.14 5)",
      "category-pink": "oklch(0.72 0.13 340)",
      "category-violet": "oklch(0.7 0.13 295)",
      "category-slate": "oklch(0.65 0.04 240)",
    }),
  },
  {
    id: "bondi",
    name: "Bondi",
    type: "light",
    builtin: true,
    tokens: createCanopyTokens("light", {
      "surface-canvas": "#F6F0E4",
      "surface-sidebar": "#EDE7DB",
      "surface-panel": "#FDFCFA",
      "surface-panel-elevated": "#FFFFFF",
      "surface-grid": "#E8E2D6",
      "text-primary": "#1B3626",
      "text-secondary": "color-mix(in oklab, #1B3626 65%, #F6F0E4)",
      "text-muted": "#8B8C86",
      "text-inverse": "#1B3626",
      "border-default": "#D8D2C4",
      "accent-primary": "#3F9366",
      "accent-foreground": "#08140e",
      "status-success": "#2A7A4B",
      "status-warning": "#B08800",
      "status-danger": "#A31D27",
      "status-info": "#2B5573",
      "activity-active": "#22c55e",
      "activity-idle": "#8b95a1",
      "activity-working": "#22c55e",
      "activity-waiting": "#B08800",
      "terminal-black": "#1B3626",
      "terminal-white": "#8B8C86",
      "terminal-selection": "rgba(43, 85, 115, 0.2)",
      "terminal-red": "#C0392B",
      "terminal-green": "#2A7A4B",
      "terminal-yellow": "#B08800",
      "terminal-blue": "#2B5573",
      "terminal-magenta": "#7B5EA7",
      "terminal-cyan": "#1FA8B1",
      "terminal-bright-red": "#E32B31",
      "terminal-bright-green": "#3A9B6B",
      "terminal-bright-yellow": "#C49A00",
      "terminal-bright-blue": "#3B6B8A",
      "terminal-bright-magenta": "#9070BC",
      "terminal-bright-cyan": "#2DC0CA",
      "terminal-bright-white": "#2C3E30",
      "syntax-comment": "#8B8C86",
      "syntax-punctuation": "#2C3E30",
      "syntax-number": "#778A9C",
      "syntax-string": "#2B5573",
      "syntax-operator": "#2B5573",
      "syntax-keyword": "#A31D27",
      "syntax-function": "#1FA8B1",
      "syntax-link": "#2B5573",
      "syntax-quote": "#8B8C86",
      "syntax-chip": "#1FA8B1",
      "category-blue": "oklch(0.62 0.14 250)",
      "category-purple": "oklch(0.64 0.14 310)",
      "category-cyan": "oklch(0.65 0.12 215)",
      "category-green": "oklch(0.63 0.13 145)",
      "category-amber": "oklch(0.68 0.14 75)",
      "category-orange": "oklch(0.66 0.15 45)",
      "category-teal": "oklch(0.64 0.11 185)",
      "category-indigo": "oklch(0.61 0.13 275)",
      "category-rose": "oklch(0.63 0.14 5)",
      "category-pink": "oklch(0.66 0.13 340)",
      "category-violet": "oklch(0.63 0.13 295)",
      "category-slate": "oklch(0.58 0.04 240)",
    }),
  },
  {
    id: "fiordland",
    name: "Fiordland",
    type: "dark",
    builtin: true,
    tokens: createCanopyTokens("dark", {
      "surface-canvas": "#070D12",
      "surface-sidebar": "#0A1520",
      "surface-panel": "#0D1924",
      "surface-panel-elevated": "#122030",
      "surface-grid": "#040A0F",
      "text-primary": "#D4E0D6",
      "text-secondary": "color-mix(in oklab, #D4E0D6 65%, #070D12)",
      "text-muted": "#7A8790",
      "text-inverse": "#070D12",
      "border-default": "#1A2B38",
      "accent-primary": "#3F9366",
      "status-success": "#5F8B6D",
      "status-warning": "#C59A4E",
      "status-danger": "#E04055",
      "status-info": "#7B8C96",
      "activity-active": "#22c55e",
      "activity-idle": "#3D4E5C",
      "activity-working": "#22c55e",
      "activity-waiting": "#fbbf24",
      "overlay-subtle": "rgba(255, 255, 255, 0.03)",
      "overlay-soft": "rgba(255, 255, 255, 0.05)",
      "overlay-medium": "rgba(255, 255, 255, 0.08)",
      "overlay-strong": "rgba(255, 255, 255, 0.12)",
      "overlay-emphasis": "rgba(255, 255, 255, 0.18)",
      "terminal-selection": "#1A2C22",
      "terminal-red": "#F7768E",
      "terminal-green": "#9ECE6A",
      "terminal-yellow": "#E0AF68",
      "terminal-blue": "#7AA2F7",
      "terminal-magenta": "#BB9AF7",
      "terminal-cyan": "#7DCFFF",
      "terminal-bright-red": "#FF9E64",
      "terminal-bright-green": "#B9F27C",
      "terminal-bright-yellow": "#F2D07E",
      "terminal-bright-blue": "#89DDFF",
      "terminal-bright-magenta": "#D0A9F5",
      "terminal-bright-cyan": "#B4F9F8",
      "terminal-bright-white": "#C0CAF5",
      "syntax-comment": "#7A8790",
      "syntax-punctuation": "#C2CED6",
      "syntax-number": "#E0AF68",
      "syntax-string": "#A8C96F",
      "syntax-operator": "#8FBCBB",
      "syntax-keyword": "#E86A33",
      "syntax-function": "#3F9366",
      "syntax-link": "#7AA2F7",
      "syntax-quote": "#A4B0B8",
      "syntax-chip": "#75B7A5",
      "focus-ring": "rgba(255, 255, 255, 0.18)",
      "category-blue": "oklch(0.7 0.13 250)",
      "category-purple": "oklch(0.7 0.13 310)",
      "category-cyan": "oklch(0.72 0.11 215)",
      "category-green": "oklch(0.7 0.13 145)",
      "category-amber": "oklch(0.73 0.14 75)",
      "category-orange": "oklch(0.7 0.14 45)",
      "category-teal": "oklch(0.7 0.11 185)",
      "category-indigo": "oklch(0.7 0.13 275)",
      "category-rose": "oklch(0.7 0.14 5)",
      "category-pink": "oklch(0.72 0.13 340)",
      "category-violet": "oklch(0.7 0.13 295)",
      "category-slate": "oklch(0.65 0.04 240)",
    }),
  },
  {
    id: "highlands",
    name: "Highlands",
    type: "dark",
    builtin: true,
    tokens: createCanopyTokens("dark", {
      "surface-canvas": "#1A1614",
      "surface-sidebar": "#14110F",
      "surface-panel": "#1E1A17",
      "surface-panel-elevated": "#292320",
      "surface-grid": "#110E0C",
      "text-primary": "#C9D1D9",
      "text-secondary": "color-mix(in oklab, #C9D1D9 65%, #1A1614)",
      "text-muted": "#6B767C",
      "text-inverse": "#1A1614",
      "border-default": "#2C2521",
      "accent-primary": "#3F9366",
      "status-success": "#5F8B6D",
      "status-warning": "#C59A4E",
      "status-danger": "#E35040",
      "status-info": "#7B8C96",
      "activity-active": "#22c55e",
      "activity-idle": "#4A4238",
      "activity-working": "#22c55e",
      "activity-waiting": "#fbbf24",
      "terminal-selection": "#2A2018",
      "terminal-red": "#B05C4E",
      "terminal-green": "#4E8C6A",
      "terminal-yellow": "#B08A4A",
      "terminal-blue": "#5B7E96",
      "terminal-magenta": "#8B6A8A",
      "terminal-cyan": "#5E8A8A",
      "terminal-bright-red": "#D07060",
      "terminal-bright-green": "#6AAE88",
      "terminal-bright-yellow": "#D4A96A",
      "terminal-bright-blue": "#7BAAC4",
      "terminal-bright-magenta": "#B087AE",
      "terminal-bright-cyan": "#7AABAB",
      "terminal-bright-white": "#E6E2DC",
      "syntax-comment": "#6B767C",
      "syntax-punctuation": "#A8B4BB",
      "syntax-number": "#BE7055",
      "syntax-string": "#C88C45",
      "syntax-operator": "#7BAAC4",
      "syntax-keyword": "#B872A5",
      "syntax-function": "#6898B5",
      "syntax-link": "#6BA4C5",
      "syntax-quote": "#9BA8B0",
      "syntax-chip": "#5AAA8A",
      "focus-ring": "rgba(255, 255, 255, 0.18)",
      "category-blue": "oklch(0.7 0.13 250)",
      "category-purple": "oklch(0.7 0.13 310)",
      "category-cyan": "oklch(0.72 0.11 215)",
      "category-green": "oklch(0.7 0.13 145)",
      "category-amber": "oklch(0.73 0.14 75)",
      "category-orange": "oklch(0.7 0.14 45)",
      "category-teal": "oklch(0.7 0.11 185)",
      "category-indigo": "oklch(0.7 0.13 275)",
      "category-rose": "oklch(0.7 0.14 5)",
      "category-pink": "oklch(0.72 0.13 340)",
      "category-violet": "oklch(0.7 0.13 295)",
      "category-slate": "oklch(0.65 0.04 240)",
    }),
  },
  {
    id: "arashiyama",
    name: "Arashiyama",
    type: "dark",
    builtin: true,
    tokens: createCanopyTokens("dark", {
      "surface-canvas": "#25211E",
      "surface-sidebar": "#211D1A",
      "surface-panel": "#2A2622",
      "surface-panel-elevated": "#342F2A",
      "surface-grid": "#1E1A18",
      "text-primary": "#F2EBD9",
      "text-secondary": "color-mix(in oklab, #F2EBD9 65%, #25211E)",
      "text-muted": "#9E978C",
      "text-inverse": "#25211E",
      "border-default": "#3A342F",
      "accent-primary": "#3F9366",
      "accent-foreground": "#08140e",
      "status-success": "#5A9E6F",
      "status-warning": "#C89A3A",
      "status-danger": "#C44040",
      "status-info": "#6B9CB8",
      "activity-active": "#3F9366",
      "activity-idle": "#5C5248",
      "activity-working": "#C89A3A",
      "activity-waiting": "#6B9CB8",
      "terminal-selection": "#3D2418",
      "terminal-red": "#C7504A",
      "terminal-green": "#8C9C5B",
      "terminal-yellow": "#D9A043",
      "terminal-blue": "#5B8CA6",
      "terminal-magenta": "#A9627D",
      "terminal-cyan": "#6E9C91",
      "terminal-bright-red": "#ED6D46",
      "terminal-bright-green": "#A5C767",
      "terminal-bright-yellow": "#F2BE42",
      "terminal-bright-blue": "#6BA3CD",
      "terminal-bright-magenta": "#D87B9E",
      "terminal-bright-cyan": "#8BC7BD",
      "terminal-bright-white": "#E8DFD5",
      "syntax-comment": "#928981",
      "syntax-punctuation": "#D4CAB8",
      "syntax-number": "#ED6A32",
      "syntax-string": "#F7C242",
      "syntax-operator": "#C4AA84",
      "syntax-keyword": "#E55A63",
      "syntax-function": "#A6BA65",
      "syntax-link": "#6EA89A",
      "syntax-quote": "#A09880",
      "syntax-chip": "#7DB5A8",
      "focus-ring": "rgba(255, 240, 220, 0.18)",
    }),
  },
  {
    id: "galapagos",
    name: "Galápagos",
    type: "dark",
    builtin: true,
    tokens: createCanopyTokens("dark", {
      "surface-canvas": "#131A1C",
      "surface-sidebar": "#0F1416",
      "surface-panel": "#171F22",
      "surface-panel-elevated": "#1C2528",
      "surface-grid": "#0C1113",
      "text-primary": "#CAD6D9",
      "text-secondary": "color-mix(in oklab, #CAD6D9 65%, #131A1C)",
      "text-muted": "#7D9194",
      "text-inverse": "#131A1C",
      "border-default": "#1F2D30",
      "accent-primary": "#3F9366",
      "status-success": "#5F8B6D",
      "status-warning": "#C59A4E",
      "status-danger": "#D15E4C",
      "status-info": "#7B8C96",
      "activity-active": "#22c55e",
      "activity-idle": "#3A4E52",
      "activity-working": "#22c55e",
      "activity-waiting": "#fbbf24",
      "terminal-selection": "#152425",
      "terminal-red": "#BC6C6C",
      "terminal-green": "#3F9366",
      "terminal-yellow": "#9B8E67",
      "terminal-blue": "#6585A4",
      "terminal-magenta": "#987898",
      "terminal-cyan": "#528B8B",
      "terminal-bright-red": "#C27E7E",
      "terminal-bright-green": "#66B388",
      "terminal-bright-yellow": "#C2B68E",
      "terminal-bright-blue": "#729BBF",
      "terminal-bright-magenta": "#B092B0",
      "terminal-bright-cyan": "#7DA9A9",
      "terminal-bright-white": "#E6EFF2",
      "syntax-comment": "#7D9194",
      "syntax-punctuation": "#6E8690",
      "syntax-number": "#A67C52",
      "syntax-string": "#88A649",
      "syntax-operator": "#8BBFC8",
      "syntax-keyword": "#4ECEC9",
      "syntax-function": "#7AACD6",
      "syntax-link": "#7FA2E3",
      "syntax-quote": "#758F44",
      "syntax-chip": "#C8A055",
      "focus-ring": "rgba(255, 255, 255, 0.18)",
      "category-blue": "oklch(0.7 0.13 250)",
      "category-purple": "oklch(0.7 0.13 310)",
      "category-cyan": "oklch(0.72 0.11 215)",
      "category-green": "oklch(0.7 0.13 145)",
      "category-amber": "oklch(0.73 0.14 75)",
      "category-orange": "oklch(0.7 0.14 45)",
      "category-teal": "oklch(0.7 0.11 185)",
      "category-indigo": "oklch(0.7 0.13 275)",
      "category-rose": "oklch(0.7 0.14 5)",
      "category-pink": "oklch(0.72 0.13 340)",
      "category-violet": "oklch(0.7 0.13 295)",
      "category-slate": "oklch(0.65 0.04 240)",
    }),
  },
  {
    id: "svalbard",
    name: "Svalbard",
    type: "light",
    builtin: true,
    tokens: createCanopyTokens("light", {
      "surface-canvas": "#E8EEF2",
      "surface-sidebar": "#D9E2E8",
      "surface-panel": "#F2F6F8",
      "surface-panel-elevated": "#FFFFFF",
      "surface-grid": "#CDD7DF",
      "text-primary": "#253545",
      "text-secondary": "color-mix(in oklab, #253545 72%, #E8EEF2)",
      "text-muted": "#5A6B7A",
      "text-inverse": "#10161B",
      "border-default": "#BCC8D2",
      "accent-primary": "#3F9366",
      "accent-foreground": "#08140E",
      "status-success": "#2F6F4F",
      "status-warning": "#7A4D12",
      "status-danger": "#8C3A33",
      "status-info": "#4A5E6E",
      "activity-active": "#22c55e",
      "activity-idle": "#7A8E9E",
      "activity-working": "#22c55e",
      "activity-waiting": "#B86000",
      "terminal-selection": "#C8DDE8",
      "terminal-red": "#CF222E",
      "terminal-green": "#0F6A31",
      "terminal-yellow": "#82500C",
      "terminal-blue": "#0550AE",
      "terminal-magenta": "#6930C3",
      "terminal-cyan": "#0A6678",
      "terminal-bright-red": "#A0111F",
      "terminal-bright-green": "#1A7C36",
      "terminal-bright-yellow": "#4D2D00",
      "terminal-bright-blue": "#004EC7",
      "terminal-bright-magenta": "#7525CC",
      "terminal-bright-cyan": "#0C7285",
      "terminal-bright-white": "#1B2838",
      "syntax-comment": "#5C6C7A",
      "syntax-punctuation": "#2E3E4E",
      "syntax-number": "#8B4A00",
      "syntax-string": "#2D6A4F",
      "syntax-operator": "#1F6A75",
      "syntax-keyword": "#7A3B18",
      "syntax-function": "#836500",
      "syntax-link": "#1A5E9C",
      "syntax-quote": "#5A6B7A",
      "syntax-chip": "#1F6A75",
      "category-blue": "oklch(0.62 0.14 250)",
      "category-purple": "oklch(0.64 0.14 310)",
      "category-cyan": "oklch(0.65 0.12 215)",
      "category-green": "oklch(0.63 0.13 145)",
      "category-amber": "oklch(0.68 0.14 75)",
      "category-orange": "oklch(0.66 0.15 45)",
      "category-teal": "oklch(0.64 0.11 185)",
      "category-indigo": "oklch(0.61 0.13 275)",
      "category-rose": "oklch(0.63 0.14 5)",
      "category-pink": "oklch(0.66 0.13 340)",
      "category-violet": "oklch(0.63 0.13 295)",
      "category-slate": "oklch(0.58 0.04 240)",
    }),
  },
];

export const APP_THEME_PREVIEW_KEYS = {
  background: "surface-canvas",
  sidebar: "surface-sidebar",
  accent: "accent-primary",
  success: "status-success",
  warning: "status-warning",
  danger: "status-danger",
  text: "text-primary",
  border: "border-default",
  panel: "surface-panel",
} as const satisfies Record<string, AppThemeTokenKey>;

export const LEGACY_THEME_TOKEN_ALIASES: Record<string, AppThemeTokenKey> = {
  "canopy-bg": "surface-canvas",
  "canopy-sidebar": "surface-sidebar",
  "canopy-border": "border-default",
  "canopy-text": "text-primary",
  "canopy-accent": "accent-primary",
  surface: "surface-panel",
  "surface-highlight": "surface-panel-elevated",
  "grid-bg": "surface-grid",
  "canopy-focus": "focus-ring",
  "status-success": "status-success",
  "status-warning": "status-warning",
  "status-error": "status-danger",
  "status-info": "status-info",
  "state-active": "activity-active",
  "state-idle": "activity-idle",
  "state-working": "activity-working",
  "state-waiting": "activity-waiting",
  "server-running": "status-success",
  "server-stopped": "activity-idle",
  "server-starting": "status-warning",
  "server-error": "status-danger",
  "terminal-selection": "terminal-selection",
};

export function hexToRgbTriplet(hex: string): string {
  const clean = hex.replace("#", "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : clean;
  const red = parseInt(expanded.slice(0, 2), 16);
  const green = parseInt(expanded.slice(2, 4), 16);
  const blue = parseInt(expanded.slice(4, 6), 16);

  if (Number.isNaN(red) || Number.isNaN(green) || Number.isNaN(blue)) {
    return "0, 0, 0";
  }

  return `${red}, ${green}, ${blue}`;
}

export const LEGACY_APP_SCHEME_ID_ALIASES: Record<string, string> = {
  canopy: "daintree",
  "canopy-slate": "daintree",
};

export function getAppThemeById(
  id: string,
  customSchemes: AppColorScheme[] = []
): AppColorScheme | undefined {
  const resolvedId = LEGACY_APP_SCHEME_ID_ALIASES[id] ?? id;
  return [...BUILT_IN_APP_SCHEMES, ...customSchemes].find((scheme) => scheme.id === resolvedId);
}

export function getBuiltInAppSchemeForType(type: "dark" | "light"): AppColorScheme {
  return (
    BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === type) ??
    (type === "light" ? INTERNAL_LIGHT_FALLBACK_SCHEME : BUILT_IN_APP_SCHEMES[0])
  );
}

export function resolveAppTheme(id: string, customSchemes: AppColorScheme[] = []): AppColorScheme {
  return getAppThemeById(id, customSchemes) ?? BUILT_IN_APP_SCHEMES[0];
}

export function getAppThemeCssVariables(scheme: AppColorScheme): Record<string, string> {
  const entries = Object.entries(scheme.tokens).map(([token, value]) => [
    `--theme-${token}`,
    value,
  ]);
  const variables = Object.fromEntries(entries);
  const accent = scheme.tokens["accent-primary"];

  variables["--theme-color-mode"] = scheme.type;
  variables["--theme-accent-rgb"] = accent.startsWith("#") ? hexToRgbTriplet(accent) : "0, 0, 0";

  for (const [legacyToken, themeToken] of Object.entries(LEGACY_THEME_TOKEN_ALIASES)) {
    variables[`--theme-legacy-${legacyToken}`] = scheme.tokens[themeToken];
  }

  return variables;
}

export function normalizeAppThemeTokens(
  maybeTokens: Record<string, unknown>,
  fallback: AppColorSchemeTokens = BUILT_IN_APP_SCHEMES[0].tokens
): AppColorSchemeTokens {
  const normalized = { ...fallback };

  for (const token of Object.keys(fallback) as AppThemeTokenKey[]) {
    const value = maybeTokens[token];
    if (typeof value === "string" && value.trim()) {
      normalized[token] = value;
    }
  }

  for (const [legacyToken, themeToken] of Object.entries(LEGACY_THEME_TOKEN_ALIASES)) {
    const value = maybeTokens[legacyToken];
    if (typeof value === "string" && value.trim()) {
      normalized[themeToken] = value;
    }
  }

  return normalized;
}

function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

function inferThemeTypeFromHex(hex: string): "dark" | "light" {
  const clean = hex.replace("#", "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : clean;
  const red = parseInt(expanded.slice(0, 2), 16);
  const green = parseInt(expanded.slice(2, 4), 16);
  const blue = parseInt(expanded.slice(4, 6), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance < 0.5 ? "dark" : "light";
}

export function inferAppThemeTypeFromTokens(
  maybeTokens: Record<string, unknown>
): "dark" | "light" | undefined {
  const surfaceToken = maybeTokens["surface-canvas"] ?? maybeTokens["canopy-bg"];
  if (typeof surfaceToken === "string" && isHexColor(surfaceToken.trim())) {
    return inferThemeTypeFromHex(surfaceToken.trim());
  }
  return undefined;
}

function hexToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : clean;
  const red = hexToLinear(parseInt(expanded.slice(0, 2), 16));
  const green = hexToLinear(parseInt(expanded.slice(2, 4), 16));
  const blue = hexToLinear(parseInt(expanded.slice(4, 6), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function pickReadableForeground(background: string, candidates: string[]): string {
  const validCandidates = candidates.filter(isHexColor);
  if (!isHexColor(background) || validCandidates.length === 0) {
    return "#000000";
  }

  let bestCandidate = validCandidates[0];
  let bestContrast = contrastRatio(bestCandidate, background);

  for (const candidate of validCandidates.slice(1)) {
    const candidateContrast = contrastRatio(candidate, background);
    if (candidateContrast > bestContrast) {
      bestCandidate = candidate;
      bestContrast = candidateContrast;
    }
  }

  return bestCandidate;
}

const CRITICAL_CONTRAST_PAIRS: Array<{
  foreground: AppThemeTokenKey;
  background: AppThemeTokenKey;
  minimum: number;
}> = [
  { foreground: "text-primary", background: "surface-canvas", minimum: 4.5 },
  { foreground: "text-primary", background: "surface-panel", minimum: 4.5 },
  { foreground: "text-primary", background: "surface-panel-elevated", minimum: 4.5 },
  { foreground: "text-primary", background: "surface-sidebar", minimum: 4.5 },
  { foreground: "accent-foreground", background: "accent-primary", minimum: 4.5 },
];

export function getAppThemeWarnings(scheme: AppColorScheme): AppThemeValidationWarning[] {
  const warnings: AppThemeValidationWarning[] = [];

  for (const pair of CRITICAL_CONTRAST_PAIRS) {
    const fg = scheme.tokens[pair.foreground];
    const bg = scheme.tokens[pair.background];

    if (!isHexColor(fg) || !isHexColor(bg)) {
      continue;
    }

    const ratio = contrastRatio(fg, bg);
    if (ratio < pair.minimum) {
      warnings.push({
        message: `${pair.foreground} on ${pair.background} is ${ratio.toFixed(2)}:1; target is ${pair.minimum.toFixed(1)}:1`,
      });
    }
  }

  return warnings;
}

export function normalizeAppColorScheme(
  maybeScheme: Partial<Omit<AppColorScheme, "tokens">> & { tokens?: Record<string, unknown> },
  fallback: AppColorScheme = BUILT_IN_APP_SCHEMES[0]
): AppColorScheme {
  const explicitType =
    maybeScheme.type === "light"
      ? "light"
      : maybeScheme.type === "dark"
        ? "dark"
        : inferAppThemeTypeFromTokens(
            (maybeScheme.tokens as Record<string, unknown> | undefined) ?? {}
          );
  const resolvedType = explicitType ?? fallback.type;
  const baseScheme =
    fallback.type === resolvedType ? fallback : getBuiltInAppSchemeForType(resolvedType);

  const rawTokens = (maybeScheme.tokens as Record<string, unknown> | undefined) ?? {};
  const normalizedTokens = normalizeAppThemeTokens(rawTokens, baseScheme.tokens);
  if (
    typeof rawTokens["accent-foreground"] !== "string" &&
    typeof normalizedTokens["accent-primary"] === "string"
  ) {
    normalizedTokens["accent-foreground"] = pickReadableForeground(
      normalizedTokens["accent-primary"],
      [normalizedTokens["text-inverse"], normalizedTokens["text-primary"], "#ffffff", "#000000"]
    );
  }

  return {
    id:
      typeof maybeScheme.id === "string" && maybeScheme.id.trim() ? maybeScheme.id : baseScheme.id,
    name:
      typeof maybeScheme.name === "string" && maybeScheme.name.trim()
        ? maybeScheme.name
        : baseScheme.name,
    type: resolvedType,
    builtin: false,
    tokens: normalizedTokens,
  };
}
