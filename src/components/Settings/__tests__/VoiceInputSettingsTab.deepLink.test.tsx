// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceInputSettingsTab } from "../VoiceInputSettingsTab";
import { SettingsDeepLinkScope } from "../SettingsDialog";
import { SettingsValidationProvider } from "../SettingsValidationRegistry";
import { SETTINGS_SEARCH_INDEX } from "../settingsSearchIndex";
import { filterSettings } from "../settingsSearchUtils";

vi.mock("@/lib/voiceInputSettingsEvents", () => ({
  dispatchVoiceInputSettingsChanged: vi.fn(),
}));

vi.mock("@/hooks/useAudioDevices", () => ({
  SYSTEM_DEFAULT_VALUE: "__system_default__",
  useAudioDevices: () => ({
    devices: [{ value: "__system_default__", label: "System default" }],
    loading: false,
    error: null,
    complete: true,
    refresh: vi.fn(),
  }),
}));

// Saved settings that show every row search can name.
const SAVED = {
  enabled: true,
  openaiApiKey: "",
  deepgramApiKey: "",
  xaiApiKey: "",
  anthropicApiKey: "",
  language: "en",
  dictionary: [],
  transcriptionProvider: "openai",
  transcriptionModel: "gpt-live-transcribe",
  correctionEnabled: true,
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
  suggestedDictionary: [],
  learnFromCorrections: true,
};

const VOICE_RESULT_IDS = SETTINGS_SEARCH_INDEX.filter(
  (entry) => entry.tab === "voice" && entry.kind === "section"
).map((entry) => entry.id);

/** Installs the voice API with saved settings that arrive only when `load` or `fail` is called. */
function install(saved: Partial<typeof SAVED> = {}) {
  let answer: ((value: typeof SAVED) => void) | null = null;
  let refuse: ((reason: unknown) => void) | null = null;
  const getSettings = vi.fn(
    () =>
      new Promise<typeof SAVED>((resolve, reject) => {
        answer = resolve;
        refuse = reject;
      })
  );
  Object.defineProperty(window, "electron", {
    value: {
      voiceInput: {
        getSettings,
        setSettings: vi.fn().mockResolvedValue(undefined),
        checkMicPermission: vi.fn().mockResolvedValue("granted"),
        requestMicPermission: vi.fn().mockResolvedValue(true),
        openMicSettings: vi.fn(),
        validateApiKey: vi.fn().mockResolvedValue({ valid: true }),
        getLastTerms: vi.fn().mockResolvedValue(null),
        onStatus: vi.fn(() => () => {}),
        onSessionEnded: vi.fn(() => () => {}),
      },
      voiceDictionary: {
        add: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
        acceptSuggestion: vi.fn(),
        dismissSuggestion: vi.fn(),
        recordSuggestions: vi.fn(),
      },
      system: { openExternal: vi.fn() },
    },
    configurable: true,
    writable: true,
  });
  return {
    load: async () => {
      await waitFor(() => expect(getSettings).toHaveBeenCalled());
      await act(async () => {
        answer?.({ ...SAVED, ...saved });
      });
    },
    fail: async () => {
      await waitFor(() => expect(getSettings).toHaveBeenCalled());
      await act(async () => {
        refuse?.(new Error("settings unreadable"));
      });
    },
  };
}

function renderVoiceTab(sectionId: string | null) {
  const onHandled = vi.fn();
  const tree = (id: string | null) => (
    <SettingsValidationProvider>
      <div id="settings-panel-voice">
        <SettingsDeepLinkScope
          isActive
          scrollToSectionId={id}
          query={null}
          onHandled={onHandled}
          tab="voice"
        >
          <VoiceInputSettingsTab />
        </SettingsDeepLinkScope>
      </div>
    </SettingsValidationProvider>
  );
  const view = render(tree(sectionId));
  return { onHandled, link: (id: string) => view.rerender(tree(id)) };
}

const scrollIntoView = vi.fn();
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
/** The element the landing scrolled to, last. */
const scrolledTo = () => scrollIntoView.mock.contexts.at(-1) as Element | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  if (originalScrollIntoView) {
    Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
});

describe("VoiceInputSettingsTab deep links", () => {
  it("finds paragraph breaks by search and lands on its row", async () => {
    const [top] = filterSettings(SETTINGS_SEARCH_INDEX, "paragraph breaks");
    expect(top?.tab).toBe("voice");
    const id = top?.id ?? "";
    const { load } = install();
    const { onHandled } = renderVoiceTab(id);

    await load();

    await waitFor(() => expect(onHandled).toHaveBeenCalledWith(id, true));
    expect(scrolledTo()?.textContent).toContain("Paragraph breaks");
  });

  it.each(VOICE_RESULT_IDS)("lands on %s by its id once the saved settings load", async (id) => {
    const { load } = install();
    const { onHandled } = renderVoiceTab(id);
    // Until then the page shows defaults, with voice off and its rows hidden.
    expect(onHandled).not.toHaveBeenCalled();

    await load();

    await waitFor(() => expect(onHandled).toHaveBeenCalledWith(id, true));
    expect(onHandled).toHaveBeenCalledTimes(1);
    // Landed by its own id, not by the text fallback finding a row of the same name.
    const row = document.getElementById(id);
    expect(row?.contains(scrolledTo() ?? null)).toBe(true);
  });

  it("still reports a row as hidden when the saved settings have voice off", async () => {
    const { load } = install({ enabled: false });
    const { onHandled } = renderVoiceTab("voice-provider");

    await load();

    await waitFor(() => expect(onHandled).toHaveBeenCalledWith("voice-provider", false));
    expect(onHandled).toHaveBeenCalledTimes(1);
  });

  it("lets the link go as a miss when the saved settings can't be read", async () => {
    const { fail } = install();
    const { onHandled } = renderVoiceTab("voice-provider");
    expect(onHandled).not.toHaveBeenCalled();

    await fail();

    await waitFor(() => expect(onHandled).toHaveBeenCalled());
    expect(onHandled).toHaveBeenCalledExactlyOnceWith("voice-provider", false);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("closes the dictionary page when a link lands on the voice page", async () => {
    const { load } = install();
    const { onHandled, link } = renderVoiceTab(null);
    await load();
    fireEvent.click(await screen.findByRole("button", { name: /Manage dictionary/ }));
    expect(document.getElementById("voice-language")).toBeNull();

    link("voice-language");

    await waitFor(() => expect(onHandled).toHaveBeenCalledWith("voice-language", true));
    expect(onHandled).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Manage dictionary/ })).toBeTruthy();
  });
});
