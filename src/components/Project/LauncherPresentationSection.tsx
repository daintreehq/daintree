import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/field";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsPresetGroup } from "@/components/Settings/SettingsPresetGroup";
import { SettingsSelect } from "@/components/Settings/SettingsSelect";
import { launcherArrangementFor, resolvePresentationFor } from "@/hooks/useResolvedPresentation";
import { useProjectStore } from "@/store/projectStore";
import { useProjectPresentationStore } from "@/store/projectPresentationStore";
import { usePluginLaunchEntriesStore } from "@/store/pluginLaunchEntriesStore";
import {
  PRESENTATION_FEATURES,
  type PresentationFeatureId,
  type PresentationLevel,
} from "@shared/config/presentationProfile";
import {
  arrangeLauncherGroups,
  compareLauncherPluginGroups,
  featuredRefForLaunchEntry,
  launcherPluginGroupId,
  mergeLauncherGroupOrder,
} from "@shared/config/launcherArrangement";

const LAUNCHER_FEATURES = [
  "launcherAgents",
  "launcherPanels",
] as const satisfies readonly PresentationFeatureId[];

const LEVEL_LABELS: Partial<Record<PresentationLevel, string>> = {
  shown: "Shown",
  demoted: "In More",
};

const BUILT_IN_GROUP_LABELS: Record<string, string> = {
  agents: "Agents",
  panels: "Panels",
  recipes: "Recipes",
};

/**
 * A reorder this list has sent: the order it draws, the order it stores, and
 * every stored order the chain has been through, the one it started from
 * first, so main's replies along the way read as its own.
 */
interface PendingOrder {
  drawn: string[];
  stored: string[];
  sent: string[];
}

const orderKey = (order: readonly string[]) => order.join("\n");

/** Radix Select refuses an empty item value, so "no featured entry" needs a name. */
const NO_FEATURED = "none";

/**
 * Project settings → General → Launcher (#13791): how the launcher arranges
 * this project. Demoting folds a built-in group into More, featuring an entry
 * preselects it, and the user's group order wins over the profile's. Instant
 * apply, through main, like the Features rows above it.
 */
