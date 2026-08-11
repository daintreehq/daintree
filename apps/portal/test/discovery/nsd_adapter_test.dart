import 'package:daintree_portal/discovery/host_discovery_controller.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nsd/nsd.dart' as nsd;

void main() {
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
