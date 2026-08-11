# Console renderer decision

## Decision

Daintree Portal uses the native Flutter `xterm.dart` renderer, pinned exactly to `xterm: 4.0.0`. Version 4.0.0 is the current stable release published by Terminal Studio and supports Flutter mobile, wide characters, emoji, a frontend-independent terminal core, read-only rendering, selection, and configurable bounded scrollback. The evaluated API and release metadata are recorded at [pub.dev](https://pub.dev/packages/xterm/versions) and in the [4.0.0 API reference](https://pub.dev/documentation/xterm/latest/xterm/TerminalView-class.html).

The xterm.js WebView fallback is not selected. The native renderer passed the required corpus and operational gates, while a WebView would add a second rendering runtime, CSP policy, navigation boundary, and native/JavaScript message bridge without a demonstrated fidelity benefit.

## Production boundary

`PortalTerminalModel` owns a fixed 100×30 observation terminal with 10,000 retained lines. It accepts only host output, uses one stateful UTF-8 decoder across arbitrarily split byte chunks, incrementally writes decoded output directly into the terminal, and rebuilds from a clean terminal and decoder when a snapshot replaces prior output. It retains no raw million-character copy and never creates an arbitrary raw tail that could begin inside Unicode or an ANSI/OSC sequence. High-frequency updates notify only the console model and terminal subtree, not the broad Portal controller or shell. `inputHandler` and `mouseHandler` are null. `PortalTerminalView` is read-only, hardware-keyboard-only, disables automatic host PTY resize and simulated alternate-screen scrolling, hides the cursor, and exposes the most recent 8,000 normalized characters through a read-only semantic node without splitting a Unicode surrogate pair. Text remains selectable through `TerminalController`; high-contrast media uses the package's white-on-black theme and mobile text scaling adjusts the terminal font.

No WebView, remote content, JavaScript execution, URL navigation, or native message bridge exists in this path. OSC titles are parsed as metadata, OSC hyperlinks retain visible text without becoming an embedded browser surface, and alternate-screen/bracketed-paste modes affect parsing only; Portal never forwards terminal-generated input to the host.

## Corpus and gates

The checked-in corpus contains sanitized representative Claude Code, Codex, Gemini CLI, and OpenCode output. It covers SGR attributes, named/256/truecolor output, Unicode, emoji, combining skin-tone/ZWJ sequences, CJK double-width cells, fixed-width wrapping, carriage-return progress replacement, cursor erasure, OSC titles, OSC hyperlinks, alternate-screen entry/exit, bracketed-paste entry/exit, markdown-like output, and long scrollback. Automated tests compare reviewed Android/iOS visual goldens and normalized buffer text and directly assert cell attributes, color encodings, character widths, mode transitions, selection text, accessibility semantics, and clean snapshot replacement.

| Gate | Evidence | Result |
| --- | --- | --- |
| Android target | Physical Samsung SM S721B, Android 16 / API 36, `integration_test/console_renderer_test.dart` | Pass |
| iOS target | iPhone 16 Pro simulator, iOS 18.5, `integration_test/console_renderer_test.dart` | Pass |
| Host parser matrix | Corpus replayed with `TerminalTargetPlatform.android` and `.ios` | Pass |
| Visual fidelity | Reviewed 900×600 Android and iOS corpus goldens check cell geometry, wrapping, and colors byte-for-byte; normalized-buffer assertions check the glyph content | Pass |
| ANSI and color | Bold named red and RGB `#50C878` asserted from buffer cells; 256-color background retained in corpus | Pass |
| Unicode and width | Emoji/ZWJ text retained; `界` asserted as width 2 plus continuation cell | Pass |
| Modes and cursor behavior | Alternate screen returns to main buffer; bracketed paste returns off; carriage-return progress and erase-line output normalized | Pass |
| Selection | Selected buffer range returns exact `select me` text | Pass |
| Accessibility | Read-only semantic label/value survives large text, high contrast, reduced motion, rotation, pause/resume, reconnect, and resync | Pass |
| Throughput | 1,428,890 UTF-8 bytes / 60,000 lines delivered through 350 production decoder chunks in 64–90 ms across local, independent-runner, and STEP-audit runs | Pass against 5-second gate |
| Memory bound | The same production-path burst added 8,945,664–35,209,216 RSS bytes, retained at most 5,000 test lines, and passed the 64 MiB delta gate; production retains at most 10,000 lines | Pass |

The physical wireless iPhone test could not start because Xcode could not mount the developer disk image on iOS 26.6. This was a device/tooling failure before application launch, not a renderer failure; the same signed iOS build path and corpus passed on the available iOS 18.5 simulator.

The Android/iOS widget goldens are deterministic host-rendered baselines for cell geometry, wrapping, and colors rather than device screenshots. Target-specific behavior is additionally exercised by the passing physical Android and iOS Simulator integration runs, while glyph fidelity is asserted from normalized terminal buffers.

## Verification commands

```bash
cd apps/portal
flutter analyze
flutter test test/console/portal_terminal_corpus_test.dart test/portal/portal_shell_test.dart
flutter test integration_test/console_renderer_test.dart -d R5CY122LPRR
flutter test integration_test/console_renderer_test.dart -d C15B8DA4-FF43-4B27-9E0F-30F3DA46F40F
```
