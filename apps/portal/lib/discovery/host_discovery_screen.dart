import 'package:flutter/material.dart';

import 'discovered_host.dart';
import 'host_discovery_controller.dart';

class HostDiscoveryScreen extends StatefulWidget {
  const HostDiscoveryScreen({
    required this.controller,
    this.onHostSelected,
    this.onScanPairing,
    super.key,
  });

  final HostDiscoveryController controller;
  final ValueChanged<DiscoveredHost>? onHostSelected;
  final VoidCallback? onScanPairing;

  @override
  State<HostDiscoveryScreen> createState() => _HostDiscoveryScreenState();
}

class _HostDiscoveryScreenState extends State<HostDiscoveryScreen>
    with WidgetsBindingObserver {
  final endpointController = TextEditingController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.addListener(_refresh);
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => widget.controller.start(),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(_refresh);
    widget.controller.dispose();
    endpointController.dispose();
    super.dispose();
  }

  void _refresh() => setState(() {});

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      widget.controller.start();
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      widget.controller.pause();
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            final horizontal = constraints.maxWidth >= 760;
            final discoveryPanel = _DiscoveryPanel(
              controller: controller,
              onHostSelected: widget.onHostSelected,
            );
            final manualPanel = _ManualPanel(
              endpointController: endpointController,
              onConnect: _addManual,
            );
            return Padding(
              padding: EdgeInsets.fromLTRB(
                constraints.maxWidth < 500 ? 20 : 42,
                32,
                constraints.maxWidth < 500 ? 20 : 42,
                24,
              ),
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
                    'Find a Daintree host',
                    style: Theme.of(context).textTheme.headlineLarge?.copyWith(
                      fontWeight: FontWeight.w700,
                      letterSpacing: -1.1,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Portal looks only on this local network. Trust is verified when you pair.',
                    style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                      color: const Color(0xFF566159),
                    ),
                  ),
                  const SizedBox(height: 30),
                  if (widget.onScanPairing != null) ...[
                    FilledButton.icon(
                      onPressed: widget.onScanPairing,
                      icon: const Icon(Icons.qr_code_scanner_rounded),
                      label: const Text('Pair a new host'),
                      style: FilledButton.styleFrom(
                        minimumSize: const Size(180, 52),
                      ),
                    ),
                    const SizedBox(height: 22),
                  ],
                  Expanded(
                    child: horizontal
                        ? Row(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Expanded(flex: 3, child: discoveryPanel),
                              const SizedBox(width: 28),
                              Expanded(flex: 2, child: manualPanel),
                            ],
                          )
                        : ListView(
                            children: [
                              SizedBox(height: 340, child: discoveryPanel),
                              const SizedBox(height: 28),
                              SizedBox(height: 360, child: manualPanel),
                            ],
                          ),
                  ),
                ],
              ),
            );
          },
        ),
      ),
    );
  }

  void _addManual() {
    try {
      final host = widget.controller.addManual(endpointController.text);
      endpointController.clear();
      widget.onHostSelected?.call(host);
    } on FormatException catch (error) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(error.message.toString())));
    }
  }
}

class _DiscoveryPanel extends StatelessWidget {
  const _DiscoveryPanel({required this.controller, this.onHostSelected});

