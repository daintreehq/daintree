import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import { Button } from "@/components/ui/button";
import { ChoiceCard } from "@/components/ui/card";
import {
  activateDockLaunchItem,
  buildEmptyCanvasPluginGroups,
  hidePluginGroup,
  type DockLaunchAgentOptions,
  type DockLaunchPluginEntryItem,
} from "@/components/Layout/dockLaunchItems";
import { useChromeWhenContext } from "@/hooks/useChromeWhenContext";
import { actionService } from "@/services/ActionService";
import { usePluginLaunchEntriesStore } from "@/store/pluginLaunchEntriesStore";
import { useUserAgentRegistryStore } from "@/store/userAgentRegistryStore";
import { isBuiltInAgentId } from "@shared/config/agentIds";
import {
  subscribeToPanelKindRegistry,
  getPanelKindRegistrySnapshot,
} from "@shared/config/panelKindRegistry";
import {
  subscribeToPluginAgentRegistry,
  getPluginAgentRegistrySnapshot,
} from "@shared/config/pluginAgentRegistry";

interface PluginLaunchBandProps {
  activeWorktreeId: string | null | undefined;
  cwd: string | undefined;
  /** Entry motion for the band's root, which exists only while a band does. */
  className?: string;
}

const COLUMNS = "grid-cols-3 @max-[34rem]/launcher:grid-cols-2 @max-[26rem]/launcher:grid-cols-1";

function launchAgent(agentId: string, presetId?: string | null, options?: DockLaunchAgentOptions) {
  void actionService.dispatch(
    "agent.launch",
    {
      agentId,
      ...(presetId !== undefined ? { presetId } : {}),
      ...(options?.prompt !== undefined ? { prompt: options.prompt } : {}),
    },
    { source: "user" }
  );
}

/**
 * The "From <plugin>" bands of the stock empty-canvas launcher: the launch
 * entries a plugin opted in with `showInEmptyState`, drawn by the host. Renders
 * nothing — no heading, no reserved height — until there is a band to show, and
 * holds back until main has said which plugins this project hides, so a hidden
 * band never flashes in.
 */
export function PluginLaunchBand({ activeWorktreeId, cwd, className }: PluginLaunchBandProps) {
  const entries = usePluginLaunchEntriesStore((s) => s.entries);
  const hiddenPluginIds = usePluginLaunchEntriesStore((s) => s.hiddenPluginIds);
  const hiddenLoaded = usePluginLaunchEntriesStore((s) => s.hiddenLoaded);
  const init = usePluginLaunchEntriesStore((s) => s.init);
  const whenContext = useChromeWhenContext();
  // Panel kinds and agents can register after the entries arrive; reading the
  // snapshots re-derives the tiles' disabled state when they do.
  const kindRegistry = useSyncExternalStore(
    subscribeToPanelKindRegistry,
    getPanelKindRegistrySnapshot,
    getPanelKindRegistrySnapshot
  );
  const pluginAgentRegistry = useSyncExternalStore(
    subscribeToPluginAgentRegistry,
    getPluginAgentRegistrySnapshot,
    getPluginAgentRegistrySnapshot
  );
  const userAgentRegistry = useUserAgentRegistryStore((s) => s.registry);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const tileRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    init();
  }, [init]);

  const groups = useMemo(() => {
    void kindRegistry;
    return buildEmptyCanvasPluginGroups(entries, {
      surface: "grid",
      hiddenPluginIds,
      whenContext,
      isAgentRegistered: (agentId) =>
        isBuiltInAgentId(agentId) ||
        Object.hasOwn(pluginAgentRegistry, agentId) ||
        (userAgentRegistry !== null && Object.hasOwn(userAgentRegistry, agentId)),
    });
  }, [entries, hiddenPluginIds, whenContext, kindRegistry, pluginAgentRegistry, userAgentRegistry]);

  const activate = useCallback(
    (item: DockLaunchPluginEntryItem) => {
      if (item.disabled || !cwd) return;
      activateDockLaunchItem(item, {
        cwd,
        activeWorktreeId: activeWorktreeId ?? null,
        onLaunchAgent: launchAgent,
        source: "user",
      });
    },
    [cwd, activeWorktreeId]
  );

  const order = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.key)), [groups]);

  if (!hiddenLoaded || groups.length === 0) return null;

  const tabbableKey = focusedKey !== null && order.includes(focusedKey) ? focusedKey : order[0];

  const onKeyDown = (key: string) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const index = order.indexOf(key);
    let next = index;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = (index + 1) % order.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        next = (index - 1 + order.length) % order.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = order.length - 1;
        break;
    }
    if (next === index) return;
    e.preventDefault();
    const nextKey = order[next]!;
    setFocusedKey(nextKey);
    tileRefs.current.get(nextKey)?.focus();
  };

  return (
    <div className={className} data-testid="plugin-launch-bands">
      {groups.map((group) => (
        <section
          key={group.pluginId}
          aria-label={`From ${group.pluginName}`}
          className="mb-6 w-full"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="truncate text-xs font-medium text-text-secondary">
              From {group.pluginName}
            </h2>
            <Button
              variant="ghost"
              size="xs"
              aria-label={`Hide ${group.pluginName} in this project`}
              onClick={() => {
                const nextFocus = order.find((k) => !group.items.some((i) => i.key === k));
                hidePluginGroup(group);
                if (nextFocus) tileRefs.current.get(nextFocus)?.focus();
                else
                  document
                    .querySelector<HTMLElement>("[data-launcher-anchor]")
                    ?.focus({ preventScroll: true });
              }}
            >
              Hide
            </Button>
          </div>
          <div className={`grid ${COLUMNS} gap-2`}>
            {group.items.map((item) => (
              <ChoiceCard
                key={item.key}
                ref={(el) => {
                  if (el) tileRefs.current.set(item.key, el);
                  else tileRefs.current.delete(item.key);
                }}
                padding="sm"
                title={item.description}
                aria-label={[item.name, item.pluginName, item.disabled?.reason]
                  .filter(Boolean)
                  .join(", ")}
                aria-disabled={item.disabled || !cwd ? true : undefined}
                tabIndex={item.key === tabbableKey ? 0 : -1}
                onFocus={() => setFocusedKey(item.key)}
                onKeyDown={onKeyDown(item.key)}
                onClick={() => activate(item)}
                className="group items-center gap-2 text-sm text-text-secondary hover:text-text-primary aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              >
                <PanelKindIcon iconId={item.iconId} size={14} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                {item.disabled && (
                  <span className="shrink-0 text-2xs text-text-secondary">
                    {item.disabled.reason}
                  </span>
                )}
              </ChoiceCard>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
