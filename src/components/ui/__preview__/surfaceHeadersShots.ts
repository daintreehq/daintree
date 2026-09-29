/**
 * The states the surface-headers harness renders, one per page load.
 *
 * Pure data with no runtime imports, so the preview entry and the Playwright spec
 * read the same table: the spec needs each shot's viewport and the text that
 * proves the real component mounted, and the page needs its caption.
 */

export type ShotInteraction =
  | "none"
  /** Click the collapsed artifact trigger so the overlay's header is on screen. */
  | "open-artifacts"
  /** Hover the theme browser hero's close (X) button. */
  | "hover-theme-close";

export interface ShotSpec {
  /** What the frame's caption says, and what a reviewer is looking at. */
  label: string;
  viewport: { width: number; height: number };
  /**
   * What the spec photographs: the frame itself, or a CSS selector for a surface
   * the component portals out of the frame (full-window views and dialogs).
   */
  target: "frame" | string;
  /** Strings that must be on screen before a PNG is written. */
  expectText: string[];
  /**
   * What the PAGE waits for before it sets `data-ready` — the proof the real
   * component mounted. Defaults to `expectText`; differs only where the spec's
   * interaction is what brings `expectText` on screen.
   */
  readyText?: string[];
  interaction: ShotInteraction;
}

export const SHOTS = {
  "pane-unfocused": {
    label: "Reference — PanelHeader grid pane + TerminalScratchpad, pane unfocused",
    viewport: { width: 920, height: 460 },
    target: "frame",
    expectText: ["auth-refresh", "Scratchpad", "Temporary"],
    interaction: "none",
  },
  "pane-focused": {
    label: "Reference — PanelHeader grid pane + TerminalScratchpad, pane focused",
    viewport: { width: 920, height: 460 },
    target: "frame",
    expectText: ["auth-refresh", "Scratchpad", "Temporary"],
    interaction: "none",
  },
  "assistant-unfocused": {
    label: "Assistant column — HelpPanelHeader unfocused, session strip, HelpPanelFooter",
    viewport: { width: 460, height: 600 },
    target: "frame",
    expectText: ["Daintree Assistant", "Session 1", "Session 2"],
    interaction: "none",
  },
  "assistant-focused": {
    label: "Assistant column — HelpPanelHeader focused, session strip, HelpPanelFooter",
    viewport: { width: 460, height: 600 },
    target: "frame",
    expectText: ["Daintree Assistant", "Session 1", "Session 2"],
    interaction: "none",
  },
  "artifact-overlay-single": {
    label: "ArtifactOverlay — one artifact, no bulk-action bar",
    viewport: { width: 820, height: 600 },
    target: "frame",
    expectText: ["Artifacts", "Clear"],
    readyText: ["1 artifact"],
    interaction: "open-artifacts",
  },
  "artifact-overlay-bulk": {
    label: "ArtifactOverlay — several artifacts, with the bulk-action bar",
    viewport: { width: 820, height: 600 },
    target: "frame",
    expectText: ["Artifacts", "Clear", "Copy all"],
    readyText: ["artifacts"],
    interaction: "open-artifacts",
  },
  "theme-browser": {
    label: "ThemeBrowser — hero and filter row",
    viewport: { width: 600, height: 420 },
    target: "frame",
    expectText: ["Dark", "Light"],
    interaction: "none",
  },
  "theme-browser-close-hover": {
    label: "ThemeBrowser — hero close (X) hovered",
    viewport: { width: 600, height: 420 },
    target: "frame",
    expectText: ["Dark", "Light"],
    interaction: "hover-theme-close",
  },
  "plugin-manager": {
    label: "PluginManagerView — full-window view header",
    viewport: { width: 1100, height: 320 },
    target: '[data-testid="plugin-manager-view"]',
    expectText: ["Plugins", "Install plugin"],
    interaction: "none",
  },
  "cross-worktree-diff": {
    label: "CrossWorktreeDiff — AppDialog header and the selector row",
    viewport: { width: 1180, height: 520 },
    target: '[role="dialog"]',
    expectText: ["Compare worktrees", "Base", "Compare"],
    interaction: "none",
  },
  "review-hub-grid": {
    label: 'ReviewHubContent — location="grid", its own header row',
    viewport: { width: 860, height: 520 },
    target: "frame",
    expectText: ["Review & commit", "feature/auth-refresh", "Working tree"],
    interaction: "none",
  },
  "review-hub-dialog": {
    label: 'ReviewHubContent — location="dialog", hosted by the real PanelDialogHost',
    viewport: { width: 1180, height: 620 },
    target: '[data-testid="panel-dialog"]',
    expectText: ["feature/auth-refresh", "Working tree", "Open as panel"],
    interaction: "none",
  },
  footers: {
    label: "Footers — FileBrowserHiddenStrip, ZoomableImage, TerminalScratchpad, HelpPanelFooter",
    viewport: { width: 520, height: 1000 },
    target: "frame",
    expectText: ["dotfiles hidden", "Fit to screen", "Temporary", "1600 × 900"],
    interaction: "none",
  },
  diagnostics: {
    label: "Reference — DiagnosticsPanel header",
    viewport: { width: 620, height: 420 },
    target: "frame",
    expectText: ["Session diagnostics", "localhost:5173"],
    interaction: "none",
  },
} satisfies Record<string, ShotSpec>;

export type ShotName = keyof typeof SHOTS;

export function isShotName(value: string): value is ShotName {
  return Object.prototype.hasOwnProperty.call(SHOTS, value);
}

export const SHOT_NAMES: ShotName[] = Object.keys(SHOTS).filter(isShotName);
