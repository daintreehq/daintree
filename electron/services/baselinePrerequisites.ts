import type { AgentInstallBlock } from "../../shared/config/agentRegistry.js";
import type { PrerequisiteSpec } from "../../shared/types/ipc.js";
import { getLinuxDistroFamily, type LinuxDistroFamily } from "../utils/linuxDistro.js";

const NODE_MIN_VERSION_NOTE = "Requires Node.js v18.0.0 or later";
const NPM_INCLUDED_NOTE = "npm is included with Node.js";

interface LinuxHints {
  git: AgentInstallBlock[];
  node: AgentInstallBlock[];
  /** Only where npm is its own package; elsewhere the generic block applies. */
  npm?: AgentInstallBlock[];
  gh: AgentInstallBlock[];
}

/**
 * Linux install hints per package-manager family. Every one needs `sudo`, so
 * none is a one-click install (see `AgentInstallService`); they are copy-paste
 * guidance, and a wrong package manager is guidance that cannot work.
 *
 * GitHub CLI commands are the vendor's own (cli/cli `docs/install_linux.md`):
 * its apt and RPM repositories, and Arch's community package, which that page
 * points to. Fedora is DNF5 from Fedora 41; the enterprise line is still DNF4.
 */
const LINUX_HINTS: Record<LinuxDistroFamily, LinuxHints> = {
  debian: {
    git: [{ label: "apt", commands: ["sudo apt-get install git"] }],
    node: [
      {
        label: "NodeSource",
        commands: [
          "curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -",
          "sudo apt-get install -y nodejs",
        ],
        notes: [
          NPM_INCLUDED_NOTE,
          NODE_MIN_VERSION_NOTE,
          "The default Ubuntu nodejs package may be outdated — NodeSource provides current versions",
        ],
      },
    ],
    gh: [
      {
        label: "Official APT repository",
        commands: [
          "sudo mkdir -p -m 755 /etc/apt/keyrings",
          "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null",
          "sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg",
          'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null',
          "sudo apt update && sudo apt install gh -y",
        ],
      },
    ],
  },
  fedora: {
    git: [{ label: "dnf", commands: ["sudo dnf install git"] }],
    // Fedora's own nodejs tracks a current LTS, so no third-party repo.
    node: [
      {
        label: "dnf",
        commands: ["sudo dnf install nodejs npm"],
        notes: [NODE_MIN_VERSION_NOTE],
      },
    ],
    npm: [{ label: "dnf", commands: ["sudo dnf install npm"] }],
    gh: [
      {
        label: "Official RPM repository",
        commands: [
          "sudo dnf install dnf5-plugins",
          "sudo dnf config-manager addrepo --from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo",
          "sudo dnf install gh",
        ],
      },
    ],
  },
  rhel: {
    git: [{ label: "dnf", commands: ["sudo dnf install git"] }],
    node: [
      {
        label: "NodeSource",
        commands: [
          "curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -",
          "sudo dnf install -y nodejs",
        ],
        notes: [
          NPM_INCLUDED_NOTE,
          NODE_MIN_VERSION_NOTE,
          "The default nodejs package on RHEL-based systems may be outdated — NodeSource provides current versions",
        ],
      },
    ],
    gh: [
      {
        label: "Official RPM repository",
        commands: [
          "sudo dnf install 'dnf-command(config-manager)'",
          "sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo",
          "sudo dnf install gh",
        ],
      },
    ],
  },
  arch: {
    git: [{ label: "pacman", commands: ["sudo pacman -S git"] }],
    node: [
      {
        label: "pacman",
        commands: ["sudo pacman -S nodejs npm"],
        notes: [NODE_MIN_VERSION_NOTE],
      },
    ],
    npm: [{ label: "pacman", commands: ["sudo pacman -S npm"] }],
    gh: [{ label: "pacman", commands: ["sudo pacman -S github-cli"] }],
  },
  suse: {
    git: [{ label: "zypper", commands: ["sudo zypper install git"] }],
    // openSUSE ships only versioned nodejsNN packages; the -default
    // metapackages follow the release's current major on Tumbleweed and Leap.
    node: [
      {
        label: "zypper",
        commands: ["sudo zypper install nodejs-default npm-default"],
        notes: [NODE_MIN_VERSION_NOTE],
      },
    ],
    npm: [{ label: "zypper", commands: ["sudo zypper install npm-default"] }],
    gh: [
      {
        label: "Official RPM repository",
        commands: [
          "sudo zypper addrepo https://cli.github.com/packages/rpm/gh-cli.repo",
          "sudo zypper ref",
          "sudo zypper install gh",
        ],
      },
    ],
  },
};

