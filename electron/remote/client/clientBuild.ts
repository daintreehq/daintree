import crypto from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
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

/** Why a build that isn't the feed's current release can't be installed by download. */
export const NO_CHECKSUM_MESSAGE =
  "The release feed only publishes checksums for its current release, so this build can't be checked after downloading. Update this machine to the current release, or install Daintree on the host yourself.";

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

const MAX_REDIRECTS = 5;

/**
 * GET over https only, following redirects by hand so no hop, not just the
 * last, can drop to plain http, where both a build and its checksum could be
 * replaced on the way.
 */
export async function fetchHttpsOnly(
  url: string,
  params: { fetchImpl?: typeof fetch; signal?: AbortSignal }
): Promise<Response> {
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    if (current.protocol !== "https:") {
      throw new AppError({
        code: "VALIDATION",
        message: `Refusing a release download over ${current.protocol} (${current.href})`,
        userMessage:
          "The release feed sent this download somewhere other than https, so it wasn't used.",
      });
    }
    const response = await (params.fetchImpl ?? fetch)(current.href, {
      signal: params.signal,
      redirect: "manual",
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    if (hop >= MAX_REDIRECTS) {
      throw new AppError({ code: "VALIDATION", message: `Too many redirects for ${url}` });
    }
    current = new URL(location, current);
  }
}

/** A base64 sha512 as electron-builder writes it: exactly 64 bytes. */
export function isSha512Base64(value: string): boolean {
  return /^[A-Za-z0-9+/]{86}==$/.test(value) && Buffer.from(value, "base64").length === 64;
}

function checksumUnavailable(detail: string): AppError {
  return new AppError({
    code: "INTERNAL",
    message: `Couldn't read the release feed's checksums: ${detail}`,
    userMessage:
      "This machine couldn't read the release feed's checksums, so nothing was downloaded. Check this machine's connection and try again.",
  });
}

/**
 * The checksum the feed publishes for this artifact. Only the feed's current
 * release is listed there, so an older build has none (null), as does a feed
 * with no manifest for that platform. A manifest that can't be fetched or
 * read throws instead: that says nothing about the build.
 */
export async function lookupArtifactChecksum(params: {
  url: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ArtifactChecksum | null> {
  const slash = params.url.lastIndexOf("/");
  const feed = params.url.slice(0, slash + 1);
  const name = params.url.slice(slash + 1);
  let text: string;
  try {
    const response = await fetchHttpsOnly(`${feed}${updateManifestNameFor(name)}`, params);
    if (response.status === 404) return null;
    if (!response.ok) throw checksumUnavailable(`HTTP ${response.status}`);
    text = await response.text();
  } catch (err) {
    if (params.signal?.aborted || err instanceof AppError) throw err;
    throw checksumUnavailable(formatErrorMessage(err, "the request failed"));
  }
  if (text.length > 256 * 1024) throw checksumUnavailable("the manifest is too large");
  let doc: unknown;
  try {
    doc = loadYaml(text);
  } catch {
    throw checksumUnavailable("the manifest isn't valid YAML");
  }
  const files = (doc as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) throw checksumUnavailable("the manifest lists no files");
  for (const entry of files) {
    if (!entry || typeof entry !== "object") {
      throw checksumUnavailable("the manifest has an entry that isn't a file");
    }
    const file = entry as { url?: unknown; sha512?: unknown; size?: unknown };
    if (file.url !== name) continue;
    if (typeof file.sha512 !== "string" || !isSha512Base64(file.sha512)) {
      throw checksumUnavailable("the manifest's sha512 for this build is malformed");
    }
    return {
      sha512: file.sha512,
      size: typeof file.size === "number" && file.size >= 0 ? file.size : null,
    };
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
 * its length and the feed's checksum agree; a build the feed lists no
 * checksum for is refused before anything is downloaded.
 */
export async function downloadArtifact(params: {
  url: string;
  destination: string;
  allowedPrefixes: readonly string[];
  signal?: AbortSignal;
  onProgress?: (fraction: number | null) => void;
  fetchImpl?: typeof fetch;
  /** Omitted: looked up in the feed's update manifest. Null refuses the download. */
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
  // Bytes nobody vouched for are never handed to a host to run.
  if (!expected) {
    throw new AppError({
      code: "UNSUPPORTED",
      message: `The release feed lists no checksum for ${params.url}`,
      userMessage: NO_CHECKSUM_MESSAGE,
    });
  }
  const response = await fetchHttpsOnly(params.url, params);
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
    if (expected.size !== null && received !== expected.size) {
      throw downloadFailed(`Received ${received} bytes; the feed lists ${expected.size}`);
    }
    if (hash.digest("base64") !== expected.sha512) {
      throw downloadFailed("The download's sha512 doesn't match the feed's");
    }
  } catch (err) {
    await file.close().catch(() => {});
    await fs.rm(partial, { force: true }).catch(() => {});
    throw err;
  }
  await fs.rename(partial, params.destination);
}
