// @vitest-environment jsdom
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HelpSessionActiveGrant } from "@shared/types";
import {
  MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS,
  NATIVE_GRANT_TOOL_IDS,
} from "@shared/config/mcpGrants";

const { issueNativeGrant, titles } = vi.hoisted(() => ({
  issueNativeGrant: vi.fn(),
  titles: {
    "recipe.run": "Run recipe",
    "worktree.deleteOwned": "Delete owned worktree",
  } as Record<string, string>,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { getTitle: (id: string) => titles[id] ?? "" },
}));

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { NativeGrantsSection } from "../NativeGrantsSection";

beforeEach(() => {
  issueNativeGrant.mockReset();
  Object.defineProperty(window, "electron", {
    value: { mcpServer: { issueNativeGrant, revokeNativeGrant: vi.fn() } },
    writable: true,
    configurable: true,
  });
});

function asButton(el: HTMLElement): HTMLButtonElement {
  if (!(el instanceof HTMLButtonElement)) throw new Error(`expected a button, got <${el.tagName}>`);
  return el;
}

function asInput(el: HTMLElement): HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) throw new Error(`expected an input, got <${el.tagName}>`);
  return el;
}

function describedText(el: HTMLElement): string {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderSection(grants: HelpSessionActiveGrant[] = []) {
  const view = render(<NativeGrantsSection helpSessionId="help-1" grants={grants} />);
  const approveButton = () => asButton(view.getByRole("button", { name: "Approve grant" }));
  const toolList = () => view.getByRole("group", { name: "Tools to approve" });
  const boxes = () => within(toolList()).getAllByRole("checkbox").map(asButton);
  const toolIdOf = (box: HTMLElement) =>
    box.parentElement?.querySelector("label > span:last-child")?.textContent ?? "";
  const usesInput = () => asInput(view.getByLabelText("Maximum uses"));
  return {
    ...view,
    approveButton,
    summary: () => describedText(approveButton()),
    toolList,
    boxes,
    toolIdOf,
    usesInput,
  };
}

describe("NativeGrantsSection (#14982)", () => {
  it("offers exactly the tools main accepts, labelled by name", () => {
    const { getByLabelText, boxes, toolIdOf } = renderSection();

    expect(boxes().map(toolIdOf).sort()).toEqual([...NATIVE_GRANT_TOOL_IDS].sort());
    expect(getByLabelText(/Run recipe/)).toBeTruthy();
  });

  it("says what approving does before anything is sent", () => {
    const { getByLabelText, approveButton, summary, usesInput } = renderSection();
    expect(approveButton().disabled).toBe(true);

    fireEvent.click(getByLabelText(/Delete owned worktree/));
    fireEvent.click(getByLabelText(/Run recipe/));
    fireEvent.change(usesInput(), { target: { value: "3" } });

    expect(summary()).toContain(
      "run Delete owned worktree and Run recipe without Daintree's usual confirmation"
    );
    expect(summary()).toContain("A few checks still ask");
    expect(summary()).toContain(
      "Allows 3 uses in total across these tools, and a call that fails still spends one"
    );
    expect(summary()).toMatch(
      /Lasts \d+ minutes, which a successful call can renew, and ends \d+ minutes after approval at the latest/
    );
    fireEvent.change(usesInput(), { target: { value: "8" } });
    expect(summary()).toContain("Allows 8 uses in total");
    expect(approveButton().disabled).toBe(false);
    expect(issueNativeGrant).not.toHaveBeenCalled();
  });

  it("flags a use count main would reject on the field instead of sending a fallback", () => {
    const { getByLabelText, approveButton, summary, usesInput } = renderSection();
    fireEvent.click(getByLabelText(/Run recipe/));

    for (const value of ["", "0", "2.5", "101"]) {
      fireEvent.change(usesInput(), { target: { value } });
      expect(approveButton().disabled).toBe(true);
      expect(usesInput().getAttribute("aria-invalid")).toBe("true");
      expect(describedText(usesInput())).toContain("Enter a whole number");
      expect(summary()).not.toContain("Allows");
    }
    fireEvent.click(approveButton());
    expect(issueNativeGrant).not.toHaveBeenCalled();

    fireEvent.change(usesInput(), { target: { value: "4" } });
    expect(usesInput().getAttribute("aria-invalid")).toBeNull();
    expect(approveButton().disabled).toBe(false);
  });

  it("keeps a choice the search hides and sends exactly what was chosen", async () => {
    issueNativeGrant.mockResolvedValue({ grantId: "g1" });
    const { getByLabelText, approveButton, toolList, usesInput } = renderSection();

    fireEvent.click(getByLabelText(/Run recipe/));
    fireEvent.change(getByLabelText("Search tools"), { target: { value: "owned worktree" } });
    expect(within(toolList()).queryByText("Run recipe")).toBeNull();
    fireEvent.click(getByLabelText(/Delete owned worktree/));
    fireEvent.change(usesInput(), { target: { value: "7" } });
    fireEvent.click(approveButton());

    expect(issueNativeGrant).toHaveBeenCalledWith({
      helpSessionId: "help-1",
      allowedTools: ["recipe.run", "worktree.deleteOwned"],
      maxUses: 7,
    });
    await waitFor(() =>
      expect(getByLabelText(/Delete owned worktree/).dataset.state).toBe("unchecked")
    );
  });

  it("locks the form while an approval is in flight and sends it once", async () => {
    const pending = deferred<{ grantId: string }>();
    issueNativeGrant.mockReturnValue(pending.promise);
    const { getByLabelText, approveButton, boxes, usesInput } = renderSection();

    fireEvent.click(getByLabelText(/Run recipe/));
    fireEvent.click(approveButton());
    fireEvent.click(approveButton());

    expect(issueNativeGrant).toHaveBeenCalledTimes(1);
    expect(approveButton().disabled).toBe(true);
    expect(usesInput().disabled).toBe(true);
    expect(asInput(getByLabelText("Search tools")).disabled).toBe(true);
    expect(boxes().every((box) => box.disabled)).toBe(true);

    pending.resolve({ grantId: "g1" });
    await waitFor(() => expect(usesInput().disabled).toBe(false));
    expect(boxes().every((box) => !box.disabled)).toBe(true);
    expect(getByLabelText(/Run recipe/).dataset.state).toBe("unchecked");
    expect(approveButton().disabled).toBe(true);
  });

  it("keeps the choice, unlocks, and shows main's refusal when approval fails", async () => {
    issueNativeGrant.mockRejectedValue(new Error("No live pinned session for this help session"));
    const { getByLabelText, approveButton, findByRole } = renderSection();

    fireEvent.click(getByLabelText(/Run recipe/));
    fireEvent.click(approveButton());

    expect((await findByRole("alert")).textContent).toContain("No live pinned session");
    expect(getByLabelText(/Run recipe/).dataset.state).toBe("checked");
    expect(approveButton().disabled).toBe(false);
  });

  it("locks only unchosen tools at the limit and lets one be swapped for another", () => {
    issueNativeGrant.mockReturnValue(new Promise(() => {}));
    const { approveButton, boxes, toolIdOf, toolList } = renderSection();
    const listHint = () => describedText(toolList());
    expect(listHint()).toBe(`0 of ${MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS} chosen`);
    for (const box of boxes().slice(0, MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS)) {
      fireEvent.click(box);
    }

    const [dropped, ...kept] = boxes().slice(0, MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS);
    const [replacement, ...rest] = boxes().slice(MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS);
    expect(replacement).toBeDefined();
    expect([dropped!, ...kept].every((box) => !box.disabled)).toBe(true);
    expect([replacement!, ...rest].every((box) => box.disabled)).toBe(true);
    expect(listHint()).toContain("Uncheck one to choose another");

    fireEvent.click(dropped!);
    expect(dropped!.dataset.state).toBe("unchecked");
    expect(kept.every((box) => box.dataset.state === "checked")).toBe(true);
    expect(listHint()).toBe(
      `${MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS - 1} of ${MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS} chosen`
    );
    expect(replacement!.disabled).toBe(false);

    fireEvent.click(replacement!);
    fireEvent.click(approveButton());
    expect(issueNativeGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: [...kept.map(toolIdOf), toolIdOf(replacement!)],
      })
    );
  });

  it("names an active grant's tools instead of listing their ids", () => {
    const { getByText } = renderSection([
      {
        sessionId: "transport-1",
        toolId: "*",
        expiresAt: Date.now() + 600_000,
        ttlMs: 900_000,
        kind: "native",
        grantId: "g1",
        allowedTools: ["worktree.deleteOwned", "recipe.run"],
        maxUses: 5,
        remainingUses: 4,
      },
    ]);
    expect(getByText("Delete owned worktree, Run recipe")).toBeTruthy();
  });
});
