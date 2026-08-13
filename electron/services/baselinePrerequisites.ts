import type { PrerequisiteSpec } from "../../shared/types/ipc.js";

/**
 * Tools Daintree needs regardless of which agents are configured. Kept in its
 * own module so consumers that only need the declarative data — the install
 * service resolving a one-click target, for one — don't pull in the health
 * check's `child_process` and PATH-refresh dependencies, which reach into
 * Electron's `app` and can't load outside the main process.
 */
export const BASELINE_PREREQUISITES: PrerequisiteSpec[] = [
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
      linux: [{ label: "apt", commands: ["sudo apt-get install git"] }],
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
          notes: ["npm is included with Node.js", "Requires Node.js v18.0.0 or later"],
        },
      ],
      windows: [
        {
          label: "winget",
          commands: ["winget install --id OpenJS.NodeJS.LTS -e --source winget"],
          notes: ["npm is included with Node.js", "Requires Node.js v18.0.0 or later"],
        },
      ],
      linux: [
        {
          label: "NodeSource",
          commands: [
            "curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -",
            "sudo apt-get install -y nodejs",
          ],
          notes: [
            "npm is included with Node.js",
            "Requires Node.js v18.0.0 or later",
            "The default Ubuntu nodejs package may be outdated — NodeSource provides current versions",
          ],
        },
      ],
    },
  },
  {
    tool: "npm",
    label: "npm",
    versionArgs: ["--version"],
    severity: "warn",
    installUrl: "https://docs.npmjs.com/downloading-and-installing-node-js-and-npm",
    installBlocks: {
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
      windows: [{ label: "winget", commands: ["winget install --id GitHub.cli"] }],
      linux: [
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
  },
];
