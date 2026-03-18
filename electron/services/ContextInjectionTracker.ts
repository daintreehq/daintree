export class ContextInjectionTracker {
  private injectionsInProgress = new Set<string>();
  private cancelledInjections = new Set<string>();
  private activeInjectionIds = new Map<string, string>();

  isTerminalInjecting(terminalId: string): boolean {
    return this.injectionsInProgress.has(terminalId);
  }

  beginInjection(terminalId: string, injectionId: string): void {
    this.injectionsInProgress.add(terminalId);
    this.activeInjectionIds.set(terminalId, injectionId);
  }

  finishInjection(terminalId: string, injectionId: string): void {
    this.injectionsInProgress.delete(terminalId);
    this.activeInjectionIds.delete(terminalId);
    this.cancelledInjections.delete(injectionId);
  }

  isCancelled(injectionId: string): boolean {
    return this.cancelledInjections.has(injectionId);
  }

  markCancelled(injectionId: string): boolean {
    const isActive = Array.from(this.activeInjectionIds.values()).includes(injectionId);
    if (isActive) {
      this.cancelledInjections.add(injectionId);
    }
    return isActive;
  }

  markAllCancelled(): number {
    const ids = Array.from(this.activeInjectionIds.values());
    for (const id of ids) {
      this.cancelledInjections.add(id);
    }
    return ids.length;
  }

  getActiveCount(): number {
    return this.activeInjectionIds.size;
  }

  cleanupTerminal(terminalId: string): void {
    const injectionId = this.activeInjectionIds.get(terminalId);
    if (injectionId) {
      this.cancelledInjections.delete(injectionId);
    }
    this.injectionsInProgress.delete(terminalId);
    this.activeInjectionIds.delete(terminalId);
  }

  onProjectSwitch(): void {
    this.injectionsInProgress.clear();
    this.cancelledInjections.clear();
    this.activeInjectionIds.clear();
  }
}

export const contextInjectionTracker = new ContextInjectionTracker();
