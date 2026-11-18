import fs from "node:fs";
import path from "node:path";

/** Repo-relative path of the marker `npm run dev` waits on before it starts Electron. */
export const BUILD_READY_FILE = "dist-electron/.build-ready.js";

export function removeBuildReadyMarker(file) {
  fs.rmSync(file, { force: true });
}

export function writeBuildReadyMarker(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `// build ready ${Date.now()}\n`, "utf8");
}

/**
 * Opens only when every named build's latest run succeeded, none is running,
 * and the copied assets are in place. Each watch context reports through its
 * own `plugin(name)`; one context finishing says nothing about another, so a
 * fast preload can't release Electron while main is still building or broken.
 * After the first open, every later success that leaves all builds green
 * rewrites the marker again, debounced so one edit that rebuilds several
 * contexts writes once.
 */
export function createBuildReadyGate({
  names,
  write,
  onFirstReady = () => {},
  delayMs = 100,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const states = new Map(names.map((name) => [name, "pending"]));
  let assetsReady = false;
  let opened = false;
  let timer = null;
  let disposed = false;

  const isReady = () =>
    !disposed && assetsReady && [...states.values()].every((state) => state === "ok");

  const cancel = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const fire = () => {
    timer = null;
    if (!isReady()) return;
    write();
    if (!opened) {
      opened = true;
      onFirstReady();
    }
  };

  const schedule = () => {
    cancel();
    if (isReady()) timer = setTimer(fire, delayMs);
  };

  return {
    plugin(name) {
      if (!states.has(name)) throw new Error(`Unknown build "${name}" for the ready gate`);
      return {
        name: `build-ready-gate:${name}`,
        setup(buildApi) {
          buildApi.onStart(() => {
            states.set(name, "pending");
            cancel();
          });
          buildApi.onEnd((result) => {
            states.set(name, result.errors.length === 0 ? "ok" : "error");
            schedule();
          });
        },
      };
    },
    markAssetsReady() {
      assetsReady = true;
      schedule();
    },
    isReady,
    get opened() {
      return opened;
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}

/**
 * Starts one esbuild watch context per named config and writes `readyFile`
 * once all of them have built cleanly and `copyAssets` has run. `watch()`
 * resolves before a context's first build has even started, so readiness
 * comes from each context's own onStart/onEnd, never from that promise.
 */
export async function startWatchBuild({
  configs,
  readyFile,
  copyAssets = () => {},
  onFirstReady,
  createContext,
  delayMs,
}) {
  removeBuildReadyMarker(readyFile);
  const names = Object.keys(configs);
  const gate = createBuildReadyGate({
    names,
    write: () => writeBuildReadyMarker(readyFile),
    onFirstReady,
    delayMs,
  });

  copyAssets();
  gate.markAssetsReady();

  const settled = await Promise.allSettled(
    names.map((name) =>
      createContext({
        ...configs[name],
        plugins: [...(configs[name].plugins ?? []), gate.plugin(name)],
      })
    )
  );
  const contexts = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const failed = settled.find((r) => r.status === "rejected");

  const dispose = async () => {
    gate.dispose();
    await Promise.allSettled(contexts.map((ctx) => ctx.dispose()));
  };

  if (failed) {
    await dispose();
    throw failed.reason;
  }

  try {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } catch (error) {
    await dispose();
    throw error;
  }

  return { gate, contexts, dispose };
}
