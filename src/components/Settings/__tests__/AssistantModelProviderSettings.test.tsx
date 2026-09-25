// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantProviderKeyStatus, HelpAssistantSettings } from "@shared/types";
import { AssistantModelProviderSettings } from "../AssistantModelProviderSettings";

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

const NONE = { saved: false, hint: null, storage: null, revision: 0 } as const;

function keys(
  providers: Partial<AssistantProviderKeyStatus["providers"]> = {},
  keychain = true
): AssistantProviderKeyStatus {
  return { keychain, providers: { baseten: NONE, openrouter: NONE, openai: NONE, ...providers } };
}

function settings(overrides: Partial<HelpAssistantSettings> = {}): HelpAssistantSettings {
  return {
    docSearch: true,
    daintreeControl: true,
    tier: "action",
    bypassPermissions: false,
    auditRetention: 7,
    modelId: "",
    customArgs: "",
    idleHibernateMinutes: 5,
    loadGlobalHooksAndServers: false,
    modelProvider: "openai",
    providerModels: {},
    openRouterRouting: { sort: "latency", allowTraining: false, zeroRetention: false },
    ...overrides,
  };
}

let api: {
  getProviderKeyStatus: ReturnType<typeof vi.fn>;
  setProviderKey: ReturnType<typeof vi.fn>;
  clearProviderKey: ReturnType<typeof vi.fn>;
  testProviderKey: ReturnType<typeof vi.fn>;
};
const openExternal = vi.fn();

beforeEach(() => {
  api = {
    getProviderKeyStatus: vi.fn().mockResolvedValue(keys()),
    setProviderKey: vi.fn(async (provider: string, key: string) =>
      keys({ [provider]: { saved: true, hint: key.slice(-4), storage: "keychain", revision: 1 } })
    ),
    clearProviderKey: vi.fn().mockResolvedValue(keys()),
    testProviderKey: vi
      .fn()
      .mockResolvedValue({ accepted: true, message: "OpenAI accepted this key." }),
  };
  window.electron = {
    helpAssistant: api,
    system: { openExternal },
  } as unknown as typeof window.electron;
});

afterEach(() => {
  vi.useRealTimers();
});

function renderSection(initial: HelpAssistantSettings = settings()) {
  const persist = vi.fn(async (patch: Partial<HelpAssistantSettings>) => ({
    ...initial,
    ...patch,
  }));
  const view = render(
    <AssistantModelProviderSettings settings={initial} persist={persist} disabled={false} />
  );
  return { ...view, persist };
}

async function keyInput(scope: HTMLElement = document.body) {
  const input = (await within(scope).findByTestId(
    "assistant-provider-key-input"
  )) as HTMLInputElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  return input;
}

/** The dialog's confirm button, as opposed to the row's "Remove key" that opens it. */
async function confirmRemoval() {
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));
}

