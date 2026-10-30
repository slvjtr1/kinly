// Feature switches for integrations that can be turned off for a release without removing their
// code. See docs/TRAKT_TEMPORARILY_DISABLED.md for what the Trakt switch covers.

export const FEATURES: { trakt: boolean } = {
  /**
   * Trakt sign-in, import and scrobbling. Off: no Trakt UI and no Trakt or relay requests; each
   * profile's stored Trakt connection stays on disk untouched, ready for when it is turned back on.
   */
  trakt: false,
};
