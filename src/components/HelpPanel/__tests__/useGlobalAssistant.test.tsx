// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalAssistantView } from "@shared/types/ipc/help";
import { useGlobalAssistant, type GlobalAssistantHandle } from "../useGlobalAssistant";

/**
 * Main's input ownership as GlobalAssistantService keeps it, for this one
 * view plus another window's attachment: a vacancy goes to an attachment that
 * can type, and a claim naming `from` moves input only while `from` holds it.
 */
const main = {
  owner: null as string | null,
  epoch: 0,
  eligible: new Map<string, boolean>(),
  /** Attachments of another window: never this view's to hand around. */
  foreign: new Set<string>(),
  calls: [] as string[],
  /**
   * While set, main takes each claim as it arrives but its answer, and the
   * news of it, are held back until the test lets them through.
   */
  held: null as Array<() => void> | null,
};
let listeners: Array<(next: GlobalAssistantView) => void> = [];
let attached = 0;

function state(): GlobalAssistantView {
  return {
    phase: "running",
    generation: 1,
    agentId: "claude",
    terminalId: "g-1",
    attachments: [],
    inputOwner: main.owner,
    inputEpoch: main.epoch,
    subject: { hostId: "local", scope: { kind: "global" }, terminalId: "g-1", incarnation: 1 },
    agentState: null,
  };
}

function setOwner(owner: string | null, tell = true) {
  main.owner = owner;
  main.epoch += 1;
  if (!tell) return;
  const next = state();
  for (const listener of listeners) listener(next);
}

function successor(): string | null {
  return [...main.eligible].reverse().find(([, eligible]) => eligible)?.[0] ?? null;
}

function claim(attachmentId: string, from?: string) {
  main.calls.push(
    from === undefined ? `claim ${attachmentId}` : `claim ${attachmentId} from ${from}`
  );
  if (from !== undefined && (main.owner !== from || main.foreign.has(from))) return;
  setOwner(attachmentId, main.held === null);
}

beforeEach(() => {
  main.owner = null;
  main.epoch = 0;
  main.eligible.clear();
  main.foreign.clear();
  main.calls.length = 0;
  main.held = null;
  listeners = [];
  attached = 0;
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
        attachGlobalAssistant: vi.fn(async (eligible: boolean) => {
          const attachmentId = `a-${++attached}`;
          main.calls.push(`attach ${attachmentId}`);
          main.eligible.set(attachmentId, eligible);
          if (main.owner === null && eligible) setOwner(attachmentId);
          return { attachmentId, state: state() };
        }),
        detachGlobalAssistant: vi.fn(async (attachmentId: string) => {
          main.calls.push(`detach ${attachmentId}`);
          main.eligible.delete(attachmentId);
          if (main.owner === attachmentId) setOwner(successor());
        }),
        setGlobalAssistantInputEligible: vi.fn(async (attachmentId: string, eligible: boolean) => {
          main.eligible.set(attachmentId, eligible);
          if (eligible && main.owner === null) setOwner(attachmentId);
        }),
        claimGlobalAssistantInput: vi.fn(async (attachmentId: string, from?: string) => {
          claim(attachmentId, from);
          const held = main.held;
          if (held) await new Promise<void>((resolve) => held.push(resolve));
          return state();
        }),
      },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const handles: Record<string, GlobalAssistantHandle> = {};

/** A surface of this view: the Assistant panel (covered, so it can't type) or Canopy. */
function Surface({
  name,
  keepsViewInput,
  canType = true,
}: {
  name: string;
  keepsViewInput: boolean;
  canType?: boolean;
}) {
  const handle = useGlobalAssistant(true, () => canType, keepsViewInput);
  useEffect(() => {
    handles[name] = handle;
  });
  return null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

describe("useGlobalAssistant keeping input in the view (#16214)", () => {
  it("takes input the covered panel holds, and hands it back on letting go", async () => {
    const panel = render(<Surface name="panel" keepsViewInput={false} />);
    await flush();
    expect(main.owner).toBe("a-1");
    // Canopy opens over it: the panel can't type, and stays attached.
    panel.rerender(<Surface name="panel" keepsViewInput={false} canType={false} />);
    await flush();

    const canopy = render(<Surface name="canopy" keepsViewInput />);
    await flush();
    expect(main.calls).toEqual(["attach a-1", "attach a-2", "claim a-2 from a-1"]);
    expect(main.owner).toBe("a-2");
    expect(handles.canopy!.view?.inputOwner).toBe("a-2");

    canopy.unmount();
    await flush();
    // Back to the panel before the detach, so no vacancy reaches another window.
    expect(main.calls.slice(3)).toEqual(["claim a-1 from a-2", "detach a-2"]);
    expect(main.owner).toBe("a-1");
    panel.unmount();
  });

  it("hands back a take still on its way when it lets go", async () => {
    const panel = render(<Surface name="panel" keepsViewInput={false} canType={false} />);
    await flush();
    act(() => setOwner("a-1"));
    main.held = [];
    const canopy = render(<Surface name="canopy" keepsViewInput />);
    await flush();
    // Main took it, but this view hasn't heard so when it goes.
    expect(main.owner).toBe("a-2");
    expect(handles.canopy!.view?.inputOwner).toBe("a-1");
    canopy.unmount();
    await flush();
    const held = main.held;
    main.held = null;
    for (const release of held) release();
    await flush();
    expect(main.calls.slice(1)).toEqual([
      "attach a-2",
      "claim a-2 from a-1",
      "claim a-1 from a-2",
      "detach a-2",
    ]);
    expect(main.owner).toBe("a-1");
    panel.unmount();
  });

  it("never takes input back from a window that claimed it meanwhile", async () => {
    const panel = render(<Surface name="panel" keepsViewInput={false} canType={false} />);
    await flush();
    act(() => setOwner("a-1"));
    const canopy = render(<Surface name="canopy" keepsViewInput />);
    await flush();
    expect(main.owner).toBe("a-2");
    // Another window asks for it.
    main.foreign.add("w-9");
    act(() => setOwner("w-9"));
    canopy.unmount();
    await flush();
    expect(main.owner).toBe("w-9");
    panel.unmount();
  });

  it("leaves input another window holds where it is, and has nothing to hand back", async () => {
    main.foreign.add("w-9");
    main.owner = "w-9";
    const canopy = render(<Surface name="canopy" keepsViewInput />);
    await flush();
    expect(handles.canopy!.view?.inputOwner).toBe("w-9");
    canopy.unmount();
    await flush();
    expect(main.calls).toEqual(["attach a-1", "detach a-1"]);
  });

  it("hands back nothing it didn't take from this view", async () => {
    const panel = render(<Surface name="panel" keepsViewInput={false} canType={false} />);
    await flush();
    // Nobody held it; Canopy, the one that can type, was handed it by main.
    const canopy = render(<Surface name="canopy" keepsViewInput />);
    await flush();
    expect(main.owner).toBe("a-2");
    canopy.unmount();
    await flush();
    expect(main.calls).toEqual(["attach a-1", "attach a-2", "detach a-2"]);
    panel.unmount();
  });

  it("takes nothing from the view's other surface unless asked to", async () => {
    const panel = render(<Surface name="panel" keepsViewInput={false} />);
    await flush();
    const other = render(<Surface name="other" keepsViewInput={false} />);
    await flush();
    expect(main.calls).toEqual(["attach a-1", "attach a-2"]);
    other.unmount();
    panel.unmount();
  });
});
