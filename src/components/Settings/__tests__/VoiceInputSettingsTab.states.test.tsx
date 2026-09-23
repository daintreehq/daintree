// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VoiceInputSettingsTab,
  dictationBlockers,
  maskApiKey,
  recordingModeDescription,
} from "../VoiceInputSettingsTab";

vi.mock("@/lib/voiceInputSettingsEvents", () => ({
  dispatchVoiceInputSettingsChanged: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));

vi.mock("@/hooks/useAudioDevices", () => ({
  SYSTEM_DEFAULT_VALUE: "__system_default__",
  useAudioDevices: () => ({
    devices: [{ value: "__system_default__", label: "System default" }],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("../SettingsValidationRegistry", () => ({
  useSettingsTabValidation: vi.fn(),
}));

const BASE = {
  enabled: true,
  openaiApiKey: "",
  deepgramApiKey: "",
  language: "en",
  customDictionary: [],
  transcriptionProvider: "openai",
  transcriptionModel: "gpt-live-transcribe",
  correctionEnabled: false,
  correctionModel: "gpt-5.6-luna",
  correctionCustomInstructions: "",
  paragraphingStrategy: "spoken-command",
  resolveFileLinks: true,
  deviceId: "",
  organizationId: "",
  projectId: "",
  recordingMode: "toggle",
  suggestedDictionary: [],
  learnFromCorrections: true,
};

function install(settings: Partial<typeof BASE>, overrides: Record<string, unknown> = {}) {
  const api = {
    getSettings: vi.fn().mockResolvedValue({ ...BASE, ...settings }),
    setSettings: vi.fn().mockResolvedValue(undefined),
    checkMicPermission: vi.fn().mockResolvedValue("granted"),
    requestMicPermission: vi.fn().mockResolvedValue(true),
    openMicSettings: vi.fn(),
    validateApiKey: vi.fn().mockResolvedValue({ valid: true }),
    ...overrides,
  };
  Object.defineProperty(window, "electron", {
    value: { voiceInput: api, system: { openExternal: vi.fn() } },
    configurable: true,
    writable: true,
  });
  return api;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("maskApiKey", () => {
  it("never reveals more than the key's kind and last four characters", () => {
    for (const key of [
      "sk-proj-abcdefghijklmnop1234",
      "sk-abcdefghijklmnop1234",
      "dg_abcdefgh1234",
    ]) {
      const masked = maskApiKey(key);
      expect(masked.endsWith(key.slice(-4))).toBe(true);
      expect(masked.replace("…", "").length).toBeLessThan(key.length - 8);
    }
  });
});

describe("dictationBlockers", () => {
  it("names the missing key for whichever provider transcribes", () => {
    const openai = dictationBlockers(
      { transcriptionProvider: "openai", openaiApiKey: "", deepgramApiKey: "dg_1" },
      "granted"
    );
    const deepgram = dictationBlockers(
      { transcriptionProvider: "deepgram", openaiApiKey: "sk-1", deepgramApiKey: "" },
      "granted"
    );
    expect(openai.join(" ")).toContain("OpenAI");
    expect(deepgram.join(" ")).toContain("Deepgram");
  });

  it("reports nothing it cannot observe: a present key and an undecided mic are not blockers", () => {
    for (const mic of ["granted", "not-determined", "unknown"] as const) {
      expect(
        dictationBlockers(
          { transcriptionProvider: "openai", openaiApiKey: "sk-1", deepgramApiKey: "" },
          mic
        )
      ).toEqual([]);
    }
    expect(
      dictationBlockers(
        { transcriptionProvider: "openai", openaiApiKey: "sk-1", deepgramApiKey: "" },
        "denied"
      )
    ).toHaveLength(1);
  });
});

describe("VoiceInputSettingsTab key row", () => {
  it("shows a saved key masked, never in full", async () => {
    const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    install({ openaiApiKey: key });
    const { container } = render(<VoiceInputSettingsTab />);

    await waitFor(() => expect(container.textContent).toContain(maskApiKey(key)));
    expect(container.textContent).not.toContain(key);
  });

  it("keeps the draft and says so when the key fails to persist", async () => {
    install({}, { setSettings: vi.fn().mockRejectedValue(new Error("EROFS")) });
    const { container } = render(<VoiceInputSettingsTab />);

    const input = await waitFor(() => {
      const el = container.querySelector<HTMLInputElement>("#voice-stt-openai-key input");
      if (!el) throw new Error("no key input yet");
      return el;
    });
    fireEvent.change(input, { target: { value: "sk-proj-draftdraftdraft" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(container.textContent).toContain("Couldn't save the key"));
    expect(input.value).toBe("sk-proj-draftdraftdraft");
    expect(container.textContent).not.toContain("Key checked and saved");
  });

  it("marks a rejected key invalid on the field itself", async () => {
    install(
      {},
      { validateApiKey: vi.fn().mockResolvedValue({ valid: false, error: "Incorrect API key" }) }
    );
    const { container } = render(<VoiceInputSettingsTab />);

    const input = await waitFor(() => {
      const el = container.querySelector<HTMLInputElement>("#voice-stt-openai-key input");
      if (!el) throw new Error("no key input yet");
      return el;
    });
    fireEvent.change(input, { target: { value: "sk-proj-wrong" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(input.getAttribute("aria-invalid")).toBe("true"));
    const describedBy = (input.getAttribute("aria-describedby") ?? "").split(" ");
    const status = describedBy
      .map((id) => document.getElementById(id))
      .find((el) => el?.getAttribute("role") === "status");
    expect(status?.textContent).toContain("Incorrect API key");
  });

  it("never calls an unchecked key verified", async () => {
    install({ transcriptionProvider: "deepgram" });
    const { container } = render(<VoiceInputSettingsTab />);

    const input = await waitFor(() => {
      const el = container.querySelector<HTMLInputElement>('input[type="password"]');
      if (!el) throw new Error("no key input yet");
      return el;
    });
    fireEvent.change(input, { target: { value: "dg_0123456789" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(container.textContent).toContain("Key saved"));
    expect(container.textContent).not.toMatch(/checked and saved|is valid/i);
  });
});

describe("VoiceInputSettingsTab correction prerequisites", () => {
  it("disables correction's options with a reason when there is no OpenAI key", async () => {
    install({ transcriptionProvider: "deepgram", deepgramApiKey: "dg_1", correctionEnabled: true });
    const { container } = render(<VoiceInputSettingsTab />);

    const fileRefs = await screen.findByRole("switch", { name: "Resolve file references" });
    expect(fileRefs.hasAttribute("disabled")).toBe(true);
    expect(container.textContent).toContain("Add an OpenAI API key");
  });

  it("enables them once an OpenAI key is stored", async () => {
    install({ openaiApiKey: "sk-proj-abc1234", correctionEnabled: true });
    render(<VoiceInputSettingsTab />);

    const fileRefs = await screen.findByRole("switch", { name: "Resolve file references" });
    await waitFor(() => expect(fileRefs.hasAttribute("disabled")).toBe(false));
  });
});

describe("VoiceInputSettingsTab paragraph breaks", () => {
  it("shows the mode that will actually apply for a language without spoken commands", async () => {
    install({ language: "de", paragraphingStrategy: "spoken-command" });
    const { container } = render(<VoiceInputSettingsTab />);

    await waitFor(() => {
      const row = container.querySelector("#voice-paragraph-breaks");
      expect(row?.textContent).toContain("Enter only");
    });
    // Nothing on the row offers the spoken mode the language can't use.
    expect(screen.queryByRole("radiogroup", { name: "Paragraph breaks" })).toBeNull();
  });
});

describe("recordingModeDescription", () => {
  it("names the real binding, and says so when there is none", () => {
    for (const mode of ["toggle", "push-to-talk"] as const) {
      expect(recordingModeDescription(mode, "⌘⇧D")).toContain("⌘⇧D");
      expect(recordingModeDescription(mode, "")).toMatch(/No shortcut is assigned/);
      expect(recordingModeDescription(mode, "")).not.toMatch(/\.\./);
    }
  });
});

describe("VoiceInputSettingsTab provider switch", () => {
  it("never carries one provider's key result into the other's row", async () => {
    install(
      {},
      { validateApiKey: vi.fn().mockResolvedValue({ valid: false, error: "Incorrect API key" }) }
    );
    const { container } = render(<VoiceInputSettingsTab />);

    const input = await waitFor(() => {
      const el = container.querySelector<HTMLInputElement>("#voice-stt-openai-key input");
      if (!el) throw new Error("no key input yet");
      return el;
    });
    fireEvent.change(input, { target: { value: "sk-proj-wrong" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(container.textContent).toContain("Incorrect API key"));

    fireEvent.click(screen.getByRole("radio", { name: "Deepgram" }));

    await waitFor(() => expect(container.textContent).toContain("Deepgram API key"));
    expect(container.textContent).not.toContain("Incorrect API key");
    const deepgramInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(deepgramInput?.value).toBe("");
  });
});
