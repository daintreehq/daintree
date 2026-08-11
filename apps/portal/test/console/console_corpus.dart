class ConsoleCorpusEntry {
  const ConsoleCorpusEntry({
    required this.agent,
    required this.capture,
    required this.expectedText,
  });

  final String agent;
  final String capture;
  final List<String> expectedText;
}

const representativeConsoleCorpus = <ConsoleCorpusEntry>[
  ConsoleCorpusEntry(
    agent: 'Claude Code',
    capture:
        '\x1b]0;Claude Code\x07'
        '\x1b[1;36mClaude\x1b[0m analyzing src/portal.dart\r\n'
        '✓ Read 12 files · 日本語 · 🌿\r\n'
        '\x1b[33mThinking…\x1b[0m\rWorking…\x1b[K\r\n'
        '## Plan\r\n- Preserve ordered output\r\n',
    expectedText: [
      'Claude analyzing src/portal.dart',
      '日本語 · 🌿',
      'Working…',
      '## Plan',
    ],
  ),
  ConsoleCorpusEntry(
    agent: 'Codex',
    capture:
        '\x1b]8;;https://example.invalid/task\x1b\\task link\x1b]8;;\x1b\\\r\n'
        '\x1b[38;2;80;200;120mcodex\x1b[0m editing a deliberately long line that wraps across the fixed mobile observation viewport without resizing the host PTY\r\n'
        '[1/3] inspect\r\x1b[2K[2/3] implement\r\n',
    expectedText: ['task link', 'codex editing', '[2/3] implement'],
  ),
  ConsoleCorpusEntry(
    agent: 'Gemini CLI',
    capture:
        'Gemini ready\r\n'
        '\x1b[?1049h\x1b[2J\x1b[Htemporary alternate screen\x1b[?1049l'
        'Returned to conversation\r\n'
        '\x1b[?2004hbracketed paste enabled\x1b[?2004l\r\n',
    expectedText: [
      'Gemini ready',
      'Returned to conversation',
      'bracketed paste enabled',
    ],
  ),
  ConsoleCorpusEntry(
    agent: 'OpenCode',
    capture:
        '\x1b[35m◆\x1b[0m diff --git a/app.dart b/app.dart\r\n'
        '+ final message = "emoji 👩🏽‍💻 and wide 漢字";\r\n'
        '\x1b[48;5;235m   markdown-like fenced output   \x1b[0m\r\n',
    expectedText: [
      'diff --git',
      '👩🏽‍💻',
      '漢字',
      'markdown-like fenced output',
    ],
  ),
];
