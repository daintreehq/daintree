import { installBootstrapErrorGuard } from "../../utils/bootstrapErrorGuard.js";

// As `host-bootstrap.ts`: a failed import below would otherwise leave a
// process that never posts `ready`, and main would wait out its start deadline.
const removeBootstrapGuard = installBootstrapErrorGuard({
  label: "[ElementPickerPluginResolverBootstrap]",
  postError: (message) => {
    // Shape must match the `fatal` variant of HostOutbound (hostProtocol.ts).
    const port = process.parentPort as unknown as MessagePort | undefined;
    port?.postMessage({ type: "fatal", message });
  },
});

await import("./plugin-resolver-host.js");

removeBootstrapGuard();
