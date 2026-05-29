import os from "node:os";
import path from "node:path";

/**
 * Path to the running Daintree instance's CLI control socket. A named pipe on
 * Windows (which doesn't live on disk), else `~/.daintree/cli.sock`. Kept in
 * lockstep with the host's `getCliSocketPath()` in
 * `electron/services/PluginCliServer.ts`.
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
