import 'package:daintree_portal/console/portal_terminal.dart';
import 'package:daintree_portal/main.dart';
import 'package:daintree_portal/security/device_identity_store.dart';
import 'package:daintree_portal/theme/portal_appearance.dart';
import 'package:daintree_portal/theme/portal_icons.dart';
import 'package:daintree_portal/theme/portal_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class EmptyProtectedValues implements ProtectedValueStore {
  @override
  Future<void> delete(String key) async {}

  @override
  Future<String?> read(String key) async => null;

  @override
  Future<void> write(String key, String value) async {}
}

void main() {
  testWidgets('offline entry renders the generated Daintree visual hierarchy', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(900, 700));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(
      MaterialApp(
        theme: buildPortalTheme(generatedDaintreeAppearance),
        home: PortalEntryScreen(valueStore: EmptyProtectedValues()),
      ),
    );
    await tester.pumpAndSettle();

    final scaffold = tester.widget<Scaffold>(find.byType(Scaffold));
    expect(scaffold.backgroundColor, isNull);
    expect(
      Theme.of(tester.element(find.byType(Scaffold))).scaffoldBackgroundColor,
      generatedDaintreeAppearance.surfaces.canvas,
    );
    expect(
      tester
          .getSize(find.widgetWithText(FilledButton, 'Pair a new host'))
          .height,
      greaterThanOrEqualTo(48),
    );
    expect(find.bySemanticsLabel('Pair a new host'), findsWidgets);
    await expectLater(
      find.byType(PortalEntryScreen),
      matchesGoldenFile('goldens/offline_entry.png'),
    );
  });

  testWidgets(
    'console maps every generated terminal role and retains high-contrast selection',
    (tester) async {
      late BuildContext context;
      await tester.pumpWidget(
        MaterialApp(
          theme: buildPortalTheme(generatedDaintreeAppearance),
          home: Builder(
            builder: (value) {
              context = value;
              return const SizedBox();
            },
          ),
        ),
      );

      final appearance = generatedDaintreeAppearance;
      final standard = buildPortalTerminalTheme(context, highContrast: false);
      final highContrast = buildPortalTerminalTheme(
        context,
        highContrast: true,
      );
      expect(standard.background, appearance.terminal.background);
      expect(standard.foreground, appearance.terminal.foreground);
      expect(standard.cursor, appearance.terminal.cursor);
      expect(standard.selection, appearance.terminal.selection);
      expect(standard.red, appearance.terminal.red);
      expect(standard.green, appearance.terminal.green);
      expect(standard.yellow, appearance.terminal.yellow);
      expect(standard.blue, appearance.terminal.blue);
      expect(standard.magenta, appearance.terminal.magenta);
      expect(standard.cyan, appearance.terminal.cyan);
      expect(standard.brightWhite, appearance.terminal.brightWhite);
      expect(highContrast.selection, appearance.accent.muted);
    },
  );

  test('technical typography and app concepts retain bundled fallbacks', () {
    expect(portalTerminalStyle.fontFamily, portalTechnicalFontFamily);
    expect(portalTerminalStyle.fontFamilyFallback, contains('monospace'));
    expect(PortalIcons.host.fontFamily, 'Lucide');
    expect(PortalIcons.terminal.fontPackage, 'lucide_icons_flutter');
  });
}
