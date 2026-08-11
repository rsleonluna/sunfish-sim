import { parseRig, type RigSpec } from '../sim-core/rig.ts'

/** Public URL of the rig manifest. The GLB sits beside it. */
export const RIG_MANIFEST_URL = '/models/sunfish-rig.json'

const cache = new Map<string, Promise<RigSpec>>()

/**
 * Fetches and parses the rig manifest once per URL, returning a stable promise
 * suitable for React's `use()` inside a Suspense boundary.
 */
export function rigResource(url: string = RIG_MANIFEST_URL): Promise<RigSpec> {
  const cached = cache.get(url)
  if (cached !== undefined) return cached

  const pending = fetch(url).then(async (response) => {
    if (!response.ok) {
      throw new Error(`rig: fetch ${url} failed with ${response.status} ${response.statusText}`)
    }
    return parseRig(await response.json())
  })
  cache.set(url, pending)
  return pending
}

/** Resolves the manifest URL to the GLB it references. */
export function glbUrl(rig: RigSpec, manifestUrl: string = RIG_MANIFEST_URL): string {
  return new URL(rig.glb, new URL(manifestUrl, window.location.href)).pathname
}
