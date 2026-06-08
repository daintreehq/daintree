// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, render } from "@testing-library/react";
import { StrictMode, useContext, type ReactNode } from "react";
import {
  SettingsValidationProvider,
  useSettingsTabValidation,
  SettingsValidationContext,
} from "../SettingsValidationRegistry";
import type { SettingsTab } from "../SettingsDialog";

function wrap({ children }: { children: ReactNode }) {
  return <SettingsValidationProvider>{children}</SettingsValidationProvider>;
}

function Publisher({ tab, hasError }: { tab: SettingsTab; hasError: boolean }) {
  useSettingsTabValidation(tab, hasError);
  return null;
}

function Probe({ onSnapshot }: { onSnapshot: (tabs: ReadonlySet<SettingsTab>) => void }) {
  const ctx = useContext(SettingsValidationContext);
  onSnapshot(ctx!.tabsWithErrors);
  return null;
}

interface HarnessProps {
  parentMounted: boolean;
  parentHasError: boolean;
  childMounted: boolean;
  childHasError: boolean;
  onSnapshot: (tabs: ReadonlySet<SettingsTab>) => void;
  strict?: boolean;
}

function Harness({
  parentMounted,
  parentHasError,
  childMounted,
  childHasError,
  onSnapshot,
  strict,
}: HarnessProps) {
  const tree = (
    <SettingsValidationProvider>
      {parentMounted && <Publisher tab="code-forge" hasError={parentHasError} />}
      {childMounted && <Publisher tab="code-forge" hasError={childHasError} />}
      <Probe onSnapshot={onSnapshot} />
    </SettingsValidationProvider>
  );
  return strict ? <StrictMode>{tree}</StrictMode> : tree;
}

