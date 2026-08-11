import 'dart:convert';

import 'package:daintree_portal/pairing/pairing_bootstrap.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'parses a strict compatible pairing bootstrap without exposing alternate endpoints',
    () {
      final bootstrap = PairingBootstrap.parse(jsonEncode(_validBootstrap()));

      expect(bootstrap.hostId, 'host-01');
      expect(bootstrap.endpointHints, ['wss://192.168.1.5:45123']);
      expect(bootstrap.verificationCode, '381902');
      expect(bootstrap.expired, isFalse);
    },
  );

  test(
    'fails closed for expired, incompatible, or weakly identified bootstraps',
    () {
      expect(
        PairingBootstrap.parse(
          jsonEncode({..._validBootstrap(), 'expiresAt': 1}),
        ).expired,
        isTrue,
      );
      expect(
        () => PairingBootstrap.parse(
          jsonEncode({
            ..._validBootstrap(),
            'protocol': {'min': 2, 'max': 2},
          }),
        ),
        throwsFormatException,
      );
      expect(
        () => PairingBootstrap.parse(
          jsonEncode({..._validBootstrap(), 'verificationCode': '123'}),
        ),
        throwsFormatException,
      );
      expect(
        () => PairingBootstrap.parse(
          jsonEncode({
            ..._validBootstrap(),
            'redirectUrl': 'https://example.com',
          }),
        ),
        throwsFormatException,
      );
    },
  );
}

Map<String, Object> _validBootstrap() => {
  'pairingId': 'pair-01',
  'oneTimeSecret': List.filled(43, 's').join(),
  'expiresAt': DateTime.now()
      .add(const Duration(minutes: 3))
      .millisecondsSinceEpoch,
  'host': {
    'hostId': 'host-01',
    'publicKey': '-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----\n',
    'fingerprint': 'sha256:${List.filled(43, 'h').join()}',
    'createdAt': 1,
  },
  'tlsCertificateFingerprint': 'sha256:${List.filled(43, 't').join()}',
  'endpointHints': ['wss://192.168.1.5:45123'],
  'protocol': {'min': 1, 'max': 1},
  'verificationCode': '381902',
};
