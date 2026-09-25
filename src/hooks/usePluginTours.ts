import { useEffect } from "react";
import type { PluginTourDescriptor } from "@shared/types/plugin";
import type { ActionDefinition, ActionId } from "@shared/types/actions";
import { actionService } from "@/services/ActionService";
import { createPluginTourRegistration } from "@/components/Tour/pluginTours";
import { openTour } from "@/components/Tour/tourEvents";
import { getTour, registerTour } from "@/components/Tour/tourRegistry";
import { logWarn } from "@/utils/logger";

/** Palette entry for a plugin tour; `help.tour.show` stays the one MCP entry point. */
export function pluginTourActionId(tourId: string): ActionId {
  return `help.tour.play.${tourId}` as ActionId;
}

interface Mirrored {
  /** Serialized descriptor: a changed one (a reload's new generation) re-registers. */
  key: string;
  withdraw: () => void;
}

function toAction(tour: PluginTourDescriptor): ActionDefinition {
  return {
    id: pluginTourActionId(tour.id),
    title: `${tour.pluginName}: ${tour.title}`,
    description: `Play the ${tour.title} from ${tour.pluginName}`,
    category: "help",
    kind: "command",
    danger: "safe",
    nonRepeatable: true,
    scope: "renderer",
    keywords: ["tour", "tutorial", "walkthrough", "onboarding", tour.pluginName],
    mcpVisibility: "hidden",
    run: async () => {
      openTour(tour.id);
    },
  };
}

function mirror(tour: PluginTourDescriptor): Mirrored | null {
  if (getTour(tour.id)) {
    logWarn("[PluginTours] A tour is already registered under this id", { tourId: tour.id });
    return null;
  }
  const unregisterTour = registerTour(createPluginTourRegistration(tour));
  // Panel tours are opened from their panel, never listed app-wide.
  // Only an action this mirror registered is its to withdraw.
  let actionId: ActionId | null = null;
  if (tour.panelKind === undefined) {
    const candidate = pluginTourActionId(tour.id);
    if (actionService.has(candidate)) {
      logWarn("[PluginTours] An action is already registered under this id", { candidate });
    } else {
      actionService.register(toAction(tour));
      actionId = candidate;
    }
  }
  return {
    key: JSON.stringify(tour),
    withdraw: () => {
      unregisterTour();
      if (actionId) actionService.unregister(actionId);
    },
  };
}

/**
 * Mirror main's plugin tour registry into this view's tour registry and action
 * palette (#12773). A tour that leaves the snapshot — plugin disabled,
 * uninstalled, hidden in this project, or reloaded under a new generation — is
 * withdrawn, and the tour host closes it if it is open.
 *
 * Pull-on-mount is a safety net for a view that missed a broadcast; push is
 * authoritative, so a pull resolving after a push is dropped (see
 * {@link usePluginRecipes}).
 */
export function usePluginTours(): void {
  useEffect(() => {
    const electron = typeof window !== "undefined" ? window.electron : undefined;
    if (!electron?.plugin) return;

    let disposed = false;
    let pushReceived = false;
    const mirrored = new Map<string, Mirrored>();

    const sync = (tours: readonly PluginTourDescriptor[]): void => {
      if (disposed) return;
      const incoming = new Map(tours.map((tour) => [tour.id, tour]));
      for (const [id, entry] of mirrored) {
        const next = incoming.get(id);
        if (next && JSON.stringify(next) === entry.key) continue;
        entry.withdraw();
        mirrored.delete(id);
      }
      for (const [id, tour] of incoming) {
        if (mirrored.has(id)) continue;
        const entry = mirror(tour);
        if (entry) mirrored.set(id, entry);
      }
    };

    void electron.plugin
      .getTours()
      .then((tours) => {
        if (!pushReceived) sync(tours);
      })
      .catch((err: unknown) => {
        logWarn("[PluginTours] Failed to fetch initial plugin tours", { error: err });
      });

    const cleanup = electron.plugin.onToursChanged((payload) => {
      pushReceived = true;
      sync(payload.tours);
    });

    return () => {
      disposed = true;
      cleanup();
      for (const entry of mirrored.values()) entry.withdraw();
      mirrored.clear();
    };
  }, []);
}
