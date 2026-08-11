import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';

class DeviceIdentity {
  const DeviceIdentity({
    required this.deviceId,
    required this.privateKey,
    required this.publicKey,
  });

  final String deviceId;
  final List<int> privateKey;
  final List<int> publicKey;

  String get publicKeyPem {
    const ed25519SpkiPrefix = <int>[
      0x30,
      0x2a,
      0x30,
      0x05,
      0x06,
      0x03,
      0x2b,
      0x65,
      0x70,
      0x03,
      0x21,
      0x00,
    ];
    final encoded = base64.encode([...ed25519SpkiPrefix, ...publicKey]);
    final lines = <String>[];
    for (var offset = 0; offset < encoded.length; offset += 64) {
      lines.add(
        encoded.substring(offset, (offset + 64).clamp(0, encoded.length)),
      );
    }
    return '-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n';
  }

  Future<String> sign(String message) async {
    final keyPair = SimpleKeyPairData(
      privateKey,
      publicKey: SimplePublicKey(publicKey, type: KeyPairType.ed25519),
      type: KeyPairType.ed25519,
    );
    final signature = await Ed25519().sign(
      utf8.encode(message),
      keyPair: keyPair,
    );
    return base64Url.encode(signature.bytes).replaceAll('=', '');
  }
}

abstract interface class ProtectedValueStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class PlatformProtectedValueStore implements ProtectedValueStore {
  PlatformProtectedValueStore({FlutterSecureStorage? storage})
    : _storage =
          storage ??
          const FlutterSecureStorage(
            aOptions: AndroidOptions(
              resetOnError: false,
              migrateWithBackup: true,
            ),
            iOptions: IOSOptions(
              accessibility: KeychainAccessibility.first_unlock_this_device,
            ),
          );

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

class DeviceIdentityStore {
  DeviceIdentityStore(this.values, {Ed25519? algorithm, Uuid? uuid})
    : _algorithm = algorithm ?? Ed25519(),
      _uuid = uuid ?? const Uuid();

  static const _deviceIdKey = 'portal.device.id.v1';
  static const _privateKey = 'portal.device.ed25519.private.v1';
  static const _publicKey = 'portal.device.ed25519.public.v1';

  final ProtectedValueStore values;
  final Ed25519 _algorithm;
  final Uuid _uuid;

  Future<DeviceIdentity> loadOrCreate() async {
    final storedId = await values.read(_deviceIdKey);
    final storedPrivate = await values.read(_privateKey);
    final storedPublic = await values.read(_publicKey);
    if (storedId != null && storedPrivate != null && storedPublic != null) {
      return DeviceIdentity(
        deviceId: storedId,
        privateKey: base64Url.decode(base64Url.normalize(storedPrivate)),
        publicKey: base64Url.decode(base64Url.normalize(storedPublic)),
      );
    }
    if (storedId != null || storedPrivate != null || storedPublic != null) {
      await clear();
    }
    final pair = await _algorithm.newKeyPair();
    final privateBytes = await pair.extractPrivateKeyBytes();
    final publicKey = await pair.extractPublicKey();
    final identity = DeviceIdentity(
      deviceId: _uuid.v4(),
      privateKey: privateBytes,
      publicKey: publicKey.bytes,
    );
    await values.write(_deviceIdKey, identity.deviceId);
    await values.write(_privateKey, base64Url.encode(privateBytes));
    await values.write(_publicKey, base64Url.encode(publicKey.bytes));
    return identity;
  }

  Future<void> clear() async {
    await Future.wait([
      values.delete(_deviceIdKey),
      values.delete(_privateKey),
      values.delete(_publicKey),
    ]);
  }
}

class PairedHostCredential {
  const PairedHostCredential({
    required this.hostId,
    required this.displayName,
    required this.host,
    required this.port,
    required this.hostPublicKey,
    required this.hostFingerprint,
    required this.tlsFingerprint,
    required this.capabilities,
  });

  final String hostId;
  final String displayName;
  final String host;
  final int port;
  final String hostPublicKey;
  final String hostFingerprint;
  final String tlsFingerprint;
  final List<String> capabilities;

  Map<String, Object> toJson() => {
    'hostId': hostId,
    'displayName': displayName,
    'host': host,
    'port': port,
    'hostPublicKey': hostPublicKey,
    'hostFingerprint': hostFingerprint,
    'tlsFingerprint': tlsFingerprint,
    'capabilities': capabilities,
  };

  factory PairedHostCredential.fromJson(Map<String, dynamic> value) =>
      PairedHostCredential(
        hostId: value['hostId'] as String,
        displayName: value['displayName'] as String,
        host: value['host'] as String,
        port: value['port'] as int,
        hostPublicKey: value['hostPublicKey'] as String,
        hostFingerprint: value['hostFingerprint'] as String,
        tlsFingerprint: value['tlsFingerprint'] as String,
        capabilities: (value['capabilities'] as List).cast<String>(),
      );
}

class PairedHostStore {
  PairedHostStore(this.values);

  static const _key = 'portal.paired-hosts.v1';
  final ProtectedValueStore values;

  Future<List<PairedHostCredential>> load() async {
    final encoded = await values.read(_key);
    if (encoded == null) return const [];
    final decoded = jsonDecode(encoded);
    if (decoded is! List) {
      throw const FormatException('Invalid paired host data');
    }
    return decoded
        .map(
          (item) => PairedHostCredential.fromJson(
            (item as Map).cast<String, dynamic>(),
          ),
        )
        .toList(growable: false);
  }

  Future<void> save(PairedHostCredential credential) async {
    final hosts = await load();
    final updated = [
      credential,
      ...hosts.where((host) => host.hostId != credential.hostId),
    ];
    await values.write(
      _key,
      jsonEncode(updated.map((host) => host.toJson()).toList()),
    );
  }

  Future<void> forget(String hostId) async {
    final updated = (await load())
        .where((host) => host.hostId != hostId)
        .toList();
    if (updated.isEmpty) {
      await values.delete(_key);
    } else {
      await values.write(
        _key,
        jsonEncode(updated.map((host) => host.toJson()).toList()),
      );
    }
  }
}