/**
 * An unrecognised distro gets no command at all rather than another family's:
 * the banner then offers the install guide link instead of a command that
 * cannot run here.
 */
const UNKNOWN_LINUX_HINTS: LinuxHints = {
  git: [
    {
      label: "Package manager",
      steps: ["Install the git package with your distribution's package manager"],
    },
  ],
  node: [
    {
      label: "Package manager",
      steps: [
        "Install Node.js with your distribution's package manager, or download it from nodejs.org",
      ],
      notes: [NODE_MIN_VERSION_NOTE],
    },
  ],
  gh: [
    {
      label: "Package manager",
      steps: [
        "Install gh with your distribution's package manager, or see cli.github.com for other options",
      ],
    },
  ],
};

/**
 * Tools Daintree needs regardless of which agents are configured, with Linux
 * install hints for `linuxFamily` (null for an unrecognised distro). Kept in
 * its own module so consumers that only need the declarative data — the
 * install service resolving a one-click target, for one — don't pull in the
 * health check's `child_process` and PATH-refresh dependencies, which reach
 * into Electron's `app` and can't load outside the main process.
 */
export function buildBaselinePrerequisites(
  linuxFamily: LinuxDistroFamily | null
): PrerequisiteSpec[] {
  const linux = linuxFamily ? LINUX_HINTS[linuxFamily] : UNKNOWN_LINUX_HINTS;
  return [
    {
      tool: "git",
      label: "Git",
      versionArgs: ["--version"],
      severity: "fatal",
      installUrl: "https://git-scm.com/downloads",
      macosCommandLineTool: true,
      installBlocks: {
        macos: [
          { label: "Homebrew", commands: ["brew install git"] },
          {
            label: "Xcode Command Line Tools",
            commands: ["xcode-select --install"],
            opensExternalInstaller: true,
            notes: ["Opens the macOS installer — finish it there, then re-check"],
          },
        ],
        windows: [
          {
            label: "winget",
            // The agreement flags are part of the canonical command so the
            // copy-paste and one-click paths run the same string: without them
            // winget blocks on the source-agreement prompt on first use, which
            // is invisible under piped stdio.
            commands: [
              "winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements",
            ],
          },
        ],
        linux: linux.git,
      },
    },
    {
      tool: "node",
      label: "Node.js",
      versionArgs: ["--version"],
      severity: "fatal",
      minVersion: "18.0.0",
      installUrl: "https://nodejs.org",
      installBlocks: {
        macos: [
          {
            label: "Homebrew",
            commands: ["brew install node"],
            notes: [NPM_INCLUDED_NOTE, NODE_MIN_VERSION_NOTE],
          },
        ],
        windows: [
          {
            label: "winget",
            commands: [
              "winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements",
            ],
            notes: [NPM_INCLUDED_NOTE, NODE_MIN_VERSION_NOTE],
          },
        ],
        linux: linux.node,
      },
    },
    {
      tool: "npm",
      label: "npm",
      versionArgs: ["--version"],
      severity: "warn",
      installUrl: "https://docs.npmjs.com/downloading-and-installing-node-js-and-npm",
      installBlocks: {
        ...(linux.npm ? { linux: linux.npm } : {}),
        generic: [
          {
            label: "Included with Node.js",
            steps: ["npm is automatically installed with Node.js"],
            notes: ["If npm is missing, reinstall Node.js using the instructions above"],
          },
        ],
      },
    },
    {
      tool: "gh",
      label: "GitHub CLI",
      versionArgs: ["--version"],
      severity: "warn",
      installUrl: "https://cli.github.com",
      installBlocks: {
        macos: [{ label: "Homebrew", commands: ["brew install gh"] }],
        windows: [
          {
            label: "winget",
            commands: [
              "winget install --id GitHub.cli -e --source winget --accept-source-agreements --accept-package-agreements",
            ],
          },
        ],
        linux: linux.gh,
      },
    },
  ];
}

/**
 * The baseline for this machine. os-release is read only on Linux, once per
 * process; macOS and Windows hints don't depend on it.
 */
export function getBaselinePrerequisites(): PrerequisiteSpec[] {
  return buildBaselinePrerequisites(process.platform === "linux" ? getLinuxDistroFamily() : null);
}
