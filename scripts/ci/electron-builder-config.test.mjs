import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import buildConfig from "../../electron-builder.config.cjs";

const repoFile = (relativePath) =>
  readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

/** Value of `<key>name</key><string>…</string>` in a plist, ignoring whitespace. */
const plistString = (xml, key) =>
  xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];

/** Value of `<key>name</key><integer>…</integer>` in a plist. */
const plistInteger = (xml, key) =>
  xml.match(new RegExp(`<key>${key}</key>\\s*<integer>(-?\\d+)</integer>`))?.[1];

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

describe("electron-builder config — platform files overrides (#11475)", () => {
  it("keeps every top-level files pattern in each platform override", async () => {
    const config = await buildConfig();
    // electron-builder replaces the top-level `files` with a platform-level one
    // rather than merging them, and an override left with no inclusion pattern
    // falls back to the default `**/*`. That silently packed the whole source
    // tree into app.asar (601MB vs 39.8MB) and broke the macOS universal merge
    // on the per-arch node-gyp metadata it dragged in. Every override has to
    // spread baseFiles(); comparing against the resolved top-level array keeps
    // this honest as that list grows.
    expect(config.files.some((pattern) => !pattern.startsWith("!"))).toBe(true);

    for (const platform of ["mac", "win", "linux"]) {
      const missing = config.files.filter((pattern) => !config[platform].files.includes(pattern));
      expect(missing, `${platform}.files drops top-level patterns`).toEqual([]);
    }
  });

  it("packs no source directory that the asar guard would reject", async () => {
    const config = await buildConfig();
    // afterPack.cjs asserts app.asar's top-level entries against this same set.
    // The two live in different files and would drift apart silently, so pin
    // the config side here: every inclusion pattern must root in an entry the
    // guard allows.
    const guardedRoots = ["dist", "dist-electron", "electron", "node_modules", "package.json"];
    for (const platform of ["mac", "win", "linux"]) {
      const included = config[platform].files.filter((pattern) => !pattern.startsWith("!"));
      for (const pattern of included) {
        expect(guardedRoots, `${platform}.files pattern "${pattern}"`).toContain(
          pattern.split("/")[0]
        );
      }
    }
  });
});

