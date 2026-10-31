// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostSettingKey,
  HostSettingsSnapshot,
  HostSettingsUpdatePayload,
  HostSettingsUpdateResult,
} from "@shared/types/hostSettings";
import { HostWorkSettingsPage } from "../HostWorkSettingsPage";
import { hostEnvDrafts } from "../hostEnvDrafts";

const api = {
  read: vi.fn<(payload: { hostId: string }) => Promise<HostSettingsSnapshot>>(),
  update: vi.fn<(payload: HostSettingsUpdatePayload) => Promise<HostSettingsUpdateResult>>(),
};

function snapshot(
  canopyMode = "unset",
  idle = false,
  {
    readsLocally = true,
    unavailable = [],
    env = { LANG: "C" },
  }: { readsLocally?: boolean; unavailable?: HostSettingKey[]; env?: Record<string, string> } = {}
): HostSettingsSnapshot {
  return {
    hostId: "studio-01",
    hostName: "Studio",
    scope: "host",
    instanceId: "launch-1",
    unavailable,
    settings: [
      { key: "canopyMode", value: canopyMode, revision: "3" },
      // A host from before Canopy read locally has no model to report.
      ...(readsLocally
        ? [{ key: "canopyModel" as const, value: "daintreehq/canopy-reader-17m", revision: "r-m" }]
        : []),
      { key: "agentDefaults.defaultAgent", value: "claude", revision: "r-agent" },
      { key: "agentDefaults.assistantAgentId", value: null, revision: "r-assist" },
      { key: "idleTerminalNotify.enabled", value: idle, revision: `r-idle-${idle}` },
      { key: "idleTerminalNotify.thresholdMinutes", value: 60, revision: "r-60" },
      ...(unavailable.includes("globalEnvironmentVariables")
        ? []
        : [
            {
              key: "globalEnvironmentVariables" as const,
              value: env,
              revision: "r-env",
            },
            { key: "sessionRestore.enabled" as const, value: true, revision: "r-restore" },
          ]),
    ],
  };
}

const switchNamed = (name: string) => screen.getByRole("switch", { name });

/** What a control's description says: its own error sits there, attached to it. */
const describedText = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

beforeEach(() => {
  // A test that leaves an unsaved edit would otherwise hand it to the next render.
  hostEnvDrafts.clear();
  api.read.mockReset();
  api.update.mockReset();
  api.read.mockResolvedValue(snapshot());
  Object.defineProperty(window, "electron", {
    value: { hostSettings: api },
    configurable: true,
    writable: true,
  });
});

async function renderSection(connected = true) {
  await act(async () => {
    render(
      <HostWorkSettingsPage
        hostId="studio-01"
        hostName="Studio"
        connected={connected}
        shellVersion="0.47.0"
      />
    );
  });
}

