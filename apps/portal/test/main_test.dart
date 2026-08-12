import 'package:daintree_portal/main.dart';
import 'package:daintree_portal/security/device_identity_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'security/device_identity_store_test.dart';

void main() {
  testWidgets(
    'host settings rename the local alias without replacing trust pins',
    (tester) async {
      final values = MemoryProtectedValues();
      final store = PairedHostStore(values);
      final credential = PairedHostCredential(
        hostId: 'host-01',
        displayName: 'Daintree host',
        host: '192.168.1.5',
        port: 45123,
        hostPublicKey: 'public-key',
        hostFingerprint: 'sha256:${List.filled(43, 'h').join()}',
        tlsFingerprint: 'sha256:${List.filled(43, 't').join()}',
        capabilities: const ['observe-projects'],
      );
      await store.save(credential);

      await tester.pumpWidget(
        MaterialApp(home: PortalEntryScreen(valueStore: values)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Host settings'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextField, 'Host name'),
        'Travel Mac',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Save name'));
      await tester.pumpAndSettle();

      expect(find.text('Travel Mac'), findsOneWidget);
      final renamed = (await store.load()).single;
      expect(renamed.hostFingerprint, credential.hostFingerprint);
      expect(renamed.tlsFingerprint, credential.tlsFingerprint);
    },
  );
}
