import { installBootstrapErrorGuard } from "../../utils/bootstrapErrorGuard.js";

// A failed import below would otherwise leave a process that never posts
// `ready`, since Electron 37+ only warns on unhandled rejections in utility
// processes; main would wait out its start deadline instead of failing fast.
const removeBootstrapGuard = installBootstrapErrorGuard({
  label: "[ElementPickerHostBootstrap]",
  postError: (message) => {
    // Shape must match the `fatal` variant of HostOutbound (hostProtocol.ts).
    const port = process.parentPort as unknown as MessagePort | undefined;
    port?.postMessage({ type: "fatal", message });
  },
});

await import("./host.js");

// host.ts installed its own handlers while it evaluated.
removeBootstrapGuard();
