import fs from "node:fs";
import path from "node:path";

/** The plugin roots the main build compiles and copies into `dist-electron/plugins`. */
export const PLUGIN_TIERS = ["builtin", "sample"];

/**
 * Plugin source subdirectories the asset sync must NOT mirror verbatim:
 * `main/` is compiled by esbuild into the same output tree, `renderer/` is
 * consumed by the host's Vite renderer build (not loaded by the plugin at
 * runtime), `shared/` holds `import type`-only siblings esbuild erases (never
 * loaded at runtime — same compile-time category as `main`/`renderer`), and
 * `__tests__/`, `__fixtures__/` and `review/` (the plugin panel preview's
 * `panel.stories.tsx`) are dev-only. Every other subdirectory a plugin bundles
 * (`bin/`, `mcp/`, `view/`, …) is shipped as-is so `./`-relative
 * `command`/`args` paths resolve at runtime instead of ENOENT-ing (#10579).
 * The same names are reserved in the output: the sync never touches them
 * there, which is what keeps esbuild's `main/` output safe.
 */
export const PLUGIN_EXTRA_ASSET_SKIP_DIRS = new Set([
  "main",
  "renderer",
  "shared",
  "__tests__",
  "__fixtures__",
  "review",
]);

/**
 * Whether a plugin directory entry is one the asset sync never copies, and
 * never touches in the output. Lower-cased: on a case-insensitive filesystem
 * `Main/` names `main/`.
 */
export function isReservedAssetDir(name) {
  return PLUGIN_EXTRA_ASSET_SKIP_DIRS.has(name.toLowerCase());
}

/**
 * True when `child` resolves to a path strictly inside `parent` — guards the
 * asset copy/validation against `./`-relative manifest paths that escape the
 * plugin directory via `..` segments. `mcpServers[].command` is not refined the
 * way agent commands are (electron/schemas/plugin.ts), so a manifest can name
 * `./../sibling` and pass schema validation.
 */
export function isInsideDir(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Collect the `./`-relative file paths a manifest will spawn — agent
 * `command`/`args` and MCP server `command`/`args`. Bare PATH binaries (`echo`,
 * `node`) and absolute/`..` paths are rejected at manifest-validation time, so
 * only `./`-prefixed entries name a file the build must have shipped. Tolerant
 * of a wrong-shaped manifest, which the watcher can copy mid-edit.
 */
export function collectRelativeAssetPaths(manifest) {
  const list = (value) => (Array.isArray(value) ? value : []);
  const contributes = manifest?.contributes;
  const paths = [];
  for (const source of [...list(contributes?.agents), ...list(contributes?.mcpServers)]) {
    for (const value of [source?.command, ...list(source?.args)]) {
      if (typeof value === "string" && value.startsWith("./")) paths.push(value);
    }
  }
  return paths;
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function listDirNames(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  }
}

/**
 * What a source entry ships as. A symlink ships as a copy of the file it names,
 * and only when that file is inside the plugin; a link to a directory or to
 * anything outside ships nothing.
 */
function sourceKind(file, entry, pluginRealDir) {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return null;
  try {
    const real = fs.realpathSync(file);
    return isInsideDir(real, pluginRealDir) && fs.statSync(real).isFile() ? "file" : null;
  } catch {
    return null;
  }
}

/**
 * An output entry's kind as found, without following links: a symlink matches
 * nothing the sync wants, so it is removed rather than written through.
 */
function outputKind(entry) {
  if (entry.isDirectory()) return "dir";
  return entry.isFile() ? "file" : "other";
}

/**
 * The files a manifest ships beside itself: each `./` command or arg naming a
 * file directly in the plugin directory. A nested path ships with its
 * directory, or not at all under a reserved one, where it could not be told
 * apart from compiled output. `null` when the manifest can't be parsed, so a
 * half-saved manifest never prunes the files it names.
 */
function manifestSiblingFiles(srcPluginDir, manifestText) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return null;
  }
  const names = new Set();
  for (const relPath of collectRelativeAssetPaths(manifest)) {
    const resolved = path.resolve(srcPluginDir, relPath);
    if (isInsideDir(resolved, srcPluginDir) && path.dirname(resolved) === srcPluginDir) {
      names.add(path.basename(resolved));
    }
  }
  return names;
}

/**
 * Staged beside the destination and renamed over it, so an interrupted copy
 * never leaves a truncated asset and a read-only copy can still be replaced. A
 * staged file a crash leaves behind is pruned by the next sync.
 */
function replaceFile(src, dest, mode) {
  const staged = `${dest}.sync-${process.pid}`;
  try {
    fs.copyFileSync(src, staged);
    fs.chmodSync(staged, mode);
    try {
      fs.renameSync(staged, dest);
    } catch (error) {
      // Windows won't rename over a read-only file.
      if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
      fs.rmSync(dest, { force: true });
      fs.renameSync(staged, dest);
    }
  } finally {
    fs.rmSync(staged, { force: true });
  }
}

