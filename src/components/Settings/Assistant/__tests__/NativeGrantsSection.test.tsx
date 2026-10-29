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

function renderSection(grants: HelpSessionActiveGrant[] = []) {
  const view = render(<NativeGrantsSection helpSessionId="help-1" grants={grants} />);
  const approveButton = () =>
    view.getByRole("button", { name: "Approve grant" }) as HTMLButtonElement;
  const summary = () =>
    document.getElementById(approveButton().getAttribute("aria-describedby") ?? "")
      ?.textContent ?? "";
  const toolList = () => view.getByRole("group", { name: "Tools to approve" });
  return { ...view, approveButton, summary, toolList };
}

describe("NativeGrantsSection (#14982)", () => {
  it("offers every grantable tool by name and nothing main would refuse", () => {
    const { getByLabelText, queryByText, toolList } = renderSection();

    expect(within(toolList()).getAllByRole("checkbox")).toHaveLength(
      NATIVE_GRANT_TOOL_IDS.length
    );
    expect(getByLabelText(/Run recipe/)).toBeTruthy();
    expect(queryByText("terminal.closeAll")).toBeNull();
  });

  it("says what approving does before anything is sent", () => {
    const { getByLabelText, approveButton, summary } = renderSection();
    expect(approveButton().disabled).toBe(true);

    fireEvent.click(getByLabelText(/Delete owned worktree/));
    fireEvent.click(getByLabelText(/Run recipe/));
    fireEvent.change(getByLabelText("Maximum uses"), { target: { value: "3" } });

    expect(summary()).toContain("Delete owned worktree and Run recipe without asking you");
    expect(summary()).toContain("skips its usual confirmation");
    expect(summary()).toContain("Up to 3 calls");
    expect(summary()).toMatch(/Lasts \d+ minutes, restarting with each successful call/);
    expect(approveButton().disabled).toBe(false);
    expect(issueNativeGrant).not.toHaveBeenCalled();
  });

  it("refuses a use count main would reject instead of sending a fallback", () => {
    const { getByLabelText, approveButton, summary } = renderSection();
    fireEvent.click(getByLabelText(/Run recipe/));

    for (const value of ["", "0", "2.5", "101"]) {
      fireEvent.change(getByLabelText("Maximum uses"), { target: { value } });
      expect(approveButton().disabled).toBe(true);
      expect(summary()).toContain("Set maximum uses to a whole number");
    }
    fireEvent.click(approveButton());
    expect(issueNativeGrant).not.toHaveBeenCalled();
  });

  it("keeps a choice the search hides and sends exactly what was chosen", async () => {
    issueNativeGrant.mockResolvedValue({ grantId: "g1" });
    const { getByLabelText, approveButton, toolList } = renderSection();

    fireEvent.click(getByLabelText(/Run recipe/));
    fireEvent.change(getByLabelText("Search tools"), { target: { value: "owned worktree" } });
    expect(within(toolList()).queryByText("Run recipe")).toBeNull();
    fireEvent.click(getByLabelText(/Delete owned worktree/));
    fireEvent.change(getByLabelText("Maximum uses"), { target: { value: "7" } });
    fireEvent.click(approveButton());

    expect(issueNativeGrant).toHaveBeenCalledWith({
      helpSessionId: "help-1",
      allowedTools: ["recipe.run", "worktree.deleteOwned"],
      maxUses: 7,
    });
    await waitFor(() =>
      expect((getByLabelText(/Delete owned worktree/) as HTMLElement).dataset.state).toBe(
        "unchecked"
      )
    );
  });

  it("keeps the choice and shows main's refusal when approval fails", async () => {
    issueNativeGrant.mockRejectedValue(new Error("No live pinned session for this help session"));
    const { getByLabelText, approveButton, findByRole } = renderSection();

    fireEvent.click(getByLabelText(/Run recipe/));
    fireEvent.click(approveButton());

    expect((await findByRole("alert")).textContent).toContain("No live pinned session");
    expect((getByLabelText(/Run recipe/) as HTMLElement).dataset.state).toBe("checked");
  });

  it("locks only unchosen tools once the grant's tool limit is reached", () => {
    const { toolList } = renderSection();
    const boxes = () => within(toolList()).getAllByRole("checkbox") as HTMLButtonElement[];
    for (const box of boxes().slice(0, MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS)) {
      fireEvent.click(box);
    }

    const chosen = boxes().slice(0, MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS);
    const rest = boxes().slice(MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS);
    expect(chosen.every((box) => !box.disabled)).toBe(true);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((box) => box.disabled)).toBe(true);

    fireEvent.click(chosen[0]!);
    expect(boxes().every((box) => !box.disabled)).toBe(true);
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
