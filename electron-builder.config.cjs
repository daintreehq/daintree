const PACKAGE_VERSION = require("./package.json").version;

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
    publish: [publishEntry],
    electronUpdaterCompatibility: ">=2.16",
    npmRebuild: true,
    electronLanguages: ["en-US"],
    directories: {
      buildResources: "build",
      output: "release",
    },
    files: [
      "dist/**/*",
      "dist-electron/**/*",
      "!demo/**",
      "!node_modules/node-pty/bin",
      "!node_modules/node-pty/prebuilds",
      "!node_modules/ffmpeg-static/**/*",
    ],
    extraResources: [
      { from: "help", to: "help" },
      { from: "electron/resources/sounds", to: "sounds" },
      { from: "electron/services/persistence/migrations", to: "migrations" },
    ],
    // node-pty and better-sqlite3 contain native .node binaries that need
    // real filesystem access for `require()` — they cannot live inside the
    // ASAR. This means `enableEmbeddedAsarIntegrityValidation` (below) does
    // not cover these unpacked files. `afterPack.cjs` validates binary
    // presence (and ABI for better-sqlite3) as a partial mitigation.
    asarUnpack: [
      "node_modules/node-pty/**/*",
      "node_modules/better-sqlite3/**/*",
      "node_modules/win-job-object/**/*",
      "node_modules/posix-pty-reaper/**/*",
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
    mac: {
      extraResources: [{ from: "scripts/daintree-cli.sh", to: "daintree-cli.sh" }],
      x64ArchFiles:
        "Contents/Resources/app.asar.unpacked/node_modules/{node-pty/build/Release/**,win-job-object/bin/**,posix-pty-reaper/build/Release/**,@parcel/watcher-darwin-*/watcher.node,@parcel/watcher/bin/darwin-*/watcher.node}",
      forceCodeSigning: true,
      notarize: true,
      binaries: [
        "Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper",
        "Contents/Resources/app.asar.unpacked/node_modules/posix-pty-reaper/build/Release/daintree_pty_supervisor",
      ],
      category: "public.app-category.developer-tools",
      icon: "build/icon.icns",
      extendInfo: {
        CFBundleIconName: "Icon",
        NSPrefersDisplaySafeAreaCompatibilityMode: false,
        NSMicrophoneUsageDescription:
          "Daintree uses the microphone for voice dictation into terminal inputs.",
      },
      target: [
        { target: "dmg", arch: ["arm64", "x64", "universal"] },
        { target: "zip", arch: ["arm64", "x64", "universal"] },
      ],
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.plist",
    },
    dmg: {
      icon: "build/icon.icns",
      contents: [
        { x: 130, y: 220 },
        { x: 410, y: 220, type: "link", path: "/Applications" },
      ],
    },
    win: {
      icon: "build/icon.ico",
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
    },
    // NSIS (non-Store) Windows installer. Produces a single combined x64+arm64
    // `.exe`; the installer selects the right payload at runtime. Auto-update
    // is delivered via the generic provider URL above — gated in the renderer
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
    },
    linux: {
      icon: "build/icon.png",
      executableName: "daintree",
      target: ["AppImage", "deb"],
      category: "Development",
      desktop: { entry: { StartupWMClass: "daintree" } },
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
        "libxss1",
        "libxtst6",
        "libx11-6",
        "libx11-xcb1",
        "libxcb1",
        "libatk1.0-0",
        "libatk-bridge2.0-0",
        "libcups2",
        "libdrm2",
        "libexpat1",
        "libnotify4",
        "libsecret-1-0",
        "xdg-utils",
      ],
      afterInstall: "build/linux/postinst.sh",
      afterRemove: "build/linux/postrm.sh",
    },
  };
};
