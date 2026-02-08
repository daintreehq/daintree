import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmojiPicker } from "../emoji-picker";

type RootProps = {
  emojibaseUrl?: string;
  onEmojiSelect?: (emoji: { emoji: string; label: string }) => void;
};

type EmojiRenderer = (props: {
  emoji: {
    emoji: string;
    label: string;
    isActive: boolean;
  };
}) => {
  type: unknown;
  props: Record<string, unknown>;
};

const frimousseMockState = vi.hoisted(() => ({
  rootProps: null as RootProps | null,
  listComponents: null as { Emoji?: EmojiRenderer } | null,
}));

vi.mock("frimousse", () => ({
  EmojiPicker: {
    Root: (props: RootProps & { children?: unknown }) => {
      frimousseMockState.rootProps = props;
      return props.children ?? null;
    },
    Search: () => null,
    Viewport: ({ children }: { children?: unknown }) => children ?? null,
    Loading: () => null,
    Empty: () => null,
    List: (props: { components?: { Emoji?: EmojiRenderer } }) => {
      frimousseMockState.listComponents = props.components ?? null;
      return null;
    },
    ActiveEmoji: () => null,
  },
}));

describe("EmojiPicker", () => {
  beforeEach(() => {
    frimousseMockState.rootProps = null;
    frimousseMockState.listComponents = null;
  });

  it("passes root selection callback and emojibase URL", () => {
    const onEmojiSelect = vi.fn();

    renderToStaticMarkup(<EmojiPicker onEmojiSelect={onEmojiSelect} />);

    expect(frimousseMockState.rootProps?.emojibaseUrl).toBe("/emojibase");

    const selectedEmoji = { emoji: "😀", label: "grinning face" };
    frimousseMockState.rootProps?.onEmojiSelect?.(selectedEmoji);

    expect(onEmojiSelect).toHaveBeenCalledWith(selectedEmoji);
  });

  it("renders emoji options as button elements", () => {
    renderToStaticMarkup(<EmojiPicker onEmojiSelect={vi.fn()} />);

    const emojiRenderer = frimousseMockState.listComponents?.Emoji;
    expect(emojiRenderer).toBeTypeOf("function");
    if (!emojiRenderer) {
      throw new Error("Expected Emoji renderer to be provided");
    }

    const element = emojiRenderer({
      emoji: {
        emoji: "🌲",
        label: "evergreen tree",
        isActive: false,
      },
    });

    expect(element.type).toBe("button");
    expect(element.props.type).toBe("button");
  });
});