describe("electron-builder config — OS folder context menus (#11406)", () => {
  const WORKFLOW_DIR = "build/macos/Open in Daintree.workflow";

  it("ships the Finder Quick Action bundle as a macOS resource", async () => {
    const config = await buildConfig();
    const entry = config.mac.extraResources.find((r) => r.from === WORKFLOW_DIR);
    // FinderQuickActionService resolves the packaged source as
    // `process.resourcesPath/<basename>`, so the bundle name must survive the
    // copy — renaming it in `to` would break the lookup.
    expect(entry?.to).toBe(WORKFLOW_DIR.split("/").pop());
  });

  it("declares a Finder-only service that macOS will actually dispatch", async () => {
    const infoPlist = await repoFile(`${WORKFLOW_DIR}/Contents/Info.plist`);
    // macOS dispatches an Automator workflow service by this exact selector.
    // `runWorkflow` looks plausible and is wrong: the menu item appears and
    // then does nothing at all.
    expect(plistString(infoPlist, "NSMessage")).toBe("runWorkflowAsService");
    // Scoping to Finder is what keeps the entry out of every other app's
    // Services menu.
    expect(plistString(infoPlist, "NSApplicationIdentifier")).toBe("com.apple.finder");
    // A .workflow is a bundle, not an application.
    expect(plistString(infoPlist, "CFBundlePackageType")).toBe("BNDL");
  });

  it("declares the workflow document as a folder-scoped services-menu workflow", async () => {
    const wflow = await repoFile(`${WORKFLOW_DIR}/Contents/document.wflow`);
    // Any other workflow type registers as an app/print-plugin instead of a
    // Services entry, so the Quick Action never appears.
    expect(plistString(wflow, "workflowTypeIdentifier")).toBe("com.apple.Automator.servicesMenu");
    expect(plistString(wflow, "serviceInputTypeIdentifier")).toContain(
      "com.apple.Automator.fileSystemObject"
    );
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
    // inputMethod 1 is "as arguments"; 0 would send the folder on stdin, where
    // the `"$@"` loop would silently iterate nothing.
    expect(plistInteger(wflow, "inputMethod")).toBe("1");
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
  const SELECTED_VERB = "Directory\\shell";
  const BACKGROUND_VERB = "Directory\\Background\\shell";

  /** The single-quoted command string a verb's `command` subkey is set to. */
  const verbCommand = (nsh, verbKey) =>
    nsh.match(
      new RegExp(
        `WriteRegStr HKCU "Software\\\\Classes\\\\${verbKey.replace(/\\/g, "\\\\")}\\\\Daintree\\\\command" "" '([^']*)'`
      )
    )?.[1];

  /** The value the app would receive as `--cli-path`, for a given %-expansion. */
  const cliPathOperand = (command, folder) =>
    command.replace(/%[1V]/g, folder).match(/--cli-path="([^"]*)"/)?.[1];

  it("passes the selected folder as %1 and the background folder as %V", async () => {
    const nsh = await repoFile("build/installer.nsh");
    expect(verbCommand(nsh, SELECTED_VERB)).toContain("%1");
    // Right-clicking empty space inside a folder has no selection, so %1 would
    // expand to nothing — %V carries the folder being viewed.
    expect(verbCommand(nsh, BACKGROUND_VERB)).toContain("%V");
  });

  it("joins the folder to --cli-path so a warm launch can't lose the operand", async () => {
    const nsh = await repoFile("build/installer.nsh");
    for (const verbKey of [SELECTED_VERB, BACKGROUND_VERB]) {
      const command = verbCommand(nsh, verbKey);
      // `second-instance` reports Chromium's argv reconstruction, which groups
      // switches ahead of positionals: with the two-token `--cli-path <path>`
      // form an injected Chromium switch lands in the operand slot and is read
      // as the folder (#11410). Joined-and-quoted survives the reshuffle and
      // still tolerates spaces in the path.
      expect(command).toMatch(/--cli-path="%[1V]/);
      expect(command).not.toMatch(/--cli-path\s/);
    }
  });

  it("keeps a drive root from escaping its own closing quote", async () => {
    const nsh = await repoFile("build/installer.nsh");
    const command = verbCommand(nsh, BACKGROUND_VERB);
    // At a drive root %V expands to `D:\`. CommandLineToArgvW reads an odd run
    // of backslashes before a quote as escaping it, so an operand ending in a
    // backslash never closes and swallows the rest of the command line.
    const atDriveRoot = cliPathOperand(command, "D:\\");
    expect(atDriveRoot.endsWith("\\")).toBe(false);
    // Whatever guards the quote may only add syntax that normalizes away —
    // both the drive root and an ordinary folder must survive intact.
    expect(path.win32.normalize(atDriveRoot)).toBe("D:\\");
    expect(path.win32.normalize(cliPathOperand(command, "C:\\src\\app"))).toBe("C:\\src\\app");
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

  it("keeps exactly one shell-refresh call in each macro", async () => {
    const nsh = await repoFile("build/installer.nsh");
    const uninstallStart = nsh.indexOf("!macro customUnInstall");
    const install = nsh.slice(nsh.indexOf("!macro customInstall"), uninstallStart);
    const uninstall = nsh.slice(uninstallStart);
    // SHCNE_ASSOCCHANGED covers the `.dntr` association and both folder verbs
    // in a single notification, but each macro needs its own — counting the
    // file as a whole would pass with two in install and none in uninstall.
    expect(install.match(/SHChangeNotify/g)).toHaveLength(1);
    expect(uninstall.match(/SHChangeNotify/g)).toHaveLength(1);
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
