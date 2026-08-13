import 'dart:convert';

import 'package:daintree_portal/discovery/discovered_host.dart';
import 'package:daintree_portal/discovery/host_discovery_controller.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nsd/nsd.dart' as nsd;

void main() {
  test('emits services resolved before the listener was attached', () async {
    final discovery = nsd.Discovery('existing-service');
    discovery.add(
      nsd.Service(
        name: 'Studio Mac',
        type: daintreePortalServiceType,
        host: 'studio.local',
        port: 45123,
        txt: {'id': utf8.encode('host-1')},
      ),
    );
    final events = <DiscoveryEvent>[];
    final adapter = NsdDiscoveryAdapter(
      startDiscovery: (_) async => discovery,
      stopDiscovery: (_) async {},
    );

    await adapter.start(events.add);

    expect(events, hasLength(1));
    expect(events.single.status, DiscoveryEventStatus.found);
    expect(events.single.service.name, 'Studio Mac');
  });

  test(
    'maps platform security failures to the actionable permission state',
    () async {
      final adapter = NsdDiscoveryAdapter(
        startDiscovery: (_) async => throw nsd.NsdError(
          nsd.ErrorCause.securityIssue,
          'permission denied',
        ),
      );

      await expectLater(
        adapter.start((_) {}),
        throwsA(isA<DiscoveryPermissionException>()),
      );
    },
  );

  test(
    'preserves non-permission platform failures for generic network recovery',
    () async {
      final adapter = NsdDiscoveryAdapter(
        startDiscovery: (_) async =>
            throw nsd.NsdError(nsd.ErrorCause.internalError, 'network changed'),
      );

      await expectLater(adapter.start((_) {}), throwsA(isA<nsd.NsdError>()));
    },
  );
}
