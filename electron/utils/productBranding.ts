// Product branding for the current build variant. IS_LEGACY_BUILD is a
// compile-time constant baked by esbuild define; these constants are constant
// folded so the Daintree build never references Canopy strings.

export const PRODUCT_NAME = IS_LEGACY_BUILD ? "Canopy" : "Daintree";
export const PRODUCT_WEBSITE = IS_LEGACY_BUILD ? "https://canopyide.com" : "https://daintree.org";
export const PRODUCT_COPYRIGHT_ORG = IS_LEGACY_BUILD ? "Canopy Team" : "Daintree.org Team";
