import type { LoadedPluginInfo, ProjectPluginInfo } from "@shared/types/plugin";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";

/** A plugin present here that another plugin's `worksWith` can name. */
export interface WorksWithPeer {
  name: string;
  /** False when the person switched it off; it is still installed. */
  turnedOff: boolean;
}

/**
 * What this window can see installed, keyed by manifest id: the app's own
 * plugins and the current project's. An installed plugin and a project plugin
 * can share an id and both load, so a shared id reads as turned off only when
 * every copy is, and takes its name from one that is on.
 */
export function buildWorksWithPeers(
  installed: readonly LoadedPluginInfo[],
  projectPlugins: readonly ProjectPluginInfo[]
): ReadonlyMap<string, WorksWithPeer> {
  const peers = new Map<string, WorksWithPeer>();
  const add = (id: string, copy: WorksWithPeer): void => {
    const seen = peers.get(id);
    if (!seen || (seen.turnedOff && !copy.turnedOff)) peers.set(id, copy);
  };
  for (const plugin of installed) {
    if (plugin.origin === "project") continue;
    add(plugin.manifest.name, {
      name: plugin.manifest.displayName ?? plugin.manifest.name,
      turnedOff: plugin.disabled === true,
    });
  }
  for (const plugin of projectPlugins) {
    if (plugin.state === "invalid") continue;
    add(plugin.id, { name: plugin.displayName, turnedOff: plugin.muted });
  }
  return peers;
}

function availability(peer: WorksWithPeer | undefined): string {
  if (!peer) return "Not installed";
  return peer.turnedOff ? "Installed, turned off" : "Installed";
}

/**
 * The plugins a manifest says it works with (#13817), and whether each is here.
 * Disclosure only, and the caption says so: nothing in this list is installed,
 * loaded or ordered for the plugin, so a row offers no action that would imply
 * otherwise. Neutral styling throughout — reference metadata, not a signal.
 */
export function PluginWorksWith({
  ids,
  peers,
}: {
  ids: readonly string[];
  peers: ReadonlyMap<string, WorksWithPeer>;
}) {
  return (
    <div className="space-y-2">
      <h4 className={SECTION_LABEL_CLASS}>Works with</h4>
      <p className="text-2xs text-text-secondary">
        Listed by the plugin. Daintree doesn't install or load these for it.
      </p>
      <ul className="space-y-2">
        {ids.map((id) => {
          const peer = peers.get(id);
          return (
            <li key={id} className="text-xs">
              <div className="text-text-primary break-words">{peer?.name ?? id}</div>
              {peer && peer.name !== id && (
                <div className="text-2xs text-text-secondary font-mono break-all">{id}</div>
              )}
              <div className="text-2xs text-text-secondary mt-0.5">{availability(peer)}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
