// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RunCommand } from "@shared/types";

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    variant,
    size,
    className,
  }: React.ComponentProps<"button"> & {
    variant?: string;
    size?: string;
  }) => (
    <button onClick={onClick} data-variant={variant} data-size={size} className={className}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/emoji-picker", () => ({
  EmojiPicker: () => null,
}));

vi.mock("@/components/Settings/SettingsSwitchCard", () => ({
  SettingsSwitchCard: () => null,
}));

vi.mock("@/components/Settings/SettingsChoicebox", () => ({
  SettingsChoicebox: () => null,
}));

const storeAllDetectedRunners: RunCommand[] = [];

vi.mock("@/store/projectSettingsStore", () => {
  const useProjectSettingsStore = (
    selector: (state: { allDetectedRunners: RunCommand[] }) => unknown
  ) => selector({ allDetectedRunners: storeAllDetectedRunners });
  useProjectSettingsStore.getState = () => ({ allDetectedRunners: storeAllDetectedRunners });
  return { useProjectSettingsStore };
});

vi.mock("@/components/icons", () => ({
  FolderGit2: () => null,
  McpServerIcon: () => null,
}));

import { GeneralTab } from "../GeneralTab";

function devRunner(): RunCommand {
  return {
    id: "npm-dev",
    name: "dev",
    command: "npm run dev",
    icon: "npm",
    description: "vite",
  };
}

function devcontainerRunner(): RunCommand {
  return {
    id: "devcontainer-poststart",
    name: "postStartCommand",
    command: "npm run dev",
    icon: "terminal",
    description: "from .devcontainer/devcontainer.json",
  };
}

function renderGeneralTab(overrides: { devServerCommand?: string } = {}) {
  return render(
    <GeneralTab
      currentProject={undefined}
      name=""
      onNameChange={vi.fn()}
      emoji=""
      onEmojiChange={vi.fn()}
      color={undefined}
      onColorChange={vi.fn()}
      devServerCommand={overrides.devServerCommand ?? ""}
      onDevServerCommandChange={vi.fn()}
      devServerLoadTimeout={undefined}
      onDevServerLoadTimeoutChange={vi.fn()}
      turbopackEnabled={true}
      onTurbopackEnabledChange={vi.fn()}
      daintreeMcpTier="off"
      onDaintreeMcpTierChange={vi.fn()}
      projectIconSvg={undefined}
      onProjectIconSvgChange={vi.fn()}
      enableInRepoSettings={vi.fn()}
      disableInRepoSettings={vi.fn()}
      projectId="test-project"
      isOpen={true}
    />
  );
}

describe("GeneralTab dev server suggestion", () => {
  it("shows detected suggestion when field is empty and candidate exists", () => {
    storeAllDetectedRunners.length = 0;
    storeAllDetectedRunners.push(devRunner());

    renderGeneralTab({ devServerCommand: "" });

    expect(screen.getByText(/Detected:/)).toBeDefined();
    expect(screen.getByText("npm run dev")).toBeDefined();
    expect(screen.getByText("Use command")).toBeDefined();
  });

  it("does not show suggestion when field is non-empty", () => {
    storeAllDetectedRunners.length = 0;
    storeAllDetectedRunners.push(devRunner());

    renderGeneralTab({ devServerCommand: "npm run start" });

    expect(screen.queryByText(/Detected:/)).toBeNull();
    expect(screen.queryByText("Use command")).toBeNull();
  });

  it("does not show suggestion when no runner is detected", () => {
    storeAllDetectedRunners.length = 0;

    renderGeneralTab({ devServerCommand: "" });

    expect(screen.queryByText(/Detected:/)).toBeNull();
    expect(screen.queryByText("Use command")).toBeNull();
  });

  it("shows suggestion for devcontainer fallback", () => {
    storeAllDetectedRunners.length = 0;
    storeAllDetectedRunners.push(devcontainerRunner());

    renderGeneralTab({ devServerCommand: "" });

    expect(screen.getByText(/Detected:/)).toBeDefined();
    expect(screen.getByText("npm run dev")).toBeDefined();
  });

  it("calls onDevServerCommandChange with candidate command on apply", () => {
    storeAllDetectedRunners.length = 0;
    storeAllDetectedRunners.push(devRunner());

    const onDevServerCommandChange = vi.fn();
    render(
      <GeneralTab
        currentProject={undefined}
        name=""
        onNameChange={vi.fn()}
        emoji=""
        onEmojiChange={vi.fn()}
        color={undefined}
        onColorChange={vi.fn()}
        devServerCommand=""
        onDevServerCommandChange={onDevServerCommandChange}
        devServerLoadTimeout={undefined}
        onDevServerLoadTimeoutChange={vi.fn()}
        turbopackEnabled={true}
        onTurbopackEnabledChange={vi.fn()}
        daintreeMcpTier="off"
        onDaintreeMcpTierChange={vi.fn()}
        projectIconSvg={undefined}
        onProjectIconSvgChange={vi.fn()}
        enableInRepoSettings={vi.fn()}
        disableInRepoSettings={vi.fn()}
        projectId="test-project"
        isOpen={true}
      />
    );

    fireEvent.click(screen.getByText("Use command"));
    expect(onDevServerCommandChange).toHaveBeenCalledWith("npm run dev");
  });

  it("hides suggestion after input is populated (field becomes non-empty)", () => {
    storeAllDetectedRunners.length = 0;
    storeAllDetectedRunners.push(devRunner());

    const { rerender } = renderGeneralTab({ devServerCommand: "" });
    expect(screen.getByText(/Detected:/)).toBeDefined();

    rerender(
      <GeneralTab
        currentProject={undefined}
        name=""
        onNameChange={vi.fn()}
        emoji=""
        onEmojiChange={vi.fn()}
        color={undefined}
        onColorChange={vi.fn()}
        devServerCommand="npm run dev"
        onDevServerCommandChange={vi.fn()}
        devServerLoadTimeout={undefined}
        onDevServerLoadTimeoutChange={vi.fn()}
        turbopackEnabled={true}
        onTurbopackEnabledChange={vi.fn()}
        daintreeMcpTier="off"
        onDaintreeMcpTierChange={vi.fn()}
        projectIconSvg={undefined}
        onProjectIconSvgChange={vi.fn()}
        enableInRepoSettings={vi.fn()}
        disableInRepoSettings={vi.fn()}
        projectId="test-project"
        isOpen={true}
      />
    );

    expect(screen.queryByText(/Detected:/)).toBeNull();
  });
});
