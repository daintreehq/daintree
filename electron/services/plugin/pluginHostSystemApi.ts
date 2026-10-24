import fs from "fs/promises";
import { shell } from "electron";
import { openWithDefaultApp } from "../../utils/openPath.js";
import { assertExtensionAllowed } from "../../utils/executablePathGuard.js";

import { getPluginCapabilityConsentService } from "../plugin-capability/instances.js";
import { admitPluginExternalLink, claimPluginExternalLinkSlot } from "./pluginExternalLinks.js";
import { parsePluginExternalUrl } from "../../../shared/utils/pluginExternalUrl.js";
import { openExternalUrl } from "../../utils/openExternal.js";
import { resolvePluginFrontend } from "./pluginFrontendRouting.js";

import { AppError } from "../../utils/errorTypes.js";
import type { PluginSystemApi } from "../../../shared/types/plugin.js";
import type { FsRootClass } from "./PluginServiceTypes.js";
import { type PluginHostFactoryDeps } from "./pluginHostDeps.js";
import { containToDeclaredRoots } from "./pluginHostFsApi.js";

/**
 * First-use consent for a plugin opening links to one site. Keyed by hostname,
 * so approving a site answers for that site alone. Built-ins skip it, as they
 * skip capability consent.
 */
async function ensureExternalSiteConsent(
  deps: PluginHostFactoryDeps,
  pluginId: string,
  site: string
): Promise<void> {
  const plugin = deps.plugins.get(pluginId);
  // Unloaded mid-call: the caller's liveness guard rejects.
  if (!plugin) return;
  if (plugin.isBuiltin) return;
  const displayName = plugin.manifest.displayName ?? plugin.manifest.name;
  await getPluginCapabilityConsentService().ensureExternalSiteAllowed(
    pluginId,
    displayName,
    site,
    plugin.manifest.capabilities ?? [],
    plugin.binding?.projectId ?? "global"
  );
}

/**
 * Host-mediated "open / reveal" surface (#11299), scoped to the calling
 * plugin's own filesystem roots.
 *
 * The renderer's built-in `system.openPath` action validates against the
 * *user's* roots — open projects, tracked worktrees, `userData` — and carries
 * no caller identity, so a plugin dispatching it could not reach
 * `~/.daintree/plugin-data/<plugin-id>/`: the one directory that is
 * unambiguously its own. Plugins worked around that by shelling out to
 * `/usr/bin/open`, trading a contained call for arbitrary execution.
 *
 * `pluginId` is bound here at construction rather than travelling as an
 * argument, which is what makes the scoping trustworthy — there is no
 * parameter for one plugin to name another's namespace. That is also why this
 * is a host API rather than plugin identity threaded through the generic
 * ActionService dispatch payload, which every non-plugin caller shares.
 *
 * Stateless — no watchers or handles, so nothing to tear down on unload.
 */
