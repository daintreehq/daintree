import type { ActionRegistry } from "../actionTypes";
import { openLinksLauncher } from "@/store/linksLauncherStore";

/** The toolbar's links launcher, reachable from the palette as well as its button (#17249). */
export function registerLinksActions(actions: ActionRegistry): void {
  actions.set("links.open", () => ({
    id: "links.open",
    title: "Open links",
    description:
      "Show the links saved with this project and your own links in a list beside the toolbar.",
    category: "ui",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    // A view's own popover: an agent has the project link tools for the list itself.
    mcpVisibility: "hidden",
    nonRepeatable: true,
    keywords: ["links", "bookmarks", "urls", "staging", "production", "dashboard"],
    run: async () => {
      openLinksLauncher();
    },
  }));
}