  final HostDiscoveryController controller;
  final ValueChanged<DiscoveredHost>? onHostSelected;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: const Color(0xFFE5E8DE),
        borderRadius: BorderRadius.circular(28),
        border: Border.all(color: const Color(0xFFC7CEC3)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Text(
                  'NEARBY',
                  style: TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 1.5,
                  ),
                ),
                const Spacer(),
                _StatusDot(active: controller.phase == DiscoveryPhase.scanning),
                const SizedBox(width: 8),
                Text(
                  controller.phase == DiscoveryPhase.scanning
                      ? 'Scanning'
                      : 'Paused',
                ),
              ],
            ),
            if (controller.recoveryMessage != null) ...[
              const SizedBox(height: 18),
              Material(
                color: const Color(0xFFFFE5C2),
                borderRadius: BorderRadius.circular(14),
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Row(
                    children: [
                      const Icon(Icons.wifi_off_rounded, size: 20),
                      const SizedBox(width: 10),
                      Expanded(child: Text(controller.recoveryMessage!)),
                      TextButton(
                        onPressed: controller.start,
                        child: const Text('Retry'),
                      ),
                    ],
                  ),
                ),
              ),
            ],
            const SizedBox(height: 14),
            Expanded(
              child: controller.hosts.isEmpty
                  ? const Center(
                      child: Text(
                        'Keep Daintree open with Remote access enabled',
                      ),
                    )
                  : ListView.separated(
                      itemCount: controller.hosts.length,
                      separatorBuilder: (_, _) => const Divider(height: 1),
                      itemBuilder: (context, index) => _HostRow(
                        host: controller.hosts[index],
                        onTap: onHostSelected,
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ManualPanel extends StatelessWidget {
  const _ManualPanel({
    required this.endpointController,
    required this.onConnect,
  });

  final TextEditingController endpointController;
  final VoidCallback onConnect;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: const Color(0xFF1D2A22),
        borderRadius: BorderRadius.circular(28),
      ),
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(
                Icons.route_rounded,
                color: Color(0xFFD5E8D4),
                size: 30,
              ),
              const SizedBox(height: 36),
              const Text(
                'Private network?',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 24,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'Connect by private DNS name or IP when multicast discovery cannot cross your VPN.',
                style: TextStyle(color: Color(0xFFB7C5BA), height: 1.45),
              ),
              const SizedBox(height: 20),
              TextField(
                controller: endpointController,
                style: const TextStyle(
                  color: Colors.white,
                  fontFamily: 'monospace',
                ),
                keyboardType: TextInputType.url,
                textInputAction: TextInputAction.go,
                onSubmitted: (_) => onConnect(),
                decoration: InputDecoration(
                  hintText: 'host.internal:45123',
                  hintStyle: const TextStyle(color: Color(0xFF7E9082)),
                  filled: true,
                  fillColor: const Color(0xFF27372D),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(14),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: onConnect,
                icon: const Icon(Icons.arrow_forward_rounded),
                label: const Text('Connect manually'),
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(52),
                  backgroundColor: const Color(0xFFD5E8D4),
                  foregroundColor: const Color(0xFF18231C),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _HostRow extends StatelessWidget {
  const _HostRow({required this.host, this.onTap});

  final DiscoveredHost host;
  final ValueChanged<DiscoveredHost>? onTap;

  @override
  Widget build(BuildContext context) {
    final state = switch (host.reachability) {
      HostReachability.available => 'Available',
      HostReachability.stale => 'No longer advertised',
      HostReachability.unreachable => 'Check connection',
      HostReachability.incompatible => 'Update required',
    };
    return Semantics(
      button: true,
      label: '${host.displayName}, $state',
      child: InkWell(
        onTap: host.reachability == HostReachability.available && onTap != null
            ? () => onTap!(host)
            : null,
        borderRadius: BorderRadius.circular(14),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 15, horizontal: 4),
          child: Row(
            children: [
              Container(
                width: 46,
                height: 46,
                decoration: BoxDecoration(
                  color: const Color(0xFFCCD8CB),
                  borderRadius: BorderRadius.circular(13),
                ),
                child: const Icon(Icons.computer_rounded),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      host.displayName,
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      state,
                      style: TextStyle(
                        color: host.reachability == HostReachability.available
                            ? const Color(0xFF315C45)
                            : const Color(0xFF6F5B3E),
                      ),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right_rounded),
            ],
          ),
        ),
      ),
    );
  }
}

class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.active});

  final bool active;

  @override
  Widget build(BuildContext context) => Container(
    width: 9,
    height: 9,
    decoration: BoxDecoration(
      shape: BoxShape.circle,
      color: active ? const Color(0xFF3E7A57) : const Color(0xFF8B918B),
    ),
  );
}
