// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const reporter = vi.hoisted(() => vi.fn());
const icons = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/app/usePluginUnsavedPanelsReporter", () => ({
  usePluginUnsavedPanelsReporter: reporter,
}));
vi.mock("@/hooks/usePluginIcons", () => ({ usePluginIcons: icons }));

import { CanopyPluginSupport } from "../CanopyPluginSupport";

const reportUnsavedPanels = vi.fn(async (_panels: unknown[]) => {});

beforeEach(() => {
  reportUnsavedPanels.mockClear();
  Object.defineProperty(window, "electron", {
    value: { plugin: { reportUnsavedPanels } },
    configurable: true,
    writable: true,
  });
});

afterEach(cleanup);

describe("CanopyPluginSupport", () => {
  it("reports and draws icons while mounted, and leaves nothing unsaved behind when it goes", () => {
    const view = render(<CanopyPluginSupport />);
    expect(reporter).toHaveBeenCalled();
    expect(icons).toHaveBeenCalled();
    expect(reportUnsavedPanels).not.toHaveBeenCalled();

    view.unmount();
    expect(reportUnsavedPanels).toHaveBeenCalledTimes(1);
    expect(reportUnsavedPanels).toHaveBeenCalledWith([]);
  });
});
