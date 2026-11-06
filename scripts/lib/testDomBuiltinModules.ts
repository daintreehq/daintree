/**
 * Browser libraries such as p-queue discover Node helpers through `process`,
 * which JSDOM shares with its host. Node's listener limit cannot apply to a
 * JSDOM EventTarget; leave those browser objects alone while retaining the
 * real helper for Node event emitters and targets.
 */
export function installDomBuiltinModules(): () => void {
  const original = process.getBuiltinModule;
  const DomEventTarget = globalThis.EventTarget;
  const events = original("node:events") as typeof import("node:events");
  const domEvents = {
    ...events,
    setMaxListeners(...[count, ...targets]: Parameters<typeof events.setMaxListeners>): void {
      const nativeTargets = targets.filter((target) => !(target instanceof DomEventTarget));
      if (targets.length === 0 || nativeTargets.length > 0) {
        events.setMaxListeners(count, ...nativeTargets);
      }
    },
  };
  Object.defineProperty(process, "getBuiltinModule", {
    configurable: true,
    writable: true,
    value: (name: string) =>
      name === "node:events" || name === "events" ? domEvents : original(name),
  });
  return () => {
    process.getBuiltinModule = original;
  };
}
