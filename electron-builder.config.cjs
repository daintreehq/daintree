const PACKAGE_VERSION = require("./package.json").version;
const path = require("path");
const fs = require("fs");

// Packages require()d from node_modules at runtime. Two sources:
// 1. The esbuild `external` list in scripts/build-main.mjs (minus "electron").
// 2. CJS-only packages loaded via createRequire interop — esbuild can't see
//    through `req("...")` calls, so they are never bundled and must resolve
//    from the ASAR's node_modules (PluginService: ajv, ajv-formats;
//    PluginInstaller: proper-lockfile).
// Everything else under node_modules is already bundled into dist/
// dist-electron by Vite/esbuild and is dead weight in the ASAR (~10k files,
// issue #10395).
const RUNTIME_NODE_MODULE_ROOTS = [
  "@parcel/watcher",
  "node-pty",
  "better-sqlite3",
  "win-job-object",
  "posix-pty-reaper",
  "copytree",
  "onnxruntime-node",
  "avr-vad",
  "ajv",
  "ajv-formats",
  "proper-lockfile",
];

/**
 * Walk the production dependency closure (dependencies + optional + peer,
 * skipping packages not installed) of the given root package names, resolving
 * against the top-level node_modules.
 */
function collectDependencyClosure(rootNames) {
  const closure = new Set();
  const queue = [...rootNames];
  while (queue.length > 0) {
    const name = queue.pop();
    if (closure.has(name)) continue;
    const manifestPath = path.join(__dirname, "node_modules", name, "package.json");
    if (!fs.existsSync(manifestPath)) continue; // e.g. other-platform optional deps
    closure.add(name);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    queue.push(
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {})
    );
  }
  return closure;
}

/**
 * `!node_modules/<pkg>/**` exclusion patterns for every package in the
 * production tree that no runtime-required (esbuild-external) package needs.
 * Computed per build machine so platform-specific optional deps (e.g.
 * `@parcel/watcher-darwin-arm64`) resolve naturally. Exclusion-only patterns
 * sidestep electron-builder's unreliable re-include-after-`!node_modules/**`
 * matching; nested `node_modules` copies under kept packages are untouched.
 */
function buildBundledNodeModuleExcludes() {
  const appDependencies = Object.keys(require("./package.json").dependencies ?? {});
  const keep = collectDependencyClosure(RUNTIME_NODE_MODULE_ROOTS);
  const all = collectDependencyClosure(appDependencies);
  return [...all]
    .filter((name) => !keep.has(name))
    .sort()
    .map((name) => `!node_modules/${name}/**/*`);
}

// electron-builder 26.x enforces the channel enum: "alpha" | "beta" | "dev"
// | "rc" | "stable" | null. Anything else fails schema validation. We return
// null for stable and nightly — stable and nightly both publish a `latest.yml`
// at their respective URL prefixes (URL separation, not channel separation).
// Nightly is detected from the version string and routed to a separate publish
// URL in the factory below.
function getPublishChannel(version) {
  if (version.includes("-rc")) return "rc";
  if (version.includes("-beta")) return "beta";
  return null;
}

const PUBLISH_URL = "https://updates.daintree.org/releases/";
const NIGHTLY_PUBLISH_URL = "https://updates.daintree.org/nightly/";

/**
 * The shared `files` allowlist.
 *
 * electron-builder does NOT merge a platform-level `files` with the top-level
 * one — the platform array replaces it outright. Adding `mac.files` for the
 * better-sqlite3 prebuilds therefore silently dropped every pattern below and
 * fell back to the default `**\/*`, packaging the entire project tree. That is
 * what broke the macOS universal build: `electron/native/*\/build` came along
 * with it, and @electron/universal aborts on node-gyp's per-arch metadata
 * ("Can't reconcile two non-macho files ...daintree_pty_supervisor.d").
 *
 * Every platform override must spread this list rather than replace it.
 */
function baseFiles() {
  return [
    "dist/**/*",
    "dist-electron/**/*",
    "electron/services/persistence/migrations/**/*",
    "!demo/**",
    "!node_modules/node-pty/bin",
    "!node_modules/node-pty/prebuilds",
    "!node_modules/ffmpeg-static/**/*",
    // Sample plugins are an e2e harness fixture (#9286) — sideloaded only
    // when `DAINTREE_E2E_SIDELOAD_PLUGIN_DIR` is set, which is constant-
    // folded to "" in production builds. Excluding the dir keeps shipped
    // binaries from carrying dead test fixtures.
    "!dist-electron/plugins/sample/**",
    // Drop node_modules packages that are already bundled into dist/
    // dist-electron and never require()d at runtime (#10395).
    ...buildBundledNodeModuleExcludes(),
  ];
}

