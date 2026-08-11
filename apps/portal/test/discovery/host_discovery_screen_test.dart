import 'package:daintree_portal/discovery/host_discovery_controller.dart';
import 'package:daintree_portal/discovery/host_discovery_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class EmptySession implements DiscoverySession {
  @override
  Future<void> stop() async {}
}

class EmptyAdapter implements DiscoveryAdapter {
  @override
  Future<DiscoverySession> start(
    void Function(DiscoveryEvent event) onEvent,
  ) async => EmptySession();
}

void main() {
  testWidgets(
    'offers local discovery and a keyboard-submittable manual connection path',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: HostDiscoveryScreen(
            controller: HostDiscoveryController(EmptyAdapter()),
          ),
        ),
      );
      await tester.pump();

      expect(find.text('Find a Daintree host'), findsOneWidget);
      expect(find.text('Connect manually'), findsOneWidget);
      expect(find.byType(TextField), findsOneWidget);
      final buttonSize = tester.getSize(
        find.widgetWithText(FilledButton, 'Connect manually'),
      );
      expect(buttonSize.height, greaterThanOrEqualTo(48));

      await tester.enterText(find.byType(TextField), 'vpn-host.internal:46000');
      await tester.ensureVisible(find.text('Connect manually'));
      await tester.tap(find.text('Connect manually'));
      await tester.pump();
      expect(find.text('vpn-host.internal'), findsOneWidget);
    },
  );
}
