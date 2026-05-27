import type { FileDecoration } from "../../../../shared/types/forge.js";
import type { PluginHostApi, PluginIpcContext } from "../../../../shared/types/plugin.js";

/**
 * Hello Daintree — the minimal reference plugin. It wires up exactly the host
 * APIs and contribution points that exist today, and grows by one contribution
 * point per PR as the plugin host expands (issue #9275). Every line maps to a
 * single capability so an author can read it in one sitting.
 *
 * Declared in plugin.json: one toolbar button and one menu item, both pointing
 * at the `daintree.hello.ping` action, plus one file-decoration provider scoped
 * to `hello:*`.
 */
export function activate(host: PluginHostApi): () => void {
  // An IPC handler the renderer reaches over `plugin:daintree.hello:ping`.
  host.registerHandler("ping", (ctx: PluginIpcContext) => ({
    pluginId: host.pluginId,
    worktreeId: ctx.worktreeId,
  }));

  // Badge every requested path with an "H" — the simplest honest decoration.
  const disposeDecorations = host.registerFileDecorationProvider(
    { id: "hello" },
    {
      provideDecorations: async (_scope, paths) => {
        const decorations: Record<string, FileDecoration> = {};
        for (const filePath of paths) {
          decorations[filePath] = { badge: "H", tooltip: "Hello Daintree" };
        }
        return decorations;
      },
    }
  );

  // When the active worktree changes, ask the host to re-pull our decorations.
  const disposeWorktree = host.onDidChangeActiveWorktree(() => {
    host.invalidateFileDecorations("hello:active");
  });

  return () => {
    disposeDecorations();
    disposeWorktree();
  };
}
