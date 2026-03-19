export class TerminalOffscreenManager {
  private hiddenContainer: HTMLDivElement | null = null;
  private offscreenSlots = new Map<string, HTMLDivElement>();

  ensureHiddenContainer(): HTMLDivElement | null {
    if (this.hiddenContainer) return this.hiddenContainer;
    if (typeof document === "undefined") return null;

    const container = document.createElement("div");
    container.className = "terminal-offscreen-container";
    container.style.cssText = [
      "content-visibility: hidden",
      "position: fixed",
      "left: 0",
      "top: 0",
      "width: 2000px",
      "height: 2000px",
      "overflow: hidden",
      "z-index: -1",
    ].join(";");
    document.body.appendChild(container);

    this.hiddenContainer = container;
    return this.hiddenContainer;
  }

  getOrCreateOffscreenSlot(id: string, widthPx: number, heightPx: number): HTMLDivElement {
    if (typeof document === "undefined") {
      throw new Error("Offscreen slot requires DOM");
    }

    const existing = this.offscreenSlots.get(id);
    if (existing) {
      existing.style.width = `${widthPx}px`;
      existing.style.height = `${heightPx}px`;
      return existing;
    }

    const hiddenContainer = this.ensureHiddenContainer();
    if (!hiddenContainer) {
      throw new Error("Offscreen container unavailable");
    }

    const slot = document.createElement("div");
    slot.dataset.terminalId = id;
    slot.style.width = `${widthPx}px`;
    slot.style.height = `${heightPx}px`;
    slot.style.position = "absolute";
    slot.style.left = "0";
    slot.style.top = "0";
    hiddenContainer.appendChild(slot);

    this.offscreenSlots.set(id, slot);
    return slot;
  }

  getOffscreenSlot(id: string): HTMLDivElement | undefined {
    return this.offscreenSlots.get(id);
  }

  removeOffscreenSlot(id: string): void {
    const slot = this.offscreenSlots.get(id);
    if (slot && slot.parentElement) {
      slot.parentElement.removeChild(slot);
    }
    this.offscreenSlots.delete(id);
  }

  getHiddenContainer(): HTMLDivElement | null {
    return this.hiddenContainer;
  }

  dispose(): void {
    this.offscreenSlots.forEach((slot) => {
      if (slot.parentElement) {
        slot.parentElement.removeChild(slot);
      }
    });
    this.offscreenSlots.clear();

    if (this.hiddenContainer && this.hiddenContainer.parentElement) {
      this.hiddenContainer.parentElement.removeChild(this.hiddenContainer);
    }
    this.hiddenContainer = null;
  }
}
