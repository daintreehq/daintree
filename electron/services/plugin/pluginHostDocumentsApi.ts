import fs from "fs/promises";
import path from "path";
import { resilientAtomicWriteFile } from "../../utils/fs.js";
import { runExclusive } from "../../utils/keyedMutex.js";
import { pathToFileURL } from "node:url";
import {
  MAX_HTML_BYTES,
  renderHtmlToPdf,
  reserveConsentWait,
  reserveRender,
  validateRenderPdfOptions,
  type RenderReservation,
} from "./pluginPdfRenderer.js";

import { PluginPathNotAllowedError } from "./pluginFsContainment.js";
import { assertPluginCallerDrives } from "./pluginDriveLease.js";

import type {
  BuiltInPluginCapability,
  PluginDocumentsApi,
  PluginRenderPdfResult,
} from "../../../shared/types/plugin.js";
import type { FsRootClass } from "./PluginServiceTypes.js";
import {
  type PluginHostFactoryDeps,
  trackPluginDisposer,
  ensureCapabilityConsent,
} from "./pluginHostDeps.js";
import {
  sha256Hex,
  fsTargetError,
  withVerifiedReadHandle,
  containToDeclaredRoots,
} from "./pluginHostFsApi.js";

/**
 * Host-mediated HTML-to-PDF export (`host.documents`). Electron's `printToPDF`
 * lives in main, out of reach of plugin code, so without this a plugin that
 * could render an invoice as HTML had no way to hand the user a PDF.
 *
 * The output is written under exactly the gates `host.fs.writeFile` applies —
 * containment, the per-root-class write capability, JIT consent, a containment
 * recheck and symlink-leaf refusal inside the per-path critical section, an
 * atomic replace, and an audit record — so a PDF can land nowhere a text write
 * could not. An `htmlPath` source is read-contained and read-gated like
 * `fs.readFile`, and rendered from a bounded snapshot rather than the path.
 * The render itself lives in `pluginPdfRenderer.ts`.
 *
 * The render window is torn down inside every call; a call still queued or
 * rendering when the plugin unloads is cancelled.
 */
