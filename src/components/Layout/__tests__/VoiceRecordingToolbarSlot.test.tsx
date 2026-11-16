// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

const button = vi.hoisted(() => ({ imports: 0, props: [] as Array<Record<string, unknown>> }));
vi.mock("../VoiceRecordingToolbarButton", () => {
  button.imports++;
  return {
    VoiceRecordingToolbarButton: (props: Record<string, unknown>) => {
      button.props.push(props);
      return <button data-testid="voice-button" />;
    },
  };
});

import { VoiceRecordingToolbarSlot } from "../VoiceRecordingToolbarSlot";

const IDLE = {
  isConfigured: false,
  activeTarget: null,
  pendingTarget: null,
  lockedTarget: null,
  sessionElsewhere: null,
};

beforeEach(() => {
  useVoiceRecordingStore.setState(IDLE);
  button.props.length = 0;
});

afterEach(() => {
  useVoiceRecordingStore.setState(IDLE);
});

describe("VoiceRecordingToolbarSlot (#17031)", () => {
  it("holds the slot with the placeholder alone while dictation is off and idle", async () => {
    const { container } = render(<VoiceRecordingToolbarSlot data-toolbar-item="" />);
    await act(async () => {});

    expect(button.imports).toBe(0);
    const placeholder = container.firstElementChild as HTMLElement;
    expect(placeholder.getAttribute("aria-hidden")).toBe("true");
    expect(placeholder.hasAttribute("data-toolbar-item")).toBe(false);
  });

  it.each([
    ["dictation configured", { isConfigured: true }],
    ["a lock", { lockedTarget: { panelId: "p-1" } }],
    ["another view's session", { sessionElsewhere: { sessionId: "s1" } }],
    ["a queued start", { pendingTarget: { panelId: "p-1" } }],
  ])("loads the button for %s, passing it the toolbar item", async (_why, state) => {
    useVoiceRecordingStore.setState(
      state as Partial<ReturnType<typeof useVoiceRecordingStore.getState>>
    );
    const { findByTestId } = render(<VoiceRecordingToolbarSlot data-toolbar-item="" />);

    await findByTestId("voice-button");
    await waitFor(() => expect(button.props.at(-1)).toEqual({ "data-toolbar-item": "" }));
  });
});
