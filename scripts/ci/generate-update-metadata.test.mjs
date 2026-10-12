import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { load } from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateUpdateMetadata } from "./generate-update-metadata.mjs";

const tempDirs = [];

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "daintree-metadata-"));
  tempDirs.push(dir);
  return dir;
}

async function writePackageJson(dir, version = "1.2.3") {
  const packagePath = path.join(dir, "package.json");
  await writeFile(packagePath, JSON.stringify({ version }), "utf8");
  return packagePath;
}

async function writeArtifact(dir, name, contents = name) {
  await writeFile(path.join(dir, name), contents, "utf8");
}

describe("generate-update-metadata", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes Linux metadata for the AppImage and the .deb", async () => {
    const dir = await tempDir();
    const releaseDir = path.join(dir, "release");
    await mkdir(releaseDir);
    const packagePath = await writePackageJson(dir, "2.0.0");
    await writeArtifact(releaseDir, "Daintree-2.0.0.AppImage", "appimage");
    await writeArtifact(releaseDir, "daintree_2.0.0_amd64.deb", "deb");

    const metadataPath = path.join(releaseDir, "latest-linux.yml");
    const metadata = await generateUpdateMetadata({
      platform: "linux",
      releaseDir,
      metadataPath,
      packagePath,
      releaseDate: "2026-01-02T03:04:05.000Z",
    });

    const fromFile = load(await readFile(metadataPath, "utf8"));
    expect(fromFile).toEqual(metadata);
    expect(metadata.version).toBe("2.0.0");
    expect(metadata.path).toBe("Daintree-2.0.0.AppImage");
    expect(metadata.files.map((file) => file.url)).toEqual([
      "Daintree-2.0.0.AppImage",
      "daintree_2.0.0_amd64.deb",
    ]);
    expect(metadata.files[0]).toMatchObject({ url: "Daintree-2.0.0.AppImage", size: 8 });
    expect(metadata.files[1]).toMatchObject({ url: "daintree_2.0.0_amd64.deb", size: 3 });
  });

  it("fails when Linux packaging did not produce exactly one .deb", async () => {
    const dir = await tempDir();
    const releaseDir = path.join(dir, "release");
    await mkdir(releaseDir);
    const packagePath = await writePackageJson(dir);
    await writeArtifact(releaseDir, "Daintree-1.2.3.AppImage", "appimage");

    await expect(
      generateUpdateMetadata({
        platform: "linux",
        releaseDir,
        metadataPath: path.join(releaseDir, "latest-linux.yml"),
        packagePath,
      })
    ).rejects.toThrow("Expected exactly 1 Linux .deb artifact");
  });

  // electron-updater's AppImageUpdater downloads differentially only when the
  // feed lists `blockMapSize`: it reads the new image's blockmap from
  // `size - (blockMapSize + 4)`. electron-builder embeds that blockmap in the
  // AppImage rather than writing a sidecar, so it has to be read from the image.
  it("lists the blockmap electron-builder embeds in the AppImage", async () => {
    const dir = await tempDir();
    const releaseDir = path.join(dir, "release");
    await mkdir(releaseDir);
    const packagePath = await writePackageJson(dir, "2.0.0");
    const image = path.join(releaseDir, "Daintree-2.0.0.AppImage");
    await writeFile(image, randomBytes(256 * 1024));
    const { buildBlockMap } = await import("app-builder-lib/out/targets/blockmap/blockmap.js");
    const built = await buildBlockMap(image, "deflate");
    await writeArtifact(releaseDir, "daintree_2.0.0_amd64.deb", "deb");

    const metadata = await generateUpdateMetadata({
      platform: "linux",
      releaseDir,
      metadataPath: path.join(releaseDir, "latest-linux.yml"),
      packagePath,
    });

    const entry = metadata.files.find((file) => file.url === "Daintree-2.0.0.AppImage");
    // What electron-builder itself would have written to latest-linux.yml.
    expect(entry).toMatchObject({ size: built.size, sha512: built.sha512 });
    expect(entry.blockMapSize).toBe(built.blockMapSize);
    const bytes = await readFile(image);
    const start = entry.size - (entry.blockMapSize + 4);
    const blockMap = JSON.parse(inflateRawSync(bytes.subarray(start, entry.size - 4)).toString());
    expect(blockMap.files[0].sizes.reduce((sum, n) => sum + n, 0)).toBe(256 * 1024);
  });

  it("lists no blockMapSize for an AppImage without an embedded blockmap", async () => {
    const dir = await tempDir();
    const releaseDir = path.join(dir, "release");
    await mkdir(releaseDir);
    const packagePath = await writePackageJson(dir, "2.0.0");
    // Trailing bytes that read as a plausible length but aren't a blockmap.
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(16, 0);
    await writeFile(
      path.join(releaseDir, "Daintree-2.0.0.AppImage"),
      Buffer.concat([randomBytes(64), tail])
    );
    await writeArtifact(releaseDir, "daintree_2.0.0_amd64.deb", "deb");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const metadata = await generateUpdateMetadata({
      platform: "linux",
      releaseDir,
      metadataPath: path.join(releaseDir, "latest-linux.yml"),
      packagePath,
    });

    expect(metadata.files[0].blockMapSize).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no embedded blockmap"));
    warn.mockRestore();
  });

  // electron-updater's MacUpdater.ts picks the first entry whose URL passes the
  // architecture filter. Native x64 must come first so Intel Macs select it instead
  // of the larger universal ZIP; arm64 second for Apple Silicon; universal last as a
  // fallback that should never be picked when a native build exists.
  it("ranks native macOS ZIPs before the universal ZIP", async () => {
    const dir = await tempDir();
    const releaseDir = path.join(dir, "release");
    await mkdir(releaseDir);
    const packagePath = await writePackageJson(dir);
    await writeArtifact(releaseDir, "Daintree-1.2.3-arm64-mac.zip", "arm64");
    await writeArtifact(releaseDir, "Daintree-1.2.3-x64-mac.zip", "x64");
    await writeArtifact(releaseDir, "Daintree-1.2.3-universal-mac.zip", "universal");
    await writeArtifact(releaseDir, "Daintree-1.2.3-universal.dmg", "dmg");

    const metadata = await generateUpdateMetadata({
      platform: "mac",
      releaseDir,
      metadataPath: path.join(releaseDir, "latest-mac.yml"),
      packagePath,
      releaseDate: "2026-01-02T03:04:05.000Z",
    });

    expect(metadata.path).toBe("Daintree-1.2.3-x64-mac.zip");
    expect(metadata.files.map((file) => file.url)).toEqual([
      "Daintree-1.2.3-x64-mac.zip",
      "Daintree-1.2.3-arm64-mac.zip",
      "Daintree-1.2.3-universal-mac.zip",
    ]);
  });

  // Back-compat: builds published before the explicit -x64 rename (#10380)
  // produced a bare -mac.zip for x64; macZipPriority keeps ranking it first.
  it("ranks a legacy bare -mac.zip before universal when no -x64-mac.zip is present", async () => {
    const dir = await tempDir();
    const releaseDir = path.join(dir, "release");
    await mkdir(releaseDir);
    const packagePath = await writePackageJson(dir);
    await writeArtifact(releaseDir, "Daintree-1.2.3-arm64-mac.zip", "arm64");
    await writeArtifact(releaseDir, "Daintree-1.2.3-mac.zip", "x64");
    await writeArtifact(releaseDir, "Daintree-1.2.3-universal-mac.zip", "universal");

    const metadata = await generateUpdateMetadata({
      platform: "mac",
      releaseDir,
      metadataPath: path.join(releaseDir, "latest-mac.yml"),
      packagePath,
      releaseDate: "2026-01-02T03:04:05.000Z",
    });

    expect(metadata.path).toBe("Daintree-1.2.3-mac.zip");
    expect(metadata.files.map((file) => file.url)).toEqual([
      "Daintree-1.2.3-mac.zip",
      "Daintree-1.2.3-arm64-mac.zip",
      "Daintree-1.2.3-universal-mac.zip",
    ]);
  });

  it("prefers the explicit -x64-mac.zip over a stale legacy bare -mac.zip", async () => {
    const dir = await tempDir();
    const releaseDir = path.join(dir, "release");
    await mkdir(releaseDir);
    const packagePath = await writePackageJson(dir);
    await writeArtifact(releaseDir, "Daintree-1.2.3-mac.zip", "stale-x64");
    await writeArtifact(releaseDir, "Daintree-1.2.3-x64-mac.zip", "x64");
    await writeArtifact(releaseDir, "Daintree-1.2.3-arm64-mac.zip", "arm64");

    const metadata = await generateUpdateMetadata({
      platform: "mac",
      releaseDir,
      metadataPath: path.join(releaseDir, "latest-mac.yml"),
      packagePath,
      releaseDate: "2026-01-02T03:04:05.000Z",
    });

    expect(metadata.path).toBe("Daintree-1.2.3-x64-mac.zip");
    expect(metadata.files.map((file) => file.url)).toEqual([
      "Daintree-1.2.3-x64-mac.zip",
      "Daintree-1.2.3-mac.zip",
      "Daintree-1.2.3-arm64-mac.zip",
    ]);
  });

  it("ranks arm64 before universal when no x64 ZIP is present", async () => {
    const dir = await tempDir();
    const releaseDir = path.join(dir, "release");
    await mkdir(releaseDir);
    const packagePath = await writePackageJson(dir);
    await writeArtifact(releaseDir, "Daintree-1.2.3-arm64-mac.zip", "arm64");
    await writeArtifact(releaseDir, "Daintree-1.2.3-universal-mac.zip", "universal");

    const metadata = await generateUpdateMetadata({
      platform: "mac",
      releaseDir,
      metadataPath: path.join(releaseDir, "latest-mac.yml"),
      packagePath,
      releaseDate: "2026-01-02T03:04:05.000Z",
    });

    expect(metadata.path).toBe("Daintree-1.2.3-arm64-mac.zip");
    expect(metadata.files.map((file) => file.url)).toEqual([
      "Daintree-1.2.3-arm64-mac.zip",
      "Daintree-1.2.3-universal-mac.zip",
    ]);
  });

  it("fails when Linux packaging did not produce exactly one AppImage", async () => {
    const dir = await tempDir();
    const releaseDir = path.join(dir, "release");
    await mkdir(releaseDir);
    const packagePath = await writePackageJson(dir);

    await expect(
      generateUpdateMetadata({
        platform: "linux",
        releaseDir,
        metadataPath: path.join(releaseDir, "latest-linux.yml"),
        packagePath,
      })
    ).rejects.toThrow("Expected exactly 1 Linux AppImage artifact");
  });

  it("writes Windows metadata for a single NSIS .exe and ignores .appx artifacts", async () => {
    const dir = await tempDir();
    const releaseDir = path.join(dir, "release");
    await mkdir(releaseDir);
    const packagePath = await writePackageJson(dir, "1.2.3");
    await writeArtifact(releaseDir, "Daintree-1.2.3-x64-setup.exe", "nsis-installer");
    await writeArtifact(releaseDir, "Daintree-1.2.3-x64-setup.exe.blockmap", "blockmap");
    await writeArtifact(releaseDir, "Daintree-1.2.3.appx", "appx");

    // electron-updater on Windows polls `<channel>.yml` (no platform suffix).
    const metadataPath = path.join(releaseDir, "latest.yml");
    const metadata = await generateUpdateMetadata({
      platform: "windows",
      releaseDir,
      metadataPath,
      packagePath,
      releaseDate: "2026-01-02T03:04:05.000Z",
    });

    const fromFile = load(await readFile(metadataPath, "utf8"));
    expect(fromFile).toEqual(metadata);
    expect(metadata.version).toBe("1.2.3");
    expect(metadata.path).toBe("Daintree-1.2.3-x64-setup.exe");
    expect(metadata.files).toHaveLength(1);
    expect(metadata.files[0]).toMatchObject({
      url: "Daintree-1.2.3-x64-setup.exe",
      blockMapSize: 8,
    });
  });

  it("writes Windows metadata for separate x64 and arm64 NSIS installers", async () => {
    const dir = await tempDir();
    const releaseDir = path.join(dir, "release");
    await mkdir(releaseDir);
    const packagePath = await writePackageJson(dir, "1.2.3");
    await writeArtifact(releaseDir, "Daintree-1.2.3-arm64-setup.exe", "arm64");
    await writeArtifact(releaseDir, "Daintree-1.2.3-arm64-setup.exe.blockmap", "arm64-blockmap");
    await writeArtifact(releaseDir, "Daintree-1.2.3-x64-setup.exe", "x64");
    await writeArtifact(releaseDir, "Daintree-1.2.3-x64-setup.exe.blockmap", "x64-blockmap");
    await writeArtifact(releaseDir, "Daintree-1.2.3.appx", "appx");

    const metadataPath = path.join(releaseDir, "latest.yml");
    const metadata = await generateUpdateMetadata({
      platform: "windows",
      releaseDir,
      metadataPath,
      packagePath,
      releaseDate: "2026-01-02T03:04:05.000Z",
    });

    const fromFile = load(await readFile(metadataPath, "utf8"));
    expect(fromFile).toEqual(metadata);
    expect(metadata.version).toBe("1.2.3");
    // x64 must be first for electron-updater's arch-agnostic fallback
    expect(metadata.path).toBe("Daintree-1.2.3-x64-setup.exe");
    expect(metadata.files).toHaveLength(2);
    expect(metadata.files[0]).toMatchObject({
      url: "Daintree-1.2.3-x64-setup.exe",
      blockMapSize: 12,
    });
    expect(metadata.files[1]).toMatchObject({
      url: "Daintree-1.2.3-arm64-setup.exe",
      blockMapSize: 14,
    });
    expect(metadata.files.map((file) => file.url)).toEqual([
      "Daintree-1.2.3-x64-setup.exe",
      "Daintree-1.2.3-arm64-setup.exe",
    ]);
  });

  it("fails when Windows packaging produced no NSIS .exe", async () => {
    const dir = await tempDir();
    const releaseDir = path.join(dir, "release");
    await mkdir(releaseDir);
    const packagePath = await writePackageJson(dir);
    await writeArtifact(releaseDir, "Daintree-1.2.3.appx", "appx");

    await expect(
      generateUpdateMetadata({
        platform: "windows",
        releaseDir,
        metadataPath: path.join(releaseDir, "latest.yml"),
        packagePath,
      })
    ).rejects.toThrow("Expected at least 1 Windows NSIS .exe artifact, found 0");
  });

  it("fails when Windows NSIS .exe filename lacks an architecture token", async () => {
    const dir = await tempDir();
    const releaseDir = path.join(dir, "release");
    await mkdir(releaseDir);
    const packagePath = await writePackageJson(dir);
    await writeArtifact(releaseDir, "Daintree-1.2.3-setup.exe", "no-arch");

    await expect(
      generateUpdateMetadata({
        platform: "windows",
        releaseDir,
        metadataPath: path.join(releaseDir, "latest.yml"),
        packagePath,
      })
    ).rejects.toThrow("must include architecture token");
  });

  it("fails when Windows packaging produced duplicate arch installers", async () => {
    const dir = await tempDir();
    const releaseDir = path.join(dir, "release");
    await mkdir(releaseDir);
    const packagePath = await writePackageJson(dir);
    await writeArtifact(releaseDir, "Daintree-1.2.3-x64-setup.exe", "x64-a");
    await writeArtifact(releaseDir, "Daintree-0.0.0-x64-setup.exe", "x64-b");

    await expect(
      generateUpdateMetadata({
        platform: "windows",
        releaseDir,
        metadataPath: path.join(releaseDir, "latest.yml"),
        packagePath,
      })
    ).rejects.toThrow("Duplicate x64 Windows NSIS .exe");
  });
});
