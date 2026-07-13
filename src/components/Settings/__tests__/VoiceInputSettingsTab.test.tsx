// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { VoiceInputSettingsTab } from "../VoiceInputSettingsTab";

const mockNotify = vi.fn();
vi.mock("@/lib/notify", () => ({ notify: (...args: unknown[]) => mockNotify(...args) }));

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

vi.mock("@/lib/voiceInputSettingsEvents", () => ({
  dispatchVoiceInputSettingsChanged: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));

vi.mock("@/components/ui/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));

vi.mock("../SettingsSection", () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../SettingsSwitchCard", () => ({
  SettingsSwitchCard: () => null,
}));

vi.mock("../SettingsSelect", () => ({
  SettingsSelect: ({
    label,
    value,
    onValueChange,
    options,
  }: {
    label: string;
    value: string;
    onValueChange: (v: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <div data-testid={`settings-select-${label}`}>
      <span data-testid={`settings-select-value-${label}`}>{value}</span>
      {options.map((opt) => (
        <button
          key={opt.value}
          data-testid={`settings-select-option-${label}-${opt.value}`}
          onClick={() => onValueChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("../SettingsTextarea", () => ({
  SettingsTextarea: () => null,
}));

vi.mock("../SettingsLoadErrorBanner", () => ({
  SettingsLoadErrorBanner: () => null,
}));

vi.mock("../SettingsValidationRegistry", () => ({
  useSettingsTabValidation: vi.fn(),
}));

vi.mock("@/hooks/useAudioDevices", () => ({
  useAudioDevices: () => ({
    devices: [{ value: "__system_default__", label: "System default" }],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
  SYSTEM_DEFAULT_VALUE: "__system_default__",
}));

vi.mock("@/hooks", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");
  return {
    useTabLoad: ({ initialize }: { initialize: () => Promise<unknown> }) => {
      useEffect(() => {
        initialize();
      }, []);
      return {
        isLoading: false,
        loadError: null,
        retryAction: vi.fn(),
      };
    },
  };
});

function createVoiceInputApi(overrides: Partial<typeof window.electron.voiceInput> = {}) {
  return {
    getSettings: vi.fn().mockResolvedValue({
      enabled: false,
      openaiApiKey: "",
      language: "en",
      customDictionary: [],
      transcriptionModel: "gpt-realtime-whisper",
      correctionEnabled: false,
      correctionModel: "gpt-5-mini",
      correctionCustomInstructions: "",
      paragraphingStrategy: "spoken-command",
      resolveFileLinks: true,
      deviceId: "",
    }),
    setSettings: vi.fn().mockResolvedValue(undefined),
    checkMicPermission: vi.fn().mockResolvedValue("unknown"),
    requestMicPermission: vi.fn().mockResolvedValue(undefined),
    openMicSettings: vi.fn(),
    validateApiKey: vi.fn().mockResolvedValue({ valid: true }),
    ...overrides,
  };
}

describe("VoiceInputSettingsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.electron = {
      voiceInput: createVoiceInputApi(),
    } as unknown as typeof window.electron;
  });

  it("does not render data-flow disclosure when voice is disabled", async () => {
    window.electron = {
      voiceInput: createVoiceInputApi({
        getSettings: vi.fn().mockResolvedValue({
          enabled: false,
          openaiApiKey: "",
          language: "en",
          customDictionary: [],
          transcriptionModel: "gpt-realtime-whisper",
          correctionEnabled: false,
          correctionModel: "gpt-5-mini",
          correctionCustomInstructions: "",
          paragraphingStrategy: "spoken-command",
          resolveFileLinks: true,
          deviceId: "",
        }),
      }),
    } as unknown as typeof window.electron;

    render(<VoiceInputSettingsTab />);

    await waitFor(() => {
      expect(screen.queryByText(/encrypted connection/)).toBeNull();
      expect(screen.queryByText(/model training/)).toBeNull();
    });
  });

  it("renders data-flow disclosure when voice is enabled", async () => {
    window.electron = {
      voiceInput: createVoiceInputApi({
        getSettings: vi.fn().mockResolvedValue({
          enabled: true,
          openaiApiKey: "sk-test",
          language: "en",
          customDictionary: [],
          transcriptionModel: "gpt-realtime-whisper",
          correctionEnabled: false,
          correctionModel: "gpt-5-mini",
          correctionCustomInstructions: "",
          paragraphingStrategy: "spoken-command",
          resolveFileLinks: true,
          deviceId: "",
        }),
      }),
    } as unknown as typeof window.electron;

    render(<VoiceInputSettingsTab />);

    await waitFor(() => {
      expect(screen.getByText(/encrypted connection to OpenAI/)).toBeTruthy();
      expect(screen.getByText(/not used for model training/)).toBeTruthy();
      expect(screen.getByText(/abuse-monitoring logs for up to 30 days/)).toBeTruthy();
      expect(screen.getByText(/stored locally in plain text/)).toBeTruthy();
    });
  });

  it("renders the recording-mode row with the stored value when voice is enabled", async () => {
    window.electron = {
      voiceInput: createVoiceInputApi({
        getSettings: vi.fn().mockResolvedValue({
          enabled: true,
          openaiApiKey: "sk-test",
          language: "en",
          customDictionary: [],
          transcriptionModel: "gpt-realtime-whisper",
          correctionEnabled: false,
          correctionModel: "gpt-5-mini",
          correctionCustomInstructions: "",
          paragraphingStrategy: "spoken-command",
          resolveFileLinks: true,
          deviceId: "",
          recordingMode: "push-to-talk",
        }),
      }),
    } as unknown as typeof window.electron;

    render(<VoiceInputSettingsTab />);

    await waitFor(() => {
      expect(screen.getByTestId("settings-select-value-Recording mode").textContent).toBe(
        "push-to-talk"
      );
    });
  });

  it("saves the new recording mode when the user picks 'Push to talk'", async () => {
    const setSettings = vi.fn().mockResolvedValue(undefined);
    window.electron = {
      voiceInput: createVoiceInputApi({
        getSettings: vi.fn().mockResolvedValue({
          enabled: true,
          openaiApiKey: "sk-test",
          language: "en",
          customDictionary: [],
          transcriptionModel: "gpt-realtime-whisper",
          correctionEnabled: false,
          correctionModel: "gpt-5-mini",
          correctionCustomInstructions: "",
          paragraphingStrategy: "spoken-command",
          resolveFileLinks: true,
          deviceId: "",
          recordingMode: "toggle",
        }),
        setSettings,
      }),
    } as unknown as typeof window.electron;

    render(<VoiceInputSettingsTab />);

    const pttButton = await screen.findByTestId(
      "settings-select-option-Recording mode-push-to-talk"
    );
    pttButton.click();

    await waitFor(() => {
      expect(setSettings).toHaveBeenCalledWith({ recordingMode: "push-to-talk" });
    });
  });

  it("renders data-flow disclosure even when API key is empty", async () => {
    window.electron = {
      voiceInput: createVoiceInputApi({
        getSettings: vi.fn().mockResolvedValue({
          enabled: true,
          openaiApiKey: "",
          language: "en",
          customDictionary: [],
          transcriptionModel: "gpt-realtime-whisper",
          correctionEnabled: false,
          correctionModel: "gpt-5-mini",
          correctionCustomInstructions: "",
          paragraphingStrategy: "spoken-command",
          resolveFileLinks: true,
          deviceId: "",
        }),
      }),
    } as unknown as typeof window.electron;

    render(<VoiceInputSettingsTab />);

    await waitFor(() => {
      expect(screen.getByText(/encrypted connection to OpenAI/)).toBeTruthy();
      expect(screen.getByText(/not used for model training/)).toBeTruthy();
      expect(screen.getByText(/abuse-monitoring logs for up to 30 days/)).toBeTruthy();
      expect(screen.queryByText(/stored locally in plain text/)).toBeNull();
    });
  });

  describe("microphone permission request on Windows", () => {
    const originalNavigator = globalThis.navigator;

    const stubWindowsNavigator = (getUserMedia: ReturnType<typeof vi.fn>) => {
      Object.defineProperty(globalThis, "navigator", {
        value: {
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          mediaDevices: { getUserMedia },
        },
        writable: true,
        configurable: true,
      });
    };

    const renderWithMic = async (api: Partial<typeof window.electron.voiceInput>) => {
      window.electron = {
        voiceInput: createVoiceInputApi({
          getSettings: vi.fn().mockResolvedValue({
            enabled: true,
            openaiApiKey: "sk-test",
            language: "en",
            customDictionary: [],
            transcriptionModel: "gpt-realtime-whisper",
            correctionEnabled: false,
            correctionModel: "gpt-5-mini",
            correctionCustomInstructions: "",
            paragraphingStrategy: "spoken-command",
            resolveFileLinks: true,
            deviceId: "",
          }),
          ...api,
        }),
      } as unknown as typeof window.electron;

      render(<VoiceInputSettingsTab />);
      const button = await screen.findByRole("button", { name: /Request/ });
      fireEvent.click(button);
    };

    afterEach(() => {
      Object.defineProperty(globalThis, "navigator", {
        value: originalNavigator,
        writable: true,
        configurable: true,
      });
    });

    it("reaches getUserMedia, since Windows has no native request API", async () => {
      // The preflight only clears the way on Windows — without this capture
      // attempt the Request button can never actually prompt for the mic.
      const track = { stop: vi.fn() };
      const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [track] });
      stubWindowsNavigator(getUserMedia);

      const requestMicPermission = vi.fn().mockResolvedValue(true);
      await renderWithMic({
        requestMicPermission,
        checkMicPermission: vi.fn().mockResolvedValue("not-determined"),
      });

      await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
      expect(requestMicPermission).toHaveBeenCalledTimes(1);
      // The probe must never hold the mic open past the request.
      expect(track.stop).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.getByText(/access granted/)).toBeTruthy());
    });

    it("reports a denial when the capture attempt is refused", async () => {
      const getUserMedia = vi
        .fn()
        .mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));
      stubWindowsNavigator(getUserMedia);

      await renderWithMic({
        requestMicPermission: vi.fn().mockResolvedValue(true),
        checkMicPermission: vi.fn().mockResolvedValue("not-determined"),
      });

      await waitFor(() => expect(screen.getByText(/Microphone denied/)).toBeTruthy());
    });

    it("skips capture when the native preflight denies, as it does on macOS", async () => {
      const getUserMedia = vi.fn();
      stubWindowsNavigator(getUserMedia);

      await renderWithMic({
        requestMicPermission: vi.fn().mockResolvedValue(false),
        // not-determined on mount is what surfaces the Request button at all; the
        // native prompt settles it to denied by the time the handler re-checks.
        checkMicPermission: vi
          .fn()
          .mockResolvedValueOnce("not-determined")
          .mockResolvedValue("denied"),
      });

      await waitFor(() => expect(screen.getByText(/Microphone denied/)).toBeTruthy());
      expect(getUserMedia).not.toHaveBeenCalled();
    });
  });
});
