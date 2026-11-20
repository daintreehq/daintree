import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext, ActionId } from "@shared/types/actions";
import { z } from "zod";
import { usePanelStore } from "@/store/panelStore";
import { usePanelDialogStore, selectTopDialogPanelId } from "@/store/panelDialogStore";
import { sendDiffCommand, type DiffCommand } from "@/panels/diff/diffCommands";

const argsSchema = z
  .object({
    panelId: z.string().optional().describe("Diff viewer to act on; defaults to the focused one"),
  })
  .optional();

/**
 * The diff viewer a command acts on: the presented dialog when one is open (the
 * Review Hub drills into a per-file diff without moving the grid's focus),
 * otherwise the focused grid panel. Null unless that panel is a diff viewer.
 */
function resolveDiffPanelId(explicit?: string): string | null {
  const id =
    explicit ??
    selectTopDialogPanelId(usePanelDialogStore.getState()) ??
    usePanelStore.getState().focusedId;
  if (!id) return null;
  return usePanelStore.getState().getTerminal(id)?.kind === "diff" ? id : null;
}

interface DiffActionSpec {
  id: ActionId;
  command: DiffCommand;
  title: string;
  description: string;
  /** The palette's subtitle, where the agent-facing description runs past one sentence. */
  paletteDescription?: string;
  keywords?: string[];
}

const DIFF_ACTIONS: readonly DiffActionSpec[] = [
  {
    id: "diff.nextChange",
    command: "nextChange",
    title: "Next hunk",
    description:
      "Scroll the diff viewer to the next hunk, or the next change in rendered Markdown. Past the file's last one it opens the next file in the list on its first hunk.",
    paletteDescription: "Scroll to the next hunk, on into the next file",
    keywords: ["next change"],
  },
  {
    id: "diff.previousChange",
    command: "previousChange",
    title: "Previous hunk",
    description:
      "Scroll the diff viewer to the previous hunk, or the previous change in rendered Markdown. Before the file's first one it opens the previous file in the list on its last hunk.",
    paletteDescription: "Scroll to the previous hunk, back into the previous file",
    keywords: ["previous change"],
  },
  {
    id: "diff.nextFile",
    command: "nextFile",
    title: "Next file in diff",
    description:
      "Open the next file of the diff viewer's change set, in the order its file list shows.",
  },
  {
    id: "diff.previousFile",
    command: "previousFile",
    title: "Previous file in diff",
    description:
      "Open the previous file of the diff viewer's change set, in the order its file list shows.",
  },
  {
    id: "diff.toggleViewed",
    command: "toggleViewed",
    title: "Toggle viewed",
    description:
      "Mark the diff viewer's open file viewed, or clear the mark. Pressed as a key on a row of its file list, it marks that row's file instead.",
    paletteDescription: "Mark the open file viewed, or clear the mark",
    keywords: ["mark viewed", "reviewed"],
  },
];

export function registerDiffActions(actions: ActionRegistry, _callbacks: ActionCallbacks): void {
  for (const spec of DIFF_ACTIONS) {
    actions.set(spec.id, () => ({
      id: spec.id,
      title: spec.title,
      description: spec.description,
      ...(spec.paletteDescription ? { paletteDescription: spec.paletteDescription } : {}),
      category: "git",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      ...(spec.keywords ? { keywords: spec.keywords } : {}),
      palette: {
        mode: "requireContext",
        isReady: () => resolveDiffPanelId() !== null,
        reason: "Focus a diff viewer first",
      },
      argsSchema,
      run: async (args: unknown, ctx: ActionContext) => {
        const explicit = argsSchema.parse(args)?.panelId;
        const id = resolveDiffPanelId(explicit);
        if (!id) {
          throw new Error(
            explicit ? `Panel ${explicit} isn't a diff viewer` : "No diff viewer is focused"
          );
        }
        const delivered = sendDiffCommand({
          id,
          command: spec.command,
          fromKeyboard: ctx.dispatchSource === "keybinding",
        });
        if (!delivered) throw new Error("That diff viewer isn't showing");
      },
    }));
  }
}
