import path from "node:path";
import { sendCliRequest } from "../ipc/client.js";

interface InstallResponse {
  status: string;
  pluginId?: string;
  errors?: Array<{ message: string }>;
}

function isUrl(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

/**
 * Install a `.dntr` file or URL into the running Daintree instance. Local paths
 * are resolved against the cwd; URLs are passed through unchanged so the host
 * owns the bounded download. Throws with a clear message if Daintree isn't
 * running or the install fails.
 */
export async function runInstall(rawTarget: string): Promise<void> {
  const target = rawTarget.trim();
  const params = isUrl(target) ? { url: target } : { path: path.resolve(process.cwd(), target) };

  const result = (await sendCliRequest("plugin.install", params)) as InstallResponse;

  if (result.status === "installed") {
    console.log(`Installed ${result.pluginId ?? target}`);
    return;
  }

  if (result.status === "cancelled") {
    throw new Error("Install was cancelled by Daintree");
  }

  const detail =
    result.errors && result.errors.length > 0
      ? result.errors.map((e) => e.message).join("; ")
      : result.status;
  throw new Error(`Install failed: ${detail}`);
}
