// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { useHostReparent, type ReparentEditorView } from "../useHostReparent";
import { Compartment } from "@codemirror/state";

describe("useHostReparent", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ref<T>(current: T): RefObject<T> {
    return { current };
  }

  function makeMockView() {
    const dispatch = vi.fn();
    const dom = document.createElement("div");
    const scrollDOM = document.createElement("div");
    const requestMeasure = vi.fn();
    const focus = vi.fn();
    const view: ReparentEditorView = {
      dom,
      scrollDOM,
      dispatch,
      requestMeasure,
      focus,
    };

    return { view, dispatch, dom, requestMeasure, focus };
  }

  it("repairs to modal host when expanded", () => {
    const { view, dispatch } = makeMockView();
    const compactEl = document.createElement("div");
    const modalEl = document.createElement("div");
    const editorViewRef = ref<ReparentEditorView | null>(view);
    const compactHost = ref<HTMLDivElement | null>(compactEl);
    const modalHost = ref<HTMLDivElement | null>(modalEl);
    const autoSizeRef = ref(new Compartment());

    renderHook(() =>
      useHostReparent({
        editorViewRef,
        compactEditorHostRef: compactHost,
        modalEditorHostRef: modalHost,
        autoSizeCompartmentRef: autoSizeRef,
        isExpanded: true,
      })
    );

    expect(modalEl.contains(view.dom)).toBe(true);
    expect(compactEl.contains(view.dom)).toBe(false);
    expect(dispatch).toHaveBeenCalled();
  });

  it("does not focus the compact editor during initial mount", () => {
    const { view, requestMeasure, focus } = makeMockView();
    const compactEl = document.createElement("div");
    const modalEl = document.createElement("div");
    const editorViewRef = ref<ReparentEditorView | null>(view);
    const compactHost = ref<HTMLDivElement | null>(compactEl);
    const modalHost = ref<HTMLDivElement | null>(modalEl);
    const autoSizeRef = ref(new Compartment());

    renderHook(() =>
      useHostReparent({
        editorViewRef,
        compactEditorHostRef: compactHost,
        modalEditorHostRef: modalHost,
        autoSizeCompartmentRef: autoSizeRef,
        isExpanded: false,
      })
    );

    expect(compactEl.contains(view.dom)).toBe(true);
    expect(requestMeasure).toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("restores focus after an expanded/collapsed transition", () => {
    const { view, focus } = makeMockView();
    const compactEl = document.createElement("div");
    const modalEl = document.createElement("div");
    const editorViewRef = ref<ReparentEditorView | null>(view);
    const compactHost = ref<HTMLDivElement | null>(compactEl);
    const modalHost = ref<HTMLDivElement | null>(modalEl);
    const autoSizeRef = ref(new Compartment());

    const { rerender } = renderHook(
      ({ isExpanded }: { isExpanded: boolean }) =>
        useHostReparent({
          editorViewRef,
          compactEditorHostRef: compactHost,
          modalEditorHostRef: modalHost,
          autoSizeCompartmentRef: autoSizeRef,
          isExpanded,
        }),
      { initialProps: { isExpanded: false } }
    );

    expect(focus).not.toHaveBeenCalled();

    rerender({ isExpanded: true });
    expect(modalEl.contains(view.dom)).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);

    focus.mockClear();
    rerender({ isExpanded: false });
    expect(compactEl.contains(view.dom)).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("does nothing when view is null", () => {
    const compactEl = document.createElement("div");
    const modalEl = document.createElement("div");
    const editorViewRef = ref<ReparentEditorView | null>(null);
    const compactHost = ref<HTMLDivElement | null>(compactEl);
    const modalHost = ref<HTMLDivElement | null>(modalEl);
    const autoSizeRef = ref(new Compartment());

    renderHook(() =>
      useHostReparent({
        editorViewRef,
        compactEditorHostRef: compactHost,
        modalEditorHostRef: modalHost,
        autoSizeCompartmentRef: autoSizeRef,
        isExpanded: true,
      })
    );

    expect(compactEl.children.length).toBe(0);
    expect(modalEl.children.length).toBe(0);
  });
});