function copyIfChanged(src, dest) {
  const srcStat = fs.statSync(src);
  const destStat = fs.lstatSync(dest, { throwIfNoEntry: false });
  // An executable bit flipped on an unchanged script still has to reach the copy.
  const mode = srcStat.mode & 0o777;
  if (
    destStat?.isFile() &&
    destStat.size === srcStat.size &&
    (destStat.mode & 0o777) === mode &&
    fs.readFileSync(src).equals(fs.readFileSync(dest))
  ) {
    return false;
  }
  replaceFile(src, dest, mode);
  return true;
}

/** Make `destDir` hold exactly what `srcDir` holds, recording each change under `rel`. */
function mirrorDir(srcDir, destDir, rel, pluginRealDir, changes) {
  const wanted = new Map();
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const kind = sourceKind(path.join(srcDir, entry.name), entry, pluginRealDir);
    if (kind) wanted.set(entry.name, kind);
  }
  fs.mkdirSync(destDir, { recursive: true });
  // Prune before copying, so a case-only rename on a case-insensitive
  // filesystem never deletes the fresh copy.
  for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
    if (wanted.get(entry.name) === outputKind(entry)) continue;
    fs.rmSync(path.join(destDir, entry.name), { recursive: true, force: true });
    changes.removed.push(`${rel}/${entry.name}`);
  }
  for (const [name, kind] of wanted) {
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    if (kind === "dir") mirrorDir(src, dest, `${rel}/${name}`, pluginRealDir, changes);
    else if (copyIfChanged(src, dest)) changes.copied.push(`${rel}/${name}`);
  }
}

/**
 * Bring one plugin's copied assets in the output in line with its source:
 * `plugin.json`, every subdirectory outside `PLUGIN_EXTRA_ASSET_SKIP_DIRS`
 * mirrored exactly, and any file beside the manifest that a `./`-relative
 * `command`/`args` names. Before #10579 only `plugin.json` (and a hardcoded
 * `view/` for samples) was copied, so a plugin's `bin/` agent scripts or `mcp/`
 * servers were dropped from the build and failed at spawn time.
 *
 * Everything else at the top of the output directory belongs to this sync and
 * is removed when its source is gone, so a renamed script or a deleted asset
 * does not outlive a restart of the watcher; a plugin without a manifest keeps
 * nothing. Reserved names are never touched, which leaves esbuild's `main/`
 * output in place. Records the paths it copied and removed, relative to the
 * plugin directory, in `changes`, which keeps what was done before a failure.
 */
export function syncPluginAssets(
  srcPluginDir,
  destPluginDir,
  changes = { copied: [], removed: [] }
) {
  const src = path.resolve(srcPluginDir);
  const dest = path.resolve(destPluginDir);
  const manifestText = readIfPresent(path.join(src, "plugin.json"));

  const wanted = new Map();
  let keepUnlistedFiles = false;
  let pluginRealDir = src;
  if (manifestText !== null) {
    pluginRealDir = fs.realpathSync(src);
    wanted.set("plugin.json", "file");
    for (const name of listDirNames(src)) {
      if (!isReservedAssetDir(name)) wanted.set(name, "dir");
    }
    const siblings = manifestSiblingFiles(src, manifestText);
    keepUnlistedFiles = siblings === null;
    for (const name of siblings ?? []) {
      if (wanted.has(name) || isReservedAssetDir(name)) continue;
      const file = path.join(src, name);
      const entry = fs.lstatSync(file, { throwIfNoEntry: false });
      if (entry && sourceKind(file, entry, pluginRealDir) === "file") wanted.set(name, "file");
    }
  }

  const destStat = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (destStat && !destStat.isDirectory()) {
    // Never sync through a link: replace whatever stands in for the directory.
    fs.rmSync(dest, { force: true });
    changes.removed.push(".");
  } else if (destStat) {
    for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
      if (isReservedAssetDir(entry.name)) continue;
      const kind = outputKind(entry);
      if (wanted.get(entry.name) === kind) continue;
      if (keepUnlistedFiles && kind === "file" && !wanted.has(entry.name)) continue;
      fs.rmSync(path.join(dest, entry.name), { recursive: true, force: true });
      changes.removed.push(entry.name);
    }
  }
  if (wanted.size === 0) return changes;

  fs.mkdirSync(dest, { recursive: true });
  for (const [name, kind] of wanted) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (kind === "dir") mirrorDir(from, to, name, pluginRealDir, changes);
    else if (copyIfChanged(from, to)) changes.copied.push(name);
  }
  return changes;
}

/**
 * Sync every plugin of one tier, including output directories whose source
 * plugin is gone, so a cold start drops a removed plugin's manifest and assets.
 * Returns the plugins that changed.
 */
export function syncPluginTier(srcTierDir, destTierDir) {
  const names = new Set([...listDirNames(srcTierDir), ...listDirNames(destTierDir)]);
  const changed = [];
  for (const name of [...names].sort()) {
    const { copied, removed } = syncPluginAssets(
      path.join(srcTierDir, name),
      path.join(destTierDir, name)
    );
    if (copied.length > 0 || removed.length > 0) changed.push({ name, copied, removed });
  }
  return changed;
}

