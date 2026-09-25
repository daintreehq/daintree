import { describe, expect, it } from "vitest";
import { CHANNELS } from "../channels.js";
import { CHANNEL_LOCALITY, getChannelLocality } from "../channelLocality.js";

describe("channel locality", () => {
  it("classifies every CHANNELS entry", () => {
    for (const ch of Object.values(CHANNELS)) {
      expect(getChannelLocality(ch), ch).not.toBeNull();
    }
    expect(Object.keys(CHANNEL_LOCALITY).length).toBe(new Set(Object.values(CHANNELS)).size);
  });

  it("keeps the work on the host and the screen on the shell", () => {
    expect(getChannelLocality(CHANNELS.TERMINAL_SPAWN)).toBe("host");
    expect(getChannelLocality(CHANNELS.WORKTREE_CREATE)).toBe("host");
    expect(getChannelLocality("app-theme:get")).toBe("shell");
    expect(getChannelLocality("keybinding:get-overrides")).toBe("shell");
  });

  it("marks the known mixed channels hybrid", () => {
    for (const ch of [
      "app:hydrate",
      "app:boot",
      "events:push",
      "project:switch",
      "clipboard:save-image",
      "notification:update",
    ]) {
      expect(getChannelLocality(ch), ch).toBe("hybrid");
    }
  });

  it("classifies namespace prefixes, bus events and dynamic plugin channels", () => {
    expect(getChannelLocality("remote-hosts:list")).toBe("shell");
    expect(getChannelLocality("operations:get-status")).toBe("host");
    expect(getChannelLocality("agent:state-changed")).toBe("host");
    expect(getChannelLocality("window:reclaim-memory")).toBe("shell");
    expect(getChannelLocality("plugin:acme.linear:issues-updated")).toBe("host");
  });

  it("has no default: an unknown channel is unclassified", () => {
    expect(getChannelLocality("made-up:channel")).toBeNull();
    for (const inherited of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(getChannelLocality(inherited)).toBeNull();
    }
  });
});
