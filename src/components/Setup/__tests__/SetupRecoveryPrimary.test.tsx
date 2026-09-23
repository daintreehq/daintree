// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/clients", () => ({
  systemClient: { openExternal: vi.fn(() => Promise.resolve()) },
}));

// jsdom reports no platform, so give every agent one executable npm method.
vi.mock("@/lib/agentInstall", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agentInstall")>()),
  getInstallBlocksForCurrentOS: () => [{ label: "npm", commands: ["npm install -g agent"] }],
}));

vi.mock("@/store", () => ({
  useAgentSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ updateAgent: vi.fn(), settings: { agents: {} } }),
}));

import { AgentCliStep } from "../AgentCliStep";
import { PrerequisiteCard } from "../SystemToolsStep";

function render(ui: ReactElement) {
  return rtlRender(<TooltipProvider>{ui}</TooltipProvider>);
}

/**
 * A setup step has one primary. On the install step that is the install while
 * nothing picked works yet, and the footer's Continue once something does —
 * never both at once.
 */
describe("install step primary", () => {
  function installButton(): HTMLElement {
    return screen.getByTestId("agent-cli-install-primary");
  }

  it("leads with the install while no picked agent is usable", () => {
    render(
      <AgentCliStep
        availability={{ claude: "missing", gemini: "missing" } as never}
        selections={{ claude: true }}
      />
    );
    expect(installButton().getAttribute("data-variant")).toBe("contrast");
  });

  it("steps the install down once a picked agent already works", () => {
    render(
      <AgentCliStep
        availability={{ claude: "ready", gemini: "missing" } as never}
        selections={{ claude: true, gemini: true }}
      />
    );
    // The footer's Continue is the primary now; a second filled button would
    // make two.
    expect(installButton().getAttribute("data-variant")).not.toBe("contrast");
    // One agent left to install means one install action, not a row button too.
    expect(screen.getAllByRole("button", { name: /^install/i })).toHaveLength(1);
  });
});

describe("missing required tool", () => {
  const spec = {
    tool: "git",
    label: "Git",
    versionArgs: ["--version"],
    severity: "fatal" as const,
    installUrl: "https://git-scm.com/downloads",
    installBlocks: {
      macos: [{ label: "Homebrew", commands: ["brew install git"] }],
      windows: [{ label: "winget", commands: ["winget install Git.Git"] }],
      linux: [{ label: "apt", commands: ["sudo apt-get install git"] }],
      generic: [{ label: "Download", commands: ["see git-scm.com"] }],
    },
  };
  const missing = {
    tool: "git",
    label: "Git",
    available: false,
    version: null,
    severity: "fatal" as const,
    meetsMinVersion: false,
    installUrl: spec.installUrl,
    installBlocks: spec.installBlocks,
  };

  it("opens on its install steps rather than hiding them behind a disclosure", () => {
    render(<PrerequisiteCard spec={spec} state={missing} />);
    const panel = document.getElementById("install-panel-git");
    expect(panel).not.toBeNull();
    expect(panel!.hidden).toBe(false);
  });

  it("keeps an optional tool's steps folded until asked for", () => {
    render(
      <PrerequisiteCard
        spec={{ ...spec, severity: "warn" }}
        state={{ ...missing, severity: "warn" }}
      />
    );
    expect(document.getElementById("install-panel-git")!.hidden).toBe(true);
  });

  it("names the download link", () => {
    render(<PrerequisiteCard spec={spec} state={missing} />);
    expect(screen.getByRole("link", { name: "Open the Git download page" })).toBeTruthy();
  });
});
