import { app, protocol } from "electron";
import { createAppProtocolHandler } from "./protocols/app.js";
import { createDaintreeFileProtocolHandler } from "./protocols/file.js";
import { createDaintreeMediaProtocolHandler } from "./protocols/media.js";
import { createDaintreePdfProtocolHandler } from "./protocols/pdf.js";
import { registerPluginProtocolForSession } from "./protocols/plugin.js";

export { getDistPath, registerAppProtocol } from "./protocols/app.js";
export {
  buildDaintreeFileErrorHeaders,
  isMediaMimeType,
  previewByteCeiling,
  resolveContainedRealPath,
} from "./protocols/containedFile.js";
export {
  buildContainedFileUrl,
  parseHostScopedFileUrl,
  setHostFileRequestProxy,
  type ContainedFileScheme,
  type HostFileRequestProxy,
  type HostScopedFileTarget,
} from "./protocols/hostScoped.js";
export {
  serveContainedFileRequest,
  serveOpenedContainedFile,
  type OpenedContainedFile,
} from "./protocols/hostServe.js";
export { buildPdfContentDisposition } from "./protocols/pdf.js";
export {
  createPluginProtocolHandler,
  fetchLocalPluginAsset,
  registerPluginProtocol,
  setPluginDirResolver,
  setPluginTourAudioResolver,
  setRemotePluginAssetProxy,
  type GetPluginRootByAuthority,
  type GetPluginTourAudio,
  type RemotePluginAsset,
  type RemotePluginAssetProxy,
} from "./protocols/plugin.js";
export { applyDaintreeAppCspToSession, setupWebviewCSP } from "./protocols/sessionCsp.js";

// Track which sessions have had protocols registered to avoid double-registration
const registeredSessions = new WeakSet<Electron.Session>();

/**
 * Register app://, daintree-file://, daintree-pdf://, daintree-media:// and
 * plugin:// protocol handlers on a specific session. daintree-html:// is
 * deliberately absent: previews load only in their own session
 * (htmlPreviewSession.ts), so no app session can frame one without its
 * WebRTC lockdown.
 * Safe to call multiple times — skips sessions that are already configured.
 * Used for per-project session partitions that don't inherit the default session's handlers.
 *
 * `plugin://` is only registered when `registerPluginProtocol()` has already
 * cached a resolver — at runtime the default-session registration in
 * `app.whenReady()` always runs before any project view is created, so this is
 * effectively unconditional in production. Tests that don't exercise plugin://
 * skip this branch.
 */
export function registerProtocolsForSession(ses: Electron.Session, distPath: string): void {
  if (registeredSessions.has(ses)) return;
  registeredSessions.add(ses);

  ses.protocol.handle("app", createAppProtocolHandler(distPath));
  ses.protocol.handle("daintree-file", createDaintreeFileProtocolHandler());
  ses.protocol.handle("daintree-pdf", createDaintreePdfProtocolHandler());
  ses.protocol.handle("daintree-media", createDaintreeMediaProtocolHandler());
  registerPluginProtocolForSession(ses);
}

/**
 * Claim the `daintree://` URI scheme as this build's OS-level default protocol
 * client (#9559) so deep links route to the running app. The durable OS
 * association is declared in `electron-builder.config.cjs` (`protocols`); this
 * runtime call ensures the launched build owns the scheme.
 *
 * Packaged-only: an unsigned dev/E2E build registering `daintree://` would
 * point the OS at the dev binary and pollute the user's Launch Services / XDG
 * handler database — the same reasoning that gates the macOS `.dntr`
 * `fileAssociations` on `CSC_LINK`.
 */
export function registerDeepLinkProtocolClient(): void {
  if (!app.isPackaged) return;
  app.setAsDefaultProtocolClient("daintree");
}

export function registerDaintreeFileProtocol(): void {
  protocol.handle("daintree-file", createDaintreeFileProtocolHandler());
}

export function registerDaintreePdfProtocol(): void {
  protocol.handle("daintree-pdf", createDaintreePdfProtocolHandler());
}

export function registerDaintreeMediaProtocol(): void {
  protocol.handle("daintree-media", createDaintreeMediaProtocolHandler());
}
