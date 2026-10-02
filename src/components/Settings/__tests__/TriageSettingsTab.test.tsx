// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { TriageKeysStatus } from "@shared/types/ipc/triage";
import { TriageSettingsTab } from "../TriageSettingsTab";

function status(overrides: Partial<TriageKeysStatus["keys"]> = {}): TriageKeysStatus {
  return {
    storage: "keychain",
    keys: {
      classifier: { source: "none", hint: null },
      describer: { source: "none", hint: null },
      ...overrides,
    },
  };
}

function install(initial: TriageKeysStatus, overrides: Record<string, unknown> = {}) {
  const api = {
    getKeys: vi.fn().mockResolvedValue(initial),
    checkKey: vi.fn().mockResolvedValue({ valid: true }),
    saveKey: vi.fn(),
    clearKey: vi.fn(),
    ...overrides,
  };
  Object.defineProperty(window, "electron", {
    value: { triage: api, system: { openExternal: vi.fn() } },
    configurable: true,
    writable: true,
  });
  return api;
}

afterEach(() => vi.clearAllMocks());

function keyInput(container: HTMLElement, index: number): HTMLInputElement {
  return container.querySelectorAll<HTMLInputElement>('input[type="password"]')[index]!;
}

function button(container: HTMLElement, text: string, index = 0): HTMLButtonElement {
  return [...container.querySelectorAll("button")].filter((b) => b.textContent?.includes(text))[
    index
  ]!;
}

describe("TriageSettingsTab", () => {
  it("checks a key with its provider, then saves it and shows only its last four", async () => {
    const api = install(status());
    api.saveKey.mockResolvedValue(status({ classifier: { source: "saved", hint: "wxyz" } }));
    const { container } = render(<TriageSettingsTab />);
    await waitFor(() => expect(api.getKeys).toHaveBeenCalled());

    fireEvent.change(keyInput(container, 0), { target: { value: "ts-live-abcdwxyz" } });
    fireEvent.click(button(container, "Check and save"));

    await waitFor(() => expect(api.saveKey).toHaveBeenCalledWith("classifier", "ts-live-abcdwxyz"));
    expect(api.checkKey).toHaveBeenCalledWith("classifier", "ts-live-abcdwxyz");
    await waitFor(() => expect(container.textContent).toContain("Saved · …wxyz"));
    expect(container.textContent).not.toContain("ts-live-abcdwxyz");
  });

  it("doesn't save a key the provider rejects", async () => {
    const api = install(status(), {
      checkKey: vi.fn().mockResolvedValue({ valid: false, error: "Cerebras rejected this key." }),
    });
    const { container } = render(<TriageSettingsTab />);
    await waitFor(() => expect(api.getKeys).toHaveBeenCalled());

    fireEvent.change(keyInput(container, 1), { target: { value: "csk-bad" } });
    fireEvent.click(button(container, "Check and save", 1));

    await waitFor(() => expect(container.textContent).toContain("Cerebras rejected this key."));
    expect(api.saveKey).not.toHaveBeenCalled();
  });

  it("names the environment variable a key is coming from", async () => {
    install(status({ describer: { source: "environment", hint: "9999" } }));
    const { container } = render(<TriageSettingsTab />);
    await waitFor(() =>
      expect(container.textContent).toContain("Using CEREBRAS_API_KEY from the environment (…9999)")
    );
  });

  it("warns when there is no keychain to save keys with", async () => {
    install({ ...status(), storage: "unavailable" });
    const { container } = render(<TriageSettingsTab />);
    await waitFor(() => expect(container.textContent).toContain("No system keychain"));
  });
});
