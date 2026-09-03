import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelViewProps } from "@daintreehq/plugin-sdk";
import { useHostChannel } from "@daintreehq/plugin-sdk/react";
import {
  DEFAULT_FILE_SORT,
  createVisibilityFilter,
  countHiddenRows,
  flattenTree,
  getFileTypeCategory,
  resolveTreeKey,
  type DirectoryListings,
} from "@daintreehq/plugin-sdk/files";

/**
 * A working file browser built on nothing but the public plugin surface.
 *
 * Authoring source — NOT what ships. `renderer/` is skipped by the build; the
 * committed bundle at `../view/file-tree-view.js` is what `plugin://` loads.
 * Regenerate it with `npm run build:sample-file-tree`.
 *
 * Every capability a file browser needs comes from somewhere a third-party
 * author can reach:
 *
 * - **listing** — `host.fs.readdir(dir, { detail: true })`, relayed through the
 *   plugin's own channel and pulled with `useHostChannel`
 * - **the tree** — `flattenTree` from `@daintreehq/plugin-sdk/files`, which is
 *   the same model Daintree's own browser runs on
 * - **hidden entries, ordering, keyboard, classification** — the rest of that
 *   subpath, so none of it is reimplemented here
 * - **memory** — `persistState`, so expansion and selection survive the panel
 *   being torn down and rebuilt (maximizing a sibling pane, a restart)
 *
 * What is deliberately hand-written is only presentation: rows, indentation and
 * a per-type marker. That is the boundary the SDK draws — it ships the model, a
 * plugin owns the chrome.
 */

/** One entry as the plugin's `list-directory` channel returns it: no path. */
interface DirEntry {
  name: string;
  isDirectory: boolean;
  size?: number;
  mtimeMs?: number;
}

/** What this view remembers between mounts, via `persistState`. */
interface PersistedState {
  expanded: string[];
  selected: string | null;
}

function readPersisted(initialArgs: Record<string, unknown> | undefined): PersistedState {
  const expanded = initialArgs?.["expanded"];
  const selected = initialArgs?.["selected"];
  return {
    expanded: Array.isArray(expanded)
      ? expanded.filter((value): value is string => typeof value === "string")
      : [],
    selected: typeof selected === "string" ? selected : null,
  };
}

