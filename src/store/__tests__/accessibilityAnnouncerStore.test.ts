import { describe, it, expect, beforeEach } from "vitest";
import { useAnnouncerStore } from "../accessibilityAnnouncerStore";

describe("accessibilityAnnouncerStore", () => {
  beforeEach(() => {
    useAnnouncerStore.setState({ polite: null, assertive: null });
  });

  it("starts with null polite and assertive", () => {
    const state = useAnnouncerStore.getState();
    expect(state.polite).toBeNull();
    expect(state.assertive).toBeNull();
  });

  it("announce sets polite by default", () => {
    useAnnouncerStore.getState().announce("hello");
    const state = useAnnouncerStore.getState();
    expect(state.polite?.msg).toBe("hello");
    expect(state.assertive).toBeNull();
  });

  it("announce with assertive priority sets assertive", () => {
    useAnnouncerStore.getState().announce("error!", "assertive");
    const state = useAnnouncerStore.getState();
    expect(state.assertive?.msg).toBe("error!");
    expect(state.polite).toBeNull();
  });

  it("increments ID on each call so duplicate text produces different IDs", () => {
    useAnnouncerStore.getState().announce("same text");
    const id1 = useAnnouncerStore.getState().polite?.id;
    useAnnouncerStore.getState().announce("same text");
    const id2 = useAnnouncerStore.getState().polite?.id;
    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id2).not.toBe(id1);
  });

  it("polite and assertive are independent channels", () => {
    useAnnouncerStore.getState().announce("info");
    useAnnouncerStore.getState().announce("critical", "assertive");
    const state = useAnnouncerStore.getState();
    expect(state.polite?.msg).toBe("info");
    expect(state.assertive?.msg).toBe("critical");
  });
});
