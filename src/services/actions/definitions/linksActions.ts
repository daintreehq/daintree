import type { ActionRegistry } from "../actionTypes";
import { openLinksLauncher } from "@/store/linksLauncherStore";

/** The toolbar's links launcher, reachable from the palette as well as its button (#17249, #17251, #17253). */
export function registerLinksActions(actions: ActionRegistry): void {
  actions.set("links.open", () => ({
    id: "links.open",
    title: "Open links",
    description:
      "Show this project's links, your own links, the active worktree's pull request and its failing or running checks, and dev servers across worktrees beside the toolbar.",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    // A view's own popover: an agent has the project link tools for the list itself.
    mcpVisibility: "hidden",
    nonRepeatable: true,
    keywords: [
      "links",
      "bookmarks",
      "urls",
      "staging",
      "production",
      "dashboard",
      "dev",
      "server",
      "preview",
      "ports",
      "pull request",
      "pr",
      "checks",
      "ci",
    ],
    run: async () => {
      openLinksLauncher();
    },
  }));
}
