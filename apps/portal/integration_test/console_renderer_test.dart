import 'package:daintree_portal/console/portal_terminal.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import '../test/console/console_corpus.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('production console corpus renders on the mobile target', (
    tester,
  ) async {
    expect(
      defaultTargetPlatform,
      anyOf(TargetPlatform.android, TargetPlatform.iOS),
    );
    final platform = terminalPlatformFor(defaultTargetPlatform);

    for (final entry in representativeConsoleCorpus) {
      final model = PortalTerminalModel(platform: platform);
      model.replace(entry.capture);
      for (final expected in entry.expectedText) {
        expect(model.normalizedText, contains(expected));
      }
    }

    final combined = representativeConsoleCorpus
        .map((entry) => entry.capture)
        .join('\r\n');
    final model = PortalTerminalModel(platform: platform)..replace(combined);
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData(platform: defaultTargetPlatform),
        home: Scaffold(
          body: PortalTerminalView(
            model: model,
            semanticsLabel: 'Read-only production console',
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.byType(PortalTerminalView), findsOneWidget);
    expect(
      find.bySemanticsLabel('Read-only production console'),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
}
