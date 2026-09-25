import crypto from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
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

export interface ArtifactChecksum {
  /** Base64 sha512, as electron-builder's update manifests carry it. */
  sha512: string;
  size: number | null;
}

/** The update manifest electron-builder publishes beside an artifact of this name. */
export function updateManifestNameFor(artifactName: string): string {
  if (artifactName.endsWith("-mac.zip")) return "latest-mac.yml";
  return /(arm64|aarch64)/.test(artifactName) ? "latest-linux-arm64.yml" : "latest-linux.yml";
}

/**
 * The checksum the feed publishes for this artifact. Only the feed's current
 * release is listed there, so an older build has none (null); a manifest
 * that can't be fetched or read is the same.
 */
export async function lookupArtifactChecksum(params: {
  url: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ArtifactChecksum | null> {
  const slash = params.url.lastIndexOf("/");
  const feed = params.url.slice(0, slash + 1);
  const name = params.url.slice(slash + 1);
  try {
    const response = await (params.fetchImpl ?? fetch)(`${feed}${updateManifestNameFor(name)}`, {
      signal: params.signal,
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 256 * 1024) return null;
    const doc = loadYaml(text) as { files?: unknown } | null;
    const files = Array.isArray(doc?.files) ? doc.files : [];
    for (const entry of files) {
      const file = entry as { url?: unknown; sha512?: unknown; size?: unknown };
      if (file.url !== name || typeof file.sha512 !== "string" || !file.sha512) continue;
      return {
        sha512: file.sha512,
        size: typeof file.size === "number" && file.size >= 0 ? file.size : null,
      };
    }
  } catch (err) {
    if (params.signal?.aborted) throw err;
  }
  return null;
}

async function writeFully(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("The disk accepted no bytes");
    offset += bytesWritten;
  }
}

function downloadFailed(message: string): AppError {
  return new AppError({
    code: "INTERNAL",
    message,
    userMessage: "The downloaded build didn't check out, so it wasn't used.",
  });
}

/**
 * Download a release artifact to a local file, reporting progress. Only the
 * release feeds are accepted, so a caller can't be steered to fetch anything
 * else. The file lands at `destination` only once every byte is on disk and
 * its length (and the feed's checksum, when it lists one) agree.
 */
export async function downloadArtifact(params: {
  url: string;
  destination: string;
  allowedPrefixes: readonly string[];
  signal?: AbortSignal;
  onProgress?: (fraction: number | null) => void;
  fetchImpl?: typeof fetch;
  /** Omitted: looked up in the feed's update manifest. */
  expected?: ArtifactChecksum | null;
}): Promise<void> {
  if (!params.allowedPrefixes.some((prefix) => params.url.startsWith(prefix))) {
    throw new AppError({ code: "VALIDATION", message: `Not a release feed URL: ${params.url}` });
  }
  const expected =
    params.expected !== undefined
      ? params.expected
      : await lookupArtifactChecksum({
          url: params.url,
          fetchImpl: params.fetchImpl,
          signal: params.signal,
        });
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
  const hash = crypto.createHash("sha512");
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writeFully(file, value);
      hash.update(value);
      received += value.byteLength;
      params.onProgress?.(total ? Math.min(1, received / total) : null);
    }
    await file.close();
    const saved = (await fs.stat(partial)).size;
    if (saved !== received) throw downloadFailed(`Saved ${saved} of ${received} bytes`);
    if (total !== null && received !== total) {
      throw downloadFailed(`Received ${received} of ${total} bytes`);
    }
    if (expected) {
      if (expected.size !== null && received !== expected.size) {
        throw downloadFailed(`Received ${received} bytes; the feed lists ${expected.size}`);
      }
      if (hash.digest("base64") !== expected.sha512) {
        throw downloadFailed("The download's sha512 doesn't match the feed's");
      }
    }
  } catch (err) {
    await file.close().catch(() => {});
    await fs.rm(partial, { force: true }).catch(() => {});
    throw err;
  }
  await fs.rename(partial, params.destination);
}
