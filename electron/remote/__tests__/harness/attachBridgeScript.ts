import path from "node:path";
import { build } from "esbuild";

/**
 * The real attach bridge (`host/attachStdio.ts`) as a standalone Node script,
 * so tests can run `--attach-stdio`'s logic as a real child process (locally,
 * or over ssh) without launching Electron. The script takes the host's
 * discovery file as its one argument, or from `DAINTREE_ATTACH_DISCOVERY`
 * when started the product's way (`<command> --attach-stdio`), and exits with
 * the bridge's code.
 */
export async function buildAttachBridgeScript(outDir: string): Promise<string> {
  const bridgeModule = path.resolve(__dirname, "../../host/attachStdio.ts");
  const outfile = path.join(outDir, "attach-bridge.mjs");
  await build({
    stdin: {
      contents: [
        `import { runAttachStdioBridge } from ${JSON.stringify(bridgeModule)};`,
        "const code = await runAttachStdioBridge({",
        "  discoveryPath:",
        '    process.argv[2] && process.argv[2] !== "--attach-stdio"',
        "      ? process.argv[2]",
        "      : process.env.DAINTREE_ATTACH_DISCOVERY,",
        "  input: process.stdin,",
        "  output: process.stdout,",
        "  errorOutput: process.stderr,",
        "});",
        "process.exit(code);",
      ].join("\n"),
      resolveDir: path.dirname(bridgeModule),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    logLevel: "silent",
  });
  return outfile;
}