export function LauncherPresentationSection() {
  const project = useProjectStore((s) => s.currentProject);
  const levels = useProjectPresentationStore((s) => s.levels);
  const loaded = useProjectPresentationStore((s) => s.loaded);
  const profileProjectId = useProjectPresentationStore((s) => s.projectId);
  const launcherGroupOrder = useProjectPresentationStore((s) => s.launcherGroupOrder);
  const featuredLaunchEntry = useProjectPresentationStore((s) => s.featuredLaunchEntry);
  const failedSave = useProjectPresentationStore((s) => s.failedSave);
  const setLevel = useProjectPresentationStore((s) => s.setLevel);
  const setLauncherGroupOrder = useProjectPresentationStore((s) => s.setLauncherGroupOrder);
  const setFeaturedLaunchEntry = useProjectPresentationStore((s) => s.setFeaturedLaunchEntry);
  const retryFailedSave = useProjectPresentationStore((s) => s.retryFailedSave);
  const entries = usePluginLaunchEntriesStore((s) => s.entries);
  const hiddenPluginIds = usePluginLaunchEntriesStore((s) => s.hiddenPluginIds);
  const initLaunchEntries = usePluginLaunchEntriesStore((s) => s.init);
  const initPresentation = useProjectPresentationStore((s) => s.init);

  useEffect(() => {
    initPresentation();
    initLaunchEntries();
  }, [initPresentation, initLaunchEntries]);

  const profile = {
    levels,
    loaded,
    projectId: profileProjectId,
    launcherGroupOrder,
    featuredLaunchEntry,
  };
  const resolved = resolvePresentationFor(project, profile);
  const arrangement = launcherArrangementFor(project, profile);
  // Until main has answered for this project the rows show defaults and take
  // no input, as on the Features rows.
  const applies = project != null && loaded && profileProjectId === project.id;

  // One group per plugin with an entry, as the launcher lists them; a group
  // this project hides is restored from Project settings → Plugins instead.
  const hidden = new Set(hiddenPluginIds);
  const pluginGroups = [
    ...new Map(
      entries
        .filter((entry) => !hidden.has(entry.pluginId))
        .map((entry) => [
          entry.pluginId,
          { pluginId: entry.pluginId, pluginName: entry.pluginName },
        ])
    ).values(),
  ].sort(compareLauncherPluginGroups);
  const groupLabel = (id: string) =>
    BUILT_IN_GROUP_LABELS[id] ??
    pluginGroups.find((group) => launcherPluginGroupId(group.pluginId) === id)?.pluginName ??
    id;
  const layout = arrangeLauncherGroups(pluginGroups, arrangement);

  // Writes land only once main replies. Until the store holds the last order
  // this list asked for, the rows show — and the next move builds on — that
  // order, so a quick second move can't put the first one back. An order the
  // store gets from anywhere else, another window say, wins over it.
  const [pending, setPending] = useState<PendingOrder | null>(null);
  const storedKey = orderKey(launcherGroupOrder);
  const editing =
    pending !== null && pending.sent.includes(storedKey) && orderKey(pending.stored) !== storedKey
      ? pending
      : null;
  const groups = editing?.drawn ?? [...layout.shown, ...layout.demoted];

  // Moves stay inside the shown groups or inside More: an order that crossed
  // between them would change nothing the launcher draws.
  const canMove = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= groups.length) return false;
    return layout.demoted.includes(groups[index]!) === layout.demoted.includes(groups[target]!);
  };
  const move = (index: number, by: -1 | 1) => {
    if (!canMove(index, by)) return;
    const drawn = [...groups];
    [drawn[index], drawn[index + by]] = [drawn[index + by]!, drawn[index]!];
    const stored = mergeLauncherGroupOrder(drawn, editing?.stored ?? launcherGroupOrder);
    setPending({ drawn, stored, sent: [...(editing?.sent ?? [storedKey]), orderKey(stored)] });
    void setLauncherGroupOrder(stored);
  };
  const resetOrder = () => {
    setPending(null);
    void setLauncherGroupOrder([]);
  };

  const ownEntries = project
    ? entries.flatMap((entry) => {
        const ref = featuredRefForLaunchEntry(entry, project.id);
        return ref === null ? [] : [{ ref, label: entry.label, pluginName: entry.pluginName }];
      })
    : [];
  const featuredOptions = [
    { value: NO_FEATURED, label: "None" },
    ...ownEntries.map((entry) => ({
      value: entry.ref,
      label: entry.label,
      description: entry.pluginName,
    })),
    // A choice whose plugin is not loaded right now stays visible, so it can
    // still be seen and let go. Its ref is an internal id, never a label.
    ...(featuredLaunchEntry !== null && !ownEntries.some((e) => e.ref === featuredLaunchEntry)
      ? [{ value: featuredLaunchEntry, label: "An entry from a plugin that isn't loaded" }]
      : []),
  ];

  const failed =
    failedSave?.kind === "launcherGroupOrder" ||
    failedSave?.kind === "featuredLaunchEntry" ||
    (failedSave?.kind === "level" &&
      (LAUNCHER_FEATURES as readonly string[]).includes(failedSave.feature));

  return (
    <SettingsSection
      id="project-launcher"
      title="Launcher"
      description="How the launcher arranges this project. Groups in More stay one click away, and search still finds every entry."
    >
      <SettingsGroup>
        {LAUNCHER_FEATURES.map((id) => {
          const feature = PRESENTATION_FEATURES[id];
          return (
            <SettingsPresetGroup<PresentationLevel>
              key={id}
              id={`project-feature-${id}`}
              label={id === "launcherAgents" ? "Agents" : "Panels"}
              description={`${id === "launcherAgents" ? "Every agent row, recent ones included" : "The built-in panels, for the dock and the grid"} · Default: Shown`}
              options={feature.levels.map((level) => ({
                value: level,
                label: LEVEL_LABELS[level] ?? level,
              }))}
              value={resolved[id]}
              onChange={(level) => {
                if (level === resolved[id]) return;
                void setLevel(id, level === "shown" ? null : level);
              }}
              isModified={applies && levels[id] !== undefined}
              onReset={() => void setLevel(id, null)}
              disabled={!applies}
            />
          );
        })}
        <SettingsSelect
          id="project-launcher-featured"
          label="Featured entry"
          description="Selected when the launcher opens, so Enter runs it. Only this project's own plugins can be featured."
          value={featuredLaunchEntry ?? NO_FEATURED}
          onValueChange={(value) => {
            const ref = value === NO_FEATURED ? null : value;
            if (ref !== featuredLaunchEntry) void setFeaturedLaunchEntry(ref);
          }}
          options={featuredOptions}
          isModified={applies && featuredLaunchEntry !== null}
          onReset={() => void setFeaturedLaunchEntry(null)}
          disabled={!applies || featuredOptions.length === 1}
          disabledReason={
            applies && featuredOptions.length === 1
              ? "This project's plugins add no launcher entries"
              : undefined
          }
        />
        <SettingsRow
          id="project-launcher-order"
          label="Group order"
          description="Your order wins over the project's. Groups in More keep their order inside it."
          layout="stacked"
          isModified={applies && launcherGroupOrder.length > 0}
          onReset={resetOrder}
          resetAriaLabel="Reset group order"
          disabled={!applies}
          control={({ labelId, disabled }) => (
            <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1">
              {groups.map((id, index) => {
                const label = groupLabel(id);
                const inMore = layout.demoted.includes(id);
                return (
                  <div
                    key={id}
                    data-launcher-group={id}
                    className="flex items-center gap-2 text-sm text-text-primary"
                  >
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {inMore && <span className="text-xs text-text-secondary">In More</span>}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => move(index, -1)}
                      disabled={disabled || !canMove(index, -1)}
                      aria-label={`Move ${label} up`}
                    >
                      <ChevronUp />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => move(index, 1)}
                      disabled={disabled || !canMove(index, 1)}
                      aria-label={`Move ${label} down`}
                    >
                      <ChevronDown />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        />
        {failed && (
          <SettingsEmptyRow
            action={
              <Button variant="outline" size="sm" onClick={retryFailedSave}>
                Retry
              </Button>
            }
          >
            <InlineError as="span" role="alert">
              Couldn&apos;t save the change
            </InlineError>
          </SettingsEmptyRow>
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
