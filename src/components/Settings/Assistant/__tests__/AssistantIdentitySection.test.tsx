// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssistantIdentities,
  SetAssistantIdentityRequest,
} from "@shared/types/displayIdentity";

vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
// The picker is the emoji library's; these tests cover the row's own saves.
vi.mock("@/components/Persona/PersonaEmojiButton", () => ({
  PersonaEmojiButton: ({
    ariaLabel,
    onEmojiChange,
  }: {
    ariaLabel: string;
    onEmojiChange: (emoji: string | undefined) => void;
  }): ReactNode => (
    <button type="button" aria-label={ariaLabel} onClick={() => onEmojiChange("🐻")} />
  ),
}));

import { AssistantIdentitySection } from "../AssistantIdentitySection";
import { useAssistantIdentityStore } from "@/store/assistantIdentityStore";
import { useProjectStore } from "@/store/projectStore";
import { EMPTY_ASSISTANT_IDENTITIES } from "@shared/utils/displayIdentity";

type Resolver = (identities: AssistantIdentities) => void;
const pending: { request: SetAssistantIdentityRequest; resolve: Resolver }[] = [];
const setIdentity = vi.fn(
  (request: SetAssistantIdentityRequest) =>
    new Promise<AssistantIdentities>((resolve) => pending.push({ request, resolve }))
);

/** Answers the oldest save as main would: the global persona is what it sent. */
async function answer(): Promise<void> {
  const next = pending.shift()!;
  await act(async () => {
    next.resolve({ global: next.request.identity, projects: {} });
  });
}

function globalNameInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[placeholder="Global"]') as HTMLInputElement;
}

beforeEach(() => {
  pending.length = 0;
  setIdentity.mockClear();
  useAssistantIdentityStore.setState({ identities: EMPTY_ASSISTANT_IDENTITIES });
  useProjectStore.setState({ currentProject: null } as never);
  Object.defineProperty(window, "electron", {
    value: { helpAssistant: { setIdentity } },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
});

describe("AssistantIdentitySection (#16213)", () => {
  it("saves a typed name on Enter, once, for the scope it belongs to", async () => {
    const { container } = render(<AssistantIdentitySection />);
    const input = globalNameInput(container);
    fireEvent.change(input, { target: { value: "  Assistant to the Regional Manager " } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);

    expect(setIdentity).toHaveBeenCalledTimes(1);
    expect(setIdentity).toHaveBeenCalledWith({
      scope: { kind: "global" },
      identity: { name: "Assistant to the Regional Manager" },
    });
    await answer();
    expect(useAssistantIdentityStore.getState().identities.global.name).toBe(
      "Assistant to the Regional Manager"
    );
  });

  it("keeps a name typed while the previous one was saving", async () => {
    const { container } = render(<AssistantIdentitySection />);
    const input = globalNameInput(container);
    fireEvent.change(input, { target: { value: "Dot" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "Dwight" } });
    await answer();

    expect(globalNameInput(container).value).toBe("Dwight");
  });

  it("sends the emoji picked while a name is still saving with that name", async () => {
    const { container, getByLabelText } = render(<AssistantIdentitySection />);
    const input = globalNameInput(container);
    fireEvent.change(input, { target: { value: "Dwight" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(getByLabelText("Global assistant emoji"));

    expect(setIdentity.mock.calls.at(-1)?.[0].identity).toEqual({ name: "Dwight", emoji: "🐻" });
  });

  it("saves a name left unsaved when the page closes", () => {
    const { container, unmount } = render(<AssistantIdentitySection />);
    fireEvent.change(globalNameInput(container), { target: { value: "Dwight" } });
    unmount();

    expect(setIdentity).toHaveBeenCalledWith({
      scope: { kind: "global" },
      identity: { name: "Dwight" },
    });
  });

  it("backs out of an edit on Escape without saving it", () => {
    const { container } = render(<AssistantIdentitySection />);
    const input = globalNameInput(container);
    fireEvent.change(input, { target: { value: "Dwight" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);

    expect(globalNameInput(container).value).toBe("");
    expect(setIdentity).not.toHaveBeenCalled();
  });
});
