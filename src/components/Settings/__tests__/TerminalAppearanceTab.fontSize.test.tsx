// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

import { actionService } from "@/services/ActionService";
import { TerminalAppearanceTab } from "../TerminalAppearanceTab";
import { SettingsValidationProvider } from "../SettingsValidationRegistry";

afterEach(cleanup);

describe("Terminal font size field", () => {
  it("keeps a rejected size in the field beside its error, and applies nothing", async () => {
    const { container } = render(
      <SettingsValidationProvider>
        <TerminalAppearanceTab activeSubtab="terminal" onSubtabChange={() => {}} />
      </SettingsValidationProvider>
    );
    const input = container.querySelector<HTMLInputElement>('[aria-label="Terminal font size"]')!;

    await act(async () => {
      fireEvent.change(input, { target: { value: "40" } });
      fireEvent.blur(input);
    });

    expect(input.value).toBe("40");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toMatch(/between 8 and 24/);
    expect(vi.mocked(actionService.dispatch)).not.toHaveBeenCalledWith(
      "terminalConfig.setFontSize",
      expect.anything(),
      expect.anything()
    );
  });
});
