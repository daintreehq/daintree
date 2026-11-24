import { useRef, useState } from "react";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import {
  makeInstalledProjectInstanceKey,
  type ProjectPluginTrustDecision,
} from "@shared/types/plugin";
import type { PluginUnsavedPanel } from "@shared/types/pluginUnsavedPanels";
import {
  UNSAVED_READ_FAILED,
  hasUnshownPanels,
  readUnsavedPanels,
  unsavedPanelKey,
} from "./unsavedPluginPanels";

/**
 * A change to a project's own plugins that unloads what is running. `instanceOff`
 * stops this project's copy of an installed per-project package, so it carries
 * the project whose copy it is: the key its panels report is built from it.
 */
export type ProjectPluginUnload =
  | { kind: "trustOff" }
  | { kind: "mute"; pluginId: string; displayName: string }
  | { kind: "instanceOff"; pluginId: string; displayName: string; projectId: string };

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
  // Read whether or not the loaded list shows the instance: that list lags, and
  // the read is an in-memory lookup on main.
  if (unload.kind === "instanceOff") {
    return [makeInstalledProjectInstanceKey(unload.projectId, unload.pluginId)];
  }
  const targets: string[] = [];
  for (const plugin of useProjectPluginStore.getState().plugins) {
    if (plugin.state !== "active" || plugin.instanceId === undefined) continue;
    if (unload.kind === "mute" && plugin.id !== unload.pluginId) continue;
    targets.push(plugin.instanceId);
  }
  return targets;
}

/**
 * The dirty panels of everything the unload would take down, once each, or
 * `null` when any read failed. A plugin that loads while a read is out unloads
 * with the rest, so the targets are taken again after every read until none is
 * new, and nothing is submitted unread.
 */
async function readUnloadPanels(unload: ProjectPluginUnload): Promise<PluginUnsavedPanel[] | null> {
  const read = new Set<string>();
  const seen = new Set<string>();
  const panels: PluginUnsavedPanel[] = [];
  for (;;) {
    const fresh = unloadTargets(unload).filter((target) => !read.has(target));
    if (fresh.length === 0) return panels;
    const answers = await Promise.all(fresh.map(readUnsavedPanels));
    for (const answer of answers) {
      if (answer === null) return null;
      for (const panel of answer) {
        const key = unsavedPanelKey(panel);
        if (seen.has(key)) continue;
        seen.add(key);
        panels.push(panel);
      }
    }
    for (const target of fresh) read.add(target);
  }
}

/**
 * The project the unload is about, as the store names it now. A per-project
 * package follows the view, since its instance can run before the repository
 * snapshot that sets `projectId` arrives.
 */
function currentProjectId(unload: ProjectPluginUnload): string | null {
  const store = useProjectPluginStore.getState();
  return unload.kind === "instanceOff" ? (store.viewProjectId ?? store.projectId) : store.projectId;
}

function submit(unload: ProjectPluginUnload): Promise<void> {
  const store = useProjectPluginStore.getState();
  switch (unload.kind) {
    case "trustOff":
      return store.decide("disabled");
    case "mute":
      return store.setMuted(unload.pluginId, true);
    case "instanceOff":
      return store.setInstanceEnabled(unload.pluginId, false);
  }
}

/** A failed read stops the action where its own failures show, with the same retry. */
function reportReadFailure(unload: ProjectPluginUnload): void {
  const store = useProjectPluginStore.getState();
  switch (unload.kind) {
    case "trustOff":
      store.reportFailure(
        { action: "decide", decision: "disabled" },
        PROJECT_PLUGINS_UNSAVED_READ_FAILED
      );
      return;
    case "mute":
      store.reportFailure(
        { action: "mute", pluginId: unload.pluginId, muted: true },
        UNSAVED_READ_FAILED
      );
      return;
    case "instanceOff":
      store.reportFailure(
        { action: "instanceEnabled", pluginId: unload.pluginId, enabled: false },
        UNSAVED_READ_FAILED
      );
  }
}

/**
 * Stand-ins for the store's `decide`, `setMuted` and `setInstanceEnabled` that
 * ask before unloading a project plugin whose panels hold unsaved work (#16656),
 * or this project's copy of a per-project package (#17215), the same Discard /
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
    if (unloadTargets(unload).length === 0) {
      await submit(unload);
      return;
    }
    const projectId = currentProjectId(unload);
    readingRef.current = true;
    let panels: PluginUnsavedPanel[] | null;
    try {
      panels = await readUnloadPanels(unload);
    } finally {
      readingRef.current = false;
    }
    // The view moved to another project while main answered: the click was
    // about plugins this store no longer describes.
    if (currentProjectId(unload) !== projectId) return;
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

  const setInstanceEnabled = async (pluginId: string, enabled: boolean, displayName: string) => {
    const store = useProjectPluginStore.getState();
    if (enabled) return store.setInstanceEnabled(pluginId, true);
    if (store.instanceToggling.has(pluginId)) return;
    const projectId = store.viewProjectId ?? store.projectId;
    // No project means no instance key to read, and an unread turn-off is the
    // silent discard this guard exists to stop.
    if (projectId === null) {
      if (readingRef.current || pendingRef.current !== null) return;
      store.reportFailure(
        { action: "instanceEnabled", pluginId, enabled: false },
        UNSAVED_READ_FAILED
      );
      return;
    }
    await request({ kind: "instanceOff", pluginId, displayName, projectId });
  };

  const cancel = () => setPending(null);

  const confirm = async () => {
    const prompt = pendingRef.current;
    if (!prompt || confirmingRef.current === prompt) return;
    confirmingRef.current = prompt;
    // Read afresh rather than reused: a plugin that loaded while the prompt was
    // open unloads with the rest, so its panels count too.
    const current = await readUnloadPanels(prompt.unload);
    if (confirmingRef.current === prompt) confirmingRef.current = null;
    if (pendingRef.current !== prompt) return;
    if (currentProjectId(prompt.unload) !== prompt.projectId) {
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

  return { decide, setMuted, setInstanceEnabled, pending, confirm, cancel };
}

export type ProjectPluginUnsavedGuard = ReturnType<typeof useProjectPluginUnsavedGuard>;
