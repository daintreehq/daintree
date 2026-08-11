import 'dart:io';

import 'package:flutter/material.dart';

import 'discovery/discovered_host.dart';
import 'discovery/host_discovery_controller.dart';
import 'discovery/host_discovery_screen.dart';
import 'pairing/pairing_controller.dart';
import 'pairing/pairing_screen.dart';
import 'portal/portal_controller.dart';
import 'portal/portal_shell.dart';
import 'security/device_identity_store.dart';
import 'transport/remote_protocol_client.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const DaintreePortalApp());
}

class DaintreePortalApp extends StatelessWidget {
  const DaintreePortalApp({super.key});

  @override
  Widget build(BuildContext context) {
    const ink = Color(0xFF17211B);
    const moss = Color(0xFF315C45);
    const paper = Color(0xFFF2F1E9);
    final scheme = ColorScheme.fromSeed(
      seedColor: moss,
      brightness: Brightness.light,
      surface: paper,
    );
    final theme = ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: paper,
      fontFamily: 'Avenir Next',
      textTheme: ThemeData.light().textTheme.apply(
        bodyColor: ink,
        displayColor: ink,
        fontFamilyFallback: const ['Inter', 'sans-serif'],
      ),
      visualDensity: VisualDensity.standard,
      inputDecorationTheme: const InputDecorationTheme(
        border: OutlineInputBorder(),
      ),
    );
    return MaterialApp(
      title: 'Daintree Portal',
      debugShowCheckedModeBanner: false,
      theme: theme,
      highContrastTheme: theme.copyWith(
        colorScheme: scheme.copyWith(
          outline: Colors.black,
          surfaceContainerHighest: Colors.white,
        ),
        dividerTheme: const DividerThemeData(
          color: Colors.black,
          thickness: 1.5,
        ),
      ),
      home: PortalEntryScreen(valueStore: PlatformProtectedValueStore()),
    );
  }
}

class PortalEntryScreen extends StatefulWidget {
  const PortalEntryScreen({required this.valueStore, super.key});

  final ProtectedValueStore valueStore;

  @override
  State<PortalEntryScreen> createState() => _PortalEntryScreenState();
}

