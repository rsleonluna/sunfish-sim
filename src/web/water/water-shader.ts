import { GERSTNER_GLSL } from './gerstner.glsl.ts'

/**
 * The water vertex shader.
 *
 * The geometry is baked flat into the XZ plane, so `position.xz` is already the
 * Gerstner parameter point and the shader can displace it directly. Both the
 * position and the normal come from the shared chunk — no finite differences,
 * no second sampling path to drift out of step with the CPU.
 */
export const WATER_VERTEX_SHADER: string = /* glsl */ `
uniform float uTime;
uniform vec2 uOrigin;

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying float vHeight;

${GERSTNER_GLSL}

void main() {
  // The patch follows the boat, but the waves must not follow with it. Adding
  // the patch's world origin to the parameter point keeps the field locked to
  // the world while the mesh slides underneath it.
  vec2 p = position.xz + uOrigin;

  vec3 d = gerstnerDisplacement(p, uTime);
  vec3 displaced = vec3(position.x + d.x, d.y, position.z + d.z);

  vNormal = gerstnerNormal(p, uTime);
  vHeight = d.y;
  vWorldPosition = (modelMatrix * vec4(displaced, 1.0)).xyz;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
`

/**
 * Placeholder water shading: a depth-tinted base, a wrapped diffuse term, a
 * Fresnel sky reflection and a tight sun glint. Stage 8 replaces the palette
 * with something taken off the reference photos.
 */
export const WATER_FRAGMENT_SHADER: string = /* glsl */ `
uniform vec3 uTroughColor;
uniform vec3 uCrestColor;
uniform vec3 uSkyColor;
uniform vec3 uSunDirection;
uniform float uOpacity;
uniform float uAmplitudeScale;

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying float vHeight;

void main() {
  vec3 normal = normalize(vNormal);
  vec3 viewDir = normalize(cameraPosition - vWorldPosition);
  // Backfaces (seen from under the water) should still light sensibly.
  if (dot(normal, viewDir) < 0.0) normal = -normal;

  vec3 sunDir = normalize(uSunDirection);

  // Normalised crest-to-trough position, so the tint holds as amplitude changes.
  float shade = clamp(vHeight / max(uAmplitudeScale, 1e-4) * 0.5 + 0.5, 0.0, 1.0);
  vec3 base = mix(uTroughColor, uCrestColor, shade);

  float diffuse = max(dot(normal, sunDir), 0.0);
  float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 4.0);
  vec3 halfway = normalize(sunDir + viewDir);
  float glint = pow(max(dot(normal, halfway), 0.0), 120.0);

  vec3 color = base * (0.45 + 0.55 * diffuse);
  color = mix(color, uSkyColor, fresnel * 0.55);
  color += vec3(1.0, 0.97, 0.9) * glint * 0.8;

  gl_FragColor = vec4(color, uOpacity);
}
`
