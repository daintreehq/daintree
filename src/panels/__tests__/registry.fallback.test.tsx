// @vitest-environment jsdom
import type { ComponentType } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MinimalComponent = ComponentType<Record<string, never>>;

// Each lazy pane import never settles, so every wrapper stays suspended and
// renders its Suspense fallback — letting us assert the per-kind skeleton
// wiring (the #10984 bug surface) through the public registry API.
function mockWiringImports(): void {
  vi.doMock("@/components/Terminal/TerminalPane", () => ({
    TerminalPane: (() => null) as MinimalComponent,
  }));
  vi.doMock("@/components/ErrorBoundary", () => ({
    ErrorBoundary: ({ children }: { children?: unknown }) => children,
  }));
  vi.doMock("@/components/Browser/BrowserPane", () => new Promise(() => {}));
  vi.doMock("@/components/DevPreview/DevPreviewPane", () => new Promise(() => {}));
  vi.doMock("../review/ReviewPane", () => new Promise(() => {}));
  vi.doMock("../file/FilePane", () => new Promise(() => {}));
  vi.doMock("@/components/Browser/BrowserPaneSkeleton", () => ({
    BrowserPaneSkeleton: ({ label }: { label?: string }) => (
      <div data-testid="browser-skeleton">{label}</div>
    ),
  }));
  vi.doMock("../review/ReviewPaneSkeleton", () => ({
    ReviewPaneSkeleton: () => <div data-testid="review-skeleton" />,
  }));
}

async function renderPanelKind(kind: string): Promise<void> {
  const registry = await import("../registry");
  const definition = registry.getPanelKindDefinition(kind);
  expect(definition).toBeTruthy();
  const Component = definition!.component;
  render(
    <Component id="panel-1" title="Panel" isFocused={false} onFocus={() => {}} onClose={() => {}} />
  );
}

describe("panel registry Suspense fallback wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    mockWiringImports();
  });

  it("browser falls back to the browser skeleton", async () => {
    await renderPanelKind("browser");
    expect(screen.getByTestId("browser-skeleton")).toBeTruthy();
  });

  it("dev-preview falls back to the browser skeleton with its own label", async () => {
    await renderPanelKind("dev-preview");
    const skeleton = screen.getByTestId("browser-skeleton");
    expect(skeleton.textContent).toBe("Loading dev preview panel");
  });

  it("review falls back to the review skeleton, not the browser one", async () => {
    await renderPanelKind("review");
    expect(screen.getByTestId("review-skeleton")).toBeTruthy();
    expect(screen.queryByTestId("browser-skeleton")).toBeNull();
  });

  it("file falls back to the browser skeleton with its own label", async () => {
    await renderPanelKind("file");
    const skeleton = screen.getByTestId("browser-skeleton");
    expect(skeleton.textContent).toBe("Loading file panel");
  });
});
