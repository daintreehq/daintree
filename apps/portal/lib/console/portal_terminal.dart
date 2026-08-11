import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

const portalTerminalColumns = 100;
const portalTerminalRows = 30;
const portalTerminalMaxLines = 10000;
const portalTerminalSemanticsCharacters = 8000;

TerminalTargetPlatform terminalPlatformFor(TargetPlatform platform) {
  return switch (platform) {
    TargetPlatform.android => TerminalTargetPlatform.android,
    TargetPlatform.iOS => TerminalTargetPlatform.ios,
    TargetPlatform.fuchsia => TerminalTargetPlatform.fuchsia,
    TargetPlatform.linux => TerminalTargetPlatform.linux,
    TargetPlatform.macOS => TerminalTargetPlatform.macos,
    TargetPlatform.windows => TerminalTargetPlatform.windows,
  };
}

class PortalTerminalModel extends ChangeNotifier {
  PortalTerminalModel({
    required this.platform,
    this.maxLines = portalTerminalMaxLines,
    this.columns = portalTerminalColumns,
    this.rows = portalTerminalRows,
  }) {
    terminal = _createTerminal();
    _resetDecoder();
  }

  final TerminalTargetPlatform platform;
  final int maxLines;
  final int columns;
  final int rows;
  late Terminal terminal;
  late ByteConversionSink _decoder;
  String? title;

  String get normalizedText => terminal.buffer.getText().trimRight();

  String get accessibleText {
    final text = normalizedText;
    if (text.length <= portalTerminalSemanticsCharacters) return text;
    var start = text.length - portalTerminalSemanticsCharacters;
    final codeUnit = text.codeUnitAt(start);
    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) start += 1;
    return 'Recent console output\n${text.substring(start)}';
  }

  void replace(String next) {
    title = null;
    terminal = _createTerminal()..write(next);
    _resetDecoder();
    notifyListeners();
  }

  void append(String chunk) {
    if (chunk.isEmpty) return;
    terminal.write(chunk);
    notifyListeners();
  }

  void appendBytes(List<int> bytes) {
    _decoder.add(bytes);
  }

  void _resetDecoder() {
    _decoder = const Utf8Decoder(allowMalformed: true).startChunkedConversion(
      StringConversionSink.fromStringSink(_DecodedStringSink(append)),
    );
  }

  Terminal _createTerminal() {
    final next = Terminal(
      maxLines: maxLines,
      platform: platform,
      inputHandler: null,
      mouseHandler: null,
      reflowEnabled: true,
      onTitleChange: (value) => title = value,
    );
    next.resize(columns, rows);
    return next;
  }
}

class _DecodedStringSink implements StringSink {
  const _DecodedStringSink(this.onText);

  final void Function(String text) onText;

  @override
  void write(Object? object) => onText(object?.toString() ?? '');

  @override
  void writeAll(Iterable<Object?> objects, [String separator = '']) =>
      onText(objects.join(separator));

  @override
  void writeCharCode(int charCode) => onText(String.fromCharCode(charCode));

  @override
  void writeln([Object? object = '']) => onText('${object ?? ''}\n');
}

class PortalTerminalView extends StatelessWidget {
  const PortalTerminalView({
    required this.model,
    required this.semanticsLabel,
    this.emptyMessage,
    super.key,
  });

  final PortalTerminalModel model;
  final String semanticsLabel;
  final String? emptyMessage;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: model,
      builder: (context, _) {
        final media = MediaQuery.of(context);
        final textScale = media.textScaler.scale(13) / 13;
        final terminalTheme = media.highContrast
            ? TerminalThemes.whiteOnBlack
            : TerminalThemes.defaultTheme;
        return Semantics(
          container: true,
          label: semanticsLabel,
          value: model.accessibleText,
          readOnly: true,
          child: ColoredBox(
            color: terminalTheme.background,
            child: Stack(
              children: [
                TerminalView(
                  model.terminal,
                  key: ValueKey(model.terminal),
                  theme: terminalTheme,
                  textStyle: TerminalStyle(
                    fontSize: 13 * textScale,
                    height: 1.35,
                  ),
                  padding: const EdgeInsets.all(18),
                  readOnly: true,
                  hardwareKeyboardOnly: true,
                  autoResize: false,
                  simulateScroll: false,
                  alwaysShowCursor: false,
                ),
                if (model.normalizedText.isEmpty && emptyMessage != null)
                  Center(
                    child: Text(
                      emptyMessage!,
                      style: TextStyle(color: terminalTheme.foreground),
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}
