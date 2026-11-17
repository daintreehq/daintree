// @vitest-environment jsdom
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/emoji-picker", () => ({ EmojiPicker: () => null }));
vi.mock("@/components/Settings/SettingsSwitchCard", () => ({ SettingsSwitchCard: () => null }));
vi.mock("@/components/Settings/SettingsChoicebox", () => ({ SettingsChoicebox: () => null }));
vi.mock("@/clients/workspaceResidencyClient", () => ({
  workspaceResidencyClient: {
    get: vi.fn(() => Promise.resolve(false)),
    set: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock("@/store/projectSettingsStore", () => {
  const useProjectSettingsStore = (selector: (s: { allDetectedRunners: never[] }) => unknown) =>
    selector({ allDetectedRunners: [] });
  useProjectSettingsStore.getState = () => ({ allDetectedRunners: [] });
  return { useProjectSettingsStore };
});
vi.mock("@/components/icons", () => ({ FolderGit2: () => null, McpServerIcon: () => null }));
vi.mock("../ProjectGroupSettingsRow", () => ({ ProjectGroupSettingsRow: () => null }));
vi.mock("../ProjectLinksSection", () => ({ ProjectLinksSection: () => null }));

import type { Project } from "@shared/types";
import { GeneralTab } from "../GeneralTab";

function Harness() {
  const [color, setColor] = useState<string | undefined>("#ff0000");
  const [svg, setSvg] = useState<string | undefined>('<svg xmlns="http://www.w3.org/2000/svg"/>');
  return (
    <GeneralTab
      currentProject={
        {
          id: "test-project",
          path: "/tmp/p",
          name: "p",
          emoji: "",
          lastOpened: 0,
        } satisfies Partial<Project> as Project
      }
      name=""
      onNameChange={vi.fn()}
      emoji=""
      onEmojiChange={vi.fn()}
      color={color}
      onColorChange={setColor}
      devServerCommand=""
      onDevServerCommandChange={vi.fn()}
      devServerLoadTimeout={undefined}
      onDevServerLoadTimeoutChange={vi.fn()}
      turbopackEnabled={true}
      onTurbopackEnabledChange={vi.fn()}
      daintreeMcpTier="off"
      onDaintreeMcpTierChange={vi.fn()}
      daintreeMcpSkipConfirmations={false}
      onDaintreeMcpSkipConfirmationsChange={vi.fn()}
      projectIconSvg={svg}
      onProjectIconSvgChange={setSvg}
      enableInRepoSettings={vi.fn()}
      disableInRepoSettings={vi.fn()}
      projectId="test-project"
      isOpen={true}
    />
  );
}

describe("GeneralTab focus handoff", () => {
  it("moves focus to the hex input when Clear unmounts itself", () => {
    render(<Harness />);
    const clear = screen.getByRole("button", { name: "Clear project color" });
    clear.focus();
    fireEvent.click(clear);
    expect(screen.queryByRole("button", { name: "Clear project color" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Hex color value"));
  });

  it("moves focus to the icon uploader when Remove unmounts the preview", () => {
    render(<Harness />);
    const remove = screen.getByRole("button", { name: "Remove" });
    remove.focus();
    fireEvent.click(remove);
    expect(document.activeElement).toBe(screen.getByTestId("project-icon-uploader"));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("uses the settings row-action variants", () => {
    render(<Harness />);
    const clear = screen.getByRole("button", { name: "Clear project color" });
    const remove = screen.getByRole("button", { name: "Remove" });
    expect(clear.className).toContain("ring-border-strong");
    expect(remove.className).toContain("text-status-danger-text");
  });
});