module.exports = async function () {
  const publishChannel = getPublishChannel(PACKAGE_VERSION);
  const isNightly = PACKAGE_VERSION.includes("-nightly");
  const publishUrl = isNightly ? NIGHTLY_PUBLISH_URL : PUBLISH_URL;

  // Only include `channel` when it's a valid enum value; passing null is
  // accepted but passing undefined via object-spread can still trip some
  // downstream tooling, so we build the entry conditionally.
  const publishEntry = { provider: "generic", url: publishUrl };
  if (publishChannel !== null) {
    publishEntry.channel = publishChannel;
  }

  return {
    asar: true,
    appId: "org.daintree.app",
    productName: "Daintree",
    // Register the `daintree://` deep-link scheme at the OS level (#9559).
    // electron-builder injects `CFBundleURLTypes` on macOS, an HKCU registry
    // write in the NSIS installer (per-user, no elevation), and
    // `x-scheme-handler/daintree` into the Linux `.desktop` entry. External
    // pages and catalog entries deep-link into the plugin install / open flow;
    // installs still route through the in-app confirm + security gates.
    protocols: [{ name: "Daintree", schemes: ["daintree"] }],
    publish: [publishEntry],
    electronUpdaterCompatibility: ">=2.16",
    npmRebuild: true,
    electronLanguages: ["en-US"],
    directories: {
      buildResources: "build",
      output: "release",
    },
    files: baseFiles(),
    extraResources: [
      { from: "help", to: "help" },
      { from: "electron/resources/sounds", to: "sounds" },
    ],
    // node-pty and better-sqlite3 contain native .node binaries that need
    // real filesystem access for `require()` — they cannot live inside the
    // ASAR. This means `enableEmbeddedAsarIntegrityValidation` (below) does
    // not cover these unpacked files. `afterPack.cjs` validates binary
    // presence (and loadability for better-sqlite3) as a partial mitigation.
    asarUnpack: [
      "node_modules/node-pty/**/*",
      "node_modules/better-sqlite3/**/*",
      "node_modules/win-job-object/**/*",
      "node_modules/posix-pty-reaper/**/*",
      // onnxruntime-node ships per-platform native binaries (.node/.dll/.dylib/
      // .so) for the Silero VAD side-chain (#9177) — they require real
      // filesystem access for the N-API load and cannot live inside the ASAR.
      "node_modules/onnxruntime-node/**/*",
      // avr-vad reads its bundled silero_vad_v5.onnx via `fs` relative to its
      // own dist dir; unpack so that path resolves outside the ASAR too.
      "node_modules/avr-vad/**/*",
      // @parcel/watcher loads per-platform `watcher.node` binaries; the mac
      // x64ArchFiles signing glob below already assumes they live under
      // app.asar.unpacked — make that explicit instead of relying on
      // electron-builder's smart-unpack detection.
      "node_modules/@parcel/watcher/**/*",
      "node_modules/@parcel/watcher-*/**/*",
      // Built-in plugins may bundle `bin/`/`mcp/` scripts spawned via node-pty,
      // which uses native OS spawn and bypasses Electron's ASAR filesystem patch
      // — a `./bin/*.mjs` packed inside app.asar ENOENTs at spawn time. Unpack
      // the whole built-in plugin tree so those `./`-relative paths resolve on
      // the real filesystem (#10579). Sample plugins are excluded from `files`.
      "dist-electron/plugins/builtin/**/*",
    ],
    electronFuses: {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      loadBrowserProcessSpecificV8Snapshot: false,
      grantFileProtocolExtraPrivileges: false,
    },
    afterPack: "./scripts/afterPack.cjs",
    afterSign: "./scripts/notarize-macos.cjs",
    mac: {
      // No `beforePack` hook and no `singleArchFiles` allowList: both were
      // added to keep node-gyp's per-arch build metadata out of the macOS
      // universal merge, and both were only ever needed because the platform
      // `files` overrides had dropped the allowlist and electron-builder was
      // packing the whole source tree (#11475). With `baseFiles()` restored,
      // `electron/native/**` is not selected at all, and the only route those
      // packages take into the ASAR is the production-dependency copier, which
      // strips Makefile / binding.Makefile / config.gypi / *.mk / gyp-mac-tool
      // and Release/{.deps,obj.target} unconditionally, plus `.forge-meta` via
      // its excluded-extension list. `x64ArchFiles` below stays — it solves a
      // different problem (identical Mach-O prebuilds present in both slices).
      extraResources: [
        { from: "scripts/daintree-cli.sh", to: "daintree-cli.sh" },
        // Finder "Open in Daintree" Quick Action. Rides in the sealed bundle as
        // an inert resource and becomes user data only once the user installs
        // it into ~/Library/Services from the app menu, so it carries no
        // signing or notarization impact and needs no CSC_LINK gate.
        {
          from: "build/macos/Open in Daintree.workflow",
          to: "Open in Daintree.workflow",
        },
      ],
      // better-sqlite3 v13 ships prebuilds for every OS in one package; drop
      // the foreign-platform binaries (~12MB). Both darwin arches stay — the
      // universal build merges x64 and arm64 app trees, and the identical
      // Mach-O prebuilds present in both are allowlisted via x64ArchFiles.
      files: [...baseFiles(), "!node_modules/better-sqlite3/prebuilds/{linux,linuxmusl,win32}-*.node"],
      x64ArchFiles:
        "Contents/Resources/app.asar.unpacked/node_modules/{node-pty/build/Release/**,better-sqlite3/prebuilds/darwin-*.node,win-job-object/bin/**,posix-pty-reaper/build/Release/**,onnxruntime-node/bin/**,@parcel/watcher-darwin-*/watcher.node,@parcel/watcher/bin/darwin-*/watcher.node}",
      forceCodeSigning: true,
      notarize: false,
      binaries: [
        "Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper",
        "Contents/Resources/app.asar.unpacked/node_modules/posix-pty-reaper/build/Release/daintree_pty_supervisor",
      ],
      category: "public.app-category.developer-tools",
      icon: "build/icon.icns",
      // Register the `.dntr` plugin-archive association so Finder double-click
      // and "Open With → Daintree" route through the open-file handler (#9293).
      // Gated on CSC_LINK (set only in signed CI release runs) so unsigned dev
      // builds don't pollute the macOS Launch Services database with an
      // unsigned mapping. `icon` is relative to buildResources ("build/"), so
      // the value is "icons/dntr.icns" — not "build/icons/dntr.icns".
      fileAssociations: process.env.CSC_LINK
        ? [
            {
              ext: "dntr",
              name: "Daintree Plugin",
              role: "Editor",
              rank: "Owner",
              isPackage: false,
              icon: "icons/dntr.icns",
            },
          ]
        : [],
      extendInfo: {
        CFBundleIconName: "Icon",
        NSPrefersDisplaySafeAreaCompatibilityMode: false,
        NSMicrophoneUsageDescription:
          "Daintree uses the microphone for voice dictation into terminal inputs.",
        // Accept folders dropped on the Dock icon / "Open With" so macOS Launch
        // Services delivers them to the `open-file` handler, which opens them as
        // projects (#10976). `public.folder` is the Finder-facing folder UTI (not
        // the abstract `public.directory`); Viewer/Alternate registers as a
        // non-default handler so Finder keeps opening folders itself. electron-
        // builder concatenates this with the `.dntr` `fileAssociations` entry
        // above into one CFBundleDocumentTypes array (PR #8035), so neither is
        // clobbered. Gated on CSC_LINK for the same Launch-Services-pollution
        // guard — unsigned dev builds skip it.
        ...(process.env.CSC_LINK
          ? {
              CFBundleDocumentTypes: [
                {
                  CFBundleTypeName: "Folder",
                  CFBundleTypeRole: "Viewer",
                  LSHandlerRank: "Alternate",
                  LSItemContentTypes: ["public.folder"],
                },
              ],
            }
          : {}),
      },
      target: [
        { target: "dmg", arch: ["arm64", "x64", "universal"] },
        { target: "zip", arch: ["arm64", "x64", "universal"] },
      ],
      // A user-specified artifactName forces ${arch} to render for x64 too
      // (bypassing electron-builder's default-arch suffix stripping), so no
      // macOS artifact looks like "the" Mac download (#10380). This pattern
      // covers the zip target — a root-level `zip` block is rejected by the
      // config schema — while the dmg block's artifactName takes precedence
      // for DMGs.
      artifactName: "${productName}-${version}-${arch}-${os}.${ext}",
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.plist",
    },
    // Explicit dmg block override; the dmg pattern drops the ${os} token.
    // Unpacked dirs (release/mac/, release/mac-arm64/, release/mac-universal/)
    // are unaffected by artifactName.
    dmg: {
      icon: "build/icon.icns",
      artifactName: "${productName}-${version}-${arch}.${ext}",
      contents: [
        { x: 130, y: 220 },
        { x: 410, y: 220, type: "link", path: "/Applications" },
      ],
    },
    win: {
      icon: "build/icon.ico",
      // Foreign-platform better-sqlite3 prebuilds — see the mac.files note.
      files: [...baseFiles(), "!node_modules/better-sqlite3/prebuilds/{darwin,linux,linuxmusl}-*.node"],
      artifactName: "${productName}-${version}-${arch}-setup.${ext}",
      target: [
        { target: "appx", arch: ["x64"] },
        { target: "nsis", arch: ["x64", "arm64"] },
      ],
    },
    // Identity values must match Partner Center → Daintree → Product Identity
    // verbatim or `msstore submission update` fails with `Invalid Identity`.
    // See docs/distribution/microsoft-store.md.
    appx: {
      identityName: "GregPriday.Daintree",
      publisher: "CN=BC1A870C-0C12-4FAB-90BF-AB9D8A0DC176",
      publisherDisplayName: "Greg Priday",
      applicationId: "Daintree",
      displayName: "Daintree",
      languages: ["en-US"],
      setBuildNumber: true,
    },
    // NSIS (non-Store) Windows installer. Separate x64 and arm64 installers
    // built on their respective native runners (#9244). Auto-update is
    // delivered via the generic provider URL above — gated in the renderer
    // by `process.windowsStore` so MSIX/AppX builds keep using the Store path.
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      allowElevation: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: "Daintree",
      uninstallDisplayName: "Daintree",
      differentialPackage: true,
      buildUniversalInstaller: false,
      // `.dntr` (plugin archive) file association is registered via a custom
      // NSIS include rather than electron-builder's `fileAssociations`: the
      // built-in path requires `perMachine: true` (HKLM, system-wide), which
      // would force elevation on install AND on every auto-update. We keep the
      // per-user (HKCU) install model and register the association by hand in
      // build/installer.nsh. Double-clicking a `.dntr` then launches Daintree
      // with the file path in argv, picked up by the second-instance handler.
      include: "build/installer.nsh",
    },
    linux: {
      icon: "build/icon.png",
      // Foreign-platform better-sqlite3 prebuilds — see the mac.files note.
      // Electron only runs on glibc, so the linuxmusl variants go too.
      files: [...baseFiles(), "!node_modules/better-sqlite3/prebuilds/{darwin,win32,linuxmusl}-*.node"],
      executableName: "daintree",
      target: ["AppImage", "deb"],
      category: "Development",
      desktop: { entry: { StartupWMClass: "daintree" } },
      // Puts Daintree in the "Open With" menu for folders on desktops that
      // honour `inode/directory` (GNOME/Nautilus). electron-builder merges this
      // with the `fileAssociations` mime types and the `daintree://` scheme
      // handler into one semicolon-joined MimeType line, so it does not clobber
      // them. The folder arrives as a `file://` URI via the `%U` field code
      // electron-builder appends to Exec — `extractDirectoryPaths` in
      // electron/lifecycle/appLifecycle.ts decodes it.
      mimeTypes: ["inode/directory"],
      // `.dntr` plugin-archive association. electron-builder generates the XDG
      // mime-type XML and adds `MimeType=application/x-dntr` to the .desktop
      // entry; double-clicking then launches Daintree with the path in argv.
      fileAssociations: [
        {
          ext: "dntr",
          name: "Daintree Plugin",
          description: "Daintree plugin archive",
          mimeType: "application/x-dntr",
        },
      ],
      extraResources: [
        { from: "scripts/daintree-cli.sh", to: "daintree-cli.sh" },
        { from: "build/linux/daintree.apparmor", to: "daintree.apparmor" },
      ],
    },
    deb: {
      packageName: "daintree",
      depends: [
        "libc6 (>= 2.31)",
        "libgtk-3-0",
        "libnss3",
        "libasound2",
        "libgbm1",
        "libxkbcommon0",
        "libxrandr2",
        "libxshmfence1",
        "libxss1",
        "libxtst6",
        "libx11-6",
        "libx11-xcb1",
        "libxcb1",
        "libxdamage1",
        "libxfixes3",
        "libatk1.0-0",
        "libatk-bridge2.0-0",
        "libcups2",
        "libdbus-1-3",
        "libdrm2",
        "libexpat1",
        "libnotify4",
        "libnspr4",
        "libsecret-1-0",
        "xdg-utils",
      ],
      afterInstall: "build/linux/postinst.sh",
      afterRemove: "build/linux/postrm.sh",
    },
  };
};
