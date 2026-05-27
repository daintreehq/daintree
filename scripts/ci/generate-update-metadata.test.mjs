import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
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

  it("writes Linux metadata for the AppImage artifact", async () => {
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
    expect(metadata.files).toHaveLength(1);
    expect(metadata.files[0]).toMatchObject({
      url: "Daintree-2.0.0.AppImage",
      size: 8,
    });
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
    await writeArtifact(releaseDir, "Daintree-1.2.3-mac.zip", "x64");
    await writeArtifact(releaseDir, "Daintree-1.2.3-universal-mac.zip", "universal");
    await writeArtifact(releaseDir, "Daintree-1.2.3-universal.dmg", "dmg");

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

  it("writes Windows metadata for the NSIS .exe and ignores .appx artifacts", async () => {
    const dir = await tempDir();
    const releaseDir = path.join(dir, "release");
    await mkdir(releaseDir);
    const packagePath = await writePackageJson(dir, "1.2.3");
    await writeArtifact(releaseDir, "Daintree-1.2.3-setup.exe", "nsis-installer");
    await writeArtifact(releaseDir, "Daintree-1.2.3-setup.exe.blockmap", "blockmap");
    await writeArtifact(releaseDir, "Daintree-1.2.3.appx", "appx");

    // electron-updater on Windows polls `<channel>.yml` (no platform suffix).
    // Mirror the production filename so this test catches a regression that
    // accidentally moves Windows metadata into `latest-win.yml` again.
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
    expect(metadata.path).toBe("Daintree-1.2.3-setup.exe");
    expect(metadata.files).toHaveLength(1);
    expect(metadata.files[0]).toMatchObject({
      url: "Daintree-1.2.3-setup.exe",
      blockMapSize: 8,
    });
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
    ).rejects.toThrow("Expected exactly 1 Windows NSIS .exe artifact, found 0");
  });

  it("fails when Windows packaging produced more than one NSIS .exe", async () => {
    const dir = await tempDir();
    const releaseDir = path.join(dir, "release");
    await mkdir(releaseDir);
    const packagePath = await writePackageJson(dir);
    await writeArtifact(releaseDir, "Daintree-1.2.3-x64.exe", "x64");
    await writeArtifact(releaseDir, "Daintree-1.2.3-arm64.exe", "arm64");

    await expect(
      generateUpdateMetadata({
        platform: "windows",
        releaseDir,
        metadataPath: path.join(releaseDir, "latest.yml"),
        packagePath,
      })
    ).rejects.toThrow("Expected exactly 1 Windows NSIS .exe artifact, found 2");
  });
});
