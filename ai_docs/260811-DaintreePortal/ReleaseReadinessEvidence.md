# Daintree Portal Release Readiness Evidence

## Status

This evidence snapshot was prepared on 2026-08-11 for SynthOps task `f9f5b0a3-7448-469b-8def-431741d4bdd3`. The implementation and local automated surfaces are substantially green, but version 1 release acceptance is not complete because the required real-device, cross-host, six-journey, performance, energy, and hostile-LAN evidence has not been produced. The SynthOps task must remain `in_progress` and its acceptance criteria must remain unaccepted until those gaps are closed.

## Confirmed implementation fixes

- Fresh-database migration: the final statement separator in `electron/services/persistence/migrations/0011_flawless_emma_frost.sql` produced an empty SQL statement and broke a new database. Removing the trailing separator made all 11 remote mutation audit tests pass under Electron's matching native runtime.
- Production renderer bootstrap: Vite 8.0/Rolldown 1.0 `lazyBarrel` output miswired shared Zod schema initializers and produced `ReferenceError` during production startup. Disabling that experimental transform restored a clean production renderer boot.
- Smoke integrity: unpackaged and packaged smoke validators now treat `Bootstrap failed:` as fatal, so a later stability marker cannot hide renderer bootstrap failure.
- IPC channel registry: all nine generated `remote-access:*` invoke channels are declared in the central `CHANNELS` registry; the channel drift guard passes.

## Automated evidence

| Surface | Result | Evidence |
| --- | --: | --- |
| Production desktop build | Pass | `npm run build` exited zero after the renderer bootstrap fix |
| Production desktop smoke | Pass | `npm run test:smoke` completed renderer/IPC, terminal, persistence, project stress, and stability soak checks without a bootstrap fatal marker |
| Smoke validator regression | Pass | Focused smoke/protocol/settings run passed 38 tests and directly rejects a `Bootstrap failed:` log |
| Full ordinary Vitest surface | Pass with native-lane limitation | The unrestricted full run passed 46,898 tests and identified exactly seven stale registry/search/action-snapshot assertions; after updating those intentional feature expectations, the focused failure set passed 178/178. Thirteen Node workers that load Electron-rebuilt native SQLite still exit before execution and are covered separately by the matching-runtime lane |
| Remote non-native focused suite | Pass | 153 tests passed locally; the 17 real TLS gateway tests also passed when allowed to bind localhost |
| Native mutation and persistence suite | Pass | 11 tests passed with `ELECTRON_RUN_AS_NODE=1` and the repository Electron binary, matching the rebuilt `better-sqlite3` ABI |
| Flutter analysis and tests | Pass | `flutter analyze` reported no issues and `flutter test` passed 51 tests |
| Android console integration | Pass | One console renderer integration test passed on physical Android 16 device `R5CY122LPRR` |
| iOS console integration | Pass | One console renderer integration test passed on an iOS 18.5 simulator |
| Mobile renderer burst | Pass for observed sample | 1,428,890 bytes in 350 chunks rendered in 68 ms with 5,000 retained lines and 19,513,344-byte RSS growth |
| Android release artifact | Pass | `flutter build appbundle --release` produced a 62.3 MB release AAB |
| iOS release artifact | Pass with expected limitation | `flutter build ios --release --no-codesign` produced an 18.4 MB unsigned Runner.app |
| Production dependency critical threshold | Pass | `npm audit --omit=dev --audit-level=critical` exited zero; six high-severity transitive findings remain for follow-up |
| Flutter dependency advisories | Pass | The OSV query found no advisories across 89 locked Pub packages |
| Secret scan | Pass for Portal scope | No high-confidence credential finding was found in the new Portal scope; repository-wide matches were known fake fixtures |
| Platform permission review | Pass | Android requests internet, camera, network state, and nearby Wi-Fi with `neverForLocation`, disables backup, and iOS declares Bonjour and explicit camera/local-network purpose strings with keychain entitlements |
| MCP exposure review | Pass | MCP source remains bound to `127.0.0.1`; Remote access is a separate disabled-by-default surface |

## Specification coverage and remaining evidence

| Requirement | Current conclusion | Missing evidence |
| --- | --- | --- |
| §18.5 six real journeys | Not accepted | Run discover/pair/observe/prompt, background launch/convergence, lost-response exactly-once, live revocation, renderer eviction/revival, and desktop restart persistence against real host/client processes |
| Phase 2 device matrix | Not accepted | Complete the critical journey on physical iPhone, physical iPad, representative Android phone and tablet |
| Phase 2 host matrix | Not accepted | Complete the critical journey against macOS, Windows, and Linux release-candidate hosts |
| §18.1, §18.2, §18.4 hostile/fault matrix | Partially evidenced | Execute hostile LAN and malformed-traffic cases against the real listener, all disconnect-at-mutation boundaries, and fifty-repeat duplicate-prevention runs |
| §16 performance budgets | Not accepted | Retain p95 measurements for discovery, reconnect, warm/cold snapshot, prompt, launch, and console presentation on a representative LAN |
| §16 resource and energy budgets | Not accepted | Measure idle gateway RSS/CPU, sustained high-output queue isolation, physical mobile background/foreground reconnect, and battery/energy behavior |
| Cross-platform repository gate | Not accepted | Run the current tree's desktop checks, build, smoke, and relevant Portal E2E on Windows and Linux in addition to macOS |
| §21 definition of done | Not accepted | Complete the missing real journey, matrix, hostile, performance, energy, and cross-platform evidence, then perform the final independent STEP audit |

## Residual findings

- Six high-severity npm dependency findings remain, although the requested critical threshold is clean. They are transitive through `adm-zip`, `onnxruntime-node`/`@ngify/http`, `brace-expansion`, `fast-uri`, and `js-yaml` paths and should be remediated or explicitly risk-accepted before a public release.
- Normal Node/Vitest workers on this macOS worktree cannot load the Electron-rebuilt `better-sqlite3` binary reliably. The affected native tests pass under the Electron runtime that matches the production ABI; CI should retain an explicit matching-runtime lane rather than silently executing zero tests.
- Current iOS release evidence is unsigned and the console integration used a simulator. Neither result substitutes for the physical iPhone/iPad acceptance matrix.
- No current-tree Windows or Linux result exists because the work is uncommitted and acceptance testing is not authorized to commit or push it to CI.

## Release recommendation

Do not mark the final SynthOps task or project complete yet. The next release-readiness step is a guided macOS plus physical iPhone six-journey run, followed by the remaining device/host matrix and measured §16 campaign. Once those artifacts are retained, rerun the cross-platform gates and request the final independent STEP audit.
