/**
 * Build-time branding for this client distribution.
 *
 * This is a universal client: it connects to the official Stoat instance as
 * well as any self-hosted instance. Strings and marks describing the
 * *product* come from here; anything specific to a particular instance must
 * be resolved from that instance's own configuration (`GET /` on its API).
 */

/**
 * Product name shown in app chrome (title, notifications, marketing copy).
 * Override at build time with VITE_BRAND_NAME.
 */
export const BRAND_NAME =
  (import.meta.env.VITE_BRAND_NAME as string | undefined) || "Ermine";

/**
 * API URLs operated by the upstream Stoat project.
 */
const FIRST_PARTY_API_URLS = [
  // historically...
  "https://api.revolt.chat",
  "https://beta.revolt.chat/api",
  "https://revolt.chat/api",
  // ... and now:
  "https://stoat.chat/api",
];

/**
 * Whether the given API URL is an official Stoat instance; gates surfaces
 * that only exist there (lounge, discover, feedback).
 */
export function isFirstPartyHost(apiUrl: string): boolean {
  return FIRST_PARTY_API_URLS.includes(apiUrl);
}
