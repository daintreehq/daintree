import path from "node:path";
import type { PluginInstallStatus } from "../../../../shared/types/plugin.js";
import { sendCliRequest } from "../ipc/client.js";

interface InstallResponse {
  status: PluginInstallStatus;
  pluginId?: string;
  errors?: Array<{ message: string }>;
}

export interface InstallOptions {
  /** The archive's expected SHA-256, as hex. Refuses any other bytes. */
  sha256?: string;
}

const VERIFIED_INSTALL_METHOD = "plugin.install.verified";

function isUrl(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

/**
 * Install a `.dntr` file or URL into the running Daintree instance. Local paths
 * are resolved against the cwd; URLs are passed through unchanged so the host
 * owns the bounded download. Throws with a clear message if Daintree isn't
 * running or the install fails.
 *
 * With `sha256`, the install is a fresh one held to that digest. It goes over a
 * method of its own so a Daintree too old to check the digest refuses the call
 * rather than installing unchecked, and nothing falls back to a plain install.
 */
export async function runInstall(rawTarget: string, opts: InstallOptions = {}): Promise<void> {
  const target = rawTarget.trim();
  const source = isUrl(target) ? { url: target } : { path: path.resolve(process.cwd(), target) };

  let result: InstallResponse;
  if (opts.sha256 === undefined) {
    result = (await sendCliRequest("plugin.install", source)) as InstallResponse;
  } else {
    const sha256 = opts.sha256.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error("--sha256 must be a SHA-256 digest: 64 hex characters");
    }
    try {
      result = (await sendCliRequest(VERIFIED_INSTALL_METHOD, {
        ...source,
        sha256,
      })) as InstallResponse;
    } catch (err) {
      if ((err as Error).message.includes(`Unknown method: ${VERIFIED_INSTALL_METHOD}`)) {
        throw new Error(
          "This Daintree can't check a --sha256 digest, so nothing was installed. Update Daintree, or install without --sha256."
        );
      }
      throw err;
    }
  }

  if (result.status === "installed") {
    console.log(`Installed ${result.pluginId ?? target}`);
    return;
  }

  if (result.status === "cancelled") {
    throw new Error("Install was cancelled by Daintree");
  }

  if (result.status === "invalid-url") {
    throw new Error("That URL isn't a valid plugin source");
  }

  if (result.status === "not-implemented") {
    throw new Error("This install path isn't available in your Daintree build yet");
  }

  const detail =
    result.errors && result.errors.length > 0
      ? result.errors.map((e) => e.message).join("; ")
      : result.status;
  throw new Error(`Install failed: ${detail}`);
}
