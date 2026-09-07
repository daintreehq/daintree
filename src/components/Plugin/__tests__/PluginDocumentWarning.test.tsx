// @vitest-environment jsdom
import { act, render, screen, fireEvent } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PluginDocumentWarning } from "../PluginDocumentWarning";
import { pluginDocumentRuntime } from "@/services/plugin/pluginDocumentRuntime";
import { actionService } from "@/services/ActionService";

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

it("aggregates affected plugins into one banner and routes recovery through the confirmed action", async () => {
  const url = "plugin://pi-warning-test/__dtv-1/view.js";
  pluginDocumentRuntime.registerView("project__abc__acme.warning-test", url);
  render(
    <>
      <PluginDocumentWarning />
      <p>Editor content</p>
    </>
  );
  expect(screen.queryByText("Plugins need a window reload")).toBeNull();
  await act(async () => {
    // Vitest cannot import plugin://, exercising a real failed package load.
    await pluginDocumentRuntime
      .load(url, {
        name: "editor",
        version: "1.0.0",
        buildId: "a".repeat(64),
        entryUrl: "./editor.js",
      })
      .catch(() => {});
  });
  expect(screen.getByText("Editor content")).toBeTruthy();
  expect(screen.getByText("Plugins need a window reload")).toBeTruthy();
  // The manifest id, not the hashed instance key, is what the user sees.
  expect(screen.getByText("acme.warning-test")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reload window" }));
  expect(actionService.dispatch).toHaveBeenCalledWith("plugin.reloadWindow", undefined, {
    source: "user",
  });
});