export default function FileTreeView({ pluginId, initialArgs, persistState }: PanelViewProps) {
  // `initialArgs` is frozen at mount, so reading it once is the whole contract.
  const restored = useMemo(() => readPersisted(initialArgs), [initialArgs]);

  const [root, setRoot] = useState<string | null>(null);
  const [listings, setListings] = useState<DirectoryListings>(() => new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(restored.expanded));
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  /** Directories the host refused to list, keyed the way the model keys them. */
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | null>(restored.selected);
  const [hideDotfiles, setHideDotfiles] = useState(true);

  const rootChannel = useHostChannel<undefined, { path: string | null }>(pluginId, "root");
  const listChannel = useHostChannel<{ dirPath: string }, DirEntry[]>(pluginId, "list-directory");

  // `invoke` is not a stable reference, so it is read from a ref rather than
  // depended on — otherwise every loader would be rebuilt each render and the
  // effects below would re-fire.
  const invokeList = useRef(listChannel.invoke);
  invokeList.current = listChannel.invoke;
  const invokeRoot = useRef(rootChannel.invoke);
  invokeRoot.current = rootChannel.invoke;

  /**
   * Directory loads are serialized through one chain.
   *
   * `useHostChannel` is deliberately single-flight: a second `invoke` before
   * the first resolves drops the earlier call, which resolves `undefined`. That
   * is right for a click handler and wrong for a fan-out — restoring four
   * expanded directories at once would land only the last one and silently lose
   * the rest. One channel means one queue.
   */
  const queue = useRef<Promise<void>>(Promise.resolve());
  const enqueueLoad = useCallback((dirPath: string, relative: string) => {
    setPending((current) => new Set(current).add(relative));
    setFailed((current) => {
      if (!current.has(relative)) return current;
      const next = new Set(current);
      next.delete(relative);
      return next;
    });
    queue.current = queue.current.then(async () => {
      try {
        const entries = await invokeList.current({ dirPath });
        // `invoke` resolves `undefined` when the host rejected the call —
        // a denied path, a directory that vanished. Recording that per
        // directory is the difference between "empty" and "we could not read
        // it": without it a permission failure renders as a blank panel with
        // nothing to act on, which is the wrong lesson for a sample to teach.
        if (!entries) {
          setFailed((current) => new Set(current).add(relative));
          return;
        }
        setListings((current) => {
          const next = new Map(current);
          // Anchored from the browse root, which is how the model keys the map.
          next.set(
            relative,
            entries.map((entry) => ({
              ...entry,
              path: relative === "" ? entry.name : `${relative}/${entry.name}`,
            }))
          );
          return next;
        });
      } finally {
        setPending((current) => {
          const next = new Set(current);
          next.delete(relative);
          return next;
        });
      }
    });
    return queue.current;
  }, []);

  // One-shot startup: resolve the root, list it, then replay whatever
  // directories were expanded when this panel was last alive. Guarded by a ref
  // rather than by state so a re-render can never restart it.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      const resolved = await invokeRoot.current(undefined);
      if (!resolved?.path) return;
      setRoot(resolved.path);
      await enqueueLoad(resolved.path, "");
      // Restored expansion is worth nothing without the listings behind it.
      for (const dir of restored.expanded) {
        await enqueueLoad(`${resolved.path}/${dir}`, dir);
      }
    })();
  }, [enqueueLoad, restored.expanded]);

  const visibility = useMemo(
    () => ({ hideDotfiles, alwaysHiddenPatterns: [".git", "node_modules"] }),
    [hideDotfiles]
  );
  const isVisible = useMemo(() => createVisibilityFilter(visibility), [visibility]);

  const rows = useMemo(
    () => flattenTree(listings, expanded, pending, "", isVisible, DEFAULT_FILE_SORT),
    [listings, expanded, pending, isVisible]
  );
  const hidden = useMemo(
    () => countHiddenRows(listings, expanded, "", visibility),
    [listings, expanded, visibility]
  );

  const select = useCallback(
    (path: string) => {
      setCursor(path);
      persistState?.({ selected: path });
    },
    [persistState]
  );

  const setExpansion = useCallback(
    (path: string, shouldExpand: boolean) => {
      // Computed outside the updater on purpose. A state updater must be pure —
      // React can invoke it twice (StrictMode does in development) — so the
      // load and the persist both belong out here, where they happen once.
      const next = new Set(expanded);
      if (shouldExpand) next.add(path);
      else next.delete(path);
      setExpanded(next);
      persistState?.({ expanded: [...next] });
      if (shouldExpand && !listings.has(path) && root !== null) {
        void enqueueLoad(`${root}/${path}`, path);
      }
    },
    [expanded, listings, root, enqueueLoad, persistState]
  );

  const activate = useCallback(
    (path: string, isDirectory: boolean) => {
      select(path);
      if (isDirectory) setExpansion(path, !expanded.has(path));
    },
    [select, setExpansion, expanded]
  );

  // Re-resolve and re-list the root. Separate from the one-shot bootstrap so a
  // transient failure is recoverable without reopening the panel.
  const retryRoot = useCallback(async () => {
    const resolved = await invokeRoot.current(undefined);
    if (!resolved?.path) return;
    setRoot(resolved.path);
    await enqueueLoad(resolved.path, "");
  }, [enqueueLoad]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // The SDK decides what the key means against the flattened rows; this view
      // only carries the decision out. That is why arrow behaviour matches
      // Daintree's own tree without this file knowing the rules.
      const intent = resolveTreeKey(event.key, rows, cursor);
      if (!intent) return;
      event.preventDefault();
      switch (intent.type) {
        case "select":
          select(intent.path);
          return;
        case "expand":
          setExpansion(intent.path, true);
          return;
        case "collapse":
          setExpansion(intent.path, false);
          return;
        case "activate": {
          const row = rows.find((candidate) => candidate.path === intent.path);
          if (row) activate(intent.path, row.isDirectory);
          return;
        }
      }
    },
    [rows, cursor, select, setExpansion, activate]
  );

  if (root === null) {
    // Distinguish "nothing to browse" from "we could not read it". The second
    // is what a scope or permission mistake looks like, and it needs a retry
    // rather than an empty panel.
    return failed.has("") ? (
      <div data-testid="file-tree-error">
        <p>Could not read the worktree.</p>
        <button data-testid="file-tree-retry" onClick={() => void retryRoot()}>
          Try again
        </button>
      </div>
    ) : (
      <div data-testid="file-tree-empty">No worktree to browse</div>
    );
  }

  return (
    <div data-testid="file-tree-view" style={{ font: "12px system-ui", padding: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
        <button data-testid="file-tree-toggle-dotfiles" onClick={() => setHideDotfiles((v) => !v)}>
          {hideDotfiles ? "Show hidden" : "Hide hidden"}
        </button>
        <span data-testid="file-tree-hidden-count">
          {`${hidden.dotfiles + hidden.alwaysHidden} hidden`}
        </span>
      </div>
      <div role="tree" tabIndex={0} onKeyDown={onKeyDown} data-testid="file-tree-rows">
        {rows.map((row) => (
          <div
            key={row.path}
            role="treeitem"
            aria-expanded={row.isDirectory ? row.isExpanded : undefined}
            aria-selected={row.path === cursor}
            aria-level={row.depth + 1}
            aria-posinset={row.posInSet}
            aria-setsize={row.setSize}
            data-testid={`file-tree-row-${row.path}`}
            onClick={() => activate(row.path, row.isDirectory)}
            style={{
              paddingLeft: 8 + row.depth * 14,
              background: row.path === cursor ? "rgba(91,141,239,0.25)" : undefined,
              cursor: "pointer",
            }}
          >
            <span aria-hidden="true">
              {row.isDirectory ? (row.isExpanded ? "▾" : "▸") : "·"}
              {row.isLoading ? "…" : ""}
            </span>{" "}
            <span data-category={getFileTypeCategory(row.name)}>{row.name}</span>
            {/* Per-directory, not global: `listChannel.error` only ever
                describes the latest single-flight call, so it cannot say WHICH
                directory failed. A row that could not be read says so on the
                row, and clicking it retries. */}
            {failed.has(row.path) ? (
              <span data-testid={`file-tree-failed-${row.path}`}>
                {" "}
                — unreadable, click to retry
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
