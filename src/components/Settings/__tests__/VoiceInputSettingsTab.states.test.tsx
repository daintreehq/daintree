// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VoiceInputSettingsTab,
  dictationBlockers,
  maskApiKey,
  recordingModeDescription,
} from "../VoiceInputSettingsTab";
import { VOICE_CLEANUP_MODELS_BY_PROVIDER } from "@shared/config/voiceCorrection";
import type { SuggestedDictionaryEntry, VoiceDictionaryEntry } from "@shared/types";

vi.mock("@/lib/voiceInputSettingsEvents", () => ({
  dispatchVoiceInputSettingsChanged: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));

const audioDevices = vi.hoisted(() => {
  const systemDefault = { value: "__system_default__", label: "System default" };
  const initial = () => ({
    devices: [systemDefault] as Array<{ value: string; label: string }>,
    loading: false,
    error: null as string | null,
    complete: true,
  });
  return { systemDefault, initial, current: initial() };
});

vi.mock("@/hooks/useAudioDevices", () => ({
  SYSTEM_DEFAULT_VALUE: "__system_default__",
  useAudioDevices: () => ({ ...audioDevices.current, refresh: vi.fn() }),
}));

vi.mock("../SettingsValidationRegistry", () => ({
  useSettingsTabValidation: vi.fn(),
}));

const BASE = {
  enabled: true,
  openaiApiKey: "",
  deepgramApiKey: "",
  xaiApiKey: "",
  anthropicApiKey: "",
  language: "en",
  dictionary: [] as VoiceDictionaryEntry[],
  transcriptionProvider: "openai",
  transcriptionModel: "gpt-live-transcribe",
  correctionEnabled: false,
  correctionProvider: "openai",
  correctionModel: "gpt-6.1-terra",
  correctionCustomInstructions: "",
  paragraphingStrategy: "spoken-command",
  resolveFileLinks: true,
  deviceId: "",
  deviceLabel: "",
  organizationId: "",
  projectId: "",
  recordingMode: "toggle",
  suggestedDictionary: [] as SuggestedDictionaryEntry[],
  learnFromCorrections: true,
};

function install(
  settings: Partial<typeof BASE>,
  overrides: Record<string, unknown> = {},
  dictionaryOverrides: Record<string, unknown> = {}
) {
  const api = {
    getSettings: vi.fn().mockResolvedValue({ ...BASE, ...settings }),
    setSettings: vi.fn().mockResolvedValue(undefined),
    checkMicPermission: vi.fn().mockResolvedValue("granted"),
    requestMicPermission: vi.fn().mockResolvedValue(true),
    openMicSettings: vi.fn(),
    validateApiKey: vi.fn().mockResolvedValue({ valid: true }),
    getLastTerms: vi.fn().mockResolvedValue(null),
    onStatus: vi.fn(() => () => {}),
    onSessionEnded: vi.fn(() => () => {}),
    ...overrides,
  };
  const voiceDictionary = {
    add: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
    acceptSuggestion: vi.fn(),
    dismissSuggestion: vi.fn(),
    recordSuggestions: vi.fn(),
    ...dictionaryOverrides,
  };
  Object.defineProperty(window, "electron", {
    value: { voiceInput: api, voiceDictionary, system: { openExternal: vi.fn() } },
    configurable: true,
    writable: true,
  });
  return { ...api, dictionary: voiceDictionary };
}

const term = (value: string): VoiceDictionaryEntry => ({
  term: value,
  heardAs: [],
  source: "manual",
  addedAt: 1,
});

afterEach(() => {
  vi.clearAllMocks();
  audioDevices.current = audioDevices.initial();
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
      { transcriptionProvider: "openai", openaiApiKey: "", deepgramApiKey: "dg_1", xaiApiKey: "" },
      "granted"
    );
    const deepgram = dictationBlockers(
      {
        transcriptionProvider: "deepgram",
        openaiApiKey: "sk-1",
        deepgramApiKey: "",
        xaiApiKey: "",
      },
      "granted"
    );
    const grok = dictationBlockers(
      {
        transcriptionProvider: "grok",
        openaiApiKey: "sk-1",
        deepgramApiKey: "dg_1",
        xaiApiKey: "",
      },
      "granted"
    );
    expect(openai.join(" ")).toContain("OpenAI");
    expect(deepgram.join(" ")).toContain("Deepgram");
    expect(grok.join(" ")).toContain("xAI API key");
  });

  it("reports nothing it cannot observe: a present key and an undecided mic are not blockers", () => {
    for (const mic of ["granted", "not-determined", "unknown"] as const) {
      expect(
        dictationBlockers(
          {
            transcriptionProvider: "openai",
            openaiApiKey: "sk-1",
            deepgramApiKey: "",
            xaiApiKey: "",
          },
          mic
        )
      ).toEqual([]);
    }
    expect(
      dictationBlockers(
        {
          transcriptionProvider: "openai",
          openaiApiKey: "sk-1",
          deepgramApiKey: "",
          xaiApiKey: "",
        },
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

  it("asks for the OpenAI key in the cleanup section while another provider transcribes", async () => {
    install({ transcriptionProvider: "deepgram", deepgramApiKey: "dg_1", correctionEnabled: true });
    const { container } = render(<VoiceInputSettingsTab />);

    await screen.findByRole("switch", { name: "Resolve file references" });
    const cleanup = container.querySelector("#voice-ai-correction") as HTMLElement;
    expect(cleanup.querySelector("#voice-stt-openai-key")).toBeTruthy();
    const stt = container.querySelector("#voice-speech-to-text") as HTMLElement;
    expect(stt.textContent).toContain("Deepgram API key");
    expect(stt.textContent).not.toContain("OpenAI API key");
    expect(cleanup.textContent).not.toMatch(/Deepgram/);
  });

  it("asks Grok users for an xAI key, saves it to its own field, and says what xAI keeps", async () => {
    const setSettings = vi.fn().mockResolvedValue(undefined);
    install(
      { transcriptionProvider: "grok", xaiApiKey: "", correctionEnabled: true },
      { setSettings }
    );
    const { container } = render(<VoiceInputSettingsTab />);

    await screen.findByRole("switch", { name: "Resolve file references" });
    const stt = container.querySelector<HTMLElement>("#voice-speech-to-text");
    expect(stt?.textContent).toContain("xAI API key");
    expect(stt?.textContent).not.toContain("Deepgram API key");
    expect(stt?.textContent).not.toContain("OpenAI API key");
    expect(container.textContent).toContain("Can't start yet: add your xAI API key");
    const disclosure = screen.getByText(/xAI receives your audio/).textContent ?? "";
    expect(disclosure).toMatch(/30 days/);
    expect(disclosure).toMatch(/Zero Data Retention/);
    expect(disclosure).toMatch(/go with the audio/);

    const input = screen.getByPlaceholderText("Paste an xAI API key");
    fireEvent.change(input, { target: { value: "xai-abc123" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(setSettings).toHaveBeenCalledWith({ xaiApiKey: "xai-abc123" }));
  });

  it("saves the cleanup key and turns cleanup's options on while another provider transcribes", async () => {
    const setSettings = vi.fn().mockResolvedValue(undefined);
    install(
      { transcriptionProvider: "deepgram", deepgramApiKey: "dg_1", correctionEnabled: true },
      { setSettings }
    );
    const { container } = render(<VoiceInputSettingsTab />);

    const fileRefs = await screen.findByRole("switch", { name: "Resolve file references" });
    expect(fileRefs.hasAttribute("disabled")).toBe(true);
    const input = await waitFor(() => {
      const el = container.querySelector<HTMLInputElement>(
        "#voice-ai-correction #voice-stt-openai-key input"
      );
      if (!el) throw new Error("no cleanup key input yet");
      return el;
    });
    expect(input.hasAttribute("disabled")).toBe(false);
    fireEvent.change(input, { target: { value: "sk-proj-cleanupkey123" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith({ openaiApiKey: "sk-proj-cleanupkey123" })
    );
    await waitFor(() => expect(fileRefs.hasAttribute("disabled")).toBe(false));
  });

  it("says one OpenAI key covers both sections when OpenAI transcribes", async () => {
    install({ openaiApiKey: "sk-proj-abc1234", correctionEnabled: true });
    const { container } = render(<VoiceInputSettingsTab />);

    await screen.findByRole("switch", { name: "Resolve file references" });
    const stt = container.querySelector("#voice-speech-to-text") as HTMLElement;
    const cleanup = container.querySelector("#voice-ai-correction") as HTMLElement;
    expect(stt.querySelectorAll("#voice-stt-openai-key")).toHaveLength(1);
    expect(cleanup.querySelector("#voice-stt-openai-key")).toBeNull();
    expect(stt.textContent).toContain("covers transcription and text cleanup");
    expect(cleanup.textContent).toContain("covers transcription and cleanup");
  });

  it("enables them once an OpenAI key is stored", async () => {
    install({ openaiApiKey: "sk-proj-abc1234", correctionEnabled: true });
    render(<VoiceInputSettingsTab />);

    const fileRefs = await screen.findByRole("switch", { name: "Resolve file references" });
    await waitFor(() => expect(fileRefs.hasAttribute("disabled")).toBe(false));
  });
});

describe("VoiceInputSettingsTab cleanup default", () => {
  const resetName = "Reset Clean up transcriptions to default";

  it("treats cleanup switched on as the default", async () => {
    install({ openaiApiKey: "sk-proj-abc1234", correctionEnabled: true });
    render(<VoiceInputSettingsTab />);

    const cleanup = await screen.findByRole("switch", { name: "Clean up transcriptions" });
    expect(cleanup.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: resetName })).toBeNull();
  });

  it("marks cleanup switched off as modified and resets it back on", async () => {
    const api = install({ openaiApiKey: "sk-proj-abc1234", correctionEnabled: false });
    render(<VoiceInputSettingsTab />);

    const cleanup = await screen.findByRole("switch", { name: "Clean up transcriptions" });
    expect(cleanup.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(await screen.findByRole("button", { name: resetName }));
    await waitFor(() => expect(api.setSettings).toHaveBeenCalledWith({ correctionEnabled: true }));
  });
});

describe("VoiceInputSettingsTab paragraph breaks", () => {
  it("shows the mode that will actually apply for a language without spoken commands", async () => {
    install({ language: "de", paragraphingStrategy: "spoken-command" });
    const { container } = render(<VoiceInputSettingsTab />);

    await waitFor(() => {
      const row = container.querySelector("#voice-paragraph-breaks");
      expect(row?.textContent).toContain("Spoken commands need English");
      expect(row?.textContent).toContain("Shift+Enter");
    });
    // Nothing on the row offers the spoken mode the language can't use.
    expect(screen.queryByRole("radiogroup", { name: "Paragraph breaks" })).toBeNull();
  });
});

describe("VoiceInputSettingsTab copy", () => {
  it("never tells the user Enter commits or starts a paragraph, since it sends the prompt", async () => {
    for (const paragraphingStrategy of ["spoken-command", "manual"]) {
      install({ paragraphingStrategy });
      const { container, unmount } = render(<VoiceInputSettingsTab />);
      await waitFor(() => expect(container.querySelector("#voice-paragraph-breaks")).toBeTruthy());
      const text = container.querySelector("#voice-paragraph-breaks")?.textContent ?? "";
      expect(text).not.toMatch(/Enter to (commit|start)/);
      expect(text).toContain("Enter stops dictation and sends the prompt");
      unmount();
    }
  });

  it("describes the once-per-stop pass and offers the provider's cleanup models, the default picked", async () => {
    install({ correctionEnabled: true, openaiApiKey: "sk-test" });
    render(<VoiceInputSettingsTab />);
    const models = await screen.findByRole("radiogroup", { name: "Cleanup model" });
    const section = models.closest("#voice-ai-correction");
    expect(section?.textContent).toContain("whole passage is corrected once");

    const choices = within(models).getAllByRole("radio");
    expect(choices).toHaveLength(VOICE_CLEANUP_MODELS_BY_PROVIDER.openai.length);
    // Each choice says what its model is better at.
    for (const choice of choices) {
      expect(choice.getAttribute("aria-describedby")).toBeTruthy();
    }
    const picked = choices.filter((choice) => choice.getAttribute("aria-checked") === "true");
    expect(picked).toHaveLength(1);
    expect(picked[0]!.textContent).toMatch(/Terra/);
  });

  it("shows a chosen Luna as picked and marks it changed from the default", async () => {
    install({ correctionEnabled: true, openaiApiKey: "sk-test", correctionModel: "gpt-6-luna" });
    render(<VoiceInputSettingsTab />);
    const models = await screen.findByRole("radiogroup", { name: "Cleanup model" });
    const picked = within(models)
      .getAllByRole("radio")
      .filter((choice) => choice.getAttribute("aria-checked") === "true");
    expect(picked.map((choice) => choice.textContent)).toEqual([expect.stringMatching(/Luna/)]);
    expect(screen.getByRole("button", { name: /reset.*cleanup model/i })).toBeTruthy();
  });

  it("lists the dictation shortcuts with a way to rebind them", async () => {
    install({});
    const { container } = render(<VoiceInputSettingsTab />);
    await waitFor(() => expect(container.querySelector("#voice-shortcuts")).toBeTruthy());
    const row = container.querySelector("#voice-shortcuts");
    for (const phrase of [
      "Start or stop dictation",
      "Pause or resume",
      "Cancel and discard this dictation",
      "Stop dictation and send the prompt",
    ]) {
      expect(row?.textContent).toContain(phrase);
    }
    expect(screen.getByRole("button", { name: "Change in Keyboard settings" })).toBeTruthy();
  });

  it("labels the microphone row by what it is and offers no Re-check once access is granted", async () => {
    install({}, { checkMicPermission: vi.fn().mockResolvedValue("granted") });
    const { container } = render(<VoiceInputSettingsTab />);
    await waitFor(() =>
      expect(container.querySelector("#voice-mic-access")?.textContent).toContain(
        "Microphone access granted"
      )
    );
    const row = container.querySelector("#voice-mic-access");
    if (!row) throw new Error("missing mic row");
    expect(row.textContent).toContain("Microphone access");
    expect(row.querySelector("button")).toBeNull();
  });
});

describe("recordingModeDescription", () => {
  it("names the real binding, and says so when there is none", () => {
    for (const mode of ["tap-or-hold", "toggle", "push-to-talk"] as const) {
      expect(recordingModeDescription(mode, "⌘⇧D")).toContain("⌘⇧D");
      expect(recordingModeDescription(mode, "")).toMatch(/No shortcut is assigned/);
      expect(recordingModeDescription(mode, "")).not.toMatch(/\.\./);
    }
  });
});

/** Open the provider select from the keyboard and choose an option, the way Radix expects in jsdom. */
async function pickProvider(name: string): Promise<void> {
  const trigger = await screen.findByRole("combobox", { name: "Transcription provider" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  const option = await screen.findByRole("option", { name });
  fireEvent.keyDown(option, { key: "Enter" });
}

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

    await pickProvider("Deepgram");

    await waitFor(() => expect(container.textContent).toContain("Deepgram API key"));
    expect(container.textContent).not.toContain("Incorrect API key");
    const deepgramInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(deepgramInput?.value).toBe("");
  });
});

describe("VoiceInputSettingsTab cleanup provider", () => {
  it("switches cleanup to Anthropic with Haiku in one save", async () => {
    const setSettings = vi.fn().mockResolvedValue(undefined);
    install({ correctionEnabled: true, openaiApiKey: "sk-test" }, { setSettings });
    render(<VoiceInputSettingsTab />);

    const trigger = await screen.findByRole("combobox", { name: "Cleanup provider" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(await screen.findByRole("option", { name: "Anthropic" }), { key: "Enter" });

    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith({
        correctionProvider: "anthropic",
        correctionModel: "claude-haiku-5-5",
      })
    );
  });

  it("offers the Claude models behind the Anthropic key while OpenAI transcribes", async () => {
    install({
      correctionEnabled: true,
      openaiApiKey: "sk-test",
      correctionProvider: "anthropic",
      correctionModel: "claude-haiku-5-5",
    });
    const { container } = render(<VoiceInputSettingsTab />);

    const models = await screen.findByRole("radiogroup", { name: "Cleanup model" });
    const names = within(models)
      .getAllByRole("radio")
      .map((choice) => choice.textContent);
    expect(names).toEqual([expect.stringMatching(/Haiku/), expect.stringMatching(/Sonnet/)]);
    const section = container.querySelector("#voice-ai-correction");
    expect(section?.textContent).toContain("Anthropic API key");
    expect(section?.textContent).not.toContain("covers transcription and cleanup");
    expect(section?.textContent).toContain("Cleanup runs on Anthropic. Add an Anthropic API key");
  });

  it("names the cleanup provider the passage goes to, with OpenAI's retention only for OpenAI", async () => {
    install({ correctionEnabled: true, openaiApiKey: "sk-test" });
    const { container, unmount } = render(<VoiceInputSettingsTab />);
    await screen.findByRole("radiogroup", { name: "Cleanup model" });
    const openai = container.querySelector("#voice-ai-correction")?.textContent ?? "";
    expect(openai).toContain(
      "are sent to OpenAI, which keeps them for up to 30 days for abuse monitoring and doesn't train on them."
    );
    unmount();

    install({
      correctionEnabled: true,
      openaiApiKey: "sk-test",
      correctionProvider: "anthropic",
      correctionModel: "claude-haiku-5-5",
    });
    const anthropic = render(<VoiceInputSettingsTab />);
    await screen.findByRole("radiogroup", { name: "Cleanup model" });
    const text = anthropic.container.querySelector("#voice-ai-correction")?.textContent ?? "";
    expect(text).toContain("are sent to Anthropic.");
    expect(text).not.toMatch(/30 days|OpenAI, which keeps/);
  });
});

describe("VoiceInputSettingsTab file references", () => {
  it("stay switchable on their own OpenAI key while the Anthropic key is missing", async () => {
    install({
      correctionEnabled: true,
      openaiApiKey: "sk-test",
      correctionProvider: "anthropic",
      correctionModel: "claude-haiku-5-5",
    });
    render(<VoiceInputSettingsTab />);

    const models = await screen.findByRole("radiogroup", { name: "Cleanup model" });
    expect(within(models).getAllByRole("radio")[0]!.hasAttribute("disabled")).toBe(true);
    const fileRefs = await screen.findByRole("switch", { name: "Resolve file references" });
    expect(fileRefs.hasAttribute("disabled")).toBe(false);
  });

  it("offer an OpenAI key row when neither selected provider shows one", async () => {
    const setSettings = vi.fn().mockResolvedValue(undefined);
    install(
      {
        transcriptionProvider: "deepgram",
        deepgramApiKey: "dg_1",
        correctionEnabled: true,
        anthropicApiKey: "sk-ant-1",
        correctionProvider: "anthropic",
        correctionModel: "claude-haiku-5-5",
      },
      { setSettings }
    );
    const { container } = render(<VoiceInputSettingsTab />);

    const fileRefs = await screen.findByRole("switch", { name: "Resolve file references" });
    expect(fileRefs.hasAttribute("disabled")).toBe(true);
    const input = await waitFor(() => {
      const el = container.querySelector<HTMLInputElement>(
        "#voice-ai-correction #voice-stt-openai-key input"
      );
      if (!el) throw new Error("no OpenAI key input yet");
      return el;
    });
    fireEvent.change(input, { target: { value: "sk-proj-filelinks123" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith({ openaiApiKey: "sk-proj-filelinks123" })
    );
  });

  it("show no second OpenAI key row when Speech-to-text already has it", async () => {
    install({
      correctionEnabled: true,
      openaiApiKey: "sk-test",
      correctionProvider: "anthropic",
      correctionModel: "claude-haiku-5-5",
    });
    const { container } = render(<VoiceInputSettingsTab />);
    await screen.findByRole("switch", { name: "Resolve file references" });
    expect(container.querySelectorAll("#voice-stt-openai-key")).toHaveLength(1);
    expect(container.querySelector("#voice-ai-correction #voice-stt-openai-key")).toBeNull();
  });
});

describe("VoiceInputSettingsTab provider select", () => {
  it("puts each provider's own logo on the trigger and on its option", async () => {
    install({});
    render(<VoiceInputSettingsTab />);

    const mark = (el: Element) => el.querySelector('svg[width="14"]')?.getAttribute("viewBox");
    // OpenAI's mark is drawn on a 320 grid, Deepgram's on a 24 grid.
    const OPENAI_MARK = "0 0 320 320";
    const DEEPGRAM_MARK = "0 0 24 24";

    const trigger = await screen.findByRole("combobox", { name: "Transcription provider" });
    // The row keeps the anchor the `voice-provider` search deep link scrolls to.
    expect(document.getElementById("voice-provider")?.contains(trigger)).toBe(true);
    expect(trigger.textContent).toContain("OpenAI");
    expect(mark(trigger)).toBe(OPENAI_MARK);

    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(mark(await screen.findByRole("option", { name: "OpenAI" }))).toBe(OPENAI_MARK);
    const deepgramOption = await screen.findByRole("option", { name: "Deepgram" });
    expect(mark(deepgramOption)).toBe(DEEPGRAM_MARK);

    fireEvent.keyDown(deepgramOption, { key: "Enter" });
    await waitFor(() => expect(mark(trigger)).toBe(DEEPGRAM_MARK));
    expect(trigger.textContent).toContain("Deepgram");
  });

  it("swaps the privacy note with the selection, naming recipient, retention and hints", async () => {
    install({});
    const { container } = render(<VoiceInputSettingsTab />);

    const openai = await screen.findByText(/OpenAI receives your audio/);
    expect(openai.textContent).toMatch(/up to 30 days/);
    expect(openai.textContent).toMatch(/doesn't train on it/);
    expect(openai.textContent).toMatch(/Recognition hints go with the audio/);
    expect(openai.textContent).toMatch(/dictionary/);
    expect(openai.textContent).toMatch(/branch/);
    expect(openai.textContent).toMatch(/terminal output/);

    await pickProvider("Deepgram");

    const deepgram = await screen.findByText(/Deepgram receives your audio/);
    expect(deepgram.textContent).toMatch(/may keep audio and transcripts to improve its models/);
    expect(deepgram.textContent).toMatch(/Recognition hints go with the audio/);
    expect(container.textContent).not.toContain("OpenAI receives your audio");
  });

  it("saves the picked provider and resets to OpenAI", async () => {
    const setSettings = vi.fn().mockResolvedValue(undefined);
    install({ transcriptionProvider: "deepgram" }, { setSettings });
    render(<VoiceInputSettingsTab />);

    const trigger = await screen.findByRole("combobox", { name: "Transcription provider" });
    expect(trigger.textContent).toContain("Deepgram");

    fireEvent.click(screen.getByRole("button", { name: /Reset Transcription provider/ }));
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith({ transcriptionProvider: "openai" })
    );
  });
});

describe("VoiceInputSettingsTab input device (#14850)", () => {
  const BUILT_IN = { value: "builtin", label: "MacBook Pro Microphone" };
  const AIRPODS = { value: "airpods", label: "Greg's AirPods Pro" };
  const withDevices = (...devices: Array<{ value: string; label: string }>) => {
    audioDevices.current.devices = [audioDevices.systemDefault, ...devices];
  };
  const inputDevice = () => screen.findByRole("combobox", { name: "Input device" });
  const row = () => document.getElementById("voice-input-device")!;

  it("keeps naming the chosen mic, marked not connected, while it's unplugged", async () => {
    withDevices(BUILT_IN);
    install({ deviceId: "airpods", deviceLabel: "Greg's AirPods Pro" });
    render(<VoiceInputSettingsTab />);

    await waitFor(async () =>
      expect((await inputDevice()).textContent).toContain("Greg's AirPods Pro (not connected)")
    );
    expect(row().textContent).toMatch(/dictation uses the system default until it's back/);
  });

  it("drops the mark once the chosen mic is plugged back in", async () => {
    withDevices(BUILT_IN);
    install({ deviceId: "airpods", deviceLabel: "Greg's AirPods Pro" });
    const { rerender } = render(<VoiceInputSettingsTab />);
    const trigger = await inputDevice();
    await waitFor(() =>
      expect(trigger.textContent).toContain("Greg's AirPods Pro (not connected)")
    );

    withDevices(BUILT_IN, AIRPODS);
    rerender(<VoiceInputSettingsTab />);

    await waitFor(() => expect(trigger.textContent).not.toContain("not connected"));
    expect(trigger.textContent).toContain("Greg's AirPods Pro");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(await screen.findAllByRole("option", { name: /AirPods/ })).toHaveLength(1);
  });

  it.each([
    ["the list is still loading", { loading: true }],
    ["the list couldn't be read", { error: "Could not enumerate audio devices" }],
    ["devices are still unnamed", { complete: false }],
  ])("doesn't call the chosen mic gone while %s", async (_case, state) => {
    withDevices();
    Object.assign(audioDevices.current, state);
    install({ deviceId: "airpods", deviceLabel: "Greg's AirPods Pro" });
    render(<VoiceInputSettingsTab />);

    await waitFor(async () =>
      expect((await inputDevice()).textContent).toContain("Greg's AirPods Pro")
    );
    expect(row().textContent).not.toContain("not connected");
  });

  it("names a mic chosen before its name was saved", async () => {
    withDevices(BUILT_IN);
    install({ deviceId: "airpods" });
    render(<VoiceInputSettingsTab />);

    await waitFor(async () =>
      expect((await inputDevice()).textContent).toContain("Selected microphone (not connected)")
    );
  });

  it("says System default follows the system input", async () => {
    withDevices(BUILT_IN);
    install({ deviceId: "" });
    render(<VoiceInputSettingsTab />);

    expect((await inputDevice()).textContent).toContain("System default");
    await waitFor(() =>
      expect(row().textContent).toMatch(/system input, so a headset that connects takes over/)
    );
  });

  it.each(["default", "communications"])(
    "reads a saved %j alias as System default, not a change",
    async (deviceId) => {
      withDevices(BUILT_IN);
      install({ deviceId, deviceLabel: "Default - MacBook Pro Microphone" });
      render(<VoiceInputSettingsTab />);

      await waitFor(async () =>
        expect((await inputDevice()).textContent).toContain("System default")
      );
      expect(screen.queryByRole("button", { name: /Reset Input device/ })).toBeNull();
    }
  );

  it("saves the picked mic's name with its id", async () => {
    withDevices(BUILT_IN, AIRPODS);
    const api = install({ deviceId: "" });
    render(<VoiceInputSettingsTab />);

    const trigger = await inputDevice();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(await screen.findByRole("option", { name: AIRPODS.label }), {
      key: "Enter",
    });

    await waitFor(() =>
      expect(api.setSettings).toHaveBeenCalledWith({
        deviceId: "airpods",
        deviceLabel: "Greg's AirPods Pro",
      })
    );
  });

  it("clears the name with the id on reset", async () => {
    withDevices(BUILT_IN);
    const api = install({ deviceId: "airpods", deviceLabel: "Greg's AirPods Pro" });
    render(<VoiceInputSettingsTab />);

    fireEvent.click(await screen.findByRole("button", { name: /Reset Input device/ }));

    await waitFor(() =>
      expect(api.setSettings).toHaveBeenCalledWith({ deviceId: "", deviceLabel: "" })
    );
  });

  it("keeps a newer pick's name when an older pick fails to save", async () => {
    const LOOPBACK_A = { value: "loopback-a", label: "Loopback Audio" };
    const LOOPBACK_B = { value: "loopback-b", label: "Loopback Audio" };
    withDevices(LOOPBACK_A, LOOPBACK_B);
    let failFirst: () => void = () => {};
    const setSettings = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            failFirst = () => reject(new Error("disk full"));
          })
      )
      .mockResolvedValue(undefined);
    install({ deviceId: "airpods", deviceLabel: "Greg's AirPods Pro" }, { setSettings });
    const { rerender } = render(<VoiceInputSettingsTab />);
    const trigger = await inputDevice();
    await waitFor(() => expect(trigger.textContent).toContain("Greg's AirPods Pro"));
    const pick = async (index: number) => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter" });
      const options = await screen.findAllByRole("option", { name: "Loopback Audio" });
      fireEvent.keyDown(options[index]!, { key: "Enter" });
    };

    await pick(0);
    await waitFor(() => expect(setSettings).toHaveBeenCalledTimes(1));
    await pick(1);
    await waitFor(() => expect(setSettings).toHaveBeenCalledTimes(2));
    failFirst();
    await waitFor(() => expect(screen.getByText(/Input device is back/)).toBeTruthy());

    // The second pick is what's saved: unplugged, it must still carry its own name.
    withDevices(LOOPBACK_A);
    rerender(<VoiceInputSettingsTab />);
    await waitFor(() => expect(trigger.textContent).toContain("Loopback Audio (not connected)"));
  });

  it("puts the name back with the id when a pick fails to save", async () => {
    withDevices(BUILT_IN);
    const api = install(
      { deviceId: "airpods", deviceLabel: "Greg's AirPods Pro" },
      { setSettings: vi.fn().mockRejectedValue(new Error("disk full")) }
    );
    render(<VoiceInputSettingsTab />);

    const trigger = await inputDevice();
    await waitFor(() => expect(trigger.textContent).toContain("Greg's AirPods Pro"));
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(await screen.findByRole("option", { name: BUILT_IN.label }), {
      key: "Enter",
    });

    await waitFor(() => expect(api.setSettings).toHaveBeenCalled());
    await waitFor(() =>
      expect(trigger.textContent).toContain("Greg's AirPods Pro (not connected)")
    );
  });
});

/** Remove the stored key the way a user does: the row's button, then the confirm. */
async function removeKey(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
  const confirm = await screen.findByRole("alertdialog");
  fireEvent.click(within(confirm).getByRole("button", { name: "Remove key" }));
}

describe("VoiceInputSettingsTab key removal", () => {
  it("asks before removing the key, like every other stored credential", async () => {
    const key = "sk-proj-abcdefghijklmnop6789";
    const setSettings = vi.fn().mockResolvedValue(undefined);
    install({ openaiApiKey: key }, { setSettings });
    render(<VoiceInputSettingsTab />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Remove the OpenAI API key?");
    expect(setSettings).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(setSettings).not.toHaveBeenCalled();
  });

  it("says so when removing a key fails, and keeps showing it as saved", async () => {
    const key = "sk-proj-abcdefghijklmnop6789";
    install({ openaiApiKey: key }, { setSettings: vi.fn().mockRejectedValue(new Error("EROFS")) });
    const { container } = render(<VoiceInputSettingsTab />);

    await removeKey();

    await waitFor(() => expect(container.textContent).toContain("Couldn't remove the key"));
    expect(container.textContent).toContain(maskApiKey(key));
  });
});

describe("VoiceInputSettingsTab key state honesty", () => {
  it("keeps showing the key as saved until its removal has persisted", async () => {
    const key = "sk-proj-abcdefghijklmnop6789";
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((r) => {
      finish = r;
    });
    install({ openaiApiKey: key }, { setSettings: vi.fn().mockReturnValue(pending) });
    const { container } = render(<VoiceInputSettingsTab />);

    await removeKey();
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toContain(maskApiKey(key));
    expect(container.textContent).not.toContain("Not set");

    finish?.();
    await waitFor(() => expect(container.textContent).toContain("Key removed"));
    expect(container.textContent).toContain("Not set");
  });
});

describe("VoiceInputSettingsTab key operations", () => {
  it("runs one key operation at a time, so the result names the one the user ran", async () => {
    const key = "sk-proj-abcdefghijklmnop6789";
    const pending = new Promise<void>(() => {});
    install({ openaiApiKey: key }, { setSettings: vi.fn().mockReturnValue(pending) });
    const { container } = render(<VoiceInputSettingsTab />);

    await removeKey();

    const input = container.querySelector<HTMLInputElement>("#voice-stt-openai-key input");
    await waitFor(() => expect(input?.disabled).toBe(true));
    const save = screen.getByRole("button", { name: "Check and save" });
    expect(save.hasAttribute("disabled")).toBe(true);
  });
});

describe("VoiceInputSettingsTab mic settings button", () => {
  // jsdom's user agent is neither macOS nor Windows, so the row takes its Linux shape.
  async function openSettings(opened: boolean) {
    const api = install(
      { openaiApiKey: "sk-proj-abcdefghijklmnop6789" },
      {
        checkMicPermission: vi.fn().mockResolvedValue("denied"),
        openMicSettings: vi.fn().mockResolvedValue(opened),
      }
    );
    const { container } = render(<VoiceInputSettingsTab />);
    fireEvent.click(await screen.findByRole("button", { name: /Open sound settings/ }));
    await waitFor(() => expect(api.openMicSettings).toHaveBeenCalledTimes(1));
    return container;
  }

  it("says so in the row when no settings app could be opened", async () => {
    const container = await openSettings(false);
    await waitFor(() => expect(container.textContent).toContain("Couldn't open the settings app"));
  });

  it("says why Test microphone is off while access is denied (#15233)", async () => {
    install(
      { openaiApiKey: "sk-proj-abcdefghijklmnop6789" },
      { checkMicPermission: vi.fn().mockResolvedValue("denied") }
    );
    render(<VoiceInputSettingsTab />);
    expect(
      await screen.findByText(
        "Microphone access is blocked. Allow it under Microphone access above, then re-check."
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test microphone" }).hasAttribute("disabled")).toBe(
      true
    );
  });

  it("stays quiet when the settings app opened", async () => {
    const container = await openSettings(true);
    // Long enough for the resolved open to reach the handler's state update.
    const SETTLE_MS = 20;
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(container.textContent).not.toContain("Couldn't open the settings app");
  });
});

describe("VoiceInputSettingsTab dictionary", () => {
  const termField = () => screen.findByLabelText<HTMLTextAreaElement>("Add terms");
  const openPage = async () =>
    fireEvent.click(await screen.findByRole("button", { name: /Manage dictionary/ }));
  const suggestion = (word: string, utterance: string) => ({
    word,
    utterance,
    suggestedAt: 1,
    frequency: 1,
  });

  it("summarises the dictionary and opens the page", async () => {
    install({
      dictionary: [{ ...term("Zustand"), heardAs: ["zoo stand", "zu stand"] }, term("Vite")],
      suggestedDictionary: [suggestion("Tailwind", "tail wind")],
    });
    const { container } = render(<VoiceInputSettingsTab />);

    await screen.findByRole("button", { name: /Manage dictionary/ });
    expect(container.textContent).toContain("2 terms · 2 heard-as phrases · 1 pending suggestion");
    expect(screen.queryByRole("button", { name: "Remove Vite" })).toBeNull();

    await openPage();
    expect(screen.getByRole("button", { name: "Remove Vite" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Tailwind to dictionary" })).toBeTruthy();
  });

  it("adds a term through main and shows the dictionary main returns", async () => {
    const api = install(
      {},
      {},
      {
        add: vi.fn().mockResolvedValue({
          dictionary: [term("Zustand"), term("Daintree")],
          suggestedDictionary: [],
          conflicts: [],
        }),
      }
    );
    const { container } = render(<VoiceInputSettingsTab />);
    await openPage();

    const input = await termField();
    fireEvent.change(input, { target: { value: "  Daintree " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove Daintree" })).toBeTruthy()
    );
    expect(api.dictionary.add).toHaveBeenCalledWith({ term: "Daintree", heardAs: [] });
    // A term main already held, added from elsewhere, shows up too.
    expect(screen.getByRole("button", { name: "Remove Zustand" })).toBeTruthy();
    expect(input.value).toBe("");
    expect(container.textContent).toContain("Added 1 term");
    expect(api.setSettings).not.toHaveBeenCalled();
  });

  it("adds pasted lines, comma lists and heard -> Term pairs as imports", async () => {
    const add = vi
      .fn()
      .mockResolvedValue({ dictionary: [], suggestedDictionary: [], conflicts: [] });
    install({}, {}, { add });
    render(<VoiceInputSettingsTab />);
    await openPage();

    fireEvent.change(await termField(), {
      target: { value: "Vite, Daintree\nzoo stand -> Zustand\nzu stand -> zustand" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(add).toHaveBeenCalledTimes(3));
    const imported = { source: "imported", heardAsConflict: "skip" };
    expect(add).toHaveBeenNthCalledWith(1, { term: "Vite", heardAs: [], ...imported });
    expect(add).toHaveBeenNthCalledWith(2, { term: "Daintree", heardAs: [], ...imported });
    expect(add).toHaveBeenNthCalledWith(3, {
      term: "Zustand",
      heardAs: ["zoo stand", "zu stand"],
      ...imported,
    });
  });

  it("adds heard -> Term as a rule on the term and shows it on the row", async () => {
    const api = install(
      {},
      {},
      {
        add: vi.fn().mockResolvedValue({
          dictionary: [{ ...term("Zustand"), heardAs: ["zoo stand"] }],
          suggestedDictionary: [],
          conflicts: [],
        }),
      }
    );
    const { container } = render(<VoiceInputSettingsTab />);
    await openPage();

    const input = await termField();
    fireEvent.change(input, { target: { value: " zoo stand -> Zustand " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove Zustand" })).toBeTruthy()
    );
    expect(api.dictionary.add).toHaveBeenCalledWith({ term: "Zustand", heardAs: ["zoo stand"] });
    expect(container.textContent).toContain('Heard as "zoo stand"');
    expect(input.value).toBe("");
  });

  it("shows the queue main holds after an accept, keeping a word learned meanwhile", async () => {
    const api = install(
      { suggestedDictionary: [suggestion("Zustand", "zoo stand")] },
      {},
      {
        acceptSuggestion: vi.fn().mockResolvedValue({
          dictionary: [{ ...term("Zustand"), heardAs: ["zoo stand"], source: "learned" }],
          suggestedDictionary: [suggestion("Tailwind", "tail wind")],
          conflicts: [],
        }),
      }
    );
    const { container } = render(<VoiceInputSettingsTab />);
    await openPage();

    fireEvent.click(await screen.findByRole("button", { name: "Add Zustand to dictionary" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove Zustand" })).toBeTruthy()
    );
    expect(api.dictionary.acceptSuggestion).toHaveBeenCalledWith({ word: "Zustand" });
    expect(screen.getByRole("button", { name: "Add Tailwind to dictionary" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add Zustand to dictionary" })).toBeNull();
    expect(container.textContent).toContain('Learned from "zoo stand"');
    expect(api.setSettings).not.toHaveBeenCalled();
  });

  it("leaves the page as it was when a change fails, and retries it", async () => {
    const add = vi
      .fn()
      .mockRejectedValueOnce(new Error("EROFS"))
      .mockResolvedValue({
        dictionary: [term("Daintree")],
        suggestedDictionary: [],
        conflicts: [],
      });
    install({}, {}, { add });
    const { container } = render(<VoiceInputSettingsTab />);
    await openPage();

    const input = await termField();
    fireEvent.change(input, { target: { value: "Daintree" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(container.textContent).toContain("The dictionary is back to its previous value.")
    );
    expect(input.value).toBe("Daintree");
    expect(screen.queryByRole("button", { name: "Remove Daintree" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove Daintree" })).toBeTruthy()
    );
    expect(add).toHaveBeenCalledTimes(2);
    expect(input.value).toBe("");
    expect(container.textContent).not.toContain("back to its previous value");
  });

  it("removes a term, undoes the removal, and dismisses a suggestion through main", async () => {
    const learned = {
      ...term("Daintree"),
      heardAs: ["dain tree"],
      source: "learned" as const,
      addedAt: 42,
    };
    const api = install(
      {
        dictionary: [learned, term("Vite")],
        suggestedDictionary: [suggestion("Tailwind", "tail wind")],
      },
      {},
      {
        remove: vi.fn().mockResolvedValue({
          dictionary: [term("Vite")],
          suggestedDictionary: [suggestion("Tailwind", "tail wind")],
        }),
        add: vi.fn().mockResolvedValue({
          dictionary: [term("Vite"), learned],
          suggestedDictionary: [suggestion("Tailwind", "tail wind")],
          conflicts: [],
        }),
        dismissSuggestion: vi.fn().mockResolvedValue({
          dictionary: [term("Vite"), learned],
          suggestedDictionary: [],
        }),
      }
    );
    const { container } = render(<VoiceInputSettingsTab />);
    await openPage();

    fireEvent.click(await screen.findByRole("button", { name: "Remove Daintree" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove Daintree" })).toBeNull()
    );
    expect(api.dictionary.remove).toHaveBeenCalledWith({ term: "Daintree" });
    expect(container.textContent).toContain("Removed Daintree");

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove Daintree" })).toBeTruthy()
    );
    expect(api.dictionary.add).toHaveBeenCalledWith({
      term: "Daintree",
      heardAs: ["dain tree"],
      source: "learned",
      addedAt: 42,
      heardAsConflict: "skip",
    });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Tailwind" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Dismiss Tailwind" })).toBeNull()
    );
    expect(api.dictionary.dismissSuggestion).toHaveBeenCalledWith({ word: "Tailwind" });
    expect(screen.getByRole("button", { name: "Remove Vite" })).toBeTruthy();
    expect(api.setSettings).not.toHaveBeenCalled();
  });

  it("searches terms and heard-as phrases", async () => {
    install({
      dictionary: [{ ...term("Zustand"), heardAs: ["zoo stand"] }, term("Vite")],
    });
    render(<VoiceInputSettingsTab />);
    await openPage();

    fireEvent.change(await screen.findByLabelText("Search the dictionary"), {
      target: { value: "zoo" },
    });
    expect(screen.getByRole("button", { name: "Remove Zustand" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove Vite" })).toBeNull();
  });

  it("edits an entry and refuses a term another entry already has", async () => {
    const update = vi.fn().mockResolvedValue({
      dictionary: [{ ...term("Zustand"), heardAs: ["zu stand"] }, term("Vite")],
      suggestedDictionary: [],
      conflicts: [],
    });
    install(
      { dictionary: [{ ...term("Zustand"), heardAs: ["zoo stand"] }, term("Vite")] },
      {},
      {
        update,
      }
    );
    render(<VoiceInputSettingsTab />);
    await openPage();

    fireEvent.click(await screen.findByRole("button", { name: "Edit Zustand" }));
    const heard = screen.getByLabelText("Heard-as phrases for Zustand");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(heard, { target: { value: "zu stand" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        term: "Zustand",
        changes: { term: "Zustand", heardAs: ["zu stand"] },
      })
    );
    await screen.findByRole("button", { name: "Edit Zustand" });

    fireEvent.click(screen.getByRole("button", { name: "Edit Vite" }));
    const field = screen.getByLabelText("Edit Vite");
    fireEvent.change(field, { target: { value: "zustand" } });
    expect(screen.getByText("That term is already in the dictionary")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("retries a failed settings save against what the page shows now", async () => {
    let finishSecond: () => void = () => {};
    const setSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error("EROFS"))
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finishSecond = resolve)))
      .mockRejectedValueOnce(new Error("EROFS"));
    install({}, { setSettings });
    render(<VoiceInputSettingsTab />);

    const learn = await screen.findByRole("switch", { name: "Learn words from corrections" });
    fireEvent.click(learn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());
    expect(learn.getAttribute("aria-checked")).toBe("true");

    // A second save is still in flight when the first failure is retried, and the retry fails.
    fireEvent.click(learn);
    await waitFor(() => expect(learn.getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(setSettings).toHaveBeenCalledTimes(3));
    finishSecond();

    // The in-flight save landed, so rolling back must not undo it.
    await waitFor(() => expect(learn.getAttribute("aria-checked")).toBe("false"));
  });
});