class _PortalEntryScreenState extends State<PortalEntryScreen> {
  late final PairedHostStore hostStore = PairedHostStore(widget.valueStore);
  late final DeviceIdentityStore identityStore = DeviceIdentityStore(
    widget.valueStore,
  );
  List<PairedHostCredential>? hosts;
  String? loadError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final result = await hostStore.load();
      if (mounted) {
        setState(() => hosts = result);
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => loadError = 'Unlock protected device storage, then retry',
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 920),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(22, 32, 22, 24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'DAINTREE / PORTAL',
                  style: TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 1.8,
                  ),
                ),
                const SizedBox(height: 14),
                Text(
                  'Your Daintree hosts',
                  style: Theme.of(context).textTheme.headlineLarge?.copyWith(
                    fontWeight: FontWeight.w700,
                    letterSpacing: -1,
                  ),
                ),
                const SizedBox(height: 8),
                const Text('Continue an agent from this private network'),
                const SizedBox(height: 26),
                if (loadError != null)
                  MaterialBanner(
                    content: Text(loadError!),
                    actions: [
                      TextButton(onPressed: _load, child: const Text('Retry')),
                    ],
                  ),
                Expanded(child: _hostList()),
                const SizedBox(height: 14),
                Row(
                  children: [
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: _showPairing,
                        icon: const Icon(Icons.qr_code_scanner_rounded),
                        label: const Text('Pair a new host'),
                        style: FilledButton.styleFrom(
                          minimumSize: const Size.fromHeight(52),
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: _showDiscovery,
                        icon: const Icon(Icons.radar_rounded),
                        label: const Text('Find nearby'),
                        style: OutlinedButton.styleFrom(
                          minimumSize: const Size.fromHeight(52),
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );

  Widget _hostList() {
    final values = hosts;
    if (values == null) {
      return Center(
        child: MediaQuery.disableAnimationsOf(context)
            ? const Icon(Icons.hourglass_top_rounded, size: 30)
            : const CircularProgressIndicator(),
      );
    }
    if (values.isEmpty) {
      return const Center(child: _EntryEmptyState());
    }
    return ListView.separated(
      itemCount: values.length,
      separatorBuilder: (_, _) => const SizedBox(height: 10),
      itemBuilder: (context, index) {
        final host = values[index];
        return Semantics(
          button: true,
          label: '${host.displayName}, paired host',
          child: Card(
            clipBehavior: Clip.antiAlias,
            child: ListTile(
              minTileHeight: 74,
              leading: const CircleAvatar(child: Icon(Icons.computer_rounded)),
              title: Text(
                host.displayName,
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              subtitle: Text('${host.host}:${host.port}'),
              trailing: IconButton(
                icon: const Icon(Icons.more_vert_rounded),
                tooltip: 'Host settings',
                onPressed: () => _showHostSettings(host),
              ),
              onTap: () => _openHost(host),
            ),
          ),
        );
      },
    );
  }

  void _openHost(PairedHostCredential credential) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => PortalShell(
          controller: PortalController(
            credential: credential,
            identityStore: identityStore,
            client: RemoteProtocolClient(),
          ),
        ),
      ),
    );
  }

  Future<void> _showHostSettings(PairedHostCredential host) async {
    final forget = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text("Forget '${host.displayName}'?"),
        content: const Text(
          'Protected credentials for this host will be removed from this device. Pair again to reconnect.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Forget host'),
          ),
        ],
      ),
    );
    if (forget == true) {
      await hostStore.forget(host.hostId);
      await _load();
    }
  }

  void _showPairing() {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => PairingScreen(
          controller: PairingController(
            identityStore: identityStore,
            hostStore: hostStore,
            client: RemoteProtocolClient(),
            platform: Platform.isIOS ? 'ios' : 'android',
          ),
          onPaired: (credential) {
            Navigator.pop(context);
            _load();
            _openHost(credential);
          },
        ),
      ),
    );
  }

  void _showDiscovery() {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (routeContext) => HostDiscoveryScreen(
          controller: HostDiscoveryController(NsdDiscoveryAdapter()),
          onScanPairing: () {
            Navigator.pop(routeContext);
            _showPairing();
          },
          onHostSelected: (host) => _openDiscovered(host, routeContext),
        ),
      ),
    );
  }

  void _openDiscovered(DiscoveredHost discovered, BuildContext routeContext) {
    final matches = (hosts ?? const <PairedHostCredential>[]).where((host) {
      if (discovered.manual) return host.host == discovered.host;
      return host.hostId == discovered.id &&
          host.tlsFingerprint.startsWith(
            'sha256:${discovered.fingerprintPrefix}',
          );
    }).toList();
    if (matches.length != 1) {
      ScaffoldMessenger.of(routeContext).showSnackBar(
        SnackBar(
          content: Text(
            discovered.manual
                ? 'Pair this host before connecting to a new address'
                : 'Pair this host to verify its full identity',
          ),
          action: SnackBarAction(
            label: 'Pair',
            onPressed: () {
              Navigator.pop(routeContext);
              _showPairing();
            },
          ),
        ),
      );
      return;
    }
    final trusted = matches.single;
    final endpoint = PairedHostCredential(
      hostId: trusted.hostId,
      displayName: trusted.displayName,
      host: discovered.host,
      port: discovered.port,
      hostPublicKey: trusted.hostPublicKey,
      hostFingerprint: trusted.hostFingerprint,
      tlsFingerprint: trusted.tlsFingerprint,
      capabilities: trusted.capabilities,
    );
    Navigator.pop(routeContext);
    _openHost(endpoint);
  }
}

class _EntryEmptyState extends StatelessWidget {
  const _EntryEmptyState();

  @override
  Widget build(BuildContext context) => const Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      Icon(Icons.phonelink_lock_rounded, size: 44),
      SizedBox(height: 14),
      Text(
        'Pair your first host to continue an agent',
        textAlign: TextAlign.center,
      ),
    ],
  );
}