// A POSIX file name may contain a backslash, so split only where the platform does.
const PATH_SEPARATOR = process.platform === "win32" ? /[\\/]/ : /\//;

/**
 * Keep the copied plugin assets current while the development watcher runs.
 * A recursive `fs.watch` on each source tier marks the plugin an event names,
 * and a short debounce syncs what it marked. An event naming no current plugin
 * directory (the tier itself, a `.` path, a Windows short name, no name at all)
 * rescans its whole tier instead. Passes never overlap: edits that land while
 * one runs, including while `onChange` awaits, are drained by the next. A
 * periodic rescan of every tier backs up the watcher, which can miss an edit
 * (Linux's recursive watch keeps the old inode after an atomic save) or fail
 * outright, and covers a tier that did not exist when it started.
 *
 * `initialSync` mirrors every tier before this returns and reports what it
 * changed through `onChange` like any later pass, so an edit made between the
 * caller's own checks and this sync is still rechecked. `onChange` receives
 * `{ tier, name, copied, removed }` for each plugin a pass changed. `close()`
 * stops the watcher and resolves once any pass in flight has finished.
 */
export function watchPluginAssets({
  srcRoot,
  destRoot,
  tiers = PLUGIN_TIERS,
  debounceMs = 100,
  rescanMs = 2000,
  initialSync = false,
  onChange = async () => {},
  onError = (error) => console.warn("[Build] Plugin asset watcher:", error),
  watch = fs.watch,
}) {
  const dirtyTiers = new Set();
  const dirtyPlugins = new Map();
  const watchers = [];
  let pending = [];
  let debounceTimer = null;
  let draining = null;
  let closed = false;

  function onEvent(tier, filename) {
    if (closed) return;
    const parts = filename ? String(filename).split(PATH_SEPARATOR).filter(Boolean) : [];
    // esbuild owns these sources (or they are dev-only), and the sync never copies them.
    if (parts.length >= 2 && isReservedAssetDir(parts[1])) return;
    if (parts.length >= 2) dirtyPlugins.set(`${tier}/${parts[0]}`, { tier, name: parts[0] });
    else dirtyTiers.add(tier);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      drain();
    }, debounceMs);
  }

  function takeBatch() {
    const plugins = [...dirtyPlugins.values()];
    const scanTiers = new Set(dirtyTiers);
    dirtyTiers.clear();
    dirtyPlugins.clear();
    const tierNames = new Map();
    const namesIn = (tier) => {
      if (!tierNames.has(tier)) {
        let names = new Set();
        try {
          names = new Set([
            ...listDirNames(path.join(srcRoot, tier)),
            ...listDirNames(path.join(destRoot, tier)),
          ]);
        } catch (error) {
          // The rescan tries the tier again.
          onError(error);
        }
        tierNames.set(tier, names);
      }
      return tierNames.get(tier);
    };
    const targets = new Map();
    for (const { tier, name } of plugins) {
      if (namesIn(tier).has(name)) targets.set(`${tier}/${name}`, { tier, name });
      else scanTiers.add(tier);
    }
    for (const tier of scanTiers) {
      for (const name of namesIn(tier)) targets.set(`${tier}/${name}`, { tier, name });
    }
    return [...targets.values()];
  }

  function syncDirty() {
    for (const { tier, name } of takeBatch()) {
      const changes = { copied: [], removed: [] };
      try {
        syncPluginAssets(path.join(srcRoot, tier, name), path.join(destRoot, tier, name), changes);
      } catch (error) {
        // A file can vanish mid-save; the event that follows, or the rescan, syncs it again.
        onError(error);
      }
      // Kept from a pass that failed partway, so a manifest it copied is still rechecked.
      if (changes.copied.length > 0 || changes.removed.length > 0) {
        pending.push({ tier, name, ...changes });
      }
    }
  }

  async function runPasses() {
    while (!closed) {
      syncDirty();
      if (pending.length === 0) return;
      const changed = pending;
      pending = [];
      try {
        await onChange(changed);
      } catch (error) {
        onError(error);
      }
    }
  }

  function drain() {
    if (closed || draining) return;
    draining = runPasses().finally(() => {
      draining = null;
    });
  }

  for (const tier of tiers) {
    const dir = path.join(srcRoot, tier);
    if (!fs.existsSync(dir)) continue;
    try {
      const watcher = watch(dir, { recursive: true }, (_event, filename) =>
        onEvent(tier, filename)
      );
      // The rescan keeps the output current without it.
      watcher.on("error", onError);
      watchers.push(watcher);
    } catch (error) {
      onError(error);
    }
  }

  if (initialSync) {
    for (const tier of tiers) dirtyTiers.add(tier);
    syncDirty();
    drain();
  }

  const rescanTimer = setInterval(() => {
    for (const tier of tiers) dirtyTiers.add(tier);
    drain();
  }, rescanMs);
  rescanTimer.unref();

  return {
    close() {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(rescanTimer);
      for (const watcher of watchers) watcher.close();
      return draining ?? Promise.resolve();
    },
  };
}
