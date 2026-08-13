import 'dart:convert';

import 'package:daintree_portal/pairing/pairing_controller.dart';
import 'package:daintree_portal/security/device_identity_store.dart';
import 'package:daintree_portal/transport/remote_protocol_client.dart';
import 'package:flutter_test/flutter_test.dart';
import '../security/device_identity_store_test.dart';

class FakePairingClient extends RemoteProtocolClient {
  final requests = <String>[];
  final responses = <Map<String, dynamic>>[];
  List<String> approvedCapabilities = const [
    'observe-projects',
    'prompt-agents',
  ];
  bool approvalAvailable = false;

  @override
  Future<void> open(Uri endpoint, String tlsFingerprint) async {}

  @override
  Future<Map<String, dynamic>> request(
    String type,
    Map<String, Object?> payload, {
    Duration timeout = const Duration(seconds: 12),
  }) async {
    requests.add(type);
    return responses.removeAt(0);
  }

  @override
  Future<RemoteAuthenticationResult> authenticate({
    required DeviceIdentity identity,
    required String hostPublicKey,
    required String hostFingerprint,
    String? resumeSessionId,
  }) async {
    if (!approvalAvailable) {
      throw const RemoteProtocolException(
        'AUTHENTICATION_FAILED',
        'Approval is still pending',
      );
    }
    return RemoteAuthenticationResult(capabilities: approvedCapabilities);
  }

  @override
  Future<void> close() async {}
}

void main() {
  test(
    'requires the host response to match the QR verification code',
    () async {
      final client = FakePairingClient()
        ..responses.add(
          _response('hosts.pair.verify', {
            'pairingId': 'pair-01',
            'verificationCode': '000000',
            'state': 'match-required',
          }),
        );
      final controller = _controller(client);

      await controller.scan(jsonEncode(_bootstrap()));

      expect(controller.phase, PairingPhase.failed);
      expect(controller.errorMessage, contains('does not match'));
    },
  );

  test(
    'retains an explicit approval wait and saves only after authenticated reconnect',
    () async {
      final client = FakePairingClient()
        ..responses.addAll([
          _response('hosts.pair.verify', {
            'pairingId': 'pair-01',
            'verificationCode': '381902',
            'state': 'match-required',
          }),
          _response('hosts.pair.verify', {
            'pairingId': 'pair-01',
            'verificationCode': '381902',
            'state': 'awaiting-approval',
          }),
        ]);
      final values = MemoryProtectedValues();
      final controller = _controller(client, values: values);

      await controller.scan(jsonEncode(_bootstrap()));
      expect(controller.phase, PairingPhase.verifyIdentity);
      await controller.confirmMatchingCode();
      expect(controller.phase, PairingPhase.awaitingApproval);
      expect(await controller.checkApproval(), isNull);
      expect(await PairedHostStore(values).load(), isEmpty);

      client.approvalAvailable = true;
      final credential = await controller.checkApproval(
        displayName: 'Studio Mac',
      );
      expect(controller.phase, PairingPhase.paired);
      expect(credential?.displayName, 'Studio Mac');
      expect(
        (await PairedHostStore(values).load()).single.tlsFingerprint,
        _bootstrap()['tlsCertificateFingerprint'],
      );
      expect(client.requests, ['hosts.pair.begin', 'hosts.pair.verify']);
    },
  );

  test('rejects pairing endpoints outside private network ranges', () async {
    final client = FakePairingClient();
    final controller = _controller(client);

    await controller.scan(
      jsonEncode({
        ..._bootstrap(),
        'endpointHints': ['wss://8.8.8.8:45123'],
      }),
    );

    expect(controller.phase, PairingPhase.failed);
    expect(controller.errorMessage, contains('private-network endpoint'));
    expect(client.requests, isEmpty);
  });

  test(
    're-pairing rejects a different host before opening a connection',
    () async {
      final client = FakePairingClient();
      final controller = _controller(
        client,
        replacingHost: _existingHost(accessRevoked: true),
      );

      await controller.scan(
        jsonEncode({
          ..._bootstrap(),
          'host': {..._bootstrap()['host'] as Map, 'hostId': 'host-02'},
        }),
      );

      expect(controller.phase, PairingPhase.failed);
      expect(controller.errorMessage, contains('different Daintree host'));
      expect(client.requests, isEmpty);
    },
  );

  test(
    're-pairing preserves the host alias and clears revoked state',
    () async {
      final client = FakePairingClient()
        ..approvalAvailable = true
        ..responses.addAll([
          _response('hosts.pair.verify', {
            'pairingId': 'pair-01',
            'verificationCode': '381902',
            'state': 'match-required',
          }),
          _response('hosts.pair.verify', {
            'pairingId': 'pair-01',
            'verificationCode': '381902',
            'state': 'awaiting-approval',
          }),
        ]);
      final controller = _controller(
        client,
        replacingHost: _existingHost(accessRevoked: true),
      );

      await controller.scan(jsonEncode(_bootstrap()));
      await controller.confirmMatchingCode();
      final credential = await controller.checkApproval(displayName: 'Ignored');

      expect(credential?.displayName, 'Studio Mac');
      expect(credential?.accessRevoked, isFalse);
    },
  );
}

PairingController _controller(
  FakePairingClient client, {
  MemoryProtectedValues? values,
  PairedHostCredential? replacingHost,
}) {
  final protected = values ?? MemoryProtectedValues();
  return PairingController(
    identityStore: DeviceIdentityStore(protected),
    hostStore: PairedHostStore(protected),
    client: client,
    platform: 'ios',
    replacingHost: replacingHost,
  );
}

PairedHostCredential _existingHost({bool accessRevoked = false}) =>
    PairedHostCredential(
      hostId: 'host-01',
      displayName: 'Studio Mac',
      host: '192.168.1.5',
      port: 45123,
      hostPublicKey:
          '-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----\n',
      hostFingerprint: 'sha256:${List.filled(43, 'h').join()}',
      tlsFingerprint: 'sha256:${List.filled(43, 't').join()}',
      capabilities: const ['observe-projects'],
      accessRevoked: accessRevoked,
    );

Map<String, dynamic> _response(String type, Map<String, Object> payload) => {
  'protocolVersion': 1,
  'sessionId': 'session-01',
  'kind': 'response',
  'type': type,
  'requestId': 'request-01',
  'payload': payload,
};

Map<String, Object> _bootstrap() => {
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
