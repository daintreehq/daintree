import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

const portalTerminalColumns = 100;
const portalTerminalRows = 30;
const portalTerminalMaxLines = 10000;
const portalTerminalSemanticsCharacters = 8000;

typedef PortalTerminalFactory =
    Terminal Function({required int columns, required int rows});

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
    this.terminalFactory,
  }) {
    terminal = _createTerminal();
    _resetDecoder();
  }

  final TerminalTargetPlatform platform;
  final int maxLines;
  final int columns;
  final int rows;
  final PortalTerminalFactory? terminalFactory;
  late Terminal terminal;
  late ByteConversionSink _decoder;
  String? title;
  int parserRecoveryCount = 0;

  String get normalizedText => terminal.buffer.getText().trimRight();

  int get lastContentLine {
    final lines = terminal.buffer.lines;
    for (var index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].getText().trim().isNotEmpty) return index;
    }
    return terminal.buffer.absoluteCursorY;
  }

  String get accessibleText {
    final text = normalizedText;
    if (text.length <= portalTerminalSemanticsCharacters) return text;
    var start = text.length - portalTerminalSemanticsCharacters;
    final codeUnit = text.codeUnitAt(start);
    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) start += 1;
    return 'Recent console output\n${text.substring(start)}';
  }

  void replace(String next, {int? columns, int? rows}) {
    final fallback = _readableText();
    title = null;
    final replacement = _createTerminal(
      columns: columns ?? this.columns,
      rows: rows ?? this.rows,
    );
    try {
      replacement.write(next);
      terminal = replacement;
    } catch (error, stackTrace) {
      if (error is! AssertionError && error is! TypeError) rethrow;
      _reportParserFailure(
        operation: 'replace',
        input: next,
        terminal: replacement,
        error: error,
        stackTrace: stackTrace,
      );
      terminal = _recoveredTerminal(
        fallback.isNotEmpty ? fallback : _plainTextFallback(next),
        columns: columns ?? this.columns,
        rows: rows ?? this.rows,
      );
    }
    _resetDecoder();
    notifyListeners();
  }

  void append(String chunk) {
    if (chunk.isEmpty) return;
    final fallback = _readableText();
    try {
      terminal.write(chunk);
    } catch (error, stackTrace) {
      if (error is! AssertionError && error is! TypeError) rethrow;
      _reportParserFailure(
        operation: 'append',
        input: chunk,
        terminal: terminal,
        error: error,
        stackTrace: stackTrace,
      );
      terminal = _recoveredTerminal(
        fallback,
        columns: terminal.viewWidth,
        rows: terminal.viewHeight,
      );
    }
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

  Terminal _createTerminal({int? columns, int? rows}) {
    final resolvedColumns = columns ?? this.columns;
    final resolvedRows = rows ?? this.rows;
    final factory = terminalFactory;
    if (factory != null) {
      return factory(columns: resolvedColumns, rows: resolvedRows);
    }
    final next = _PortalTerminal(
      maxLines: maxLines,
      platform: platform,
      inputHandler: null,
      mouseHandler: null,
      reflowEnabled: true,
      onTitleChange: (value) => title = value,
    );
    next.resize(resolvedColumns, resolvedRows);
    return next;
  }

  Terminal _recoveredTerminal(
    String text, {
    required int columns,
    required int rows,
  }) {
    final recovered = _createTerminal(columns: columns, rows: rows);
    if (text.isEmpty) return recovered;
    try {
      recovered.write(text);
      return recovered;
    } catch (error) {
      if (error is! AssertionError && error is! TypeError) rethrow;
      return _createTerminal(columns: columns, rows: rows);
    }
  }

  String _readableText() {
    try {
      return normalizedText;
    } catch (error) {
      if (error is! AssertionError && error is! TypeError) rethrow;
      return '';
    }
  }

  String _plainTextFallback(String input) => input
      .replaceAll(RegExp(r'\x1b\][^\x07]*(?:\x07|\x1b\\)'), '')
      .replaceAll(RegExp(r'\x1b\[[0-?]*[ -/]*[@-~]'), '')
      .replaceAll(RegExp(r'\x1b.'), '')
      .replaceAll(RegExp(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'), '');

  void _reportParserFailure({
    required String operation,
    required String input,
    required Terminal terminal,
    required Object error,
    required StackTrace stackTrace,
  }) {
    parserRecoveryCount += 1;
    final bytes = utf8.encode(input);
    final controls = RegExp(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|.)')
        .allMatches(input)
        .take(12)
        .map(
          (match) => match
              .group(0)!
              .codeUnits
              .map((value) => value.toRadixString(16).padLeft(2, '0'))
              .join(),
        )
        .join(',');
    debugPrint(
      '[PortalTerminal] parser recovery operation=$operation '
      'bytes=${bytes.length} digest=${sha256.convert(bytes)} '
      'geometry=${terminal.viewWidth}x${terminal.viewHeight} '
      'bufferRows=${terminal.buffer.lines.length} controls=[$controls] '
      'error=$error\n$stackTrace',
    );
  }
}

class _PortalTerminal extends Terminal {
  _PortalTerminal({
    required super.maxLines,
    required super.platform,
    required super.inputHandler,
    required super.mouseHandler,
    required super.reflowEnabled,
    required super.onTitleChange,
  });

  @override
  void reverseIndex() {
    if (buffer.isInVerticalMargin) {
      if (buffer.cursorY == buffer.marginTop) {
        scrollDown(1);
      } else {
        buffer.moveCursorY(-1);
      }
      return;
    }
    buffer.moveCursorY(-1);
  }

  @override
  void scrollDown(int amount) => _rotateRegion(amount, down: true);

  @override
  void scrollUp(int amount) => _rotateRegion(amount, down: false);

  void _rotateRegion(int amount, {required bool down}) {
    final top = buffer.absoluteMarginTop;
    final bottom = buffer.absoluteMarginBottom;
    final length = bottom - top + 1;
    final shift = amount < 0 ? 0 : (amount > length ? length : amount);
    if (shift == 0) return;

    final allLines = buffer.lines.toList();
    final region = allLines.sublist(top, bottom + 1);
    final recycled = down
        ? region.sublist(length - shift)
        : region.sublist(0, shift);
    for (final line in recycled) {
      line.isWrapped = false;
      line.anchors.clear();
      line.eraseRange(0, viewWidth, cursor);
    }
    final rotated = down
        ? [...recycled, ...region.take(length - shift)]
        : [...region.skip(shift), ...recycled];
    allLines.replaceRange(top, bottom + 1, rotated);
    buffer.lines.replaceWith(allLines);
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

class PortalTerminalView extends StatefulWidget {
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
  State<PortalTerminalView> createState() => _PortalTerminalViewState();
}

class _PortalTerminalViewState extends State<PortalTerminalView> {
  final _horizontalController = ScrollController();
  final _verticalController = ScrollController();
  Terminal? _anchoredTerminal;

  @override
  void dispose() {
    _horizontalController.dispose();
    _verticalController.dispose();
    super.dispose();
  }

  void _revealActiveContent(Terminal terminal, double cellHeight) {
    if (identical(_anchoredTerminal, terminal)) return;
    _anchoredTerminal = terminal;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          !identical(_anchoredTerminal, terminal) ||
          !_verticalController.hasClients) {
        return;
      }
      final position = _verticalController.position;
      final lineBottom = (widget.model.lastContentLine + 1) * cellHeight + 18;
      final target = (lineBottom - position.viewportDimension * 0.8).clamp(
        0.0,
        position.maxScrollExtent,
      );
      _verticalController.jumpTo(target);
    });
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.model,
      builder: (context, _) {
        final media = MediaQuery.of(context);
        final terminalTheme = media.highContrast
            ? TerminalThemes.whiteOnBlack
            : TerminalThemes.defaultTheme;
        const terminalStyle = TerminalStyle(fontSize: 13, height: 1.35);
        final textPainter = TextPainter(
          text: TextSpan(
            text: 'mmmmmmmmmm',
            style: terminalStyle.toTextStyle(),
          ),
          textScaler: media.textScaler,
          textDirection: Directionality.of(context),
        )..layout();
        final cellWidth = textPainter.width / 10;
        final cellHeight = textPainter.height;
        textPainter.dispose();
        _revealActiveContent(widget.model.terminal, cellHeight);
        final contentWidth = cellWidth * widget.model.terminal.viewWidth + 36;
        return Semantics(
          container: true,
          label: widget.semanticsLabel,
          value: widget.model.accessibleText,
          readOnly: true,
          child: ColoredBox(
            color: terminalTheme.background,
            child: Scrollbar(
              controller: _horizontalController,
              notificationPredicate: (notification) =>
                  notification.metrics.axis == Axis.horizontal,
              child: SingleChildScrollView(
                controller: _horizontalController,
                scrollDirection: Axis.horizontal,
                child: SizedBox(
                  key: const ValueKey('portal-terminal-surface'),
                  width: contentWidth,
                  child: Stack(
                    children: [
                      TerminalView(
                        widget.model.terminal,
                        key: ValueKey(widget.model.terminal),
                        theme: terminalTheme,
                        textStyle: terminalStyle,
                        textScaler: media.textScaler,
                        padding: const EdgeInsets.all(18),
                        scrollController: _verticalController,
                        readOnly: true,
                        hardwareKeyboardOnly: true,
                        autoResize: false,
                        simulateScroll: false,
                        alwaysShowCursor: false,
                      ),
                      if (widget.model.normalizedText.isEmpty &&
                          widget.emptyMessage != null)
                        Center(
                          child: Text(
                            widget.emptyMessage!,
                            style: TextStyle(color: terminalTheme.foreground),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
