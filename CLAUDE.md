# Sunfish Sailing Simulator — Three.js

## Architecture rule, non-negotiable
`src/sim-core/` is pure TypeScript. It imports NOTHING from three, react,
or @react-three/*. Numbers in, numbers out. It must run in a headless
vitest process with no DOM. This exists so the same core can be ported to
UE5 C++ later and validated against identical test vectors.
Anything that touches a renderer lives in `src/web/`.

## Coordinate + unit contract
- Meters, seconds, radians, kilograms. SI throughout.
- Boat frame: +Y up, boat's bow along -Z, starboard +X. Right-handed.
- The assets are authored in two OTHER frames and must be normalized on load.
  `sunfish-rig.json` is Blender-frame (+X bow, +Y port, +Z up). `sunfish.glb`
  was exported yup, so glTF sees it as +X bow, +Y up, +Z starboard. Only
  `src/sim-core/rig.ts` knows this; it converts everything to boat frame, and
  `src/web/Boat.tsx` yaws the glTF scene by `GLTF_TO_BOAT_YAW`. Nothing else
  may touch a raw asset coordinate.
- Freshwater: rho = 1000 kg/m^3. NOT 1025. Tawas Bay is Lake Huron.
- g = 9.81
- Rig pivots and buoyancy probes are read from
  public/models/sunfish-rig.json at load. Never hardcode a position that
  exists in that file.

## Setting: Tawas Bay, Lake Huron
Shallow, fetch-limited. Short wind chop, not swell.
Wavelengths 3-8m, periods 2-4s, directional spread around the wind vector.
Total steepness stays below cusping. The boat should feel busy and slappy.

## Determinism
- Fixed timestep 1/120s with an accumulator. Rendering interpolates.
- No Math.random() in sim-core. Seeded PRNG passed in if randomness needed.
- Same inputs + same dt sequence must produce identical trajectories.

## Testing
Every sim-core module ships with vitest tests written in the same commit.
No "tests later."

## Style
Explicit types on all exported functions. Small pure functions.
No classes in sim-core unless there's genuine mutable state.