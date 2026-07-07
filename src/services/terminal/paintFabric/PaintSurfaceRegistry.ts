import type { TerminalPaintPlane } from "../TerminalInstanceService";

// How a surface is hosted. "local" surfaces live in this renderer and answer
// the plane's synchronous methods directly. "view" surfaces live in a sibling
// WebContentsView (their own process, GPU budget, and glyph atlas — Phase 1V),
// so their sync reads are answered from compositor-side mirrors and their
// geometry flows through the bounds protocol instead of DOM attach.
export type PaintSurfaceKind = "local" | "view";

// A render surface in the paint fabric. Phase 0 has exactly one (the local
// in-view TerminalInstanceService); later phases add sibling WebContentsView
// surfaces and worker-parse surfaces behind the same shape.
export interface PaintSurface {
  readonly id: string;
  readonly plane: TerminalPaintPlane;
  // Defaults to "local" when absent — every pre-1V construction site.
  readonly kind?: PaintSurfaceKind;
}

export function surfaceKind(surface: PaintSurface): PaintSurfaceKind {
  return surface.kind ?? "local";
}

// Bookkeeping for the fabric's load-bearing invariant: a terminal is owned by
// exactly one surface at a time, and the compositor is the sole authority on
// which. Placement moves are an explicit two-step (release, then place) so an
// accidental double-owner is a loud error, not a silent re-home — the
// cross-surface move path (Phase 1 drag-drop re-parent) must go through a
// deliberate transfer, never an incidental overwrite.
export class PaintSurfaceRegistry {
  private surfacesById = new Map<string, PaintSurface>();
  private placements = new Map<string, string>();
  private defaultSurfaceId: string | null = null;

  registerSurface(surface: PaintSurface, options: { isDefault?: boolean } = {}): void {
    if (this.surfacesById.has(surface.id)) {
      throw new Error(`Paint surface already registered: ${surface.id}`);
    }
    this.surfacesById.set(surface.id, surface);
    if (options.isDefault || this.defaultSurfaceId === null) {
      this.defaultSurfaceId = surface.id;
    }
  }

  // Returns the terminal ids that were placed on the surface so the caller can
  // re-home them (the crash-loop fallback co-locates them on a sibling surface,
  // never drops them).
  unregisterSurface(surfaceId: string): string[] {
    if (!this.surfacesById.has(surfaceId)) {
      throw new Error(`Unknown paint surface: ${surfaceId}`);
    }
    if (surfaceId === this.defaultSurfaceId) {
      throw new Error(`Cannot unregister the default paint surface: ${surfaceId}`);
    }
    const orphaned: string[] = [];
    for (const [terminalId, ownerId] of this.placements) {
      if (ownerId === surfaceId) orphaned.push(terminalId);
    }
    orphaned.forEach((terminalId) => this.placements.delete(terminalId));
    this.surfacesById.delete(surfaceId);
    return orphaned;
  }

  surfaces(): PaintSurface[] {
    return Array.from(this.surfacesById.values());
  }

  surfaceCount(): number {
    return this.surfacesById.size;
  }

  defaultSurface(): PaintSurface {
    const surface =
      this.defaultSurfaceId !== null ? this.surfacesById.get(this.defaultSurfaceId) : undefined;
    if (!surface) {
      throw new Error("Paint fabric has no default surface");
    }
    return surface;
  }

  place(terminalId: string, surfaceId: string): void {
    const surface = this.surfacesById.get(surfaceId);
    if (!surface) {
      throw new Error(`Unknown paint surface: ${surfaceId}`);
    }
    const existing = this.placements.get(terminalId);
    if (existing !== undefined && existing !== surfaceId) {
      throw new Error(
        `Terminal ${terminalId} is already placed on surface ${existing}; release it before placing on ${surfaceId}`
      );
    }
    this.placements.set(terminalId, surfaceId);
  }

  release(terminalId: string): void {
    this.placements.delete(terminalId);
  }

  releaseAll(): void {
    this.placements.clear();
  }

  surfaceFor(terminalId: string): PaintSurface | null {
    const surfaceId = this.placements.get(terminalId);
    if (surfaceId === undefined) return null;
    return this.surfacesById.get(surfaceId) ?? null;
  }

  surfaceById(surfaceId: string): PaintSurface | null {
    return this.surfacesById.get(surfaceId) ?? null;
  }

  placementsFor(surfaceId: string): string[] {
    const terminalIds: string[] = [];
    for (const [terminalId, ownerId] of this.placements) {
      if (ownerId === surfaceId) terminalIds.push(terminalId);
    }
    return terminalIds;
  }

  placementCount(surfaceId: string): number {
    let count = 0;
    for (const ownerId of this.placements.values()) {
      if (ownerId === surfaceId) count += 1;
    }
    return count;
  }
}
