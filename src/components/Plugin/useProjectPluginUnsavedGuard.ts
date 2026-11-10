import { useRef, useState } from "react";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import type { ProjectPluginTrustDecision } from "@shared/types/plugin";
import type { PluginUnsavedPanel } from "@shared/types/pluginUnsavedPanels";
import {
  UNSAVED_READ_FAILED,
  hasUnshownPanels,
  readUnsavedPanels,
  unsavedPanelKey,
} from "./unsavedPluginPanels";

/** A change to a project's own plugins that unloads what is running. */
export type ProjectPluginUnload =
  { kind: "trustOff" } | { kind: "mute"; pluginId: string; displayName: string };

/** An unload held for the user's Discard / Cancel because it would lose unsaved work. */
export interface PendingProjectPluginUnload {
  unload: ProjectPluginUnload;
  projectId: string | null;
  panels: PluginUnsavedPanel[];
}

export const PROJECT_PLUGINS_UNSAVED_READ_FAILED =
  "Couldn't check this project's plugins for unsaved work, so nothing changed. Try again.";

/**
 * The instance keys the unload would take down, from the store as it is now.
 * Only a loaded plugin has panels to lose, and `active` is the load
 * observation: a lazy plugin that never activated, or one whose `activate()`
 * threw, is still loaded. A repository plugin's panels report its instance key,
 * so that key, never the manifest id, is what finds them.
 */
function unloadTargets(unload: ProjectPluginUnload): string[] {
  const targets: string[] = [];
  for (const plugin of useProjectPluginStore.getState().plugins) {
    if (plugin.state !== "active" || plugin.instanceId === undefined) continue;
    if (unload.kind === "mute" && plugin.id !== unload.pluginId) continue;
    targets.push(plugin.instanceId);
  }
  return targets;
}

/** Every target's dirty panels, once each, or `null` when any read failed. */
async function readTargets(targets: readonly string[]): Promise<PluginUnsavedPanel[] | null> {
  const reads = await Promise.all(targets.map(readUnsavedPanels));
  const seen = new Set<string>();
  const panels: PluginUnsavedPanel[] = [];
  for (const read of reads) {
    if (read === null) return null;
    for (const panel of read) {
      const key = unsavedPanelKey(panel);
      if (seen.has(key)) continue;
      seen.add(key);
      panels.push(panel);
    }
  }
  return panels;
}

function submit(unload: ProjectPluginUnload): Promise<void> {
  const store = useProjectPluginStore.getState();
  return unload.kind === "trustOff"
    ? store.decide("disabled")
    : store.setMuted(unload.pluginId, true);
}

/** A failed read stops the action where its own failures show, with the same retry. */
function reportReadFailure(unload: ProjectPluginUnload): void {
  const store = useProjectPluginStore.getState();
  if (unload.kind === "trustOff") {
    store.reportFailure(
      { action: "decide", decision: "disabled" },
      PROJECT_PLUGINS_UNSAVED_READ_FAILED
    );
  } else {
    store.reportFailure(
      { action: "mute", pluginId: unload.pluginId, muted: true },
      UNSAVED_READ_FAILED
    );
  }
}

/**
 * Stand-ins for the store's `decide` and `setMuted` that ask before unloading a
 * project plugin whose panels hold unsaved work (#16656), the same Discard /
 * Cancel the plugin manager asks before disabling an installed plugin (#15031).
 * Turning the project's plugins off reads every loaded one; switching one off
 * reads that one. Anything that unloads nothing goes straight through.
 *
 * The prompt belongs to the surface that asked, rendered by
 * `ProjectPluginUnsavedDialog`, so two mounted surfaces never show it twice.
 */
export function useProjectPluginUnsavedGuard() {
  const [pending, setPendingState] = useState<PendingProjectPluginUnload | null>(null);
  // The live prompt, which a read compares against after it settles, so a
  // prompt cancelled or replaced meanwhile is never acted on.
  const pendingRef = useRef<PendingProjectPluginUnload | null>(null);
  const setPending = (next: PendingProjectPluginUnload | null) => {
    pendingRef.current = next;
    setPendingState(next);
  };
  // A read before the prompt is in flight, so a double click can't start two.
  const readingRef = useRef(false);
  // The prompt whose Discard is being re-read, so a second press waits on it.
  const confirmingRef = useRef<PendingProjectPluginUnload | null>(null);

  const request = async (unload: ProjectPluginUnload) => {
    if (readingRef.current || pendingRef.current !== null) return;
    const targets = unloadTargets(unload);
    if (targets.length === 0) {
      await submit(unload);
      return;
    }
    const projectId = useProjectPluginStore.getState().projectId;
    readingRef.current = true;
    let panels: PluginUnsavedPanel[] | null;
    try {
      panels = await readTargets(targets);
    } finally {
      readingRef.current = false;
    }
    // The view moved to another project while main answered: the click was
    // about plugins this store no longer describes.
    if (useProjectPluginStore.getState().projectId !== projectId) return;
    if (panels === null) {
      reportReadFailure(unload);
      return;
    }
    if (panels.length === 0) {
      await submit(unload);
      return;
    }
    setPending({ unload, projectId, panels });
  };

  const decide = async (decision: ProjectPluginTrustDecision) => {
    const store = useProjectPluginStore.getState();
    if (decision !== "disabled") return store.decide(decision);
    if (store.deciding !== null) return;
    await request({ kind: "trustOff" });
  };

  const setMuted = async (pluginId: string, muted: boolean) => {
    const store = useProjectPluginStore.getState();
    if (!muted) return store.setMuted(pluginId, false);
    if (store.muting.has(pluginId)) return;
    const displayName = store.plugins.find((p) => p.id === pluginId)?.displayName ?? pluginId;
    await request({ kind: "mute", pluginId, displayName });
  };

  const cancel = () => setPending(null);

  const confirm = async () => {
    const prompt = pendingRef.current;
    if (!prompt || confirmingRef.current === prompt) return;
    confirmingRef.current = prompt;
    // Resolved again rather than reused: a plugin that loaded while the prompt
    // was open unloads with the rest, so its panels count too.
    const current = await readTargets(unloadTargets(prompt.unload));
    if (confirmingRef.current === prompt) confirmingRef.current = null;
    if (pendingRef.current !== prompt) return;
    if (useProjectPluginStore.getState().projectId !== prompt.projectId) {
      setPending(null);
      return;
    }
    if (current === null) {
      setPending(null);
      reportReadFailure(prompt.unload);
      return;
    }
    // Work that turned dirty under the open prompt wasn't part of the answer.
    if (hasUnshownPanels(current, prompt.panels)) {
      setPending({ ...prompt, panels: current });
      return;
    }
    setPending(null);
    await submit(prompt.unload);
  };

  return { decide, setMuted, pending, confirm, cancel };
}

export type ProjectPluginUnsavedGuard = ReturnType<typeof useProjectPluginUnsavedGuard>;
