import { FileText, FolderOpen } from "@/components/icons";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { useMenuActionSource } from "@/components/ui/menu-source";
import { actionService } from "@/services/ActionService";
import { reportFileLinkFailure } from "@/services/terminal/FileLinksAddon";

const ICON_CLASS = "w-3.5 h-3.5 mr-2 shrink-0";

interface SelectedFileMenuItemsProps {
  /** Absolute path the selected text resolved to. */
  absolutePath: string;
}

/**
 * "View file" + "Open folder" pair shown when the user right-clicks a selection
 * that resolves to a file path — in the terminal and the composer. Callers own
 * the leading separator so the section can sit flush at the top of the composer
 * menu but below the terminal menu's other items. Dispatch failures (a path
 * outside project roots, a since-deleted file) surface through the same
 * coalesced toast as terminal file links rather than failing silently.
 */
export function SelectedFileMenuItems({ absolutePath }: SelectedFileMenuItemsProps) {
  const source = useMenuActionSource();
  return (
    <>
      <ContextMenuItem
        onSelect={() => {
          void actionService
            .dispatch("file.openPanel", { path: absolutePath }, { source })
            .then((result) => {
              if (!result.ok) {
                reportFileLinkFailure("Failed to open file panel", result.error.details, absolutePath);
              }
            });
        }}
      >
        <FileText className={ICON_CLASS} aria-hidden="true" />
        View file
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => {
          void actionService
            .dispatch("file.showItemInFolder", { path: absolutePath }, { source })
            .then((result) => {
              if (!result.ok) {
                reportFileLinkFailure(
                  "Failed to reveal in file manager",
                  result.error.details,
                  absolutePath
                );
              }
            });
        }}
      >
        <FolderOpen className={ICON_CLASS} aria-hidden="true" />
        Open folder
      </ContextMenuItem>
    </>
  );
}