export function buildDocumentsApi(
  deps: PluginHostFactoryDeps,
  pluginId: string
): PluginDocumentsApi {
  const requireLoaded = (): void => {
    if (!deps.plugins.has(pluginId)) {
      throw new Error(
        `PLUGIN_UNLOADED: plugin "${pluginId}" documents.renderPdf: plugin is no longer loaded`
      );
    }
  };
  const requireCapForClass = (kind: "read" | "write", rootClass: FsRootClass, what: string) => {
    const needed = `${rootClass === "project" ? "fs:project" : "fs:user-data"}-${kind}` as const;
    if (!deps.declaredCapabilities(pluginId).has(needed)) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" documents.renderPdf requires the "${needed}" capability for ${what} under ${rootClass} paths, which is not declared in manifest.capabilities`
      );
    }
  };
  const moved = () =>
    fsTargetError(
      "TARGET_UNAVAILABLE",
      `Plugin "${pluginId}" documents.renderPdf: the output target moved while the render was running`
    );
  // Containment realpaths the leaf, so the requested leaf itself is inspected.
  const refuseSymlinkLeaf = async (outputPath: string) => {
    const leafStat = await fs
      .lstat(path.resolve(outputPath))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (leafStat?.isSymbolicLink()) {
      throw fsTargetError(
        "TARGET_IS_SYMLINK",
        `Plugin "${pluginId}" documents.renderPdf: refusing to write through a symlink`
      );
    }
    return leafStat;
  };

  const htmlMoved = () =>
    fsTargetError(
      "TARGET_UNAVAILABLE",
      `Plugin "${pluginId}" documents.renderPdf: htmlPath moved while the render was waiting`
    );
  const tooLarge = () =>
    new Error(
      `PAYLOAD_TOO_LARGE: plugin "${pluginId}" documents.renderPdf: htmlPath exceeds the ${MAX_HTML_BYTES} byte limit`
    );
  // The page is rendered from a snapshot taken here, after the consent prompt,
  // never from the path: containment is proven again and the bytes come
  // through the same verified, non-following read `fs.readFile` uses, so a
  // file swapped for a symlink while the call waited cannot be what renders.
  const readHtmlSnapshot = async (htmlPath: string, expected: string): Promise<string> => {
    const recheck = await containToDeclaredRoots(deps, pluginId, htmlPath).catch(
      (error: unknown) => {
        if (error instanceof PluginPathNotAllowedError) throw htmlMoved();
        throw error;
      }
    );
    if (recheck.resolved !== expected) throw htmlMoved();
    requireLoaded();
    requireCapForClass("read", recheck.rootClass, "htmlPath");
    const bytes = await withVerifiedReadHandle(
      pluginId,
      "renderPdf",
      expected,
      fs.constants.O_NONBLOCK ?? 0,
      async (handle, opened) => {
        if (!opened.isFile()) {
          throw new Error(
            `INVALID_PATH: plugin "${pluginId}" documents.renderPdf: htmlPath is not a file: ${expected}`
          );
        }
        // limit + 1 so an oversized file is recognised without holding more of it.
        const buffer = Buffer.allocUnsafe(MAX_HTML_BYTES + 1);
        let filled = 0;
        while (filled < buffer.length) {
          const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        if (filled > MAX_HTML_BYTES) throw tooLarge();
        return buffer.subarray(0, filled);
      }
    );
    return bytes.toString("utf-8");
  };

  return {
    renderPdf: async (rawOptions): Promise<PluginRenderPdfResult> => {
      requireLoaded();
      const caps = deps.declaredCapabilities(pluginId);
      if (!caps.has("fs:project-write") && !caps.has("fs:user-data-write")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" documents.renderPdf requires "fs:project-write" or "fs:user-data-write", which is not declared in manifest.capabilities`
        );
      }
      // Same single consent unit as `fs.writeFile`, so a plugin already allowed
      // to write files is not asked again for a PDF.
      const writeCap: BuiltInPluginCapability = caps.has("fs:project-write")
        ? "fs:project-write"
        : "fs:user-data-write";
      const { source, outputPath, print } = validateRenderPdfOptions(pluginId, rawOptions);
      // Two phases, each bounded so the HTML every parked call carries stays
      // bounded too. Until consent is given the call holds only a per-plugin
      // consent-wait place and no clock runs: the prompt goes at the user's
      // pace, and an unanswered one must not tie up a render slot. From consent
      // on it holds a render slot, and the 30 s deadline that starts with the
      // slot covers reading the input, the queue wait and the render.
      const consentWait = reserveConsentWait(pluginId);
      let reservation: RenderReservation | null = null;
      const within = <T>(step: Promise<T>): Promise<T> => {
        step.catch(() => undefined);
        return reservation ? Promise.race([step, reservation.expired]) : step;
      };
      const cancel = new AbortController();
      const untrack = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => cancel.abort());
      try {
        // A first export into the plugin's own namespace may find the data dir
        // missing. It is created only once consent is given, so until then the
        // output is checked against what exists: its parent must be the data
        // dir itself, which is host-owned and needs no containment proof.
        const dataDir = deps.pluginDataDir(pluginId);
        const normalizedOutput = path.normalize(outputPath);
        const inDataDir = deps.isPathUnder(dataDir, normalizedOutput);
        if (inDataDir) requireCapForClass("write", "user-data", "the output");
        const dataDirMissing =
          inDataDir && (await fs.stat(dataDir).catch(() => null))?.isDirectory() !== true;
        if (dataDirMissing && path.dirname(normalizedOutput) !== path.normalize(dataDir)) {
          throw new Error(
            `INVALID_PATH: plugin "${pluginId}" documents.renderPdf: the output's parent directory does not exist: ${path.dirname(normalizedOutput)}`
          );
        }

        const containOutput = async () => {
          const contained = await containToDeclaredRoots(deps, pluginId, outputPath);
          requireLoaded();
          requireCapForClass("write", contained.rootClass, "the output");
          await assertPluginCallerDrives(pluginId, "documents.renderPdf", {
            paths: [contained.resolved],
          });
          requireLoaded();
          const parent = await fs.stat(path.dirname(contained.resolved)).catch(() => null);
          if (!parent?.isDirectory()) {
            throw new Error(
              `INVALID_PATH: plugin "${pluginId}" documents.renderPdf: the output's parent directory does not exist: ${path.dirname(contained.resolved)}`
            );
          }
          return contained;
        };
        let output = dataDirMissing ? null : await containOutput();

        let input: { htmlPath: string; resolved: string; root: string } | null = null;
        if (source.kind === "path") {
          const contained = await containToDeclaredRoots(deps, pluginId, source.htmlPath);
          requireLoaded();
          requireCapForClass("read", contained.rootClass, "htmlPath");
          const inputStat = await fs.stat(contained.resolved).catch(() => null);
          if (!inputStat?.isFile()) {
            throw new Error(
              `INVALID_PATH: plugin "${pluginId}" documents.renderPdf: htmlPath is not a file: ${contained.resolved}`
            );
          }
          if (inputStat.size > MAX_HTML_BYTES) throw tooLarge();
          input = { htmlPath: source.htmlPath, resolved: contained.resolved, root: contained.root };
        }

        // Checked again once the render is done; this early pass only spares a
        // render whose write is already certain to be refused.
        if (output) await refuseSymlinkLeaf(outputPath);
        await ensureCapabilityConsent(deps, pluginId, writeCap);
        requireLoaded();
        consentWait.release();
        reservation = reserveRender(pluginId);
        if (!output) {
          await within(fs.mkdir(dataDir, { recursive: true }));
          output = await within(containOutput());
        }
        const contained = output;

        let html: string;
        let baseUrl: string | null = null;
        let resourceRoot: string | null = null;
        if (input) {
          html = await within(readHtmlSnapshot(input.htmlPath, input.resolved));
          baseUrl = pathToFileURL(path.dirname(input.resolved) + path.sep).href;
          resourceRoot = await within(fs.realpath(input.root));
        } else {
          html = source.kind === "html" ? source.html : "";
          // Inline HTML may still reference absolute file: URLs, but only inside
          // a root the plugin could read for itself.
          const readCap =
            contained.rootClass === "project" ? "fs:project-read" : "fs:user-data-read";
          if (caps.has(readCap)) resourceRoot = await within(fs.realpath(contained.root));
        }
        requireLoaded();
        const pdf = await within(
          renderHtmlToPdf({
            html,
            baseUrl,
            resourceRoot,
            print,
            signal: cancel.signal,
            timeoutMs: reservation.remainingMs(),
          })
        );
        requireLoaded();

        const revision = await runExclusive(contained.resolved, async () => {
          requireLoaded();
          // The consent prompt, the render and the queue wait can each take long
          // enough for the path to change, so containment is proven again here,
          // exactly as `fs.writeFile` does.
          const recheck = await containToDeclaredRoots(deps, pluginId, outputPath).catch(
            (error: unknown) => {
              if (error instanceof PluginPathNotAllowedError) throw moved();
              throw error;
            }
          );
          if (recheck.resolved !== contained.resolved) throw moved();
          await assertPluginCallerDrives(pluginId, "documents.renderPdf", {
            paths: [contained.resolved],
          });
          requireLoaded();
          const leafStat = await refuseSymlinkLeaf(outputPath);
          const mode = leafStat ? leafStat.mode & 0o777 : undefined;
          requireLoaded();
          await resilientAtomicWriteFile(
            contained.resolved,
            pdf,
            undefined,
            mode === undefined ? undefined : { mode }
          );
          return sha256Hex(pdf);
        });
        deps.safeAppendAudit({
          pluginId,
          actionId: `documents.renderPdf:${contained.resolved}`,
          recordType: "ipc-invoke",
          channel: "plugin:fs-write",
          result: "success",
          errorMessage: "",
          argsHash: deps.safeArgsHash([{ path: contained.resolved, bytes: pdf.byteLength }]),
          durationMs: 0,
        });
        return { path: contained.resolved, bytes: pdf.byteLength, revision };
      } finally {
        consentWait.release();
        reservation?.release();
        untrack();
      }
    },
  };
}
