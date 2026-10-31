import { app, session, type Session, type WebContents, type WebPreferences } from "electron";
import { HTML_PREVIEW_PARTITION } from "../../shared/utils/partitionUtils.js";
import { CHANNELS } from "../ipc/channels.js";
import { findTerminalCycleAction } from "../services/menuAccelerators.js";
import { createDaintreeHtmlProtocolHandler } from "./protocols/html.js";

/**
 * Chromium 148 has no per-frame WebRTC control (it ignores the CSP `webrtc`
 * directive, and neither Permissions-Policy nor iframe sandbox covers peer
 * connections), so a rendered preview is cut off from the network one level
 * up, as a WebContents in a session of its own:
 *
 * - UDP: every guest gets the `disable_non_proxied_udp` WebRTC policy, which
 *   applies to every frame in that WebContents, including child frames the
 *   page creates. No STUN, no TURN over UDP, no UDP host candidates.
 * - TCP: that policy still lets WebRTC dial TURN over TCP/TLS directly, but
 *   those sockets resolve through the session's proxy. This proxy is loopback
 *   port 1, where nothing listens, so every connection is refused without
 *   leaving the machine. `<-loopback>` drops Chromium's implicit loopback
 *   bypass, so a TURN server on 127.0.0.1 is refused too.
 *
 * The app shell can't take either: it embeds remote images and localhost
 * frames, and the policy would bind every frame it hosts.
 */
const REFUSING_PROXY = {
  mode: "fixed_servers",
  proxyRules: "http://127.0.0.1:1",
  proxyBypassRules: "<-loopback>",
} as const;

const PREVIEW_SCHEME = "daintree-html:";

// The CSP already confines every load to the token, data: and blob:. This
// refuses network schemes outright if that ever regresses, without the DNS
// lookup a proxied request would leave to the proxy.
const NETWORK_URL_PATTERNS = ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "file://*/*"];

let previewSession: Session | null = null;
let proxyApplied = false;
let sessionReady: Promise<void> | null = null;

/**
 * Configure the preview session once at startup: the `daintree-html` handler
 * and nothing else (no app:, daintree-file:, plugin:), the refusing proxy, and
 * the per-guest lockdown. The returned promise settles once the proxy is
 * confirmed or has failed (it never rejects); startup awaits it before any
 * window exists, because a refused attach leaves its <webview> blank for
 * good. Previews stay refused if `setProxy` fails, unavailable rather than
 * connected.
 */
export function setupHtmlPreviewSession(): Promise<void> {
  if (sessionReady) return sessionReady;
  const ses = session.fromPartition(HTML_PREVIEW_PARTITION);
  previewSession = ses;
  ses.protocol.handle("daintree-html", createDaintreeHtmlProtocolHandler());
  ses.webRequest.onBeforeRequest({ urls: NETWORK_URL_PATTERNS }, (_details, callback) => {
    callback({ cancel: true });
  });
  ses.on("will-download", (event) => event.preventDefault());
  app.on("web-contents-created", (_event, contents) => {
    if (contents.session === ses) lockDownHtmlPreviewGuest(contents);
  });
  sessionReady = ses.setProxy(REFUSING_PROXY).then(
    () => {
      proxyApplied = true;
    },
    (error: unknown) => {
      console.error("[MAIN] HTML preview session proxy failed; previews stay disabled:", error);
    }
  );
  return sessionReady;
}

/** True for a WebContents in the preview session — a rendered HTML preview guest. */
export function isHtmlPreviewContents(contents: Pick<WebContents, "session">): boolean {
  return previewSession !== null && contents.session === previewSession;
}

function isSamePreviewAuthority(currentUrl: string, nextUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const next = new URL(nextUrl);
    return (
      current.protocol === PREVIEW_SCHEME &&
      next.protocol === PREVIEW_SCHEME &&
      current.host !== "" &&
      current.host === next.host
    );
  } catch {
    return false;
  }
}

function isCloseChord(input: Electron.Input): boolean {
  const isMac = process.platform === "darwin";
  return (
    input.key.toLowerCase() === "w" &&
    ((isMac && input.meta && !input.control) || (!isMac && input.control && !input.meta)) &&
    !input.alt &&
    !input.shift
  );
}

/**
 * The policy is set before the guest's first navigation (`web-contents-created`
 * fires at creation), so it is already in the renderer preferences when the
 * page's scripts run. A preview may follow its own relative links (same token)
 * as the framed preview could; anything else, and every popup, is refused.
 *
 * Keys typed in a guest skip the embedder's `before-input-event`, which the
 * framed preview went through: Cmd/Ctrl+W would reach the native close
 * accelerator and close the whole window (#13634), and the terminal cycle
 * chord would do nothing. Claim the first and hand the second to the embedder.
 */
function lockDownHtmlPreviewGuest(contents: WebContents): void {
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  const guardNavigation = (event: Electron.Event, url: string) => {
    if (isSamePreviewAuthority(contents.getURL(), url)) return;
    console.warn(`[MAIN] Blocked HTML preview navigation to ${safeOrigin(url)}`);
    event.preventDefault();
  };
  contents.on("will-navigate", guardNavigation);
  contents.on("will-redirect", guardNavigation);
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (isCloseChord(input)) {
      event.preventDefault();
      return;
    }
    const cycleAction = findTerminalCycleAction(input);
    const embedder = contents.hostWebContents;
    if (cycleAction && embedder && !embedder.isDestroyed()) {
      event.preventDefault();
      embedder.send(CHANNELS.MENU_ACTION, cycleAction);
    }
  });
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "an invalid URL";
  }
}

export type HtmlPreviewAttachVerdict = "not-preview" | "allowed" | "refused";

function isPreviewSrc(src: string | undefined): boolean {
  if (typeof src !== "string") return false;
  try {
    return new URL(src).protocol === PREVIEW_SCHEME;
  } catch {
    return false;
  }
}

/**
 * The `will-attach-webview` rule for previews, shared by every host that
 * allows `<webview>`: a `daintree-html://` src attaches only in the preview
 * partition, and the preview partition only ever loads that src. An allowed
 * attach gets the same hardened preferences as any other guest, pinned to the
 * preview partition. `not-preview` hands the attach back to the host's own gate.
 */
export function gateHtmlPreviewWebviewAttach(
  webPreferences: WebPreferences,
  params: Record<string, string>
): HtmlPreviewAttachVerdict {
  const previewSrc = isPreviewSrc(params.src);
  const previewPartition = params.partition === HTML_PREVIEW_PARTITION;
  if (!previewSrc && !previewPartition) return "not-preview";
  if (!previewSrc || !previewPartition || !proxyApplied) return "refused";

  delete webPreferences.preload;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webviewTag = false;
  webPreferences.navigateOnDragDrop = false;
  webPreferences.disableBlinkFeatures = "Auxclick";
  webPreferences.partition = HTML_PREVIEW_PARTITION;
  return "allowed";
}

/** @internal Reset module state for tests only. */
export function _resetHtmlPreviewSessionForTesting(): void {
  previewSession = null;
  proxyApplied = false;
  sessionReady = null;
}
