import 'dart:convert';
import 'dart:io';

import 'package:daintree_portal/console/portal_terminal.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';
import 'console_corpus.dart';

void main() {
  for (final platform in [
    TerminalTargetPlatform.android,
    TerminalTargetPlatform.ios,
  ]) {
    group('${platform.name} production renderer corpus', () {
      for (final entry in representativeConsoleCorpus) {
        test('${entry.agent} retains normalized buffer content', () {
          final model = PortalTerminalModel(platform: platform);
          model.replace(entry.capture);

          for (final expected in entry.expectedText) {
            expect(model.normalizedText, contains(expected));
          }
          expect(model.terminal.isUsingAltBuffer, isFalse);
          expect(model.terminal.bracketedPasteMode, isFalse);
        });
      }
    });
  }

  for (final platform in [TargetPlatform.android, TargetPlatform.iOS]) {
    testWidgets(
      '${platform.name} corpus matches its reviewed visual baseline',
      (tester) async {
        await tester.binding.setSurfaceSize(const Size(900, 600));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final output = representativeConsoleCorpus
            .map((entry) => entry.capture)
            .join('\r\n');
        final model = PortalTerminalModel(
          platform: terminalPlatformFor(platform),
        )..replace(output);
        await tester.pumpWidget(
          MaterialApp(
            theme: ThemeData(platform: platform),
            home: PortalTerminalView(
              model: model,
              semanticsLabel: 'Reviewed console corpus',
            ),
          ),
        );
        await tester.pump();

        await expectLater(
          find.byType(PortalTerminalView),
          matchesGoldenFile('goldens/console_${platform.name}.png'),
        );
      },
    );
  }

  test(
    'ANSI attributes, Unicode widths, colors, and terminal modes are parsed',
    () {
      final model = PortalTerminalModel(
        platform: TerminalTargetPlatform.android,
      );
      model.replace(
        '\x1b]0;renderer corpus\x07'
        '\x1b[1;31mA\x1b[0m界'
        '\x1b[38;2;80;200;120mB\x1b[0m'
        '\x1b[?2004h',
      );

      final line = model.terminal.buffer.lines[0];
      expect(line.getAttributes(0) & CellAttr.bold, CellAttr.bold);
      expect(line.getForeground(0) & CellColor.typeMask, CellColor.named);
      expect(line.getForeground(0) & CellColor.valueMask, NamedColor.red);
      expect(line.getWidth(1), 2);
      expect(line.getWidth(2), 0);
      expect(line.getForeground(3) & CellColor.typeMask, CellColor.rgb);
      expect(line.getForeground(3) & CellColor.valueMask, 0x50C878);
      expect(model.title, 'renderer corpus');
      expect(model.terminal.bracketedPasteMode, isTrue);

      model.append('\x1b[?1049hALT');
      expect(model.terminal.isUsingAltBuffer, isTrue);
      expect(model.normalizedText, contains('ALT'));
      model.append('\x1b[?1049l\x1b[?2004l');
      expect(model.terminal.isUsingAltBuffer, isFalse);
      expect(model.terminal.bracketedPasteMode, isFalse);
    },
  );

  test('selection returns the exact normalized buffer range', () {
    final model = PortalTerminalModel(platform: TerminalTargetPlatform.ios);
    model.replace('select me\r\n');
    final controller = TerminalController();
    controller.setSelection(
      model.terminal.buffer.createAnchor(0, 0),
      model.terminal.buffer.createAnchor(9, 0),
    );

    expect(model.terminal.buffer.getText(controller.selection), 'select me');
  });

  test('screen-reader projection is recent, bounded, and Unicode-safe', () {
    final model = PortalTerminalModel(platform: TerminalTargetPlatform.ios);
    model.replace(
      '${List.filled(3000, 'old\r\n').join()}👩🏽‍💻 recent output\r\n',
    );

    expect(
      model.accessibleText.length,
      lessThanOrEqualTo(portalTerminalSemanticsCharacters + 22),
    );
    expect(model.accessibleText, startsWith('Recent console output\n'));
    expect(model.accessibleText, endsWith('👩🏽‍💻 recent output'));
    final firstProjectedCodeUnit = model.accessibleText.codeUnitAt(
      'Recent console output\n'.length,
    );
    expect(firstProjectedCodeUnit, isNot(inInclusiveRange(0xDC00, 0xDFFF)));
  });

  test(
    'stateful UTF-8 and escape parsing survives arbitrary byte boundaries',
    () {
      final model = PortalTerminalModel(
        platform: TerminalTargetPlatform.android,
      );
      final bytes = utf8.encode('prefix 👩🏽‍💻 \x1b[31mred\x1b[0m');

      for (final byte in bytes) {
        model.appendBytes([byte]);
      }

      expect(model.normalizedText, 'prefix 👩🏽‍💻 red');
      expect(model.normalizedText, isNot(contains('�')));
      final line = model.terminal.buffer.lines[0];
      final redStart = List.generate(
        line.length,
        line.getCodePoint,
      ).lastIndexOf('r'.codeUnitAt(0));
      expect(redStart, greaterThanOrEqualTo(0));
      expect(
        line.getForeground(redStart) & CellColor.valueMask,
        NamedColor.red,
      );
    },
  );

  test('bounded burst stays responsive and scrollback remains capped', () {
    final model = PortalTerminalModel(
      platform: TerminalTargetPlatform.android,
      maxLines: 5000,
    );
    final burst = List.generate(
      60000,
      (index) => 'chunk-$index ✓ 漢字\r\n',
    ).join();
    final burstBytes = utf8.encode(burst);
    final rssBefore = ProcessInfo.currentRss;
    final stopwatch = Stopwatch()..start();
    for (var offset = 0; offset < burstBytes.length; offset += 4093) {
      final end = offset + 4093 < burstBytes.length
          ? offset + 4093
          : burstBytes.length;
      model.appendBytes(burstBytes.sublist(offset, end));
    }
    stopwatch.stop();
    final rssDelta = ProcessInfo.currentRss - rssBefore;

    expect(stopwatch.elapsed, lessThan(const Duration(seconds: 5)));
    expect(model.terminal.mainBuffer.height, lessThanOrEqualTo(5000));
    expect(rssDelta, lessThan(64 * 1024 * 1024));
    expect(model.normalizedText, endsWith('chunk-59999 ✓ 漢字'));
    // ignore: avoid_print
    print(
      'PORTAL_RENDERER_BURST_MS=${stopwatch.elapsedMilliseconds} bytes=${burstBytes.length} chunks=${(burstBytes.length / 4093).ceil()} lines=${model.terminal.mainBuffer.height} rssDelta=$rssDelta',
    );
  });

  testWidgets(
    'rotation, lifecycle, reconnect, and resync preserve an accessible read-only view',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final model = PortalTerminalModel(
        platform: TerminalTargetPlatform.android,
      );
      Widget app() => MaterialApp(
        theme: ThemeData(platform: TargetPlatform.android),
        home: Scaffold(
          body: PortalTerminalView(
            model: model,
            semanticsLabel: 'Read-only agent console',
          ),
        ),
      );

      model.replace('before reconnect\r\n');
      await tester.pumpWidget(app());
      expect(find.byType(TerminalView), findsOneWidget);
      expect(find.bySemanticsLabel('Read-only agent console'), findsOneWidget);

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.binding.setSurfaceSize(const Size(844, 390));
      model.append('after reconnect\r\n');
      await tester.pumpWidget(app());
      expect(tester.takeException(), isNull);

      model.replace('fresh snapshot after resync\r\n');
      await tester.pumpWidget(app());
      await tester.pump();
      final semantics = tester.getSemantics(
        find.bySemanticsLabel('Read-only agent console'),
      );
      expect(semantics.value, contains('fresh snapshot after resync'));
      expect(semantics.value, isNot(contains('before reconnect')));
    },
  );
}
