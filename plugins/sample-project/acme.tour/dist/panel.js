/**
 * View half of the Surface Tour — loaded verbatim by the renderer over
 * `plugin://`, so it must already be valid browser ESM.
 *
 * Two constraints follow from "verbatim", and both fail silently at runtime
 * rather than at build time, because there is no build:
 *
 * 1. `react` is the only bare specifier that resolves. The host import map
 *    serves exactly five (`react`, `react/jsx-runtime`, `react/jsx-dev-runtime`,
 *    `react-dom`, `react-dom/client`) and nothing else — importing
 *    `@daintreehq/plugin-sdk/react` for `useHostChannel` here would throw at
 *    module load. Those hooks exist for plugins built through
 *    `@daintreehq/plugin-vite`, which bundles them in. A hand-written view talks
 *    to `window.electron.plugin` directly, which is all the hooks wrap.
 * 2. No JSX, because nothing transpiles it. `React.createElement`, aliased to
 *    `h` below, is the whole difference.
 */

import React from "react";

const { createElement: h, useCallback, useEffect, useRef, useState } = React;

/** Same shape the host's own file viewer builds; the protocol wants both, absolute. */
function daintreeFileUrl(filePath, rootPath) {
  return `daintree-file://load?path=${encodeURIComponent(filePath)}&root=${encodeURIComponent(rootPath)}`;
}

/**
 * Media over `daintree-file://` has to be fetched into a Blob first — pointing
 * an `<audio>`/`<video>` `src` straight at the protocol looks like it works and
 * then dies seconds in. Chromium's custom-scheme media loader is single-shot:
 * it cannot serve the follow-up range request, so any file whose index trails
 * its payload (the default mp4 layout most recorders emit) fails in the demuxer
 * once playback passes the buffered head. `fetch` bypasses the media loader and
 * a `blob:` URL is fully seekable in-renderer. Both schemes are already in the
 * host CSP's `media-src`.
 *
 * The object URL is revoked in the effect's cleanup, never straight after the
 * element is assigned — revoking early detaches the blob before the element has
 * finished reading it.
 */
function useMediaUrl(filePath, rootPath) {
  const [objectUrl, setObjectUrl] = useState(null);

  useEffect(() => {
    if (!filePath || !rootPath) return;
    const controller = new AbortController();
    let url = null;

    fetch(daintreeFileUrl(filePath, rootPath), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`daintree-file responded ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      })
      .catch(() => {
        if (!controller.signal.aborted) setObjectUrl(null);
      });

    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [filePath, rootPath]);

  return objectUrl;
}

/**
 * Every plugin panel view is handed the same props. `persistState` merges a
 * patch onto the panel record and `initialArgs` reads it back on the next
 * mount, so the two are one bag: it is what survives maximizing a sibling pane,
 * leaving a dock tab, or an app restart. Worker module state and React state
 * survive none of that, and neither survives a hot reload.
 */
export default function TourPanel({ panelId, pluginId, initialArgs, persistState }) {
  // Seeded from `initialArgs`, which is a snapshot taken at mount — it does not
  // update in response to your own `persistState` calls, so the working copy
  // lives here.
  const [filePath, setFilePath] = useState(() => initialArgs?.filePath ?? "");
  const [rootPath] = useState(() => initialArgs?.rootPath ?? "");
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  // Pushed from the worker. Pushes are not buffered, so the view pulls what it
  // needs on mount and treats anything arriving here as an update.
  const [panelsOpen, setPanelsOpen] = useState(null);

  const audioUrl = useMediaUrl(initialArgs?.audioPath ?? "", rootPath);
  const persist = useRef(persistState);
  persist.current = persistState;

  useEffect(() => {
    // `onPanel` receives only pushes targeted at THIS panelId via
    // `postToPanel(channel, payload, panelId)`. A broadcast — the same call
    // without a panel id — reaches `plugin.on` subscribers and never lands
    // here, which is the usual reason a push "does nothing".
    return window.electron.plugin.onPanel(pluginId, "tour-state", panelId, (payload) => {
      setPanelsOpen(payload?.panels ?? null);
    });
  }, [pluginId, panelId]);

  const describe = useCallback(async () => {
    setError(null);
    try {
      // The payload is the argument AFTER the channel. On the worker side it
      // arrives as the handler's SECOND parameter, because the IPC context is
      // always the first.
      const result = await window.electron.plugin.invoke(pluginId, "describe-file", {
        path: filePath,
      });
      setSummary(result);
      // Cheap to call: writing state identical to what is stored neither churns
      // the store nor schedules a save.
      persist.current?.({ filePath });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [pluginId, filePath]);

  const openAnother = useCallback(
    () => window.electron.plugin.invoke(pluginId, "open-another"),
    [pluginId]
  );

  const reveal = useCallback(
    () => window.electron.plugin.invoke(pluginId, "reveal", { path: filePath, rootPath }),
    [pluginId, filePath, rootPath]
  );

  // Inline styles off the host's own CSS custom properties, NOT Tailwind
  // classes. The view renders inside Daintree's document, so every `:root`
  // token is in scope — but Tailwind only generates a rule for class names it
  // finds in Daintree's own source at build time, and this file is delivered at
  // runtime. A utility Daintree happens to use elsewhere works; one it doesn't
  // silently renders as nothing.
  return h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 12, padding: 16, minHeight: 0 } },
    h(
      "label",
      { style: { display: "flex", flexDirection: "column", gap: 4 } },
      h("span", { style: { color: "var(--color-text-secondary)" } }, "Absolute file path"),
      h("input", {
        value: filePath,
        onChange: (event) => setFilePath(event.target.value),
        style: {
          background: "var(--color-card)",
          border: "1px solid var(--color-border)",
          borderRadius: 6,
          color: "var(--color-text-primary)",
          padding: "6px 8px",
        },
      })
    ),
    h(
      "div",
      { style: { display: "flex", gap: 8 } },
      h("button", { onClick: describe }, "Describe"),
      h("button", { onClick: reveal, disabled: !filePath }, "Open in file panel"),
      h("button", { onClick: openAnother }, "Open another tour panel")
    ),
    error
      ? h("p", { style: { color: "var(--color-status-error)" } }, error)
      : summary
        ? h(
            "p",
            { style: { color: "var(--color-text-secondary)" } },
            `${summary.lines} lines, ${summary.characters} characters`
          )
        : null,
    panelsOpen === null
      ? null
      : h(
          "p",
          { style: { color: "var(--color-text-muted)" } },
          `${panelsOpen} tour panel(s) open — pushed from the worker`
        ),
    audioUrl ? h("audio", { src: audioUrl, controls: true }) : null
  );
}
