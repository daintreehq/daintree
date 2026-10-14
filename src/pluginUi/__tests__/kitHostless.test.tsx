// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// No host installed and nothing mocked: what a plugin preview page renders.
import * as kit from "@daintreehq/plugin-ui";
import { TooltipProvider } from "@/components/ui/tooltip";

beforeAll(async () => {
  await kit.whenPluginUiReady();
}, 60_000);

afterEach(cleanup);

describe("the kit without a host", () => {
  it("draws a DiffView's patch as plain text", async () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(kit.DiffView, {
          oldText: "a: 1\n",
          newText: "a: 2\n",
          path: "config.yaml",
          "data-testid": "diff",
        })
      )
    );
    const pre = await waitFor(() => {
      const found = screen.getByTestId("diff").querySelector("pre");
      if (!found) throw new Error("diff not loaded");
      return found;
    });
    expect(pre.textContent).toContain("-a: 1");
    expect(pre.textContent).toContain("+a: 2");
    expect(screen.getByTestId("diff").getAttribute("aria-label")).toBe("Changes to config.yaml");
  });

  it("swallows a link press rather than navigating or throwing", () => {
    render(createElement(kit.Link, { href: "https://example.com" }, "Docs"));
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen.getByRole("link", { name: "Docs" }).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
