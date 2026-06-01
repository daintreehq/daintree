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
  host.registerAction(
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

  return () => {};
}