describe("HostWorkSettingsPage (#14167, #14706)", () => {
  it("reads nothing and offers no controls while the host isn't connected", async () => {
    await renderSection(false);
    expect(api.read).not.toHaveBeenCalled();
    // The page keeps its shape, with no value it hasn't read.
    expect(screen.getByText("Default agent")).toBeTruthy();
    expect(screen.getByText("Not read yet")).toBeTruthy();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("shows the host's own values, and changes one named key against the revision it showed", async () => {
    api.update.mockResolvedValue({
      hostId: "studio-01",
      hostName: "Studio",
      scope: "host",
      outcome: "applied",
      confirmedBy: "reply",
      instanceId: "launch-1",
      settings: [{ key: "idleTerminalNotify.enabled", value: true, revision: "r-idle-true" }],
    });
    await renderSection();
    expect(switchNamed("Notify me about idle terminals").getAttribute("aria-checked")).toBe(
      "false"
    );
    await act(async () => {
      fireEvent.click(switchNamed("Notify me about idle terminals"));
    });
    expect(api.update).toHaveBeenCalledWith({
      hostId: "studio-01",
      patch: { "idleTerminalNotify.enabled": true },
      expect: {
        instanceId: "launch-1",
        revisions: { "idleTerminalNotify.enabled": "r-idle-false" },
      },
    });
    expect(switchNamed("Notify me about idle terminals").getAttribute("aria-checked")).toBe("true");
  });

  it("turns Canopy on only after the consequence is stated and agreed to", async () => {
    await renderSection();
    await act(async () => {
      fireEvent.click(switchNamed("Read agent terminals"));
    });
    expect(api.update).not.toHaveBeenCalled();
    expect(screen.getByText("Turn Canopy on for 'Studio'?")).toBeTruthy();
  });

  it("keeps a hidden Canopy from being turned on until it is shown", async () => {
    api.read.mockResolvedValue(snapshot("hidden"));
    await renderSection();
    expect(switchNamed("Show Canopy").getAttribute("aria-checked")).toBe("false");
    expect(switchNamed("Read agent terminals").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Show Canopy to turn it on")).toBeTruthy();
  });

  it("offers no choice of model: there is one", async () => {
    api.read.mockResolvedValue(snapshot("on"));
    await renderSection();
    expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
  });

  it("holds an older host's Canopy off until Daintree there is updated, but lets it be turned off", async () => {
    api.read.mockResolvedValue(snapshot("unset", false, { readsLocally: false }));
    await renderSection();
    expect(switchNamed("Read agent terminals").hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("Needs Daintree 0.47.0 or later on this host to turn Canopy on")
    ).toBeTruthy();
    api.read.mockResolvedValue(snapshot("on", false, { readsLocally: false }));
    cleanup();
    await renderSection();
    expect(switchNamed("Read agent terminals").hasAttribute("disabled")).toBe(false);
  });

  it("reports a change made on the host meanwhile instead of writing over it", async () => {
    api.update.mockResolvedValue({
      hostId: "studio-01",
      hostName: "Studio",
      scope: "host",
      outcome: "conflict",
      confirmedBy: null,
      instanceId: "launch-1",
      settings: [{ key: "idleTerminalNotify.enabled", value: true, revision: "r-idle-true" }],
    });
    await renderSection();
    await act(async () => {
      fireEvent.click(switchNamed("Notify me about idle terminals"));
    });
    expect(describedText(switchNamed("Notify me about idle terminals"))).toMatch(
      /changed on Studio since it was read/
    );
    expect(switchNamed("Notify me about idle terminals").getAttribute("aria-checked")).toBe("true");
  });

  it("reads the host again when a change went unconfirmed", async () => {
    api.update.mockResolvedValue({
      hostId: "studio-01",
      hostName: "Studio",
      scope: "host",
      outcome: "unconfirmed",
      confirmedBy: null,
      instanceId: null,
      settings: [],
    });
    await renderSection();
    await act(async () => {
      fireEvent.click(switchNamed("Notify me about idle terminals"));
    });
    expect(api.read).toHaveBeenCalledTimes(2);
    expect(describedText(switchNamed("Notify me about idle terminals"))).toMatch(
      /didn't confirm the change\. Its current value is shown/
    );
  });

  it("offers a retry when the host can't be read", async () => {
    api.read.mockRejectedValueOnce(new Error("boom"));
    await renderSection();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(switchNamed("Show Canopy")).toBeTruthy();
  });

  it("holds a setting the host's Daintree lacks, naming the update it needs", async () => {
    api.read.mockResolvedValue(
      snapshot("unset", false, {
        unavailable: ["globalEnvironmentVariables", "sessionRestore.enabled"],
      })
    );
    await renderSection();
    // Named with the update it needs, and no control holding a value the host never reported.
    expect(screen.getByText("Restore live projects")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Restore live projects" })).toBeNull();
    expect(screen.getAllByText("Needs Daintree 0.47.0 or later on this host")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    // What it does know stays editable.
    expect(switchNamed("Notify me about idle terminals").hasAttribute("disabled")).toBe(false);
  });

  it("saves the host's environment as a whole, against the set it read", async () => {
    api.update.mockResolvedValue({
      hostId: "studio-01",
      hostName: "Studio",
      scope: "host",
      outcome: "applied",
      confirmedBy: "reply",
      instanceId: "launch-1",
      settings: [
        { key: "globalEnvironmentVariables", value: { LANG: "C.UTF-8" }, revision: "r-2" },
      ],
    });
    await renderSection();
    // Unavailable, not disabled: pressing Save makes the group clean, and focus has to stay.
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(screen.getByRole("textbox", { name: "Environment variable value" }), {
      target: { value: "C.UTF-8" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(api.update).toHaveBeenCalledWith({
      hostId: "studio-01",
      patch: { globalEnvironmentVariables: { LANG: "C.UTF-8" } },
      expect: { instanceId: "launch-1", revisions: { globalEnvironmentVariables: "r-env" } },
    });
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe("true");
  });
});

// Obviously fake: the shapes the shared secret test recognises, with no real key material.
const FAKE_GITHUB_PAT = `ghp_${"0".repeat(36)}`;
const FAKE_OPENAI_KEY = `sk-${"x".repeat(32)}`;

const envValueInputs = () =>
  screen.getAllByLabelText<HTMLInputElement>("Environment variable value");

describe("HostWorkSettingsPage environment masking (#15577)", () => {
  it("masks a token stored under a neutral name and leaves an ordinary value readable", async () => {
    api.read.mockResolvedValue(
      snapshot("unset", false, { env: { GITHUB_PAT: FAKE_GITHUB_PAT, TOOLS_DIR: "/usr/local/bin" } })
    );
    await renderSection();
    const [pat, tools] = envValueInputs();
    expect(pat!.type).toBe("password");
    expect(screen.getByRole("button", { name: "Show value of GITHUB_PAT" })).toBeTruthy();
    expect(tools!.type).toBe("text");
    expect(screen.queryByRole("button", { name: "Show value of TOOLS_DIR" })).toBeNull();
  });

  it("still masks a secret-sounding name whatever its value, except a ${VAR} reference", async () => {
    api.read.mockResolvedValue(
      snapshot("unset", false, { env: { API_TOKEN: "plain", GH_TOKEN: "${GITHUB_TOKEN}" } })
    );
    await renderSection();
    const [apiToken, ghToken] = envValueInputs();
    expect(apiToken!.type).toBe("password");
    expect(ghToken!.type).toBe("text");
  });

  it("masks an unrevealed row as soon as a token is pasted into its value", async () => {
    api.read.mockResolvedValue(snapshot("unset", false, { env: { OPENAI: "pending" } }));
    await renderSection();
    expect(envValueInputs()[0]!.type).toBe("text");
    fireEvent.change(envValueInputs()[0]!, { target: { value: FAKE_OPENAI_KEY } });
    expect(envValueInputs()[0]!.type).toBe("password");
    expect(screen.getByRole("button", { name: "Show value of OPENAI" })).toBeTruthy();
  });

  it("keeps a row the user revealed revealed while they edit its value", async () => {
    api.read.mockResolvedValue(snapshot("unset", false, { env: { GITHUB_PAT: FAKE_GITHUB_PAT } }));
    await renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Show value of GITHUB_PAT" }));
    expect(envValueInputs()[0]!.type).toBe("text");
    fireEvent.change(envValueInputs()[0]!, { target: { value: `${FAKE_GITHUB_PAT}1` } });
    expect(envValueInputs()[0]!.type).toBe("text");
  });
});
