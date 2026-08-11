import 'package:daintree_portal/main.dart';
import 'package:daintree_portal/security/device_identity_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

class IntegrationProtectedValues implements ProtectedValueStore {
  final data = <String, String>{};

  @override
  Future<void> delete(String key) async => data.remove(key);

  @override
  Future<String?> read(String key) async => data[key];

  @override
  Future<void> write(String key, String value) async => data[key] = value;
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'protected paired host state reaches the adaptive entry journey',
    (tester) async {
      final values = IntegrationProtectedValues();
      await PairedHostStore(values).save(
        PairedHostCredential(
          hostId: 'host-01',
          displayName: 'Studio Mac',
          host: '192.168.1.5',
          port: 45123,
          hostPublicKey: 'host-public-key',
          hostFingerprint: 'sha256:${List.filled(43, 'h').join()}',
          tlsFingerprint: 'sha256:${List.filled(43, 't').join()}',
          capabilities: const ['observe-projects', 'prompt-agents'],
        ),
      );

      await tester.pumpWidget(
        MaterialApp(home: PortalEntryScreen(valueStore: values)),
      );
      await tester.pumpAndSettle();

      expect(find.text('Studio Mac'), findsOneWidget);
      expect(find.text('192.168.1.5:45123'), findsOneWidget);
      expect(
        find.widgetWithText(FilledButton, 'Pair a new host'),
        findsOneWidget,
      );
      expect(
        find.widgetWithText(OutlinedButton, 'Find nearby'),
        findsOneWidget,
      );
      expect(find.bySemanticsLabel('Studio Mac, paired host'), findsOneWidget);

      await tester.tap(find.byTooltip('Host settings'));
      await tester.pumpAndSettle();
      expect(find.text("Forget 'Studio Mac'?"), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Forget host'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect((await PairedHostStore(values).load()).single.hostId, 'host-01');
    },
  );
}
