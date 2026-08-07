// Get collision maps in the browser without shipping a copy of them.
//
// The maps are GENERATED from the client bundle, so a baked-in snapshot goes
// stale the moment the game redeploys -- and it fails silently, as bots pathing
// into trees the map thinks are open. The Python bot solved this by re-running
// the extractor on startup. A userscript can't shell out, but it doesn't need
// to: the page has already downloaded and executed the exact bundle we'd want to
// parse. We fetch it from the browser cache and run the same extractor the CLI
// uses, so the maps always match the client the player is actually running.
//
// Fetching the bundle is same-origin (it's the page's own script tag), so CSP
// permits it and it is normally served straight from cache.

import { extractAll } from '../core/maps.js';

/** The bundle URL the page is actually running, read from its own script tag. */
export function liveBundleHref() {
  const el = document.querySelector('script[type=module][src*="/assets/index-"]');
  return el ? el.getAttribute('src') : null;
}

/**
 * Extract maps from the running client.
 *
 * Returns {maps, source} where source is 'page' on success. Throws on failure so
 * the caller can decide whether to fall back to the embedded snapshot -- callers
 * should never silently proceed with no maps, since that degrades A* to greedy
 * movement and looks like "the bot is stuck on a rock".
 */
export async function extractFromPage() {
  const src = liveBundleHref();
  if (!src) throw new Error('could not find the client bundle script tag');
  const r = await fetch(src, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`fetching ${src} failed: HTTP ${r.status}`);
  const js = await r.text();
  return { maps: extractAll(js, src), source: 'page' };
}
