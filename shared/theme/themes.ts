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
  const dark = type === "dark";
  const lightInk = tokens["text-primary"];
  const overlayTone = dark ? "#ffffff" : lightInk;
  const accentSoft =
    tokens["accent-soft"] ?? withAlpha(tokens["accent-primary"], dark ? 0.18 : 0.12);
  const accentMuted =
    tokens["accent-muted"] ?? withAlpha(tokens["accent-primary"], dark ? 0.3 : 0.2);

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
    "border-subtle": tokens["border-subtle"] ?? withAlpha(overlayTone, dark ? 0.08 : 0.12),
    "border-strong": tokens["border-strong"] ?? withAlpha(overlayTone, dark ? 0.14 : 0.2),
    "border-divider": tokens["border-divider"] ?? withAlpha(overlayTone, dark ? 0.05 : 0.08),
    "accent-foreground": tokens["accent-foreground"] ?? tokens["text-inverse"],
    "accent-soft": accentSoft,
    "accent-muted": accentMuted,
    "focus-ring": tokens["focus-ring"] ?? withAlpha(overlayTone, dark ? 0.18 : 0.2),
    "overlay-subtle": tokens["overlay-subtle"] ?? withAlpha(overlayTone, dark ? 0.02 : 0.04),
    "overlay-soft": tokens["overlay-soft"] ?? withAlpha(overlayTone, dark ? 0.03 : 0.08),
    "overlay-medium": tokens["overlay-medium"] ?? withAlpha(overlayTone, dark ? 0.04 : 0.12),
    "overlay-strong": tokens["overlay-strong"] ?? withAlpha(overlayTone, dark ? 0.06 : 0.16),
    "overlay-emphasis": tokens["overlay-emphasis"] ?? withAlpha(overlayTone, dark ? 0.1 : 0.2),
    "scrim-soft": tokens["scrim-soft"] ?? (dark ? "rgba(0, 0, 0, 0.2)" : "rgba(0, 0, 0, 0.12)"),
    "scrim-medium":
      tokens["scrim-medium"] ?? (dark ? "rgba(0, 0, 0, 0.45)" : "rgba(0, 0, 0, 0.30)"),
    "scrim-strong":
      tokens["scrim-strong"] ?? (dark ? "rgba(0, 0, 0, 0.62)" : "rgba(0, 0, 0, 0.45)"),
    "terminal-black":
      tokens["terminal-black"] ?? (dark ? tokens["surface-canvas"] : tokens["text-primary"]),
    "terminal-white":
      tokens["terminal-white"] ?? (dark ? tokens["text-primary"] : tokens["surface-canvas"]),
    "terminal-bright-black": tokens["terminal-bright-black"] ?? tokens["activity-idle"],
    ...tokens,
  };
}

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    return `rgba(${hexToRgbTriplet(color)}, ${alpha})`;
  }

  return `color-mix(in oklab, ${color} ${(alpha * 100).toFixed(1)}%, transparent)`;
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
      "surface-canvas": "#F3EFE4",
      "surface-sidebar": "#E6DEC9",
      "surface-panel": "#FFFCF7",
      "surface-panel-elevated": "#FFFFFF",
      "surface-grid": "#EBE4D5",
      "text-primary": "#1B3626",
      "text-secondary": "color-mix(in oklab, #1B3626 74%, #F3EFE4)",
      "text-muted": "#6E746D",
      "text-inverse": "#F3EFE4",
      "border-default": "#C8B89E",
      "overlay-subtle": "rgba(27, 54, 38, 0.06)",
      "accent-primary": "#3F9366",
      "accent-foreground": "#08140e",
      "status-success": "#2A7A4B",
      "status-warning": "#B08800",
      "status-danger": "#A31D27",
      "status-info": "#2B5573",
      "activity-active": "#1D9B5E",
      "activity-idle": "#8b95a1",
      "activity-working": "#1D9B5E",
      "activity-waiting": "#C17F2E",
      "terminal-black": "#1B3626",
      "terminal-white": "#6E746D",
      "terminal-selection": "rgba(43, 85, 115, 0.24)",
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
      "activity-idle": "#73665A",
      "activity-working": "#22c55e",
      "activity-waiting": "#fbbf24",
      "terminal-selection": "#2A2018",
      "terminal-red": "#C4746E",
      "terminal-green": "#7AA87B",
      "terminal-yellow": "#C4A85A",
      "terminal-blue": "#8BA4B0",
      "terminal-magenta": "#9E7AAE",
      "terminal-cyan": "#7AABAB",
      "terminal-bright-red": "#D99080",
      "terminal-bright-green": "#96C496",
      "terminal-bright-yellow": "#D4BC7A",
      "terminal-bright-blue": "#A0C4D6",
      "terminal-bright-magenta": "#C09ACC",
      "terminal-bright-cyan": "#96C4C4",
      "terminal-bright-white": "#E6E2DC",
      "syntax-comment": "#6B767C",
      "syntax-punctuation": "#A8B4BB",
      "syntax-number": "#C080A0",
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
      "terminal-red": "#D96C6C",
      "terminal-green": "#62A862",
      "terminal-yellow": "#C9A040",
      "terminal-blue": "#5693BF",
      "terminal-magenta": "#B882B0",
      "terminal-cyan": "#4DB8C2",
      "terminal-bright-red": "#C27E7E",
      "terminal-bright-green": "#7CC48A",
      "terminal-bright-yellow": "#C2B68E",
      "terminal-bright-blue": "#729BBF",
      "terminal-bright-magenta": "#B092B0",
      "terminal-bright-cyan": "#89C8CC",
      "terminal-bright-white": "#E6EFF2",
      "syntax-comment": "#617B7F",
      "syntax-punctuation": "#A0AFBA",
      "syntax-number": "#D4895A",
      "syntax-string": "#88A649",
      "syntax-operator": "#6CB8CC",
      "syntax-keyword": "#BB9AF7",
      "syntax-function": "#7AACD6",
      "syntax-link": "#7FA2E3",
      "syntax-quote": "#758F44",
      "syntax-chip": "#D4A853",
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
      "surface-canvas": "#DFEAF1",
      "surface-sidebar": "#C8D7E3",
      "surface-panel": "#EFF5F9",
      "surface-panel-elevated": "#FFFFFF",
      "surface-grid": "#B8C8D6",
      "text-primary": "#253545",
      "text-secondary": "color-mix(in oklab, #253545 72%, #DFEAF1)",
      "text-muted": "#5A6B7A",
      "text-inverse": "#10161B",
      "border-default": "#9EB4C4",
      "border-subtle": "#A8BCC9",
      "border-strong": "#8BA5B8",
      "accent-primary": "#3F9366",
      "accent-foreground": "#08140E",
      "status-success": "#2F6F4F",
      "status-warning": "#7A4D12",
      "status-danger": "#8C3A33",
      "status-info": "#4A5E6E",
      "activity-active": "#006B8F",
      "activity-idle": "#7A8E9E",
      "activity-working": "#006B8F",
      "activity-waiting": "#4C5980",
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
  {
    id: "namib",
    name: "Namib",
    type: "dark",
    builtin: true,
    tokens: createCanopyTokens("dark", {
      "surface-canvas": "#1A1714",
      "surface-sidebar": "#110F0D",
      "surface-panel": "#1F1C19",
      "surface-panel-elevated": "#2B2622",
      "surface-grid": "#0E0D0B",
      "text-primary": "#E5E0D8",
      "text-secondary": "color-mix(in oklab, #E5E0D8 65%, #1A1714)",
      "text-muted": "#8A8278",
      "text-inverse": "#1A1714",
      "border-default": "#302C26",
      "accent-primary": "#3F9366",
      "status-success": "#5A8A70",
      "status-warning": "#B88B40",
      "status-danger": "#C86858",
      "status-info": "#708898",
      "activity-active": "#22c55e",
      "activity-idle": "#3A3328",
      "activity-working": "#22c55e",
      "activity-waiting": "#D4913E",
      "terminal-bright-black": "#5A5347",
      "terminal-selection": "#2A2418",
      "terminal-red": "#C8704E",
      "terminal-green": "#52956A",
      "terminal-yellow": "#C8922A",
      "terminal-blue": "#6A88C8",
      "terminal-magenta": "#B07BB8",
      "terminal-cyan": "#3DADA0",
      "terminal-bright-red": "#E08568",
      "terminal-bright-green": "#6AB580",
      "terminal-bright-yellow": "#E2A45B",
      "terminal-bright-blue": "#85A0D8",
      "terminal-bright-magenta": "#C896D0",
      "terminal-bright-cyan": "#5EC4B8",
      "terminal-bright-white": "#EDE6D6",
      "syntax-comment": "#8A8278",
      "syntax-punctuation": "#C0B8AA",
      "syntax-number": "#7A85C4",
      "syntax-string": "#3F9366",
      "syntax-operator": "#9DBFC8",
      "syntax-keyword": "#48C0B2",
      "syntax-function": "#CFA782",
      "syntax-link": "#5AACCF",
      "syntax-quote": "#A09888",
      "syntax-chip": "#48C0B2",
    }),
  },
  {
    id: "redwoods",
    name: "Redwoods",
    type: "dark",
    builtin: true,
    tokens: createCanopyTokens("dark", {
      "surface-canvas": "#1A1210",
      "surface-sidebar": "#0E0A08",
      "surface-panel": "#211510",
      "surface-panel-elevated": "#2B1D19",
      "surface-grid": "#0F0B09",
      "text-primary": "#D0C8B5",
      "text-secondary": "color-mix(in oklab, #D0C8B5 65%, #1A1210)",
      "text-muted": "#7A6A60",
      "text-inverse": "#1A1210",
      "border-default": "#3A2620",
      "accent-primary": "#4D9E6A",
      "status-success": "#5F8B6D",
      "status-warning": "#C59A4E",
      "status-danger": "#CC5C48",
      "status-info": "#7B8C96",
      "activity-active": "#22c55e",
      "activity-idle": "#52423D",
      "activity-working": "#22c55e",
      "activity-waiting": "#D4AA5E",
      "terminal-selection": "#3A2218",
      "terminal-red": "#C46C5C",
      "terminal-green": "#85A37A",
      "terminal-yellow": "#CFA962",
      "terminal-blue": "#7D9FBB",
      "terminal-magenta": "#A888B0",
      "terminal-cyan": "#79B5AC",
      "terminal-bright-red": "#D4806E",
      "terminal-bright-green": "#9CB890",
      "terminal-bright-yellow": "#DFC078",
      "terminal-bright-blue": "#8FB5CC",
      "terminal-bright-magenta": "#BC9EC0",
      "terminal-bright-cyan": "#8FCCC4",
      "terminal-bright-white": "#D0C8B5",
      "syntax-comment": "#6A8A78",
      "syntax-punctuation": "#C8B8AE",
      "syntax-number": "#C87A52",
      "syntax-string": "#8CC255",
      "syntax-operator": "#7AADA8",
      "syntax-keyword": "#C06258",
      "syntax-function": "#D49A42",
      "syntax-link": "#7AADA8",
      "syntax-quote": "#9BA8A2",
      "syntax-chip": "#6BBAB4",
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
    id: "atacama",
    name: "Atacama",
    type: "light",
    builtin: true,
    tokens: createCanopyTokens("light", {
      "surface-canvas": "#F0F0ED",
      "surface-sidebar": "#E5E4DF",
      "surface-panel": "#F8F8F6",
      "surface-panel-elevated": "#FFFFFF",
      "surface-grid": "#DCDAD4",
      "text-primary": "#3A3431",
      "text-secondary": "color-mix(in oklab, #3A3431 72%, #F0F0ED)",
      "text-muted": "#6B6560",
      "text-inverse": "#10161b",
      "border-default": "#C6C4BF",
      "accent-primary": "#3F9366",
      "accent-foreground": "#08140e",
      "status-success": "#166534",
      "status-warning": "#854D0E",
      "status-danger": "#A11E1E",
      "status-info": "#4B5F74",
      "activity-active": "#277A4A",
      "activity-idle": "#8C8782",
      "activity-working": "#277A4A",
      "activity-waiting": "#926E4F",
      "terminal-selection": "#dce8df",
      "terminal-red": "#CC3333",
      "terminal-green": "#1A7A2E",
      "terminal-yellow": "#9B6C00",
      "terminal-blue": "#2453A8",
      "terminal-magenta": "#7B3FA0",
      "terminal-cyan": "#0F766E",
      "terminal-bright-red": "#B22222",
      "terminal-bright-green": "#15662A",
      "terminal-bright-yellow": "#7D5500",
      "terminal-bright-blue": "#1A3E8C",
      "terminal-bright-magenta": "#5D2D7A",
      "terminal-bright-cyan": "#0A5A53",
      "terminal-bright-white": "#1A1210",
      "syntax-keyword": "#293D71",
      "syntax-string": "#89362B",
      "syntax-function": "#1B5F5C",
      "syntax-comment": "#5E645A",
      "syntax-number": "#804918",
      "syntax-operator": "#4A5D7B",
      "syntax-punctuation": "#6B6560",
      "syntax-link": "#0369a1",
      "syntax-quote": "#5E645A",
      "syntax-chip": "#1B5F5C",
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
    id: "serengeti",
    name: "Serengeti",
    type: "light",
    builtin: true,
    tokens: createCanopyTokens("light", {
      "surface-canvas": "#F4EDE0",
      "surface-sidebar": "#EBE1D0",
      "surface-panel": "#FAF7F2",
      "surface-panel-elevated": "#FFFFFF",
      "surface-grid": "#E4D9CA",
      "text-primary": "#4A3F35",
      "text-secondary": "color-mix(in oklab, #4A3F35 72%, #F4EDE0)",
      "text-muted": "#7A6E63",
      "text-inverse": "#2A2018",
      "border-default": "#D5C8B8",
      "accent-primary": "#3F9366",
      "accent-foreground": "#08140e",
      "status-success": "#2F6F4F",
      "status-warning": "#8F5318",
      "status-danger": "#B03530",
      "status-info": "#4B5F74",
      "activity-active": "#1D9B5E",
      "activity-idle": "#8C8782",
      "activity-working": "#1D9B5E",
      "activity-waiting": "#C17F2E",
      "terminal-selection": "#D5E8D8",
      "terminal-black": "#4A3F35",
      "terminal-bright-white": "#2A2018",
      "terminal-red": "#B03530",
      "terminal-green": "#166534",
      "terminal-yellow": "#8F5318",
      "terminal-blue": "#1D4ED8",
      "terminal-magenta": "#7E22CE",
      "terminal-cyan": "#0F766E",
      "terminal-bright-red": "#B83424",
      "terminal-bright-green": "#166534",
      "terminal-bright-yellow": "#A16207",
      "terminal-bright-blue": "#1D4ED8",
      "terminal-bright-magenta": "#7E22CE",
      "terminal-bright-cyan": "#0E7490",
      "syntax-keyword": "#B03530",
      "syntax-string": "#7A5C77",
      "syntax-function": "#256645",
      "syntax-number": "#8F5318",
      "syntax-comment": "#6E6259",
      "syntax-punctuation": "#4A3F35",
      "syntax-operator": "#0F766E",
      "syntax-link": "#1D4ED8",
      "syntax-quote": "#6E6259",
      "syntax-chip": "#0F766E",
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
    id: "hokkaido",
    name: "Hokkaido",
    type: "light",
    builtin: true,
    tokens: createCanopyTokens("light", {
      "surface-canvas": "#EEF3F7",
      "surface-sidebar": "#DDE6EE",
      "surface-panel": "#FAFCFD",
      "surface-panel-elevated": "#FFFFFF",
      "surface-grid": "#CDD9E3",
      "text-primary": "#2B3540",
      "text-secondary": "color-mix(in oklab, #2B3540 72%, #EEF3F7)",
      "text-muted": "#576C7D",
      "text-inverse": "#0D1A24",
      "border-default": "#B8CAD6",
      "border-subtle": "#D8E5ED",
      "border-divider": "#E5EFF4",
      "border-strong": "#AABFCC",
      "accent-primary": "#3F9366",
      "accent-foreground": "#08140e",
      "status-success": "#2F6F4F",
      "status-warning": "#855519",
      "status-danger": "#943E3A",
      "status-info": "#3A6080",
      "activity-active": "oklch(0.62 0.17 345)",
      "activity-idle": "#8895A5",
      "activity-working": "oklch(0.58 0.16 250)",
      "activity-waiting": "oklch(0.60 0.15 65)",
      "terminal-selection": "#D0E4EE",
      "terminal-red": "#BF616A",
      "terminal-green": "#4A8C5C",
      "terminal-yellow": "#A07A2E",
      "terminal-blue": "#5E81AC",
      "terminal-magenta": "#7B5C8C",
      "terminal-cyan": "#3E7D86",
      "terminal-bright-red": "#D9747D",
      "terminal-bright-green": "#62A872",
      "terminal-bright-yellow": "#C49A3E",
      "terminal-bright-blue": "#7AA0C8",
      "terminal-bright-magenta": "#9A7AAA",
      "terminal-bright-cyan": "#5A9EA8",
      "terminal-bright-white": "#0D1A24",
      "syntax-keyword": "#795293",
      "syntax-string": "#B94665",
      "syntax-function": "#2D7A52",
      "syntax-comment": "#526D7E",
      "syntax-number": "#2E5E82",
      "syntax-operator": "#006A71",
      "syntax-punctuation": "#3A4D5C",
      "syntax-link": "#2E5E82",
      "syntax-quote": "#526D7E",
      "syntax-chip": "#006A71",
      "category-blue": "oklch(0.62 0.14 250)",
      "category-purple": "oklch(0.60 0.14 310)",
      "category-cyan": "oklch(0.62 0.12 215)",
      "category-green": "oklch(0.60 0.13 145)",
      "category-amber": "oklch(0.64 0.14 75)",
      "category-orange": "oklch(0.62 0.15 45)",
      "category-teal": "oklch(0.62 0.11 185)",
      "category-indigo": "oklch(0.59 0.13 275)",
      "category-rose": "oklch(0.60 0.14 5)",
      "category-pink": "oklch(0.62 0.13 340)",
      "category-violet": "oklch(0.60 0.13 295)",
      "category-slate": "oklch(0.55 0.04 240)",
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
