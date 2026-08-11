/**
 * GLSL port of `src/sim-core/gerstner.ts`.
 *
 * This string is the single source of truth for the GPU side of the wave
 * field: the water mesh compiles it into its vertex shader, and the parity
 * harness in `src/web/__tests__/parity.ts` compiles the identical string so
 * the thing being verified is the thing that ships.
 *
 * Keep it a line-for-line mirror of `sampleDisplacement` and `sampleNormal`.
 * If one side changes, change the other in the same commit and re-run
 * `npm run parity`.
 *
 * Written in the common subset of GLSL ES 1.0 and 3.0 so both the water
 * material (three's default GLSL1) and the parity harness (GLSL3) can include
 * it unchanged. That means: no `texture()`, no dynamic loop bounds, and array
 * indexing only by the loop counter.
 */

/** Uniform array length. The Tawas preset uses five. */
export const MAX_WAVES = 8

/**
 * Wave parameters arrive as two vec4s per component, matching `CompiledWave`:
 *
 *   uWaveA[i] = (dirX, dirZ, amplitude, wavenumber)
 *   uWaveB[i] = (angularFrequency, horizontalAmplitude, steepness, phase)
 */
export const GERSTNER_GLSL: string = /* glsl */ `
#define MAX_WAVES ${MAX_WAVES}

uniform vec4 uWaveA[MAX_WAVES];
uniform vec4 uWaveB[MAX_WAVES];
uniform int uWaveCount;

// Mirrors sampleDisplacement(). p is the parameter point (x, z); the surface
// point is (p.x + d.x, d.y, p.y + d.z).
vec3 gerstnerDisplacement(vec2 p, float t) {
  vec3 d = vec3(0.0);

  for (int i = 0; i < MAX_WAVES; i++) {
    if (i >= uWaveCount) break;
    vec4 a = uWaveA[i];
    vec4 b = uWaveB[i];

    float theta = a.w * dot(a.xy, p) - b.x * t + b.w;
    float sinTheta = sin(theta);

    // Particles bunch toward the crest, which is what sharpens it.
    float pinch = b.y * sinTheta;
    d.x -= a.x * pinch;
    d.z -= a.y * pinch;
    d.y += a.z * cos(theta);
  }

  return d;
}

// Mirrors sampleNormal(). Analytic tangents, then tz x tx so flat water is +Y.
vec3 gerstnerNormal(vec2 p, float t) {
  float ax = 0.0;
  float cx = 0.0;
  float az = 0.0;
  float cz = 0.0;
  float hx = 0.0;
  float hz = 0.0;

  for (int i = 0; i < MAX_WAVES; i++) {
    if (i >= uWaveCount) break;
    vec4 a = uWaveA[i];
    vec4 b = uWaveB[i];

    float theta = a.w * dot(a.xy, p) - b.x * t + b.w;
    float sinTheta = sin(theta);
    float cosTheta = cos(theta);

    float s = b.z * cosTheta;
    ax -= s * a.x * a.x;
    cz -= s * a.y * a.y;
    float crossTerm = s * a.x * a.y;
    cx -= crossTerm;
    az -= crossTerm;

    float slope = a.z * a.w * sinTheta;
    hx -= slope * a.x;
    hz -= slope * a.y;
  }

  vec3 tx = vec3(1.0 + ax, hx, cx);
  vec3 tz = vec3(az, hz, 1.0 + cz);

  return normalize(cross(tz, tx));
}
`
