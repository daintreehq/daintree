import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:daintree_portal/security/device_identity_store.dart';
import 'package:flutter_test/flutter_test.dart';

class MemoryProtectedValues implements ProtectedValueStore {
  final values = <String, String>{};

  @override
  Future<void> delete(String key) async => values.remove(key);

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;
}

void main() {
  test(
    'creates one stable signing identity entirely in protected storage',
    () async {
      final values = MemoryProtectedValues();
      final store = DeviceIdentityStore(values);
      final created = await store.loadOrCreate();
      final restored = await DeviceIdentityStore(values).loadOrCreate();

      expect(restored.deviceId, created.deviceId);
      expect(restored.privateKey, created.privateKey);
      expect(restored.publicKey, created.publicKey);
      expect(created.publicKeyPem, startsWith('-----BEGIN PUBLIC KEY-----'));
      expect(values.values.values.join(), isNot(contains('BEGIN PRIVATE KEY')));

      const message = 'pairing-id.device-id.381902';
      final signature = Signature(
        base64Url.decode(base64Url.normalize(await restored.sign(message))),
        publicKey: SimplePublicKey(
          restored.publicKey,
          type: KeyPairType.ed25519,
        ),
      );
      expect(
        await Ed25519().verify(utf8.encode(message), signature: signature),
        isTrue,
      );
    },
  );

  test(
    'replaces an incomplete identity instead of mixing key generations',
    () async {
      final values = MemoryProtectedValues();
      values.values['portal.device.id.v1'] = 'orphaned-device';

      final identity = await DeviceIdentityStore(values).loadOrCreate();

      expect(identity.deviceId, isNot('orphaned-device'));
      expect(values.values.length, 3);
    },
  );

  test(
    'paired host records preserve trust pins and replace stale endpoints by host identity',
    () async {
      final values = MemoryProtectedValues();
      final store = PairedHostStore(values);
      final first = _credential(host: '192.168.1.5');
      final moved = _credential(host: 'daintree.internal');

      await store.save(first);
      await store.save(moved);
      final restored = await store.load();

      expect(restored, hasLength(1));
      expect(restored.single.host, 'daintree.internal');
      expect(restored.single.hostFingerprint, first.hostFingerprint);
      expect(restored.single.capabilities, contains('prompt-agents'));
    },
  );
}

PairedHostCredential _credential({required String host}) =>
    PairedHostCredential(
      hostId: 'host-01',
      displayName: 'Studio Mac',
      host: host,
      port: 45123,
      hostPublicKey: 'public-key',
      hostFingerprint: 'sha256:${List.filled(43, 'h').join()}',
      tlsFingerprint: 'sha256:${List.filled(43, 't').join()}',
      capabilities: const ['observe-projects', 'prompt-agents'],
    );
