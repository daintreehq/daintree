// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { CommandManifestEntry, CommandOverride } from "@shared/types/commands";

const COMMANDS: CommandManifestEntry[] = [
  {
    id: "git.summary",
    label: "Summarize changes",
    description: "Summarize the working tree",
    category: "git",
    args: [],
    hasBuilder: false,
    enabled: true,
  },
  {
    id: "github:create-issue",
    label: "/github:create-issue",
    description: "Create a GitHub issue",
    category: "github",
    args: [
      { name: "title", type: "string", description: "Issue title", required: false },
      { name: "labels", type: "string", description: "Labels", required: false },
    ],
    hasBuilder: false,
    enabled: true,
  },
];

const { list } = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/clients/commandsClient", () => ({
  commandsClient: { list },
}));

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { CommandOverridesTab } from "../CommandOverridesTab";

function renderTab(overrides: CommandOverride[] = []) {
  const onChange = vi.fn<(next: CommandOverride[]) => void>();
  render(<CommandOverridesTab projectId="p" overrides={overrides} onChange={onChange} />, {
    wrapper: TooltipProvider,
  });
  return { onChange, lastSaved: () => onChange.mock.calls.at(-1)?.[0] };
}

const expand = async (id: string) =>
  fireEvent.click(await screen.findByRole("button", { name: id }));

beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue(COMMANDS);
});

describe("CommandOverridesTab", () => {
  it("keeps the prompt editor for an argument-free command a stale save left defaults on", async () => {
    // An older save can leave `defaults` on a command that takes no arguments. Defaults
    // mode has no editor for such a command, so it must stay a prompt override.
    renderTab([{ commandId: "git.summary", defaults: { x: "1" } }]);

    await expand("git.summary");

    expect(document.querySelector("textarea")).not.toBeNull();
  });

  it("shows argument defaults and the custom prompt together, since defaults fill the prompt", async () => {
    renderTab([{ commandId: "github:create-issue", prompt: "About {title}" }]);

    await expand("github:create-issue");

    expect(screen.getByRole("textbox", { name: "title" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Custom prompt" })).toBeTruthy();
  });

  it("drops an argument default when its field is emptied instead of storing an empty value", async () => {
    const { lastSaved } = renderTab([
      { commandId: "github:create-issue", defaults: { labels: "ui" } },
    ]);
    await expand("github:create-issue");

    fireEvent.change(screen.getByRole("textbox", { name: "labels" }), { target: { value: "" } });

    expect(lastSaved()).toEqual([]);
  });

  it("does not save a prompt that names an unknown variable, and says the saved one stays in use", async () => {
    const { onChange } = renderTab([{ commandId: "github:create-issue", prompt: "About {title}" }]);
    await expand("github:create-issue");
    const prompt = screen.getByRole("textbox", { name: "Custom prompt" });

    fireEvent.change(prompt, { target: { value: "About {nope}" } });

    expect(onChange).not.toHaveBeenCalled();
    expect(prompt.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/saved prompt stays in use/)).toBeTruthy();

    fireEvent.change(prompt, { target: { value: "About {labels}" } });
    expect(onChange).toHaveBeenLastCalledWith([
      { commandId: "github:create-issue", prompt: "About {labels}" },
    ]);
  });

  it("turns a command off with its switch and back on without leaving an empty override", async () => {
    const off = renderTab();
    fireEvent.click(await screen.findByRole("switch", { name: "git.summary" }));
    expect(off.lastSaved()).toEqual([{ commandId: "git.summary", disabled: true }]);
  });

  it("removes the override entirely when a command that was only switched off is switched on", async () => {
    const on = renderTab([{ commandId: "git.summary", disabled: true }]);
    fireEvent.click(await screen.findByRole("switch", { name: "git.summary" }));
    expect(on.lastSaved()).toEqual([]);
  });

  it("counts a switched-off command as modified, so the filter and the row's mark agree", async () => {
    renderTab([{ commandId: "git.summary", disabled: true }]);
    await screen.findByRole("switch", { name: "git.summary" });

    fireEvent.click(screen.getByRole("radio", { name: "Modified" }));

    expect(screen.getAllByTestId("command-row")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Reset git.summary to default" })).toBeTruthy();
  });

  it("reports a failed load with a retry instead of claiming there are no commands", async () => {
    list.mockRejectedValueOnce(new Error("ipc down"));
    renderTab();

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByText(/No commands are available/)).toBeNull();

    await act(async () => retry.click());

    expect(await screen.findByRole("switch", { name: "git.summary" })).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("wires each disclosure to the panel it opens", async () => {
    renderTab();
    const toggle = await screen.findByRole("button", { name: "github:create-issue" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(panel?.contains(screen.getByRole("textbox", { name: "Custom prompt" }))).toBe(true);
  });

  it("says the command still runs normally when an invalid prompt has nothing saved behind it", async () => {
    const { onChange } = renderTab();
    await expand("github:create-issue");

    fireEvent.change(screen.getByRole("textbox", { name: "Custom prompt" }), {
      target: { value: "About {nope}" },
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/command still runs normally/)).toBeTruthy();
  });

  it("resets the whole command, including a prompt draft that was never saved, and keeps focus on it", async () => {
    const { onChange } = renderTab([
      { commandId: "github:create-issue", defaults: { labels: "ui" } },
    ]);
    await expand("github:create-issue");
    const prompt = () =>
      screen.getByRole("textbox", { name: "Custom prompt" }) as HTMLTextAreaElement;
    fireEvent.change(prompt(), { target: { value: "About {nope}" } });

    fireEvent.click(screen.getByRole("button", { name: "Reset github:create-issue to default" }));

    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(prompt().value).toBe("");
    expect(prompt().getAttribute("aria-invalid")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "github:create-issue" })
    );
  });
});
