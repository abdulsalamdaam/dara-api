/**
 * sRGB v2 ICC profile, base64.
 *
 * PDF/A requires an OutputIntent so colours are unambiguously defined, and the
 * OutputIntent has to carry the profile itself — a name is not enough. This is
 * the "sRGB-v2-micro" profile from Compact-ICC-Profiles, released under CC0, so
 * it can be redistributed inside every invoice we produce without attribution
 * or licence obligations. 456 bytes, which is why it is inlined rather than
 * shipped as a file the runtime image would have to copy.
 */
export const SRGB_ICC_BASE64 =
  "AAAByGxjbXMCEAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAA" +
  "AAAPbWAAEAAAAA0y1oYW5knZEAPUCAsD1AdCyBnqUijgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJZGVz" +
  "YwAAAPAAAABfY3BydAAAAQwAAAAMd3RwdAAAARgAAAAUclhZWgAAASwAAAAUZ1hZWgAAAUAAAAAUYlhZWgAAAVQAAA" +
  "AUclRSQwAAAWgAAABgZ1RSQwAAAWgAAABgYlRSQwAAAWgAAABgZGVzYwAAAAAAAAAFdVJHQgAAAAAAAAAAAAAAAHRl" +
  "eHQAAAAAQ0MwAFhZWiAAAAAAAADzVAABAAAAARbJWFlaIAAAAAAAAG+gAAA48gAAA49YWVogAAAAAAAAYpYAALeJAA" +
  "AY2lhZWiAAAAAAAAAkoAAAD4UAALbEY3VydgAAAAAAAAAqAAAAfAD4AZwCdQODBMkGTggSChgMYg70Ec8U9hhqHC4g" +
  "QySsKWoufjPrObM/1kZXTTZUdlwXZB1shnVWfo2ILJI2nKunjLLbvpnKx9dl5Hfx+f//" ;
