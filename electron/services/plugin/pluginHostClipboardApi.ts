import { clipboard } from "electron";
import { decodeClipboardPng, MAX_CLIPBOARD_IMAGE_BYTES } from "../../utils/clipboardImage.js";

import {
  getPluginInvokeOrigin,
  noFrontendAttached,
  resolvePluginFrontend,
} from "./pluginFrontendRouting.js";
import {
  PluginFrontendMethod,
  REMOTE_CLIPBOARD_IMAGE_MAX_BYTES,
  REMOTE_CLIPBOARD_TIMEOUT_MS,
} from "./pluginFrontendRequests.js";

import type { PluginClipboardApi } from "../../../shared/types/plugin.js";
import { type PluginHostFactoryDeps } from "./pluginHostDeps.js";
import { buildGitApi } from "./pluginHostGitApi.js";

/**
 * Host-mediated OS clipboard surface backing the `clipboard:read` /
 * `clipboard:write` tokens. Text reads/writes plus bounded PNG writes
 * (#11299); every method runs here in the main
 * process because Electron's `clipboard` module is undefined inside the
 * dev-worker utility process (a worker-side call would silently no-op). Like
 * {@link buildGitApi} the liveness check precedes the capability check so a
 * torn-down plugin reports `PLUGIN_UNLOADED`, not `PERMISSION_REQUIRED`
 * (declaredCapabilities() also returns [] post-unload). Clipboard ops are
 * stateless — no watchers or handles — so there is nothing to tear down on
 * unload.
 */
export function buildClipboardApi(
  deps: PluginHostFactoryDeps,
  pluginId: string,
  boundProjectId: string | null
): PluginClipboardApi {
  // Mirror the renderer IPC clipboard write guard (electron/ipc/handlers/
  // clipboard.ts) so a runaway plugin can't exhaust the main-process heap.
  const MAX_TEXT_BYTES = 8 * 1024 * 1024;
  const requireLoaded = (op: string): void => {
    if (!deps.plugins.has(pluginId)) {
      throw new Error(
        `PLUGIN_UNLOADED: plugin "${pluginId}" clipboard.${op}: plugin is no longer loaded`
      );
    }
  };
  // The clipboard is the person's: when another machine drives the project,
  // theirs is the one the plugin means. A window on this machine, or a project
  // nobody drives, keeps this machine's, as it always was. A call made for a
  // person on another machine who has since gone, or a driver away inside its
  // grace, has nobody's clipboard to use: this one isn't theirs.
  const remoteDriver = (op: string) => {
    const frontend = resolvePluginFrontend(boundProjectId, pluginId);
    if (frontend.kind === "remote") return frontend.endpoint;
    if (
      frontend.kind === "none" &&
      (frontend.reason !== "vacant" ||
        getPluginInvokeOrigin(pluginId)?.endpoint.kind === "remote-view")
    ) {
      throw noFrontendAttached(pluginId, `clipboard.${op}`);
    }
    return null;
  };
  return {
    writeText: async (text): Promise<void> => {
      requireLoaded("writeText");
      if (!deps.declaredCapabilities(pluginId).has("clipboard:write")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" clipboard.writeText requires the "clipboard:write" capability, which is not declared in manifest.capabilities`
        );
      }
      if (typeof text !== "string") {
        throw new Error(`VALIDATION: plugin "${pluginId}" clipboard.writeText requires a string`);
      }
      if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
        throw new Error(
          `PAYLOAD_TOO_LARGE: plugin "${pluginId}" clipboard.writeText text exceeds the ${MAX_TEXT_BYTES} byte limit`
        );
      }
      const remote = remoteDriver("writeText");
      if (remote) {
        await remote.request(
          PluginFrontendMethod.CLIPBOARD,
          { op: "writeText", pluginId, text },
          { timeoutMs: REMOTE_CLIPBOARD_TIMEOUT_MS }
        );
        return;
      }
      clipboard.writeText(text);
    },
    writeImage: async (pngData): Promise<void> => {
      requireLoaded("writeImage");
      // Same token as writeText: putting an image on the clipboard is exactly
      // as reversible as putting text there, so it earns no second capability
      // and doesn't elevate the plugin's action danger.
      if (!deps.declaredCapabilities(pluginId).has("clipboard:write")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" clipboard.writeImage requires the "clipboard:write" capability, which is not declared in manifest.capabilities`
        );
      }
      if (!(pngData instanceof Uint8Array)) {
        throw new Error(
          `VALIDATION: plugin "${pluginId}" clipboard.writeImage requires a Uint8Array of PNG bytes`
        );
      }
      // Size-check before decoding: createFromBuffer allocates a decoded
      // bitmap several times the compressed size, so admitting the bytes
      // first would defeat the cap it exists to enforce.
      if (pngData.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
        throw new Error(
          `PAYLOAD_TOO_LARGE: plugin "${pluginId}" clipboard.writeImage image exceeds the ${MAX_CLIPBOARD_IMAGE_BYTES} byte limit`
        );
      }
      const image = decodeClipboardPng(pngData);
      if (image === null) {
        throw new Error(
          `VALIDATION: plugin "${pluginId}" clipboard.writeImage could not decode the data as an image`
        );
      }
      const remote = remoteDriver("writeImage");
      if (remote) {
        if (pngData.byteLength > REMOTE_CLIPBOARD_IMAGE_MAX_BYTES) {
          throw new Error(
            `PAYLOAD_TOO_LARGE: plugin "${pluginId}" clipboard.writeImage image exceeds the ${REMOTE_CLIPBOARD_IMAGE_MAX_BYTES} byte limit for a clipboard on another machine`
          );
        }
        await remote.request(
          PluginFrontendMethod.CLIPBOARD,
          { op: "writeImage", pluginId, png: new Uint8Array(pngData) },
          { timeoutMs: REMOTE_CLIPBOARD_TIMEOUT_MS }
        );
      } else {
        clipboard.writeImage(image);
      }
      // Audit the byte count only — never the bytes. An image write is
      // user-visible state the plugin changed without a prompt, so it belongs
      // in the trail even though it isn't destructive.
      deps.safeAppendAudit({
        pluginId,
        actionId: "clipboard.writeImage",
        recordType: "ipc-invoke",
        channel: "plugin:clipboard-write-image",
        result: "success",
        errorMessage: "",
        argsHash: deps.safeArgsHash([{ bytes: pngData.byteLength }]),
        durationMs: 0,
      });
    },
    readText: async (): Promise<string> => {
      requireLoaded("readText");
      if (!deps.declaredCapabilities(pluginId).has("clipboard:read")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" clipboard.readText requires the "clipboard:read" capability, which is not declared in manifest.capabilities`
        );
      }
      const remote = remoteDriver("readText");
      if (remote) {
        const text = await remote.request(
          PluginFrontendMethod.CLIPBOARD,
          { op: "readText", pluginId },
          { timeoutMs: REMOTE_CLIPBOARD_TIMEOUT_MS }
        );
        if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
          throw new Error(
            `VALIDATION: plugin "${pluginId}" clipboard.readText got an unusable answer from the driving machine`
          );
        }
        return text;
      }
      // Electron returns "" for empty or non-text clipboard content.
      return clipboard.readText();
    },
  };
}
