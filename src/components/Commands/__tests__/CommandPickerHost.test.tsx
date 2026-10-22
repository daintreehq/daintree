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
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
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

describe("CommandPickerHost prompt templates", () => {
  const template = (args: { name: string; label: string; required?: boolean }[]) => ({
    key: "acme::reply",
    pluginId: "acme",
    pluginName: "Acme CRM",
    projectId: null,
    template: {
      id: "reply",
      title: "Draft a reply",
      description: "Reply to the selected record.",
      body: "Reply to {{name}} about {{topic}}.",
      args,
    },
  });

  function openWith(entry: ReturnType<typeof template>) {
    usePluginRuntimeStore.setState({ promptTemplates: [entry] });
    commandsClientMock.list.mockResolvedValue([]);
    const onDraftReady = vi.fn();
    const onCommandExecuted = vi.fn();
    render(
      <CommandPickerHost
        context={{}}
        onDraftReady={onDraftReady}
        onCommandExecuted={onCommandExecuted}
      />
    );
    act(() => useCommandStore.getState().openPicker());
    return { onDraftReady, onCommandExecuted };
  }

  beforeEach(() => {
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { plugin: {} },
    });
    useCommandStore.setState({
      activeCommand: null,
      activeCommandId: null,
      builderLoadError: null,
    });
  });

  it("fills the draft at once from a template with no arguments, attributed to its plugin", async () => {
    const { onDraftReady, onCommandExecuted } = openWith({
      ...template([]),
      template: { ...template([]).template, body: "Say hello." },
    });
    const row = await screen.findByRole("option", { name: /Draft a reply/ });
    expect(row.textContent).toContain("Acme CRM");

    fireEvent.click(row);

    expect(onDraftReady).toHaveBeenCalledWith("Say hello.");
    expect(onCommandExecuted).not.toHaveBeenCalled();
    expect(commandsClientMock.execute).not.toHaveBeenCalled();
  });

  it("asks for the arguments, then fills the draft with them", async () => {
    const { onDraftReady, onCommandExecuted } = openWith(
      template([
        { name: "name", label: "Recipient", required: true },
        { name: "topic", label: "Topic" },
      ])
    );
    fireEvent.click(await screen.findByRole("option", { name: /Draft a reply/ }));

    const recipient = await screen.findByLabelText("Recipient");
    fireEvent.click(screen.getByRole("button", { name: "Fill draft" }));
    expect(onDraftReady).not.toHaveBeenCalled();
    expect(screen.getByText("Required")).toBeTruthy();

    fireEvent.change(recipient, { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "{{name}}" } });
    fireEvent.click(screen.getByRole("button", { name: "Fill draft" }));

    expect(onDraftReady).toHaveBeenCalledWith("Reply to Ada about {{name}}.");
    expect(onCommandExecuted).not.toHaveBeenCalled();
  });
});
