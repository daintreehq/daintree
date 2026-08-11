import { Globe, MonitorPlay, SquareTerminal } from "lucide-react";
import { FolderTree } from "@/components/icons";
import type { ComponentType } from "react";
import type { BuiltInActionId } from "@shared/types/actions";
import type { LauncherPanelButtonId } from "@shared/types/toolbar";

export interface LauncherPanelItem {
  id: LauncherPanelButtonId;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Drives the row's shortcut hint and, for every item but the file browser, its activation. */
  actionId: BuiltInActionId;
}

/**
 * The four panels that own a toolbar button, with the metadata the toolbar's
 * overflow menu needs to render one: a label, a glyph, and the action behind it.
 *
 * The launcher itself no longer reads this — it offers the full dynamic panel
 * inventory from `panelKindRegistry` (see `dockLaunchItems.ts`). What a toolbar
 * button needs is narrower than what a panel kind carries, which is why the list
 * stays fixed: `review`, `file` and `diff` have no toolbar button id at all.
 *
 * Order matches `LAUNCHER_PANEL_BUTTON_IDS`, which the store and Settings also
 * read, so no surface can disagree about what the section holds.
 */
export const LAUNCHER_PANEL_ITEMS: readonly LauncherPanelItem[] = [
  { id: "terminal", label: "Terminal", icon: SquareTerminal, actionId: "agent.terminal" },
  {
    id: "file-browser",
    label: "Browse files",
    icon: FolderTree,
    actionId: "worktree.openFileBrowserPanel",
  },
  { id: "browser", label: "Browser", icon: Globe, actionId: "agent.browser" },
  { id: "dev-server", label: "Dev preview", icon: MonitorPlay, actionId: "devServer.start" },
];
