import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import buildConfig from "../../electron-builder.config.cjs";

const repoFile = (relativePath) =>
  readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

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

describe("electron-builder config — OS folder context menus (#11406)", () => {
  const WORKFLOW_DIR = "build/macos/Open in Daintree.workflow";

  it("ships the Finder Quick Action bundle as a macOS resource", async () => {
    const config = await buildConfig();
    const entry = config.mac.extraResources.find((r) => r.from === WORKFLOW_DIR);
    // FinderQuickActionService resolves the packaged source as
    // `process.resourcesPath/<to>`, so the basename must survive the copy.
    expect(entry?.to).toBe("Open in Daintree.workflow");
  });

  it("points the Quick Action's shell action at the real bundle id", async () => {
    const config = await buildConfig();
    const wflow = await repoFile(`${WORKFLOW_DIR}/Contents/document.wflow`);
    // `open -b` resolves the app through Launch Services, so a drifted appId
    // silently makes the Quick Action a no-op.
    expect(wflow).toContain(`open -b ${config.appId}`);
  });

  it("hands the folder to Launch Services rather than passing argv", async () => {
    const wflow = await repoFile(`${WORKFLOW_DIR}/Contents/document.wflow`);
    // `open --args` is dropped when the app is already running; the plain
    // open-document form fires `open-file`, which handles warm and cold alike.
    expect(wflow).not.toContain("--args");
    // Input must arrive as shell arguments (inputMethod 1), not on stdin.
    expect(wflow).toContain("<key>inputMethod</key>\n\t\t\t\t\t<integer>1</integer>");
  });

  it("restricts the Quick Action to folders using the Finder-facing UTI", async () => {
    const infoPlist = await repoFile(`${WORKFLOW_DIR}/Contents/Info.plist`);
    // `public.folder`, not the abstract `public.directory` — matches the
    // CFBundleDocumentTypes registration the same folders already flow through.
    expect(infoPlist).toContain("<string>public.folder</string>");
    expect(infoPlist).not.toContain("public.directory");
  });

  it("declares the directory mime type at the top level of the linux block", async () => {
    const config = await buildConfig();
    // electron-builder merges `linux.mimeTypes` with fileAssociations and
    // scheme handlers into one MimeType line. Nesting it under desktop.entry
    // would silently overwrite that merged value instead.
    expect(config.linux.mimeTypes).toContain("inode/directory");
    expect(config.linux.desktop.entry.MimeType).toBeUndefined();
  });

  it("does not override the Exec line that supplies folder URIs", async () => {
    const config = await buildConfig();
    // electron-builder appends `%U` only when no field code is already present;
    // a custom Exec would drop the URI the folder open depends on.
    expect(config.linux.desktop.entry.Exec).toBeUndefined();
    expect(config.linux.executableArgs).toBeUndefined();
  });
});

describe("NSIS installer — folder context-menu verbs (#11406)", () => {
  it("passes the selected folder as %1 and the background folder as %V", async () => {
    const nsh = await repoFile("build/installer.nsh");
    expect(nsh).toContain(
      `WriteRegStr HKCU "Software\\Classes\\Directory\\shell\\Daintree\\command" "" '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" --cli-path "%1"'`
    );
    // Right-clicking empty space inside a folder has no selection, so %1 would
    // expand to nothing — %V carries the folder being viewed.
    expect(nsh).toContain(
      `WriteRegStr HKCU "Software\\Classes\\Directory\\Background\\shell\\Daintree\\command" "" '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" --cli-path "%V"'`
    );
  });

  it("removes exactly its own verbs on uninstall", async () => {
    const nsh = await repoFile("build/installer.nsh");
    const uninstall = nsh.slice(nsh.indexOf("!macro customUnInstall"));
    // Deleting the shared `Directory\shell` parent would take other apps'
    // context-menu entries with it.
    expect(uninstall).toContain(
      `DeleteRegKey HKCU "Software\\Classes\\Directory\\shell\\Daintree"`
    );
    expect(uninstall).toContain(
      `DeleteRegKey HKCU "Software\\Classes\\Directory\\Background\\shell\\Daintree"`
    );
    expect(uninstall).not.toContain(`DeleteRegKey HKCU "Software\\Classes\\Directory\\shell"`);
  });

  it("keeps one shell-refresh call per macro", async () => {
    const nsh = await repoFile("build/installer.nsh");
    // SHCNE_ASSOCCHANGED covers the `.dntr` association and both folder verbs
    // in a single notification; extra calls are redundant Explorer churn.
    expect(nsh.match(/SHChangeNotify/g)).toHaveLength(2);
  });
});

describe("daintree CLI — macOS app lookup (#11406)", () => {
  it("queries Spotlight with the configured bundle id", async () => {
    const config = await buildConfig();
    const script = await repoFile("scripts/daintree-cli.sh");
    // The fallback silently never matched while this drifted from `appId`.
    expect(script).toContain(`kMDItemCFBundleIdentifier == "${config.appId}"`);
  });
});