export function buildSystemApi(
  deps: PluginHostFactoryDeps,
  pluginId: string,
  boundProjectId: string | null
): PluginSystemApi {
  const requireLoaded = (op: string): void => {
    if (!deps.plugins.has(pluginId)) {
      throw new Error(
        `PLUGIN_UNLOADED: plugin "${pluginId}" system.${op}: plugin is no longer loaded`
      );
    }
  };
  // Accept either the read or the write capability for the matched root's
  // class. Revealing a file is strictly less authority than the read that
  // would let the plugin exfiltrate its contents, and a plugin that could
  // legitimately *create* the file should not also have to declare read
  // access just to show the user where it landed.
  const requireCapForClass = (op: string, rootClass: FsRootClass): void => {
    const read = rootClass === "project" ? "fs:project-read" : "fs:user-data-read";
    const write = rootClass === "project" ? "fs:project-write" : "fs:user-data-write";
    const held = deps.declaredCapabilities(pluginId);
    if (!held.has(read) && !held.has(write)) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" system.${op} requires the "${read}" or "${write}" capability for ${rootClass} paths, which is not declared in manifest.capabilities`
      );
    }
  };
  // Opening a file manager or an app on this machine's screen does nothing for
  // a person driving the project from another machine, and puts windows in
  // front of whoever is sitting here. Refused rather than guessed at.
  const refuseForRemoteDriver = (op: string): void => {
    const frontend = resolvePluginFrontend(boundProjectId, pluginId);
    if (frontend.kind !== "remote") return;
    throw new AppError({
      code: "UNSUPPORTED",
      message: `REMOTE_FRONTEND: plugin "${pluginId}" system.${op}: the project is driven from another machine, so nothing is opened on this host's screen`,
      userMessage: "Files on a host can't be opened on its screen for another machine.",
      context: { pluginId },
    });
  };
  const containWithClass = (targetPath: string) =>
    containToDeclaredRoots(deps, pluginId, targetPath);
  // The plugin path resolver deliberately admits a non-existent final
  // component so `fs.writeFile` can create a new file inside an allowed root.
  // That is wrong for these sinks: `shell.showItemInFolder` silently no-ops on
  // a missing path, so without this gate a plugin revealing a deleted file
  // would be told it succeeded while nothing opened. Checked after the
  // capability gate so an unauthorized plugin can't probe for existence.
  const requireExists = async (op: string, resolved: string): Promise<void> => {
    try {
      await fs.stat(resolved);
    } catch (err) {
      // Report only a genuine absence as absence. A permissions or I/O error
      // says the path is unreadable, not missing, and collapsing the two sends
      // an author hunting for a file that is sitting right there.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const reason =
        code === "ENOENT" || code === "ENOTDIR" ? "path does not exist" : `stat failed (${code})`;
      throw new Error(`INVALID_PATH: plugin "${pluginId}" system.${op}: ${reason}: ${resolved}`, {
        cause: err,
      });
    }
  };

  return {
    openPath: async (targetPath): Promise<void> => {
      requireLoaded("openPath");
      // Deny executables on the raw path before any I/O, then again on the
      // realpath target below — a benignly named symlink inside an allowed
      // root would otherwise be a launch primitive.
      assertExtensionAllowed(targetPath);
      const { resolved, rootClass } = await containWithClass(targetPath);
      // Re-check liveness after the await: expansion and realpath are async,
      // and the plugin can unload underneath them (#9533).
      requireLoaded("openPath");
      requireCapForClass("openPath", rootClass);
      assertExtensionAllowed(resolved);
      await requireExists("openPath", resolved);
      requireLoaded("openPath");
      refuseForRemoteDriver("openPath");
      // shell.openPath reports failure through a non-empty return string
      // rather than by rejecting, so an unchecked call fails silently.
      const error = await openWithDefaultApp(resolved);
      if (error !== "") {
        throw new Error(`plugin "${pluginId}" system.openPath failed: ${error}`);
      }
      deps.safeAppendAudit({
        pluginId,
        actionId: `system.openPath:${resolved}`,
        recordType: "ipc-invoke",
        channel: "plugin:system-open-path",
        result: "success",
        errorMessage: "",
        argsHash: deps.safeArgsHash([{ path: resolved }]),
        durationMs: 0,
      });
    },
    openExternal: async (url): Promise<void> => {
      requireLoaded("openExternal");
      const parsed = parsePluginExternalUrl(url);
      if (!parsed.ok) {
        throw new Error(`INVALID_URL: plugin "${pluginId}" system.openExternal: ${parsed.reason}`);
      }
      const { href, site } = parsed.link;
      // Before the prompt, so a remote user cannot raise dialogs on this
      // machine's screen for a link that would not open here anyway.
      refuseForRemoteDriver("openExternal");
      const releaseSlot = claimPluginExternalLinkSlot(pluginId);
      // Spent before the prompt and kept on a denial, so a plugin cannot stack
      // dialogs by asking again.
      if (!releaseSlot || !admitPluginExternalLink(pluginId)) {
        releaseSlot?.();
        throw new Error(
          `RATE_LIMITED: plugin "${pluginId}" system.openExternal: too many links opened; try again shortly`
        );
      }
      try {
        const loaded = deps.plugins.get(pluginId);
        await ensureExternalSiteConsent(deps, pluginId, site);
        requireLoaded("openExternal");
        // A reinstall under the same id is a different plugin: the answer given
        // for the old one is not this call's to use.
        if (deps.plugins.get(pluginId) !== loaded) {
          throw new Error(
            `PLUGIN_UNLOADED: plugin "${pluginId}" system.openExternal: plugin was replaced`
          );
        }
        refuseForRemoteDriver("openExternal");
        await openExternalUrl(href);
      } finally {
        releaseSlot();
      }
      // The URL can carry a token, so only its hash is recorded.
      deps.safeAppendAudit({
        pluginId,
        actionId: "system.openExternal",
        recordType: "ipc-invoke",
        channel: "plugin:system-open-external",
        result: "success",
        errorMessage: "",
        argsHash: deps.safeArgsHash([{ url: href }]),
        durationMs: 0,
      });
    },
    showItemInFolder: async (targetPath): Promise<void> => {
      requireLoaded("showItemInFolder");
      // No executable deny-list here: revealing a file in Finder/Explorer
      // shows it, it does not run it. Containment still applies in full.
      const { resolved, rootClass } = await containWithClass(targetPath);
      requireLoaded("showItemInFolder");
      requireCapForClass("showItemInFolder", rootClass);
      await requireExists("showItemInFolder", resolved);
      requireLoaded("showItemInFolder");
      refuseForRemoteDriver("showItemInFolder");
      // Returns void and no-ops on a missing path — requireExists above is
      // what turns that silent nothing into a reported failure.
      shell.showItemInFolder(resolved);
      deps.safeAppendAudit({
        pluginId,
        actionId: `system.showItemInFolder:${resolved}`,
        recordType: "ipc-invoke",
        channel: "plugin:system-show-item",
        result: "success",
        errorMessage: "",
        argsHash: deps.safeArgsHash([{ path: resolved }]),
        durationMs: 0,
      });
    },
  };
}