describe("SettingsValidationRegistry", () => {
  it("keeps the tab in error when one of two publishers reports no error", () => {
    const { result } = renderHook(
      () => {
        useSettingsTabValidation("code-forge", true);
        useSettingsTabValidation("code-forge", false);
        return useContext(SettingsValidationContext);
      },
      { wrapper: wrap }
    );

    expect(result.current!.tabsWithErrors.has("code-forge")).toBe(true);
  });

  it("keeps the tab in error when both publishers report errors", () => {
    const { result } = renderHook(
      () => {
        useSettingsTabValidation("code-forge", true);
        useSettingsTabValidation("code-forge", true);
        return useContext(SettingsValidationContext);
      },
      { wrapper: wrap }
    );

    expect(result.current!.tabsWithErrors.has("code-forge")).toBe(true);
  });

  it("keeps the parent's error when the child publisher unmounts", () => {
    let tabs: ReadonlySet<SettingsTab> = new Set();
    const onSnapshot = (next: ReadonlySet<SettingsTab>) => {
      tabs = next;
    };

    const { rerender } = render(
      <Harness
        parentMounted
        parentHasError
        childMounted
        childHasError={false}
        onSnapshot={onSnapshot}
      />
    );
    expect(tabs.has("code-forge")).toBe(true);

    rerender(
      <Harness
        parentMounted
        parentHasError
        childMounted={false}
        childHasError={false}
        onSnapshot={onSnapshot}
      />
    );
    expect(tabs.has("code-forge")).toBe(true);
  });

  it("keeps the tab in error when an errored child unmounts while the parent is errored", () => {
    let tabs: ReadonlySet<SettingsTab> = new Set();
    const onSnapshot = (next: ReadonlySet<SettingsTab>) => {
      tabs = next;
    };

    const { rerender } = render(
      <Harness parentMounted parentHasError childMounted childHasError onSnapshot={onSnapshot} />
    );
    expect(tabs.has("code-forge")).toBe(true);

    rerender(
      <Harness
        parentMounted
        parentHasError
        childMounted={false}
        childHasError
        onSnapshot={onSnapshot}
      />
    );
    expect(tabs.has("code-forge")).toBe(true);
  });

  it("keeps the tab in error when one publisher toggles to false while another stays errored", () => {
    let tabs: ReadonlySet<SettingsTab> = new Set();
    const onSnapshot = (next: ReadonlySet<SettingsTab>) => {
      tabs = next;
    };

    const { rerender } = render(
      <Harness parentMounted parentHasError childMounted childHasError onSnapshot={onSnapshot} />
    );
    expect(tabs.has("code-forge")).toBe(true);

    rerender(
      <Harness
        parentMounted
        parentHasError
        childMounted
        childHasError={false}
        onSnapshot={onSnapshot}
      />
    );
    expect(tabs.has("code-forge")).toBe(true);
  });

  it("moves the error to the new tab when a publisher's tab changes", () => {
    const { result, rerender } = renderHook(
      ({ tab }: { tab: SettingsTab }) => {
        useSettingsTabValidation(tab, true);
        return useContext(SettingsValidationContext);
      },
      { wrapper: wrap, initialProps: { tab: "code-forge" as SettingsTab } }
    );

    expect(result.current!.tabsWithErrors.has("code-forge")).toBe(true);

    rerender({ tab: "portal" });
    expect(result.current!.tabsWithErrors.has("code-forge")).toBe(false);
    expect(result.current!.tabsWithErrors.has("portal")).toBe(true);
  });

  it("clearing one tab's publishers leaves other tabs untouched", () => {
    const { result, rerender } = renderHook(
      ({ codeForgeHasError }: { codeForgeHasError: boolean }) => {
        useSettingsTabValidation("code-forge", codeForgeHasError);
        useSettingsTabValidation("portal", true);
        return useContext(SettingsValidationContext);
      },
      { wrapper: wrap, initialProps: { codeForgeHasError: true } }
    );

    expect(result.current!.tabsWithErrors.has("code-forge")).toBe(true);
    expect(result.current!.tabsWithErrors.has("portal")).toBe(true);

    rerender({ codeForgeHasError: false });
    expect(result.current!.tabsWithErrors.has("code-forge")).toBe(false);
    expect(result.current!.tabsWithErrors.has("portal")).toBe(true);
  });

  it("clears the tab once every publisher unmounts", () => {
    let tabs: ReadonlySet<SettingsTab> = new Set();
    const onSnapshot = (next: ReadonlySet<SettingsTab>) => {
      tabs = next;
    };

    const { rerender } = render(
      <Harness parentMounted parentHasError childMounted childHasError onSnapshot={onSnapshot} />
    );
    expect(tabs.has("code-forge")).toBe(true);

    rerender(
      <Harness
        parentMounted={false}
        parentHasError
        childMounted={false}
        childHasError
        onSnapshot={onSnapshot}
      />
    );
    expect(tabs.has("code-forge")).toBe(false);
  });

  it("clears a single publisher's error when it toggles to false", () => {
    const { result, rerender } = renderHook(
      ({ hasError }: { hasError: boolean }) => {
        useSettingsTabValidation("code-forge", hasError);
        return useContext(SettingsValidationContext);
      },
      { wrapper: wrap, initialProps: { hasError: true } }
    );

    expect(result.current!.tabsWithErrors.has("code-forge")).toBe(true);

    rerender({ hasError: false });
    expect(result.current!.tabsWithErrors.has("code-forge")).toBe(false);
  });

  it("tracks publishers without ghost entries under Strict Mode", () => {
    let tabs: ReadonlySet<SettingsTab> = new Set();
    const onSnapshot = (next: ReadonlySet<SettingsTab>) => {
      tabs = next;
    };

    const { rerender } = render(
      <Harness
        strict
        parentMounted
        parentHasError
        childMounted
        childHasError={false}
        onSnapshot={onSnapshot}
      />
    );
    expect(tabs.has("code-forge")).toBe(true);

    rerender(
      <Harness
        strict
        parentMounted
        parentHasError
        childMounted={false}
        childHasError={false}
        onSnapshot={onSnapshot}
      />
    );
    expect(tabs.has("code-forge")).toBe(true);

    rerender(
      <Harness
        strict
        parentMounted
        parentHasError={false}
        childMounted={false}
        childHasError={false}
        onSnapshot={onSnapshot}
      />
    );
    expect(tabs.has("code-forge")).toBe(false);
  });
});
