import os from "node:os";
import path from "node:path";

/**
 * Single source of truth for the local control-socket path that lets the
 * `daintree-plugin` CLI drive a running Daintree instance (F32). Both the host
 * server (`electron/services/PluginCliServer.ts`) and the CLI client
 * (`packages/daintree-plugin/src/lib/socketPath.ts`) import this so the two
 * sides can never drift.
 *
 * Honors a `DAINTREE_CLI_SOCKET` override; otherwise a named pipe on Windows
 * (which doesn't live on disk) or `~/.daintree/cli.sock` everywhere else. Pure
 * node — no electron — so the CLI's tsup bundle can pull it in directly.
 */
export function getCliSocketPath(): string {
  const override = process.env.DAINTREE_CLI_SOCKET;
  if (override && override.length > 0) {
    return override;
  }
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\daintree-cli";
  }
  return path.join(os.homedir(), ".daintree", "cli.sock");
}
