/**
 * Host-defined props contract for the toolbar stats dropdown view slot
 * (`ForgeProviderSlots.statsDropdown`). The host owns the button, badge,
 * dropdown shell, freshness footer, and rate-limit indicator; the active forge
 * plugin contributes the dropdown CONTENT (issue/PR/commit lists plus their
 * filter UI) through `registerBuiltinView`, typed against this contract.
 */
export type ForgeStatsDropdownKind = "issues" | "prs" | "commits";

export interface ForgeStatsDropdownProps {
  kind: ForgeStatsDropdownKind;
  /** Absolute project path — the `cwd` for all forge IPC the view makes. */
  projectPath: string;
  /** Canonical resolved provider id (`{pluginId}.{contributionId}`). */
  providerId: string;
  /**
   * Whether the dropdown is currently visible. The host keeps the view
   * mounted across open/close (Activity-hidden), so plugins use the
   * `true → false` transition to reset transient UI (e.g. search queries).
   */
  open: boolean;
  /** Commits view: active worktree path override (falls back to projectPath). */
  worktreePath?: string;
  /** Commits view: active worktree branch. */
  branch?: string;
  /** Last known count for skeleton sizing. */
  initialCount?: number | null;
  /** Close the dropdown (host restores focus to the trigger). */
  onClose: () => void;
  /**
   * Called when an open first page was just read from the forge, so the host
   * can read back the total the provider recorded and converge the badge
   * without waiting for the next poll.
   */
  onFreshFetch?: () => void;
  /**
   * Reports the open list's total (or its loaded length when it has none, with
   * whether more pages exist), so the badge can bind to what the dropdown
   * actually shows (issues #9693/#9741). `observedAt` is when the read was
   * requested, so the badge ranks it against count reads by when each was made
   * rather than when it arrived (#16866).
   */
  onCountUpdate?: (count: number, hasMore: boolean, observedAt?: number) => void;
}

/**
 * The box every stats dropdown body draws: 450×500, or as tall as the space
 * under the pill allows. `FixedDropdown` publishes that space as
 * `--fixed-dropdown-available-height`; a body that ignored it pushed its footer
 * off a short window. Loaded, loading and connection-gated bodies all use it,
 * so the panel never changes size between states.
 */
export const FORGE_DROPDOWN_PANEL_SIZE =
  "w-[450px] h-[min(500px,var(--fixed-dropdown-available-height,500px))]";
