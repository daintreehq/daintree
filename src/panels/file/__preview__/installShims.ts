import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { FAILURE_MESSAGE, FIXTURE_FILES, MANY_FILES, searchFixture } from "./fixtures";

// Imported first by `preview.tsx`, so the bridge is on `window` before any store
// module evaluates. Only ever a harness: with a real bridge present this page is
// running inside the app, and clearing that origin's storage would clear the
// user's own persisted state.
const isHarness = !Reflect.get(window, "electron");

// Long enough to land after the picker's debounce like a real IPC round trip,
// short enough to keep a capture sweep quick.
const SEARCH_LATENCY_MS = 20;

const params = new URLSearchParams(window.location.search);
const failing = params.get("search") === "fail";
const files = params.get("repo") === "many" ? MANY_FILES : FIXTURE_FILES;

interface SearchLog {
  calls: { query: string; outcome: "ok" | "fail"; count: number }[];
}
const log: SearchLog = { calls: [] };
Reflect.set(window, "__filePaneSearch", log);

installPreviewShims({
  files: new Proxy(
    {
      search: async ({ query, limit }: { cwd: string; query: string; limit?: number }) => {
        await new Promise((resolve) => setTimeout(resolve, SEARCH_LATENCY_MS));
        if (failing) {
          log.calls.push({ query, outcome: "fail", count: 0 });
          throw new Error(FAILURE_MESSAGE);
        }
        const answer = searchFixture(query, limit ?? 100, files);
        log.calls.push({ query, outcome: "ok", count: answer.length });
        return { files: answer };
      },
    },
    {
      get: (target, key) =>
        key in target ? Reflect.get(target, key) : () => Promise.resolve(undefined),
    }
  ),
});

if (isHarness) {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable; the harness renders without it.
  }
}
