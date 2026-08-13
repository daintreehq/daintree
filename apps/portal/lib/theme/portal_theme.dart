import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'portal_appearance.dart';

const portalTechnicalFontFamily = 'JetBrains Mono';
const portalTechnicalFontFallback = [
  'SFMono-Regular',
  'Menlo',
  'Consolas',
  'monospace',
];

SystemUiOverlayStyle portalSystemUiOverlayStyle(PortalAppearance appearance) {
  final iconBrightness = appearance.brightness == Brightness.dark
      ? Brightness.light
      : Brightness.dark;
  return SystemUiOverlayStyle(
    statusBarColor: appearance.surfaces.toolbar,
    statusBarIconBrightness: iconBrightness,
    statusBarBrightness: appearance.brightness,
    systemNavigationBarColor: appearance.surfaces.canvas,
    systemNavigationBarIconBrightness: iconBrightness,
    systemNavigationBarDividerColor: appearance.borders.divider,
  );
}

class PortalSystemChrome extends StatelessWidget {
  const PortalSystemChrome({
    required this.appearance,
    required this.child,
    super.key,
  });

  final PortalAppearance appearance;
  final Widget child;

  @override
  Widget build(BuildContext context) => AnnotatedRegion<SystemUiOverlayStyle>(
    value: portalSystemUiOverlayStyle(appearance),
    child: child,
  );
}

class PortalAppearanceTheme extends ThemeExtension<PortalAppearanceTheme> {
  const PortalAppearanceTheme(this.appearance);

  final PortalAppearance appearance;

  @override
  PortalAppearanceTheme copyWith({PortalAppearance? appearance}) =>
      PortalAppearanceTheme(appearance ?? this.appearance);

  @override
  PortalAppearanceTheme lerp(PortalAppearanceTheme? other, double t) =>
      t < 0.5 || other == null ? this : other;
}

ThemeData buildPortalTheme(
  PortalAppearance appearance, {
  bool highContrast = false,
}) {
  final colors =
      (appearance.brightness == Brightness.dark
              ? const ColorScheme.dark()
              : const ColorScheme.light())
          .copyWith(
            primary: appearance.accent.primary,
            onPrimary: appearance.accent.foreground,
            primaryContainer: appearance.accent.soft,
            onPrimaryContainer: appearance.text.primary,
            secondary: appearance.status.info.foreground,
            onSecondary: appearance.text.inverse,
            secondaryContainer: appearance.status.info.surface,
            onSecondaryContainer: appearance.text.primary,
            error: appearance.status.danger.foreground,
            onError: appearance.text.inverse,
            errorContainer: appearance.status.danger.surface,
            onErrorContainer: appearance.text.primary,
            surface: appearance.surfaces.canvas,
            onSurface: appearance.text.primary,
            surfaceContainerLowest: appearance.surfaces.grid,
            surfaceContainerLow: appearance.surfaces.chrome,
            surfaceContainer: appearance.surfaces.panel,
            surfaceContainerHigh: appearance.surfaces.elevatedPanel,
            surfaceContainerHighest: appearance.surfaces.input,
            onSurfaceVariant: appearance.text.secondary,
            outline: highContrast
                ? appearance.borders.strong
                : appearance.borders.defaultColor,
            outlineVariant: highContrast
                ? appearance.borders.defaultColor
                : appearance.borders.subtle,
            shadow: appearance.terminal.black,
            scrim: appearance.terminal.black,
            inverseSurface: appearance.text.primary,
            onInverseSurface: appearance.text.inverse,
            inversePrimary: appearance.accent.primary,
          );
  final base = ThemeData(
    useMaterial3: true,
    brightness: appearance.brightness,
    colorScheme: colors,
    scaffoldBackgroundColor: appearance.surfaces.canvas,
    canvasColor: appearance.surfaces.panel,
    cardColor: appearance.surfaces.panel,
    dividerColor: highContrast
        ? appearance.borders.strong
        : appearance.borders.divider,
    disabledColor: appearance.text.muted,
    focusColor: appearance.accent.focusRing,
    hoverColor: appearance.surfaces.hover,
    highlightColor: appearance.surfaces.active,
    fontFamilyFallback: const ['Inter', 'sans-serif'],
    visualDensity: VisualDensity.standard,
    extensions: [PortalAppearanceTheme(appearance)],
  );
  final radius = BorderRadius.circular(12 * appearance.radiusScale);
  final border = OutlineInputBorder(
    borderRadius: radius,
    borderSide: BorderSide(color: colors.outline),
  );
  return base.copyWith(
    textTheme: base.textTheme.apply(
      bodyColor: appearance.text.primary,
      displayColor: appearance.text.primary,
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: appearance.surfaces.toolbar,
      foregroundColor: appearance.text.primary,
      surfaceTintColor: Colors.transparent,
    ),
    cardTheme: CardThemeData(
      color: appearance.surfaces.panel,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: radius,
        side: BorderSide(color: colors.outlineVariant),
      ),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: appearance.surfaces.elevatedPanel,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: radius),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: appearance.surfaces.elevatedPanel,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: radius),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: appearance.surfaces.input,
      hintStyle: TextStyle(color: appearance.text.placeholder),
      border: border,
      enabledBorder: border,
      focusedBorder: border.copyWith(
        borderSide: BorderSide(color: appearance.accent.focusRing, width: 2),
      ),
    ),
    dividerTheme: DividerThemeData(
      color: highContrast
          ? appearance.borders.strong
          : appearance.borders.divider,
      thickness: highContrast ? 1.5 : 1,
    ),
    listTileTheme: ListTileThemeData(
      iconColor: appearance.text.secondary,
      textColor: appearance.text.primary,
      selectedTileColor: appearance.surfaces.active,
      shape: RoundedRectangleBorder(borderRadius: radius),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(48, 48),
        shape: RoundedRectangleBorder(borderRadius: radius),
        textStyle: const TextStyle(fontWeight: FontWeight.w700),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size(48, 48),
        foregroundColor: appearance.text.primary,
        side: BorderSide(color: colors.outline),
        shape: RoundedRectangleBorder(borderRadius: radius),
        textStyle: const TextStyle(fontWeight: FontWeight.w700),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: appearance.surfaces.elevatedPanel,
      contentTextStyle: TextStyle(color: appearance.text.primary),
      actionTextColor: appearance.accent.primary,
      shape: RoundedRectangleBorder(borderRadius: radius),
      behavior: SnackBarBehavior.floating,
    ),
  );
}

extension PortalAppearanceContext on BuildContext {
  PortalAppearance get portalAppearance =>
      Theme.of(this).extension<PortalAppearanceTheme>()?.appearance ??
      generatedDaintreeAppearance;
}
