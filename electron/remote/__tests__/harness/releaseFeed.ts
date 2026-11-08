import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { updateManifestNameFor } from "../../client/clientBuild.js";
import { artifactNameFor, feedUrlFor } from "../../client/installPlan.js";
import type { HostArch } from "../../../../shared/types/remoteHosts.js";

/** Where a build sits on the release feed, as the installer will ask for it. */
export interface FeedEntry {
  /** The URL path of the artifact, without the leading slash. */
  artifactPath: string;
  /** The URL path of the update manifest that vouches for it. */
  manifestPath: string;
  artifactName: string;
  url: string;
}

export function feedEntryFor(version: string, arch: HostArch): FeedEntry {
  const artifactName = artifactNameFor(arch, "appimage", version);
  const feed = new URL(feedUrlFor(version));
  const dir = feed.pathname.replace(/^\/+/, "");
  return {
    artifactName,
    artifactPath: `${dir}${artifactName}`,
    manifestPath: `${dir}${updateManifestNameFor(artifactName)}`,
    url: `${feed.href}${artifactName}`,
  };
}

export async function sha512Base64Of(file: string): Promise<string> {
  const hash = crypto.createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("base64");
}

/** A checksum of the right form that no build has: what a tampered feed would publish. */
export function wrongSha512Base64(sha512: string): string {
  const bytes = Buffer.from(sha512, "base64");
  bytes[0] = bytes[0]! ^ 0xff;
  return bytes.toString("base64");
}

/** The update manifest electron-builder publishes beside an artifact. */
export function updateManifestFor(params: {
  version: string;
  artifactName: string;
  sha512: string;
  size: number;
}): string {
  const { version, artifactName, sha512, size } = params;
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${artifactName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${artifactName}`,
    `sha512: ${sha512}`,
    "",
  ].join("\n");
}
