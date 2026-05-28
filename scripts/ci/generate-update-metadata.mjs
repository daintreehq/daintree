#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dump } from "js-yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultPackagePath = path.resolve(here, "../../package.json");

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function sha512(filePath) {
  const hash = createHash("sha512");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("base64");
}

async function artifactEntry(releaseDir, fileName) {
  const filePath = path.join(releaseDir, fileName);
  const fileStat = await stat(filePath);
  const blockMapPath = `${filePath}.blockmap`;
  const entry = {
    url: fileName,
    sha512: await sha512(filePath),
    size: fileStat.size,
  };

  try {
    const blockMapStat = await stat(blockMapPath);
    entry.blockMapSize = blockMapStat.size;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  return entry;
}

// electron-updater's MacUpdater.ts filters by "arm64" substring: on Apple Silicon
// only files containing "arm64" are kept; on Intel Macs "arm64" files are excluded.
// It then picks the first surviving entry. Rank native builds before universal so
// each architecture selects its own native ZIP and universal is never picked when
// a native build exists.
function macZipPriority(fileName) {
  if (fileName.includes("-x64-mac.zip")) return 0;
  if (fileName.includes("-arm64-mac.zip")) return 1;
  if (fileName.includes("universal-mac.zip")) return 2;
  // Bare -mac.zip (no arch suffix) is the x64 build from electron-builder.
  // Check after arm64 so arm64-mac.zip doesn't match this branch.
  if (fileName.endsWith("-mac.zip")) return 0;
  return 3;
}

function selectArtifacts(platform, fileNames) {
  if (platform === "linux") {
    const appImages = fileNames.filter((fileName) => fileName.endsWith(".AppImage")).sort();
    if (appImages.length !== 1) {
      throw new Error(`Expected exactly 1 Linux AppImage artifact, found ${appImages.length}`);
    }
    return appImages;
  }

  if (platform === "mac") {
    const zips = fileNames
      .filter((fileName) => fileName.endsWith(".zip"))
      .sort((a, b) => {
        const priority = macZipPriority(a) - macZipPriority(b);
        return priority === 0 ? a.localeCompare(b) : priority;
      });
    if (zips.length === 0) {
      throw new Error("Expected at least 1 macOS ZIP artifact");
    }
    return zips;
  }

  if (platform === "windows") {
    // NSIS produces a single combined installer covering all selected archs;
    // `.appx` artifacts are routed through the Store and must be excluded here.
    const installers = fileNames.filter((fileName) => fileName.endsWith(".exe")).sort();
    if (installers.length !== 1) {
      throw new Error(
        `Expected exactly 1 Windows NSIS .exe artifact, found ${installers.length}: ${installers.join(", ") || "(none)"}`
      );
    }
    return installers;
  }

  throw new Error(`Unsupported platform "${platform}"`);
}

export async function generateUpdateMetadata({
  platform,
  releaseDir = "release",
  metadataPath,
  packagePath = defaultPackagePath,
  releaseDate = new Date().toISOString(),
}) {
  if (!metadataPath) {
    throw new Error("metadataPath is required");
  }

  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const fileNames = await readdir(releaseDir);
  const selectedArtifacts = selectArtifacts(platform, fileNames);
  const files = [];

  for (const fileName of selectedArtifacts) {
    files.push(await artifactEntry(releaseDir, fileName));
  }

  const primary = files[0];
  const metadata = {
    version: packageJson.version,
    files,
    path: primary.url,
    sha512: primary.sha512,
    releaseDate,
  };

  await writeFile(metadataPath, dump(metadata, { lineWidth: 120 }), "utf8");
  return metadata;
}

async function main() {
  const [platform, metadataPath, releaseDir = "release"] = process.argv.slice(2);
  if (!platform || !metadataPath) {
    fail("Usage: generate-update-metadata.mjs <mac|linux|windows> <metadata-path> [release-dir]");
  }

  try {
    const metadata = await generateUpdateMetadata({ platform, metadataPath, releaseDir });
    console.log(
      `[metadata] wrote ${metadataPath}: path=${metadata.path}, files=${metadata.files.length}`
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
