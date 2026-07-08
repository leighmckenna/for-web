import type { API } from "stoat.js";

import { CONFIGURATION } from "@revolt/common";

/**
 * Instances are keyed by their canonical API URL throughout the app
 * (auth store, session manager, routing).
 */
export type InstanceUrl = string;

/**
 * Result of discovering an instance from user input.
 */
export type DiscoveredInstance = {
  /** Canonical API URL (no trailing slash) */
  apiUrl: InstanceUrl;
  /** The instance's self-reported configuration (`GET /` on the API) */
  config: API.RevoltConfig;
};

/**
 * The instance this build connects to when the user has not added any other.
 */
export const DEFAULT_INSTANCE: InstanceUrl = CONFIGURATION.DEFAULT_API_URL;

/**
 * Strip trailing slashes so instance URLs compare equal.
 */
export function canonicalUrl(url: string): InstanceUrl {
  return url.replace(/\/+$/, "");
}

/**
 * Fetch JSON with a timeout, returning undefined on any failure.
 */
async function tryJson<T>(url: string, timeoutMs = 8000): Promise<T | void> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return;
    return (await response.json()) as T;
  } catch {
    return;
  }
}

/**
 * Check whether a URL answers `GET /` like a Stoat/Revolt API node.
 */
async function queryNode(apiUrl: string): Promise<API.RevoltConfig | void> {
  const config = await tryJson<API.RevoltConfig>(`${apiUrl}/`);
  // the "Query Node" response always carries a version and ws URL
  if (config && typeof config.revolt === "string" && config.ws) return config;
}

/**
 * Discover an instance from whatever the user pasted: a bare domain,
 * an app URL, or a direct API URL.
 *
 * Resolution order:
 * 1. `https://<host>/.well-known/stoat` (`{ "api": ... }`)
 * 2. the input itself as an API URL
 * 3. `https://<host>/api`
 *
 * @throws if nothing answers like a Stoat instance
 */
export async function discoverInstance(
  input: string,
): Promise<DiscoveredInstance> {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(input) ? input : `https://${input}`);
  } catch {
    throw "InvalidUrl";
  }

  const candidates: string[] = [];

  const wellKnown = await tryJson<{ api?: string }>(
    `${url.origin}/.well-known/stoat`,
  );
  if (wellKnown?.api) candidates.push(canonicalUrl(wellKnown.api));

  const direct = canonicalUrl(url.origin + url.pathname);
  candidates.push(direct, `${url.origin}/api`);

  for (const apiUrl of [...new Set(candidates)]) {
    const config = await queryNode(apiUrl);
    if (config) return { apiUrl, config };
  }

  throw "NotAStoatInstance";
}
