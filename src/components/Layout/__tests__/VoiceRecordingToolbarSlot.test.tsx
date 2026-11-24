// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";

// The button the slot loads: counts its module's evaluations and can hold
// them back, so a case sees the slot before the chunk lands.
const button = vi.hoisted(() => ({
  imports: 0,
  gate: null as Promise<void> | null,
  props: [] as Array<{ "data-toolbar-item"?: string }>,
}));

async function renderSlot(state: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock("../VoiceRecordingToolbarButton", async () => {
    button.imports++;
    if (button.gate) await button.gate;
    return {
      VoiceRecordingToolbarButton: (props: { "data-toolbar-item"?: string }) => {
        button.props.push(props);
        return <button data-testid="voice-button" />;
      },
    };
  });
  const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
  const { VoiceRecordingToolbarSlot } = await import("../VoiceRecordingToolbarSlot");
  useVoiceRecordingStore.setState(state);
  return render(<VoiceRecordingToolbarSlot data-toolbar-item="" />);
}

function expectPlaceholder(container: HTMLElement) {
  const slot = container.firstElementChild;
  expect(slot?.getAttribute("aria-hidden")).toBe("true");
  expect(slot?.hasAttribute("data-toolbar-item")).toBe(false);
}

afterEach(cleanup);

beforeEach(() => {
  button.imports = 0;
  button.gate = null;
  button.props.length = 0;
});

describe("VoiceRecordingToolbarSlot (#17031)", () => {
  it("holds the slot with the placeholder alone while dictation is off and idle", async () => {
    const { container } = await renderSlot({});
    await act(async () => {});

    expectPlaceholder(container);
    expect(button.imports).toBe(0);
  });

  it.each([
    ["dictation configured", { isConfigured: true }],
    ["a session here", { activeTarget: { panelId: "p-1" } }],
    ["a queued start", { pendingTarget: { panelId: "p-1" } }],
    ["a lock", { lockedTarget: { panelId: "p-1" } }],
    [
      "another view's session",
      {
        sessionElsewhere: {
          sessionId: "s1",
          hostId: LOCAL_HOST_ID,
          projectId: null,
          projectName: null,
          details: null,
        },
      },
    ],
  ])("loads the button for %s, passing it the toolbar item", async (_why, state) => {
    const { findByTestId } = await renderSlot(state);

    await findByTestId("voice-button");
    expect(button.imports).toBe(1);
    expect(button.props.at(-1)).toEqual({ "data-toolbar-item": "" });
  });

  it("keeps the placeholder's footprint while the button's chunk is on its way", async () => {
    let land!: () => void;
    button.gate = new Promise((resolve) => (land = resolve));
    const { container, findByTestId } = await renderSlot({ isConfigured: true });
    await act(async () => {});

    expectPlaceholder(container);

    land();
    await findByTestId("voice-button");
  });
});
