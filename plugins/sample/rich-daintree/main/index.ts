import type { PluginHostApi } from "../../../../shared/types/plugin.js";

/**
 * Rich Daintree — the capability- and settings-rich E2E fixture (#9592). Where
 * `hello-daintree` is the minimal host-contract consumer, this one exists purely
 * so the `full-plugins` bucket has a plugin whose manifest declares sensitive
 * capabilities (`fs:project-write` elevates `pluginDanger` to `"confirm"`) and a
 * `contributes.settings` field of every type — exercising the Permissions tab,
 * the danger summary banner, and the generated settings form.
 *
 * Activation deliberately does nothing but register a sentinel action. It must
 * NOT pre-write any setting: the settings specs assert default-vs-stored
 * behaviour and a startup write would mask an unset field's default.
 */
export async function activate(host: PluginHostApi): Promise<() => void> {
  // Sentinel the E2E harness polls for: the host namespaces this to
  // `daintree.rich.ready`, so `waitForRichPluginReady` knows activation ran.
  // The host unregisters plugin actions automatically on unload.
  await host.registerAction(
    {
      id: "ready",
      title: "Rich: Ready",
      description: "Sentinel action — fires once the rich sample plugin has activated.",
      category: "Rich Daintree",
      kind: "command",
      danger: "safe",
    },
    () => ({ ready: true })
  );

  // Private storage round-trip (#10556) — exercised by core-plugin-storage.spec.
  // Writes/reads/deletes across all three scopes and reports what it observed, so
  // the E2E can assert the host.storage API works end-to-end through the real
  // plugin host AND that storage is a separate store from settings (writing a
  // key that collides with a declared setting id must not surface in the
  // settings UI). The action cleans up every key it wrote so it leaves no
  // residue for other specs.
  await host.registerAction(
    {
      id: "storage-roundtrip",
      title: "Rich: Storage round-trip",
      description: "Exercises host.storage across user/project/worktree scopes (E2E only).",
      category: "Rich Daintree",
      kind: "command",
      danger: "safe",
    },
    async () => {
      const KEY = "e2e-roundtrip";
      const report: Record<string, unknown> = {};

      await host.storage.set(KEY, { n: 1 }, "user");
      report.user = await host.storage.get(KEY, "user");

      await host.storage.set(KEY, { n: 2 }, "project");
      report.project = await host.storage.get(KEY, "project");

      // A worktree may not be active in every harness layout; report the throw
      // instead of failing the action so the spec can branch on it.
      try {
        await host.storage.set(KEY, { n: 3 }, "worktree");
        report.worktree = await host.storage.get(KEY, "worktree");
      } catch (err) {
        report.worktreeError = err instanceof Error ? err.message : String(err);
      }

      // Delete is a real method (settings has none) — confirm it removes the key.
      await host.storage.delete(KEY, "user");
      report.userAfterDelete = await host.storage.get(KEY, "user");

      // Collision guard: a storage key matching a declared setting id must live
      // in the storage store, never the settings store.
      await host.storage.set("greeting", "STORAGE-ONLY", "user");
      report.storageGreeting = await host.storage.get("greeting", "user");

      // Clean up every remaining key so the fixture leaves no residue.
      await host.storage.delete("greeting", "user");
      await host.storage.delete(KEY, "project");
      await host.storage.delete(KEY, "worktree").catch(() => {});

      return report;
    }
  );

  return () => {};
}
