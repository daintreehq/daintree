// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
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
  SettingsSelect: () => null,
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
    validateApiKey: vi.fn().mockResolvedValue("idle"),
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
    });
  });
});
