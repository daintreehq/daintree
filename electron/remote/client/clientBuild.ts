import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "../../utils/errorTypes.js";
import type { ClientBundle } from "./installPlan.js";

/** What of this running app can be copied to a host of the same platform and arch. */
export function detectClientBundle(params: {
  isPackaged: boolean;
  exePath: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}): ClientBundle {
  if (!params.isPackaged) return { kind: "none" };
  if (params.platform === "darwin") {
    // <bundle>.app/Contents/MacOS/<exe>
    const bundle = path.resolve(params.exePath, "..", "..", "..");
    return bundle.endsWith(".app") ? { kind: "app-bundle", path: bundle } : { kind: "none" };
  }
  if (params.platform === "linux") {
    const appImage = params.env.APPIMAGE;
    if (typeof appImage === "string" && path.isAbsolute(appImage)) {
      return { kind: "appimage", path: appImage };
    }
  }
  return { kind: "none" };
}

/**
 * Download a release artifact to a local file, reporting progress. Only the
 * release feeds are accepted, so a caller can't be steered to fetch anything
 * else.
 */
export async function downloadArtifact(params: {
  url: string;
  destination: string;
  allowedPrefixes: readonly string[];
  signal?: AbortSignal;
  onProgress?: (fraction: number | null) => void;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!params.allowedPrefixes.some((prefix) => params.url.startsWith(prefix))) {
    throw new AppError({ code: "VALIDATION", message: `Not a release feed URL: ${params.url}` });
  }
  const response = await (params.fetchImpl ?? fetch)(params.url, { signal: params.signal });
  if (!response.ok || !response.body) {
    throw new AppError({
      code: "NOT_FOUND",
      message: `Download failed (${response.status}) for ${params.url}`,
      userMessage: "This build isn't available from the release feed.",
    });
  }
  const total = Number(response.headers.get("content-length")) || null;
  await fs.mkdir(path.dirname(params.destination), { recursive: true, mode: 0o700 });
  const partial = `${params.destination}.part`;
  const file = await fs.open(partial, "w", 0o600);
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await file.write(value);
      received += value.byteLength;
      params.onProgress?.(total ? Math.min(1, received / total) : null);
    }
  } catch (err) {
    await file.close().catch(() => {});
    await fs.rm(partial, { force: true }).catch(() => {});
    throw err;
  }
  await file.close();
  await fs.rename(partial, params.destination);
}
