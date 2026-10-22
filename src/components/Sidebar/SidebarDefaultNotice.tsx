import { Puzzle } from "lucide-react";
import type { PluginSidebarHostedViewDescriptor } from "@shared/types/plugin";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";

/**
 * The one question a project gets when a plugin's sidebar view becomes what it
 * opens on: keep it, or go back to the built-in view. Asked once per view and
 * remembered, so a project that answered is never asked again.
 *
 * A `title` and no `description`, so it draws as one row. Not modal, and in the
 * host's layer rather than inside the plugin's own box. Equal weight on both
 * answers: each is a click from being reversed, in the switcher or in project
 * plugin settings, so promoting either one is picking for the user.
 */
export function SidebarDefaultNotice({
  view,
  builtInTitle,
  onKeep,
  onShowBuiltIn,
}: {
  view: PluginSidebarHostedViewDescriptor;
  builtInTitle: string;
  onKeep: () => void;
  onShowBuiltIn: () => void;
}) {
  return (
    <InlineStatusBanner
      icon={Puzzle}
      title={`${view.pluginName} set up this project's sidebar: ${view.title}`}
      severity="neutral"
      role="status"
      actions={[
        { id: "keep", label: "Keep", variant: "primary", onClick: onKeep },
        {
          id: "show-built-in",
          label: `Show ${builtInTitle.toLowerCase()}`,
          variant: "primary",
          onClick: onShowBuiltIn,
        },
      ]}
    />
  );
}
