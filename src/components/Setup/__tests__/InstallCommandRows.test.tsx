// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentInstallOS } from "@shared/config/agentRegistry";

const runner = vi.hoisted(() => ({ current: null as null | ReturnType<typeof vi.fn> }));
const host = vi.hoisted(() => ({ os: "linux" as AgentInstallOS }));

vi.mock("@/hooks/terminal/useInstallCommandRunner", () => ({
  useInstallCommandRunner: () => runner.current,
}));
vi.mock("@/lib/agentInstall", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agentInstall")>()),
  detectOS: () => host.os,
}));
vi.mock("@/clients/systemClient", () => ({ systemClient: { openExternal: vi.fn() } }));

import { InstallCommandRows } from "../InstallCommandRows";

const TARGET = { kind: "agent", agentId: "aider" } as const;
const ROW_LABEL = "Open command in a new terminal";
const BLOCK_LABEL = "Open all in a terminal";

function renderRows(commands: string[]) {
  return render(
    <TooltipProvider>
      <InstallCommandRows commands={commands} target={TARGET} />
    </TooltipProvider>
  );
}

beforeEach(() => {
  runner.current = vi.fn();
  host.os = "linux";
});

afterEach(cleanup);

describe("InstallCommandRows", () => {
  it("stays copy-only where no terminal can open", () => {
    runner.current = null;
    renderRows(["curl -fsSL https://aider.chat/install.sh | sh"]);

    expect(screen.queryByLabelText(ROW_LABEL)).toBeNull();
    expect(screen.queryByRole("button", { name: BLOCK_LABEL })).toBeNull();
    expect(screen.getByLabelText("Copy command to clipboard")).toBeTruthy();
  });

  it("opens a single command in a terminal", () => {
    renderRows(["  curl -fsSL https://aider.chat/install.sh | sh  "]);

    fireEvent.click(screen.getByLabelText(ROW_LABEL));

    expect(runner.current).toHaveBeenCalledWith(
      "curl -fsSL https://aider.chat/install.sh | sh",
      TARGET
    );
  });

  it("opens a POSIX block of several steps as one line in one terminal", () => {
    renderRows(["python -m pip install aider-install", "aider-install"]);

    // One terminal for the block, so a sudo password is asked once.
    expect(screen.queryByLabelText(ROW_LABEL)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: BLOCK_LABEL }));

    expect(runner.current).toHaveBeenCalledWith(
      "python -m pip install aider-install && aider-install",
      TARGET
    );
  });

  it("offers a Windows block's steps one by one, in order", () => {
    host.os = "windows";
    renderRows([
      "scoop bucket add charm https://github.com/charmbracelet/scoop-bucket.git",
      "scoop install charm/crush",
    ]);

    expect(screen.queryByRole("button", { name: BLOCK_LABEL })).toBeNull();
    const rows = screen.getAllByLabelText(ROW_LABEL);
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[1]!);

    expect(runner.current).toHaveBeenCalledTimes(1);
    expect(runner.current).toHaveBeenCalledWith("scoop install charm/crush", TARGET);
  });

  it("offers no terminal for a command that would submit itself when typed", () => {
    renderRows(["echo one\necho two"]);

    expect(screen.queryByLabelText(ROW_LABEL)).toBeNull();
    expect(screen.getByLabelText("Copy command to clipboard")).toBeTruthy();
  });
});
