/**
 * Single fetch wrapper. Centralises base URL handling, JSON parsing,
 * and error reporting. Every view imports from here, no raw fetch().
 *
 * In dev the proxy in vite.config.ts forwards /api/* to localhost:3000,
 * so this base URL works in both dev and production.
 */
const BASE = "/api";

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}
