import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'iOS declares local-network purpose and only the Portal Bonjour service',
    () {
      final plist = File('ios/Runner/Info.plist').readAsStringSync();
      expect(plist, contains('<key>NSLocalNetworkUsageDescription</key>'));
      expect(plist, contains('<key>NSCameraUsageDescription</key>'));
      expect(plist, contains('<key>NSBonjourServices</key>'));
      expect(
        RegExp(r'<string>_daintree-portal\._tcp</string>').allMatches(plist),
        hasLength(1),
      );
      final project = File(
        'ios/Runner.xcodeproj/project.pbxproj',
      ).readAsStringSync();
      expect(
        RegExp(
          r'CODE_SIGN_ENTITLEMENTS = Runner/DebugProfile\.entitlements;',
        ).allMatches(project),
        hasLength(2),
      );
      expect(
        project,
        contains('CODE_SIGN_ENTITLEMENTS = Runner/Release.entitlements;'),
      );
      for (final name in [
        'DebugProfile.entitlements',
        'Release.entitlements',
      ]) {
        final entitlements = File('ios/Runner/$name').readAsStringSync();
        expect(entitlements, contains('<key>keychain-access-groups</key>'));
      }
    },
  );

  test(
    'Android declares multicast and nearby-network access without location use',
    () {
      final manifest = File(
        'android/app/src/main/AndroidManifest.xml',
      ).readAsStringSync();
      expect(manifest, contains('android.permission.INTERNET'));
      expect(manifest, contains('android.permission.CAMERA'));
      expect(manifest, contains('android:allowBackup="false"'));
      expect(
        manifest,
        contains('android.permission.CHANGE_WIFI_MULTICAST_STATE'),
      );
      expect(manifest, contains('android.permission.NEARBY_WIFI_DEVICES'));
      expect(
        manifest,
        contains('android:usesPermissionFlags="neverForLocation"'),
      );
    },
  );
}
