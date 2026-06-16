import type { FileDecoration } from "../../../../shared/types/forge.js";
import type { PluginHostApi, PluginIpcContext } from "../../../../shared/types/plugin.js";

/**
 * Hello Daintree — the minimal reference plugin AND the host-contract test
 * fixture (#9286). It wires up every host API surface a plugin can call so the
 * Playwright headless host can assert each one produces the right UI side
 * effect, and so a single read of this file maps 1:1 to the SDK contract.
 *
 * Declared in plugin.json: one toolbar button + one menu item pointing at the
 * imperatively-registered `daintree.hello.greet` action, plus a `hello:*`
 * file-decoration provider.
 */
export async function activate(host: PluginHostApi): Promise<() => void> {
  // IPC handler the renderer reaches over `plugin:daintree.hello:ping`.
  await host.registerHandler("ping", (ctx: PluginIpcContext) => ({
    pluginId: host.pluginId,
    worktreeId: ctx.worktreeId,
  }));

  // Imperatively-registered action. The host namespaces this to
  // `daintree.hello.greet`; dispatching it surfaces a toast so the E2E spec
  // can assert the full register → dispatch → showToast loop.
  await host.registerAction(
    {
      id: "greet",
      title: "Hello: Greet",
      description: "Say hello from the Hello Daintree sample plugin.",
      category: "Hello Daintree",
      kind: "command",
      danger: "safe",
    },
    async () => {
      await host.showToast({
        message: "Hello from the greet action",
        type: "success",
        durationMs: 30_000,
      });
      return { greeted: true };
    }
  );

  // Settings round-trip — read the persisted greeting, default to "world",
  // write it back so onDidChange fires for any subscriber, and expose the
  // live value through an IPC handler so the E2E spec can read it back.
  let greeting = (await safeGet(host, "greeting")) ?? "world";
  void host.settings.set("greeting", greeting).catch(() => {});
  const disposeGreetingSub = await host.settings.onDidChange<string>("greeting", (next) => {
    greeting = next ?? "world";
  });
  await host.registerHandler("getGreeting", () => greeting);

  // Activation-time toast — observable in the notification inbox so the E2E
  // spec gets a durable signal without racing the toast dismiss timer.
  void host.showToast({
    message: "Hello Daintree plugin activated",
    type: "info",
    durationMs: 30_000,
  });

  // Badge every requested path with an "H" — the simplest honest decoration.
  const disposeDecorations = await host.registerFileDecorationProvider(
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
  const disposeWorktree = await host.onDidChangeActiveWorktree(() => {
    void host.invalidateFileDecorations("hello:active");
  });

  return () => {
    disposeDecorations();
    disposeWorktree();
    disposeGreetingSub();
  };
}

async function safeGet(host: PluginHostApi, key: string): Promise<string | undefined> {
  try {
    return await host.settings.get<string>(key);
  } catch {
    return undefined;
  }
}
