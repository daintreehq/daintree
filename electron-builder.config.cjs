const VALID_VARIANTS = ["daintree", "canopy"];
const PACKAGE_VERSION = require("./package.json").version;

function getPublishChannel(version) {
  if (version.includes("-rc")) return "rc";
  if (version.includes("-beta")) return "beta";
  return "latest";
}

const VARIANTS = {
  daintree: {
    appId: "org.daintree.app",
    productName: "Daintree",
    publishUrl: "https://updates.daintree.org/releases/",
    icon: "build/icon",
    linuxExecutableName: "daintree",
    linuxStartupWMClass: "daintree",
    linuxApparmor: "build/linux/daintree.apparmor",
    linuxPostInstall: "build/linux/postinst.sh",
    linuxPostRemove: "build/linux/postrm.sh",
    cliScript: "scripts/daintree-cli.sh",
    cliScriptName: "daintree-cli.sh",
    apparmorName: "daintree.apparmor",
    microphoneDescription:
      "Daintree uses the microphone for voice dictation into terminal inputs.",
  },
  canopy: {
    appId: "com.canopyide.app",
    productName: "Canopy",
    publishUrl: "https://updates.canopyide.com/releases/",
    icon: "build/legacy/icon",
    linuxExecutableName: "canopy-app",
    linuxStartupWMClass: "canopy-app",
    linuxApparmor: "build/linux/legacy/canopy.apparmor",
    linuxPostInstall: "build/linux/legacy/postinst.sh",
    linuxPostRemove: "build/linux/legacy/postrm.sh",
    cliScript: "scripts/legacy/canopy-cli.sh",
    cliScriptName: "canopy-cli.sh",
    apparmorName: "canopy.apparmor",
    microphoneDescription:
      "Canopy uses the microphone for voice dictation into terminal inputs.",
  },
};

module.exports = async function () {
  const variant = process.env.BUILD_VARIANT || "daintree";
  if (!VALID_VARIANTS.includes(variant)) {
    throw new Error(
      `Invalid BUILD_VARIANT: "${variant}". Must be one of: ${VALID_VARIANTS.join(", ")}`
    );
  }

  const v = VARIANTS[variant];
  const publishChannel = getPublishChannel(PACKAGE_VERSION);

  return {
    asar: true,
    appId: v.appId,
    productName: v.productName,
    publish: [{ provider: "generic", url: v.publishUrl, channel: publishChannel }],
    electronUpdaterCompatibility: ">=2.16",
    npmRebuild: true,
    electronLanguages: ["en-US"],
    directories: {
      buildResources: "build",
      output: `release/${variant}`,
    },
    files: [
      "dist/**/*",
      "dist-electron/**/*",
      "!node_modules/node-pty/bin",
      "!node_modules/node-pty/prebuilds",
    ],
    extraResources: [
      { from: "help", to: "help" },
      { from: "electron/resources/sounds", to: "sounds" },
    ],
    asarUnpack: [
      "node_modules/node-pty/**/*",
      "node_modules/better-sqlite3/**/*",
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
      extraResources: [{ from: v.cliScript, to: v.cliScriptName }],
      x64ArchFiles:
        "Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/**",
      forceCodeSigning: true,
      notarize: true,
      binaries: [
        "Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper",
      ],
      category: "public.app-category.developer-tools",
      icon: `${v.icon}.icns`,
      extendInfo: {
        CFBundleIconName: "Icon",
        NSPrefersDisplaySafeAreaCompatibilityMode: false,
        NSMicrophoneUsageDescription: v.microphoneDescription,
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
      icon: `${v.icon}.icns`,
      contents: [
        { x: 130, y: 220 },
        { x: 410, y: 220, type: "link", path: "/Applications" },
      ],
    },
    win: {
      icon: `${v.icon}.ico`,
      target: [
        { target: "nsis", arch: ["x64"] },
        { target: "portable", arch: ["x64"] },
      ],
    },
    nsis: {
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      installerIcon: `${v.icon}.ico`,
      uninstallerIcon: `${v.icon}.ico`,
      installerHeaderIcon: `${v.icon}.ico`,
    },
    linux: {
      icon: `${v.icon}.png`,
      executableName: v.linuxExecutableName,
      target: ["AppImage", "deb"],
      category: "Development",
      desktop: { entry: { StartupWMClass: v.linuxStartupWMClass } },
      extraResources: [
        { from: v.cliScript, to: v.cliScriptName },
        { from: v.linuxApparmor, to: v.apparmorName },
      ],
    },
    deb: {
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
      afterInstall: v.linuxPostInstall,
      afterRemove: v.linuxPostRemove,
    },
  };
};
