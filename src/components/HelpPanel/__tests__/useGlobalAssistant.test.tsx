// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalAssistantView } from "@shared/types/ipc/help";
import { useGlobalAssistant, type GlobalAssistantHandle } from "../useGlobalAssistant";

let state: GlobalAssistantView;
let listeners: Array<(next: GlobalAssistantView) => void>;
let attached = 0;
const calls: string[] = [];

function view(overrides: Partial<GlobalAssistantView> = {}): GlobalAssistantView {
  return {
    phase: "running",
    generation: 1,
    agentId: "claude",
    terminalId: "g-1",
    attachments: [],
    inputOwner: null,
    inputEpoch: 0,
    subject: { hostId: "local", scope: { kind: "global" }, terminalId: "g-1", incarnation: 1 },
    agentState: null,
    ...overrides,
  };
}

function publish(next: GlobalAssistantView) {
  state = next;
  for (const listener of listeners) listener(state);
}

beforeEach(() => {
  state = view();
  listeners = [];
  attached = 0;
  calls.length = 0;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      help: {
        onGlobalAssistantChanged: (listener: (next: GlobalAssistantView) => void) => {
          listeners.push(listener);
          return () => {
            listeners = listeners.filter((each) => each !== listener);
          };
        },
        attachGlobalAssistant: vi.fn(async () => {
          const attachmentId = `a-${++attached}`;
          calls.push(`attach ${attachmentId}`);
          // Main hands input nobody holds to the view attaching.
          if (state.inputOwner === null) {
            state = { ...state, inputOwner: attachmentId, inputEpoch: state.inputEpoch + 1 };
          }
          return { attachmentId, state };
        }),
        detachGlobalAssistant: vi.fn(async (attachmentId: string) => {
          calls.push(`detach ${attachmentId}`);
        }),
        setGlobalAssistantInputEligible: vi.fn(async () => {}),
        claimGlobalAssistantInput: vi.fn(async (attachmentId: string) => {
          calls.push(`claim ${attachmentId}`);
          publish({ ...state, inputOwner: attachmentId, inputEpoch: state.inputEpoch + 1 });
          return state;
        }),
      },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const handles: Record<string, GlobalAssistantHandle> = {};

function Surface({ name, keepsViewInput }: { name: string; keepsViewInput: boolean }) {
  handles[name] = useGlobalAssistant(true, undefined, keepsViewInput);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useGlobalAssistant keeping input in the view (#16214)", () => {
  it("takes input the view's other surface holds, and hands it back on letting go", async () => {
    const panel = render(<Surface name="panel" keepsViewInput={false} />);
    await flush();
    expect(handles.panel!.view?.inputOwner).toBe("a-1");

    const canopy = render(<Surface name="canopy" keepsViewInput />);
    await flush();
    expect(calls).toEqual(["attach a-1", "attach a-2", "claim a-2"]);
    expect(handles.panel!.view?.inputOwner).toBe("a-2");

    canopy.unmount();
    await flush();
    // Handed back before the detach, so main has no vacancy to fill from another window.
    expect(calls.slice(3)).toEqual(["claim a-1", "detach a-2"]);
    expect(handles.panel!.view?.inputOwner).toBe("a-1");
    panel.unmount();
  });

  it("leaves input another window holds where it is, and hands back nothing it never held", async () => {
    state = view({ inputOwner: "another-window", inputEpoch: 5 });
    const canopy = render(<Surface name="canopy" keepsViewInput />);
    await flush();
    expect(handles.canopy!.view?.inputOwner).toBe("another-window");
    canopy.unmount();
    await flush();
    expect(calls).toEqual(["attach a-1", "detach a-1"]);
  });

  it("takes nothing from the view's other surface unless asked to", async () => {
    const panel = render(<Surface name="panel" keepsViewInput={false} />);
    await flush();
    const other = render(<Surface name="other" keepsViewInput={false} />);
    await flush();
    expect(calls).toEqual(["attach a-1", "attach a-2"]);
    other.unmount();
    panel.unmount();
  });
});
