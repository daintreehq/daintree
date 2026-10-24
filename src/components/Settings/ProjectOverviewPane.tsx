import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowActions,
} from "@/components/Settings/SettingsGroup";
import { SidebarDefaultViewSection } from "@/components/Settings/SidebarDefaultViewSection";
import { ProjectAgentToolsSection } from "@/components/Settings/ProjectAgentToolsSection";
import { ProjectSurfacesSection } from "@/components/Settings/ProjectSurfacesSection";
import { HiddenLauncherGroupsSection } from "@/components/Settings/HiddenLauncherGroupsSection";
import { ContextProvidersSection } from "@/components/Settings/ContextProvidersSection";
import {
  RowFailure,
  projectPluginStatus,
  useStoreFailure,
} from "@/components/Settings/projectPluginsShared";
import {
  usePluginSettingsGaps,
  type SettingsGaps,
} from "@/components/Settings/usePluginSettingsGaps";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { actionService } from "@/services/ActionService";
import { pluralize } from "@/lib/pluralize";
import type { ProjectPluginInfo } from "@shared/types/plugin";

/** What a plugin's setup row says is missing, in the order it will be fixed. */
function setupGapDescription(gap: SettingsGaps): string | undefined {
  const names = (items: { label: string }[]) => items.map((item) => item.label).join(", ");
  const parts: string[] = [];
  if (gap.missing.length > 0) {
    parts.push(`${names(gap.missing)} ${gap.missing.length === 1 ? "isn't" : "aren't"} set yet`);
  }
  if (gap.brokenPaths.length > 0) {
    parts.push(
      `${names(gap.brokenPaths)} ${gap.brokenPaths.length === 1 ? "no longer exists" : "no longer exist"}`
    );
  }
  if (parts.length === 0) return undefined;
  const sentence = parts.join(", and ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}

/** Why a project plugin in the overview's attention list needs a look. */
function attentionReason(plugin: ProjectPluginInfo): string {
  return plugin.state === "invalid"
    ? "Its manifest isn't valid, so it isn't loaded"
    : "New to this project, so it hasn't run yet. Review what it declares before activating it";
}

/** Everything the project pane needs about the folder as a whole. */
export function ProjectOverviewPane({
  projectPlugins,
  onSelectPlugin,
}: {
  projectPlugins: readonly ProjectPluginInfo[];
  onSelectPlugin: (plugin: ProjectPluginInfo) => void;
}) {
  const trust = useProjectPluginStore((s) => s.trust);
  const deciding = useProjectPluginStore((s) => s.deciding);
  const decide = useProjectPluginStore((s) => s.decide);
  const reload = useProjectPluginStore((s) => s.reload);
  const reloading = useProjectPluginStore((s) => s.reloading);
  const decideFailure = useStoreFailure("decide");
  const reloadFailure = useStoreFailure("reload");

  const enabled = trust?.enabled === true;
  const count = projectPlugins.length;
  // A staged plugin only waits on activation once the folder may run; while it
  // may not, the folder row above already says why nothing runs.
  const needsAttention = projectPlugins.filter(
    (p) => p.state === "invalid" || (enabled && p.state === "staged" && !p.muted)
  );
  const { gaps, recheck } = usePluginSettingsGaps(projectPlugins, enabled);
  const needsSetup = projectPlugins.flatMap((plugin) => {
    const gap = plugin.instanceId ? gaps.get(plugin.instanceId) : undefined;
    if (!gap) return [];
    const first = gap.missing[0] ?? gap.brokenPaths[0];
    return first !== undefined || gap.failed ? [{ plugin, gap, first }] : [];
  });

  const decideError = decideFailure ? (
    <RowFailure
      summary={
        decideFailure.source.decision === "disabled"
          ? "Couldn't turn off this project's plugins"
          : "Couldn't allow this project's plugins"
      }
      detail={decideFailure.detail}
      onRetry={() => void decide(decideFailure.source.decision)}
    />
  ) : undefined;

  return (
    <div className="space-y-8" data-testid="project-plugins-overview">
      <SettingsSection
        title="This project's plugins"
        description={
          count === 0
            ? "None found in .daintree/plugins"
            : `${pluralize(count, "plugin")} in .daintree/plugins`
        }
      >
        <div className="grid gap-3">
          <SettingsGroup>
            {enabled ? (
              <SettingsRow
                label="Allowed to run"
                description="They execute with your account — Daintree doesn't sandbox them. Turning them off unloads every plugin this project ships; to silence just one, pick it above and use its own switch."
                error={decideError}
                control={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void decide("disabled")}
                    loading={deciding === "disabled"}
                  >
                    Turn off project plugins
                  </Button>
                }
              />
            ) : (
              <SettingsRow
                label="Not running"
                layout="stacked"
                description="Nothing in this project's plugins folder is running. Allowing it runs its plugins with your account — Daintree doesn't sandbox them — though any plugins new to this project still wait for you to activate them."
                error={decideError}
                control={
                  <SettingsRowActions>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void decide("session")}
                      loading={deciding === "session"}
                    >
                      Enable for this session
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void decide("enabled")}
                      loading={deciding === "enabled"}
                    >
                      Enable for this project
                    </Button>
                  </SettingsRowActions>
                }
              />
            )}
            <SettingsRow
              label="Plugins folder"
              description="Reads every manifest again and reloads what changed. Same trust and staging rules as opening the project."
              error={
                reloadFailure ? (
                  <RowFailure
                    summary="Couldn't re-scan the plugins folder"
                    detail={reloadFailure.detail}
                    onRetry={() => void reload()}
                  />
                ) : undefined
              }
              control={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void reload()}
                  loading={reloading}
                >
                  <RefreshCw />
                  Re-scan plugins folder
                </Button>
              }
            />
          </SettingsGroup>

          {(needsAttention.length > 0 || needsSetup.length > 0) && (
            <SettingsGroup label="Needs attention">
              {needsAttention.map((plugin) => (
                <SettingsRow
                  key={plugin.id}
                  label={plugin.displayName}
                  accessory={<Badge size="xs">{projectPluginStatus(plugin, enabled)}</Badge>}
                  description={attentionReason(plugin)}
                  control={
                    <Button variant="outline" size="sm" onClick={() => onSelectPlugin(plugin)}>
                      Review
                    </Button>
                  }
                />
              ))}
              {needsSetup.map(({ plugin, gap, first }) => (
                <SettingsRow
                  key={`setup:${plugin.id}`}
                  label={plugin.displayName}
                  accessory={first && <Badge size="xs">Needs setup</Badge>}
                  description={setupGapDescription(gap)}
                  error={
                    gap.failed ? (
                      <RowFailure
                        summary="Couldn't check all of its settings, so this may be incomplete"
                        onRetry={recheck}
                      />
                    ) : undefined
                  }
                  control={
                    first && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void actionService.dispatch(
                            "plugin.openSettings",
                            { pluginId: plugin.instanceId, key: first.id },
                            { source: "user" }
                          )
                        }
                      >
                        Set up
                      </Button>
                    )
                  }
                />
              ))}
            </SettingsGroup>
          )}
        </div>
      </SettingsSection>

      <ProjectSurfacesSection />

      <SidebarDefaultViewSection />

      <HiddenLauncherGroupsSection />

      <ContextProvidersSection />

      <ProjectAgentToolsSection />
    </div>
  );
}
