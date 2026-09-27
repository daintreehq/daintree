// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import type { BuilderStep, CommandManifestEntry } from "@shared/types/commands";

const commandsClientMock = vi.hoisted(() => ({
  list: vi.fn(),
  getBuilder: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/clients/commandsClient", () => ({ commandsClient: commandsClientMock }));

import { useCommandStore } from "@/store/commandStore";
import { CommandPickerHost } from "../CommandPickerHost";

const command: CommandManifestEntry = {
  id: "test:build",
  label: "/test:build",
  description: "",
  category: "workflow",
  hasBuilder: true,
  enabled: true,
};

const steps: BuilderStep[] = [
  { id: "one", title: "One", fields: [{ name: "x", label: "X", type: "text" }] },
];

beforeEach(() => {
  vi.clearAllMocks();
  useCommandStore.setState({
    isPickerOpen: false,
    activeCommand: command,
    activeCommandId: command.id,
    builderContext: {},
    builderSteps: null,
    isLoadingBuilder: false,
    builderLoadError: "The builder request timed out.",
    isExecuting: false,
    executionError: null,
  });
});

describe("CommandPickerHost load failure", () => {
  it("keeps the failure and its busy Retry on screen until the reload settles", async () => {
    let resolve: (value: { steps: BuilderStep[] }) => void = () => {};
    commandsClientMock.getBuilder.mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<CommandPickerHost context={{}} />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    // The store has already cleared its error and the loading dialog is still
    // gated; the dialog holding Retry must not drop out in between.
    expect(screen.getByRole("alert").textContent).toContain("The builder request timed out.");
    expect(screen.getByRole("button", { name: "Retry" }).getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      resolve({ steps });
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("X")).toBeTruthy();
  });
});
