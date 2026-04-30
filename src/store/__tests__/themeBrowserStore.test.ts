// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useThemeBrowserStore } from "../themeBrowserStore";

describe("themeBrowserStore", () => {
  beforeEach(() => {
    useThemeBrowserStore.setState({ isOpen: false });
  });

  it("starts closed", () => {
    expect(useThemeBrowserStore.getState().isOpen).toBe(false);
  });

  it("open() sets isOpen to true", () => {
    useThemeBrowserStore.getState().open();
    expect(useThemeBrowserStore.getState().isOpen).toBe(true);
  });

  it("close() sets isOpen to false", () => {
    useThemeBrowserStore.setState({ isOpen: true });
    useThemeBrowserStore.getState().close();
    expect(useThemeBrowserStore.getState().isOpen).toBe(false);
  });

  it("open() is idempotent when already open", () => {
    useThemeBrowserStore.getState().open();
    useThemeBrowserStore.getState().open();
    expect(useThemeBrowserStore.getState().isOpen).toBe(true);
  });

  it("close() is idempotent when already closed", () => {
    useThemeBrowserStore.getState().close();
    expect(useThemeBrowserStore.getState().isOpen).toBe(false);
  });
});
