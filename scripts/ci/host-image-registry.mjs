#!/usr/bin/env node
// What GHCR holds for the Daintree Host image, for publish-host-image.yml.
// GHCR can't make a tag write-once, so the workflow does: a version is pushed
// only when the registry says plainly that it has no such tag, and a rerun
// after a push finds its own image there (the same config digest) and goes on
// to record it rather than pushing again. Anything else, including any
// response it can't read, stops the publish.
//
//   check <repository> <version> <image id>      prints push=true|false
//   resolve <repository> <version> <image id>    prints digest=sha256:…
//   anonymous <repository> <digest>              exits 0 when anyone can pull it, 3 when not
//
// <repository> is `owner/name` on ghcr.io; GHCR_USER and GHCR_TOKEN
// authenticate every call but `anonymous`.

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const REGISTRY = "https://ghcr.io";

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const SINGLE_IMAGE_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);

const REQUEST_TIMEOUT_MS = 30_000;

async function request(fetchImpl, url, init = {}) {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/** A pull token for `repository`, as `user`:`token` when given, else as anyone. */
export async function pullToken({ repository, user, token, fetchImpl = fetch }) {
  const url = `${REGISTRY}/token?service=ghcr.io&scope=repository:${repository}:pull`;
  const headers = {};
  if (token) {
    headers.authorization = `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
  }
  const response = await request(fetchImpl, url, { headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GHCR gave no token for ${repository} (${response.status}): ${text}`);
  }
  const issued = JSON.parse(text).token;
  if (typeof issued !== "string" || !issued) {
    throw new Error(`GHCR's token response for ${repository} had no token`);
  }
  return issued;
}

const ABSENT = new Set(["MANIFEST_UNKNOWN", "NAME_UNKNOWN"]);

/**
 * The manifest `reference` names: `{ found: false }` only on a 404 whose every
 * error says there's no such tag or repository, its digest and body when there
 * is one, and a throw on anything else.
 */
export async function readManifest({ repository, reference, bearer, fetchImpl = fetch }) {
  const response = await request(fetchImpl, `${REGISTRY}/v2/${repository}/manifests/${reference}`, {
    method: "GET",
    headers: { authorization: `Bearer ${bearer}`, accept: MANIFEST_TYPES },
  });
  const body = Buffer.from(await response.arrayBuffer());
  const text = body.toString("utf8");
  if (response.status === 404) {
    let codes = [];
    try {
      codes = (JSON.parse(text).errors ?? []).map((error) => error.code);
    } catch {
      // Not the registry's error document: not an answer to rely on.
    }
    if (codes.length > 0 && codes.every((code) => ABSENT.has(code))) return { found: false };
  }
  if (response.status !== 200) {
    throw new Error(`GHCR answered ${response.status} for ${repository}:${reference}: ${text}`);
  }
  const digest = response.headers.get("docker-content-digest");
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`GHCR named no digest for ${repository}:${reference}`);
  }
  // What gets pinned and attested is the digest of these bytes, not the header's word for it.
  const actual = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  if (actual !== digest) {
    throw new Error(
      `GHCR named ${digest} for ${repository}:${reference}, but its bytes are ${actual}`
    );
  }
  return { found: true, digest, manifest: JSON.parse(text) };
}

/**
 * Whether `manifest` is one image whose config is `imageId`, the ID the
 * classic Docker image store gives an image: its config's digest.
 */
export function isImage(manifest, imageId) {
  return SINGLE_IMAGE_TYPES.has(manifest.mediaType) && manifest.config?.digest === imageId;
}

/** `push` when the tag is free, `pushed` when it already holds this image; throws otherwise. */
export function publishDecision(found, { repository, version, imageId }) {
  if (!found.found) return "push";
  if (isImage(found.manifest, imageId)) return "pushed";
  throw new Error(
    `${repository}:${version} already exists as ${found.digest}, which isn't the image this run tested (${imageId}). A version is published once: tag a new one.`
  );
}

function writeOutput(name, value) {
  const line = `${name}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  process.stdout.write(line);
}

/**
 * Runs one command and returns its exit status; `output` receives the step
 * outputs and `env` the credentials.
 */
export async function main(
  argv,
  {
    env = process.env,
    fetchImpl = fetch,
    output = writeOutput,
    report = (line) => process.stderr.write(`${line}\n`),
  } = {}
) {
  const [command, repository, ...rest] = argv;
  if (!repository || !/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(repository)) {
    throw new Error(`Not a repository: ${repository ?? "(none)"}`);
  }
  if (command === "anonymous") {
    const [digest] = rest;
    try {
      if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) throw new Error(`Not a digest: ${digest}`);
      const bearer = await pullToken({ repository, fetchImpl });
      const found = await readManifest({ repository, reference: digest, bearer, fetchImpl });
      if (found.found) return 0;
      report(`GHCR has no ${repository}@${digest} for anyone to pull`);
    } catch (err) {
      report(err instanceof Error ? err.message : String(err));
    }
    return 3;
  }
  const [version, imageId] = rest;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "")) {
    throw new Error(`Not a version: ${version ?? "(none)"}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId ?? "")) throw new Error(`Not an image ID: ${imageId}`);
  if (!env.GHCR_USER || !env.GHCR_TOKEN) throw new Error("GHCR_USER and GHCR_TOKEN are required");
  const bearer = await pullToken({
    repository,
    user: env.GHCR_USER,
    token: env.GHCR_TOKEN,
    fetchImpl,
  });
  const found = await readManifest({ repository, reference: version, bearer, fetchImpl });
  if (command === "check") {
    const decision = publishDecision(found, { repository, version, imageId });
    output("push", String(decision === "push"));
    return 0;
  }
  if (command === "resolve") {
    if (!found.found || !isImage(found.manifest, imageId)) {
      throw new Error(
        `${repository}:${version} doesn't hold the image this run tested (${imageId})`
      );
    }
    output("digest", found.digest);
    return 0;
  }
  throw new Error(`Unknown command: ${command ?? "(none)"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`::error::${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  );
}
