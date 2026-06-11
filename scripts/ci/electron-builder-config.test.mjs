import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import buildConfig from "../../electron-builder.config.cjs";

describe("electron-builder config — macOS artifact naming (#10380)", () => {
  it("forces an explicit arch token into every macOS artifact name", async () => {
    const config = await buildConfig();
    // A user-specified artifactName bypasses electron-builder's default-arch
    // suffix stripping, so ${arch} renders "x64" instead of "" and no artifact
    // looks like "the" Mac download. mac.artifactName covers the zip target;
    // the dmg block overrides it for DMGs.
    expect(config.dmg.artifactName).toContain("${arch}");
    expect(config.mac.artifactName).toContain("${arch}");
  });

  it("keeps the -mac suffix on zip artifacts for update-metadata ranking", async () => {
    const config = await buildConfig();
    // macZipPriority() in generate-update-metadata.mjs matches *-mac.zip names;
    // dropping the os token from the zip pattern would break latest-mac.yml
    // file ordering and electron-updater arch routing.
    expect(config.mac.artifactName.endsWith("-${os}.${ext}")).toBe(true);
  });

  it("does not override mac defaultArch", async () => {
    const config = await buildConfig();
    // defaultArch changes computeAppOutDir, renaming release/mac/ to
    // release/mac-x64/ and breaking the hardcoded app-bundle paths in
    // release-macos.yml. The arch suffix belongs on artifactName only.
    expect(config.mac.defaultArch).toBeUndefined();
  });

  it("only uses root config keys the electron-builder schema accepts", async () => {
    const config = await buildConfig();
    // The schema has additionalProperties: false at the root, so an unknown
    // key (e.g. a root-level `zip` block) fails validateConfiguration() at
    // packaging time and breaks the release build before any artifact exists.
    const scheme = JSON.parse(
      await readFile(
        new URL("../../node_modules/app-builder-lib/scheme.json", import.meta.url),
        "utf8"
      )
    );
    const allowedKeys = new Set(Object.keys(scheme.properties));
    for (const key of Object.keys(config)) {
      expect(
        allowedKeys,
        `root config key "${key}" is not in the electron-builder schema`
      ).toContain(key);
    }
  });
});
