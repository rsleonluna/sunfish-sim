Create docs/BUILD_PLAN.md listing these stages with acceptance criteria for
each. Do not implement anything yet.

Stage 1 — Load and inspect
Vite app renders the GLB. Parse sunfish_rig.json. Log every pivot and probe
with its world position. Draw debug spheres at each probe. Flat plane at y=0.
ACCEPT: probes visibly sit on the hull bottom, symmetric about centerline.

Stage 2 — sim-core/gerstner.ts
Gerstner wave field. WaveComponent interface (dir, amplitude, wavelength,
steepness, phase). Exports sampleDisplacement, sampleHeight, sampleNormal.
A tawasPreset() returning 5 components in the 3-8m / 2-4s band.
ACCEPT: vitest green. Tests cover: zero amplitude gives flat, period matches
dispersion relation, normals are unit length, output is deterministic.

Stage 3 — Water mesh + GPU parity
Subdivided plane with a custom ShaderMaterial. GLSL vertex shader is a
line-for-line port of sampleDisplacement, waves passed as uniforms.
Write src/web/__tests__/parity.ts: sample 500 random (x,z,t), compute on CPU,
render GPU values to a float target, readback, assert max delta < 1e-4.
ACCEPT: parity test green and runnable on demand.

Stage 4 — sim-core/hydrostatics.ts
Probe array -> per-probe submersion depth -> buoyant force and application
point -> summed force and torque. Include linear and quadratic drag.
ACCEPT: a probe set at rest settles to a stable draft matching hull mass.

Stage 5 — sim-core/state.ts
6-DOF rigid body. Fixed 1/120 accumulator, semi-implicit Euler, quaternion
orientation. step(state, forces, dt) -> newState, pure.
ACCEPT: headless test — boat dropped from 0.5m damps to steady float.
Second test — identical input sequence twice gives bit-identical output.

Stage 6 — sim-core/aero.ts and foils.ts
Apparent wind from true wind minus boat velocity. Sail lift/drag from angle
of attack and camber. Daggerboard and rudder side force with leeway angle.
ACCEPT: close-hauled produces forward drive plus heel; head-to-wind stalls.

Stage 7 — Controls and rig animation
Mainsheet and tiller input. Boom/yard quaternion about pivot_gooseneck.
Sail morphTargetInfluences[0] driven by the SAME camber value aero.ts used.
Rudder rotation about pivot_rudder. Leva panel for live tuning.
ACCEPT: playable. Can tack.

Stage 8 — Tawas environment
Shoreline, treeline, Tawas Point lighthouse as a landmark. Sky and water
palette from reference photos. Sail material two-sided with transmission.
ACCEPT: recognizable as the bay.