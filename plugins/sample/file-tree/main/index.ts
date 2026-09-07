import type { PluginHostApi } from "../../../../shared/types/plugin.js";

/**
 * File Tree Sample — the reference consumer of the file-listing surface.
 *
 * Daintree's own file browser reuses the same tree model, but it reaches it by
 * importing the package source directly, so it would stay green even if the
 * published `@daintreehq/plugin-sdk/files` entry or the `host.fs.readdir`
 * detail contract were broken. This plugin only ever touches the public
 * surface: if a plugin author could not build a file browser, this fails to
 * build first and we find out instead of them.
 *
 * The `main` half is deliberately thin. Listing is the only thing a view cannot
 * do for itself — `host.fs` lives in the worker — so this registers one channel
 * that forwards to `readdir` and nothing else. Everything a browser actually
 * consists of (expansion, ordering, hidden entries, keyboard navigation,
 * classification) is model code the view imports from the SDK.
 */

/** One directory's worth of entries, in the shape the SDK's tree model consumes. */
interface ListDirectoryArgs {
  /** Absolute directory path. The view is handed its root and walks down from there. */
  dirPath: string;
}

export async function activate(host: PluginHostApi): Promise<void> {
  // `(ctx, ...args)` — the IPC context is ALWAYS the first parameter and the
  // view's payload is the second. A handler declared `(args) => …` binds `args`
  // to the context and drops the payload silently: the argument-less channels
  // keep working, so the panel looks healthy while every channel that takes an
  // argument fails (#12215). `ctx` is unused here; it carries projectId,
  // worktreeId, webContentsId and pluginId when a handler needs them.
  await host.registerHandler("list-directory", async (_ctx, args: unknown) => {
    const { dirPath } = (args ?? {}) as Partial<ListDirectoryArgs>;
    if (typeof dirPath !== "string" || dirPath.length === 0) {
      throw new Error("list-directory requires a dirPath");
    }

    // `detail: true` is what makes the SDK's model usable: it returns the size,
    // mtime, symlink classification and collated order the tree renders from.
    // Without it a plugin would `stat` every entry — one host round trip per
    // row — and still could not reproduce the ordering or the link handling.
    const entries = await host.fs.readdir(dirPath, { detail: true });

    // Names and metadata only. The view owns `path`, because the tree model
    // keys the whole listing map from the browse root while a `readdir` only
    // ever knows the directory it read — sending a path from here would mean
    // sending one the view has to rewrite anyway.
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
      ...(entry.size !== undefined && { size: entry.size }),
      ...(entry.mtimeMs !== undefined && { mtimeMs: entry.mtimeMs }),
      ...(entry.symlink && { symlink: entry.symlink }),
    }));
  });

  // The root the view browses. Resolved here rather than in the view because
  // the worktree snapshot is a host observation, not something a panel knows.
  //
  // A channel rather than a `broadcastToRenderer` during activation: opening a
  // panel is usually what triggers activation, but a second panel — or a
  // remount after the view was torn down — arrives long after that one-shot
  // push has gone, and would sit at "no root" forever.
  //
  // Note this is why the manifest declares BOTH `${project}` and `${worktree}`.
  // `${project}` expands to the *main* worktree; the active worktree is often a
  // linked one in a sibling directory, so declaring only `${project}` would
  // make every `readdir` here fail `PATH_NOT_ALLOWED` the moment the user is on
  // a feature worktree — and pass in a single-worktree fixture, where the two
  // are the same directory.
  await host.registerHandler("root", async () => {
    const active = await host.getActiveWorktree();
    return { path: active?.path ?? null };
  });
}
