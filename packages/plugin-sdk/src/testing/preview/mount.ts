import { Fragment, StrictMode, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { formatErrorMessage } from "../../../../../shared/utils/errorMessage.js";
import { resetHostChannelCache } from "../../react/useCachedHostChannel.js";
import { createMockViewHost, type MockViewHost } from "./mockViewHost.js";
import { createPreviewPanelController, type PreviewPanelController } from "./panelProps.js";
import {
  composePanelStory,
  type ComposedPanelStory,
  type PanelStoriesMeta,
  type PanelStory,
} from "./stories.js";
import { DEFAULT_PREVIEW_THEME_ID, applyPreviewTheme, type PreviewTheme } from "./themes.js";

/** Attribute the page's readiness is published on: `ready` or `failed`, absent while pending. */
export const PREVIEW_READY_ATTRIBUTE = "data-daintree-preview-ready";
/** Why the preview failed, beside {@link PREVIEW_READY_ATTRIBUTE}`="failed"`. */
export const PREVIEW_FAILURE_ATTRIBUTE = "data-daintree-preview-failure";

/**
 * Where the preview's Tailwind CSS comes from.
 *
 * Daintree compiles a plugin's classes at runtime, scoped to the view's style
 * root, so a preview styled the way the host styles it plugs the host's own
 * style runtime in here (Daintree's repo does, in its plugin panel preview
 * page). Without one the view renders with whatever stylesheets the page
 * loads, and readiness has no styles to wait for.
 */
export interface PreviewStyleHost {
  /** Bring the view's style root into the styling contract. Returns the release. */
  registerRoot(root: Element): () => void;
  /** Resolves once CSS for what is in the DOM now has been installed, or failed to. */
  settled?(): Promise<void>;
  /** Why styles failed to install, or `null` while nothing has failed. */
  failure(): string | null;
  /**
   * Hear about a failure that happens after the page reported ready — a class
   * that appeared later and did not compile. Returns the unsubscribe.
   */
  subscribe?(onFailure: () => void): () => void;
}

/** Something the page waits on before it is ready — the UI kit, for one. */
export interface PreviewReadinessGate {
  readonly ready: PromiseLike<unknown>;
}

export type PreviewReadiness = { status: "ready" } | { status: "failed"; reason: string };

export interface MountPanelPreviewOptions {
  /** The element the preview renders into. Its children are replaced. */
  container: HTMLElement;
  /** Built-in theme id. Defaults to `daintree`. */
  theme?: string;
  /** Where theme variables go. Defaults to the container's document root. */
  themeRoot?: HTMLElement;
  styles?: PreviewStyleHost;
  /** Gate readiness on the UI kit, for a panel that uses it. */
  kit?: PreviewReadinessGate;
  /** Render under `StrictMode`, as Daintree's dev builds do. Default `true`. */
  strictMode?: boolean;
}

/**
 * A mounted preview. One per document: the mock bridges live on
 * `globalThis.electron`, which only one session can own at a time.
 */
export interface MountedPanelPreview {
  readonly host: MockViewHost;
  readonly panel: PreviewPanelController;
  readonly theme: PreviewTheme;
  /** The marked style root the view renders into. */
  readonly canvasElement: HTMLElement;
  /**
   * Settles once the story has mounted, `play` has run, and fonts, kit and
   * styles are in — or with the first of them that failed. Start the mount,
   * let React commit, then await this; under `act()`, not inside the same
   * `act()` callback that mounted.
   */
  readonly ready: Promise<PreviewReadiness>;
  /** Switch theme in place, keeping the view and its state. Readiness re-arms. */
  setTheme(themeId: string): Promise<PreviewReadiness>;
  /**
   * Mount a fresh attempt of the same panel, as a sibling maximize or a
   * project switch does: it reads back what the last one persisted.
   */
  remount(): Promise<PreviewReadiness>;
  /** Unmount, release the style root, and take the mock bridges off the page. */
  unmount(): void;
}

function errorText(error: unknown): string {
  return formatErrorMessage(error, String(error));
}

function MountProbe({ onMounted }: { onMounted: () => void }) {
  // Siblings commit before this effect runs, so it fires once the view is in
  // the DOM. StrictMode fires it twice; the callback is idempotent.
  useEffect(() => {
    onMounted();
  }, [onMounted]);
  return null;
}

interface PendingMount {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function pendingMount(): PendingMount {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Mount a composed story against a fresh mock view host. Lower level than
 * {@link mountPanelStory}, for a caller that has already merged meta and story.
 */
export function mountComposedPanelStory(
  composed: ComposedPanelStory,
  options: MountPanelPreviewOptions
): MountedPanelPreview {
  const { container } = options;
  const doc = container.ownerDocument;
  const themeRoot = options.themeRoot ?? doc.documentElement;
  const publishTargets = themeRoot === container ? [container] : [container, doc.documentElement];

  // Validated before anything global is touched: an unknown theme throws here
  // and leaves the page as it was.
  let theme = applyPreviewTheme(themeRoot, options.theme ?? DEFAULT_PREVIEW_THEME_ID);

  const panel = createPreviewPanelController(composed.args);
  const host = createMockViewHost({
    pluginId: panel.pluginId,
    channels: composed.fixtures.channels,
    viewCached: composed.fixtures.viewCached,
  });

  const cleanups: Array<() => void> = [];
  const runCleanups = () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch {
        // Keep unwinding: one failed release must not leave the bridges installed.
      }
    }
  };

  let root: Root;
  const canvasElement = doc.createElement("div");
  let current: PendingMount | null = null;
  try {
    cleanups.push(host.install());
    // The cached-channel cache is module state shared by every view in the
    // document; a previous story's answers must not leak into this one.
    resetHostChannelCache();

    for (const [name, value] of Object.entries(panel.styleRootAttributes)) {
      canvasElement.setAttribute(name, value);
    }
    canvasElement.style.height = "100%";
    container.replaceChildren(canvasElement);
    cleanups.push(() => canvasElement.remove());
    const releaseStyles = options.styles?.registerRoot(canvasElement);
    if (releaseStyles) cleanups.push(releaseStyles);

    root = createRoot(canvasElement, {
      // A view that throws while rendering never commits, so the mount would
      // otherwise wait forever. React 19 reports it here instead.
      onUncaughtError: (error) => current?.reject(error),
    });
    cleanups.push(() => root.unmount());
  } catch (error) {
    runCleanups();
    throw error;
  }

  let generation = 0;
  let disposed = false;
  let published: PreviewReadiness | null = null;

  function publish(readiness: PreviewReadiness | null): void {
    published = readiness;
    for (const target of publishTargets) {
      if (readiness === null) {
        target.removeAttribute(PREVIEW_READY_ATTRIBUTE);
        target.removeAttribute(PREVIEW_FAILURE_ATTRIBUTE);
        continue;
      }
      target.setAttribute(PREVIEW_READY_ATTRIBUTE, readiness.status);
      if (readiness.status === "failed") {
        target.setAttribute(PREVIEW_FAILURE_ATTRIBUTE, readiness.reason);
      } else {
        target.removeAttribute(PREVIEW_FAILURE_ATTRIBUTE);
      }
    }
  }
  cleanups.push(() => publish(null));

  const styleFailure = (): PreviewReadiness | null => {
    const failure = options.styles?.failure() ?? null;
    return failure === null
      ? null
      : { status: "failed", reason: `styles failed to install: ${failure}` };
  };

  // A class that shows up after the page said ready, and does not compile,
  // takes the ready state back: a capture taken now would be half-styled.
  const unsubscribeStyles = options.styles?.subscribe?.(() => {
    if (disposed || published?.status !== "ready") return;
    const failed = styleFailure();
    if (failed) publish(failed);
  });
  if (unsubscribeStyles) cleanups.push(unsubscribeStyles);

  async function settle(mounted: Promise<void>, runPlay: boolean): Promise<PreviewReadiness> {
    const fail = (reason: string): PreviewReadiness => ({ status: "failed", reason });
    try {
      await mounted;
    } catch (error) {
      return fail(`story did not mount: ${errorText(error)}`);
    }
    if (runPlay && composed.play) {
      try {
        await composed.play({ host, panel, canvasElement });
      } catch (error) {
        return fail(`play failed: ${errorText(error)}`);
      }
    }
    // Feature-detected: jsdom has no `document.fonts`.
    const fonts = (doc as Document & { fonts?: { ready?: PromiseLike<unknown> } }).fonts;
    try {
      await fonts?.ready;
    } catch (error) {
      return fail(`fonts did not load: ${errorText(error)}`);
    }
    try {
      await options.kit?.ready;
    } catch (error) {
      return fail(`kit did not load: ${errorText(error)}`);
    }
    try {
      await options.styles?.settled?.();
    } catch (error) {
      return fail(`styles did not settle: ${errorText(error)}`);
    }
    return styleFailure() ?? { status: "ready" };
  }

  /** Re-arm readiness and publish it for the latest generation only. */
  function track(mounted: Promise<void>, runPlay: boolean): Promise<PreviewReadiness> {
    const mine = ++generation;
    publish(null);
    return settle(mounted, runPlay).then((readiness) => {
      if (mine === generation && !disposed) publish(readiness);
      return readiness;
    });
  }

  let attemptKey = 0;

  function render(): Promise<void> {
    attemptKey += 1;
    const pending = pendingMount();
    current = pending;
    let settled = false;
    const onMounted = () => {
      if (settled) return;
      settled = true;
      pending.resolve();
    };
    const tree = createElement(
      Fragment,
      null,
      // Keyed per attempt, so a remount is a new instance rather than a re-render.
      createElement(composed.component, { ...panel.props(), key: attemptKey }),
      createElement(MountProbe, { onMounted })
    );
    try {
      root.render(options.strictMode === false ? tree : createElement(StrictMode, null, tree));
    } catch (error) {
      pending.reject(error);
    }
    return pending.promise;
  }

  const ready = track(render(), true);

  return {
    host,
    panel,
    get theme() {
      return theme;
    },
    canvasElement,
    ready,
    setTheme(themeId) {
      theme = applyPreviewTheme(themeRoot, themeId);
      return track(Promise.resolve(), false);
    },
    remount() {
      const mounted = render().then(() => panel.retirePreviousAttempts());
      return track(mounted, false);
    },
    unmount() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      runCleanups();
      // After React's cleanups, as the host aborts it.
      panel.disposeAttempt();
    },
  };
}

/** Mount one story of a `panel.stories.tsx` module against a fresh mock view host. */
export function mountPanelStory(
  meta: PanelStoriesMeta,
  story: PanelStory | undefined,
  options: MountPanelPreviewOptions
): MountedPanelPreview {
  return mountComposedPanelStory(composePanelStory(meta, story), options);
}