describe("AssistantModelProviderSettings", () => {
  it("recommends GPT-6 Luna and says a key is needed before the assistant can answer", async () => {
    renderSection();
    await screen.findByTestId("assistant-provider-key-missing");
    expect(document.body.textContent).toContain("Recommended. GPT-6 Luna");
    expect(document.body.textContent).toContain("OpenAI API key");
    expect(screen.getByPlaceholderText("gpt-6-luna")).toBeTruthy();
  });

  it("switching provider persists it", async () => {
    const { persist } = renderSection();
    await screen.findByTestId("assistant-provider-key-missing");
    fireEvent.click(screen.getByRole("radio", { name: "Baseten" }));
    expect(persist).toHaveBeenCalledWith({ modelProvider: "baseten" });
  });

  it("checks a key with the provider before saving it", async () => {
    renderSection();
    const input = await keyInput();
    fireEvent.change(input, { target: { value: "  sk-new-key-7777 " } });
    fireEvent.click(screen.getByRole("button", { name: "Check and save" }));

    await waitFor(() =>
      expect(api.setProviderKey).toHaveBeenCalledWith("openai", "sk-new-key-7777", 0)
    );
    expect(api.testProviderKey).toHaveBeenCalledWith("openai", "sk-new-key-7777");
    expect(api.testProviderKey.mock.invocationCallOrder[0]).toBeLessThan(
      api.setProviderKey.mock.invocationCallOrder[0]!
    );
    expect((await screen.findByTestId("assistant-provider-key-saved")).textContent).toContain(
      "7777"
    );
    expect(input.value).toBe("");
  });

  it("does not save a key the provider rejects, and keeps it in the field", async () => {
    api.testProviderKey.mockResolvedValue({
      accepted: false,
      message: "OpenAI rejected this key.",
    });
    renderSection();
    const input = await keyInput();
    fireEvent.change(input, { target: { value: "sk-typo" } });
    fireEvent.click(screen.getByRole("button", { name: "Check and save" }));

    await waitFor(() =>
      expect(screen.getByTestId("assistant-provider-key-status").textContent).toContain(
        "OpenAI rejected this key."
      )
    );
    expect(api.setProviderKey).not.toHaveBeenCalled();
    expect(input.value).toBe("sk-typo");
  });

  it("a check overtaken by a Remove never saves its key", async () => {
    let resolveCheck: (v: { accepted: boolean; message: string }) => void = () => {};
    api.testProviderKey.mockReturnValue(new Promise((r) => (resolveCheck = r)));
    api.getProviderKeyStatus.mockResolvedValue(
      keys({ openai: { saved: true, hint: "abcd", storage: "keychain", revision: 3 } })
    );
    const first = renderSection();
    const input = await keyInput(first.container);
    fireEvent.change(input, { target: { value: "sk-slow" } });
    fireEvent.click(within(first.container).getByRole("button", { name: "Check and save" }));

    // A second view of the same provider removes the key while the check is in flight.
    const second = renderSection();
    await keyInput(second.container);
    fireEvent.click(within(second.container).getByRole("button", { name: "Remove key" }));
    await confirmRemoval();
    await waitFor(() => expect(api.clearProviderKey).toHaveBeenCalledWith("openai"));

    await act(async () => resolveCheck({ accepted: true, message: "ok" }));
    expect(api.setProviderKey).not.toHaveBeenCalled();
  });

  it("asks before removing a saved key, and shows it by its last four characters", async () => {
    api.getProviderKeyStatus.mockResolvedValue(
      keys({ openai: { saved: true, hint: "abcd", storage: "keychain", revision: 3 } })
    );
    renderSection();
    expect((await screen.findByTestId("assistant-provider-key-saved")).textContent).toBe(
      "Saved · …abcd"
    );
    expect(screen.queryByTestId("assistant-provider-key-missing")).toBeNull();
    await keyInput();
    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    expect(api.clearProviderKey).not.toHaveBeenCalled();
    expect(await screen.findByText("Remove the OpenAI key?")).toBeTruthy();
    await confirmRemoval();
    await waitFor(() => expect(api.clearProviderKey).toHaveBeenCalledWith("openai"));
  });

  it("says where a key will be stored before it is saved, when there is no keychain", async () => {
    api.getProviderKeyStatus.mockResolvedValue(keys({}, false));
    renderSection();
    await waitFor(() =>
      expect(screen.getByTestId("assistant-provider-key-storage").textContent).toContain(
        "settings file"
      )
    );
  });

  it("offers Retry when the saved keys cannot be read", async () => {
    api.getProviderKeyStatus
      .mockRejectedValueOnce(new Error("ipc down"))
      .mockResolvedValueOnce(keys());
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByTestId("assistant-provider-key-missing");
    expect(api.getProviderKeyStatus).toHaveBeenCalledTimes(2);
  });

  it("saves only the edited provider's model once typing settles", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { persist } = renderSection(
      settings({ modelProvider: "openrouter", providerModels: { openai: "gpt-6-sol" } })
    );
    const model = screen.getByPlaceholderText("z-ai/glm-5.3-flash");
    fireEvent.change(model, { target: { value: "anthropic/claude-sonnet-4.5" } });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    await waitFor(() =>
      expect(persist).toHaveBeenCalledWith({
        providerModels: { openrouter: "anthropic/claude-sonnet-4.5" },
      })
    );
  });

  it("never writes back a model it did not edit, when settings arrive after mount", async () => {
    // Mounted with defaults, as the tab is before getSettings() answers…
    const initial = settings();
    const persist = vi.fn(async () => initial);
    const view = render(
      <AssistantModelProviderSettings settings={initial} persist={persist} disabled={false} />
    );
    // …then the stored override arrives.
    view.rerender(
      <AssistantModelProviderSettings
        settings={settings({ providerModels: { openai: "gpt-6-sol" } })}
        persist={persist}
        disabled={false}
      />
    );
    expect((screen.getByPlaceholderText("gpt-6-luna") as HTMLInputElement).value).toBe("gpt-6-sol");
    fireEvent.click(screen.getByRole("radio", { name: "Baseten" }));
    view.unmount();
    expect(persist).toHaveBeenCalledWith({ modelProvider: "baseten" });
    expect(persist).not.toHaveBeenCalledWith(
      expect.objectContaining({ providerModels: expect.anything() })
    );
  });

  it("does not drop a model edit when Settings closes before the debounce settles", async () => {
    const { persist, unmount } = renderSection();
    fireEvent.change(screen.getByPlaceholderText("gpt-6-luna"), {
      target: { value: "gpt-6-sol" },
    });
    unmount();
    expect(persist).toHaveBeenCalledWith({ providerModels: { openai: "gpt-6-sol" } });
  });

  it("carries a pending model edit along when the provider is switched", async () => {
    const { persist } = renderSection();
    await screen.findByTestId("assistant-provider-key-missing");
    fireEvent.change(screen.getByPlaceholderText("gpt-6-luna"), {
      target: { value: "gpt-6-sol" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Baseten" }));
    expect(persist).toHaveBeenCalledWith({
      modelProvider: "baseten",
      providerModels: { openai: "gpt-6-sol" },
    });
  });

  it("shows OpenRouter's routing options only for OpenRouter, and persists them", async () => {
    const openai = renderSection();
    await screen.findByTestId("assistant-provider-key-missing");
    expect(document.body.textContent).not.toContain("Optimise for");
    openai.unmount();

    const { persist } = renderSection(settings({ modelProvider: "openrouter" }));
    await screen.findByTestId("assistant-provider-key-missing");
    fireEvent.click(screen.getByRole("radio", { name: "Cost" }));
    expect(persist).toHaveBeenCalledWith({
      openRouterRouting: { sort: "price", allowTraining: false, zeroRetention: false },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Only hosts without log retention" }));
    expect(persist).toHaveBeenCalledWith({
      openRouterRouting: { sort: "latency", allowTraining: false, zeroRetention: true },
    });
  });

  it("links to where the provider issues keys", async () => {
    renderSection(settings({ modelProvider: "openrouter" }));
    await screen.findByTestId("assistant-provider-key-missing");
    fireEvent.click(screen.getByRole("button", { name: /Get a key/ }));
    expect(openExternal).toHaveBeenCalledWith("https://openrouter.ai/settings/keys");
  });
});
