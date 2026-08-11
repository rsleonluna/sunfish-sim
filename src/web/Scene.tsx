import { type JSX, use, useMemo, useRef } from 'react'
import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useControls } from 'leva'
import { Vector3 } from 'three'
import { Boat } from './Boat.tsx'
import { Water } from './Water.tsx'
import { compileWaveField, tawasPreset } from '../sim-core/gerstner.ts'
import { TawasEnvironment, sunDirection } from './environment/Environment.tsx'
import { Marks } from './environment/Marks.tsx'
import { useKeyboardControls } from './input.ts'
import { RIG_MANIFEST_URL, glbUrl, rigResource } from './rig-resource.ts'
import { useBoatSim, type BoatFrame } from './useBoatSim.ts'
import type { Vec3 } from '../sim-core/vec.ts'

export interface SceneProps {
  /** Written each frame so the HUD outside the canvas can read it. */
  hud: { current: BoatFrame | null }
}

export function Scene({ hud }: SceneProps): JSX.Element {
  const rig = use(rigResource())
  const input = useKeyboardControls()

  // Shared refs the water, sky and camera read without re-rendering React.
  const simTime = useRef(0)
  const boatPosition = useRef<Vec3>([0, 0, 0])

  const { windSpeed, windHeading, startHeading, paused } = useControls('sailing', {
    windSpeed: { value: 4, min: 0, max: 12, step: 0.1, label: 'wind (m/s)' },
    windHeading: { value: Math.PI / 2, min: -Math.PI, max: Math.PI, step: 0.01, label: 'wind dir' },
    startHeading: { value: -45, min: -180, max: 180, step: 5, label: 'reset heading' },
    paused: { value: false, label: 'pause' },
  })

  const { amplitudeScale, sharpness, spreadScale, depth, patchSize, segments, waterOpacity, waterWireframe } =
    useControls('tawas chop', {
      amplitudeScale: { value: 0.7, min: 0, max: 3, step: 0.05, label: 'amplitude' },
      sharpness: { value: 0.85, min: 0, max: 1, step: 0.01, label: 'sharpness' },
      spreadScale: { value: 1, min: 0, max: 2, step: 0.05, label: 'spread' },
      depth: { value: 4, min: 0.5, max: 40, step: 0.5, label: 'depth (m)' },
      patchSize: { value: 120, min: 40, max: 400, step: 20, label: 'patch (m)' },
      segments: { value: 300, min: 32, max: 600, step: 4, label: 'segments' },
      waterOpacity: { value: 0.95, min: 0.05, max: 1, step: 0.01, label: 'opacity' },
      waterWireframe: { value: false, label: 'wireframe' },
    })

  const {
    sunElevation,
    sunAzimuth,
    troughColour,
    crestColour,
    skyColour,
    hazeColour,
    farWaterColour,
    showLand,
    showMarks,
  } = useControls('tawas bay', {
    sunElevation: { value: 34, min: 2, max: 88, step: 1, label: 'sun height' },
    sunAzimuth: { value: -125, min: -180, max: 180, step: 1, label: 'sun bearing' },
    troughColour: { value: '#12556a', label: 'water trough' },
    crestColour: { value: '#48a2ac', label: 'water crest' },
    skyColour: { value: '#c2dcea', label: 'water sky tint' },
    hazeColour: { value: '#b9cfdc', label: 'haze' },
    farWaterColour: { value: '#1e6576', label: 'far water' },
    showLand: { value: true, label: 'land' },
    showMarks: { value: true, label: 'racing marks' },
  })

  const { showProbes, probeRadius, hullOpacity, hullWireframe, showAxes, follow } = useControls(
    'debug',
    {
      showProbes: { value: false, label: 'probes' },
      probeRadius: { value: 0.035, min: 0.005, max: 0.15, step: 0.005, label: 'probe size' },
      hullOpacity: { value: 1, min: 0.05, max: 1, step: 0.05, label: 'hull opacity' },
      hullWireframe: { value: false, label: 'hull wireframe' },
      showAxes: { value: false, label: 'axes + grid' },
      follow: { value: true, label: 'camera follows' },
    },
  )

  // Waves travel with the wind, which is what makes the two look related.
  const field = useMemo(
    () =>
      compileWaveField(tawasPreset({ heading: windHeading, amplitudeScale, sharpness, spreadScale }), {
        depth,
      }),
    [windHeading, amplitudeScale, sharpness, spreadScale, depth],
  )

  const { config, frame } = useBoatSim(rig, input, {
    field,
    windSpeed,
    windHeading,
    startHeading,
    paused,
  })

  useFrame(() => {
    const current = frame.current
    if (current === null) return
    simTime.current = current.time
    boatPosition.current = current.render.position
    hud.current = current
    // Dev-only handle so the position can be read from the console or a
    // headless driver without going through React.
    if (import.meta.env.DEV) {
      ;(window as unknown as { __boat?: unknown }).__boat = current
    }
  })

  const sun = useMemo(
    () => ({ elevation: sunElevation, azimuth: sunAzimuth }),
    [sunElevation, sunAzimuth],
  )
  const sunVector = useMemo(() => sunDirection(sun), [sun])

  return (
    <>
      {/* Sky above, water below: a hemisphere light is most of the lighting on
          open water, with one directional for the sun itself. */}
      <hemisphereLight args={['#dceaf7', '#3a5f63', 1.9]} />
      <directionalLight
        position={[sunVector[0] * 120, sunVector[1] * 120, sunVector[2] * 120]}
        intensity={2.4}
      />
      {/* Bounce off the water, so the leeward side of the hull is not a hole. */}
      <directionalLight
        position={[-sunVector[0] * 80, 12, -sunVector[2] * 80]}
        intensity={0.5}
        color="#9fc6d8"
      />

      <TawasEnvironment
        sun={sun}
        follow={boatPosition}
        patchSize={patchSize}
        showLand={showLand}
        hazeColour={hazeColour}
        farWaterColour={farWaterColour}
      />

      <Boat
        rig={rig}
        url={glbUrl(rig, RIG_MANIFEST_URL)}
        frame={frame}
        centreOfMass={config.centreOfMass}
        showProbes={showProbes}
        probeRadius={probeRadius}
        hullOpacity={hullOpacity}
        hullWireframe={hullWireframe}
      />

      <Water
        field={field}
        size={patchSize}
        segments={segments}
        opacity={waterOpacity}
        wireframe={waterWireframe}
        animate
        frozenTime={0}
        time={simTime}
        follow={boatPosition}
        troughColour={troughColour}
        crestColour={crestColour}
        skyColour={skyColour}
        sunDirection={sunVector}
      />

      {showAxes && (
        <>
          {/* +X red (starboard), +Y green (up), +Z blue (aft — the bow is -Z). */}
          <axesHelper args={[2]} />
          <gridHelper args={[40, 40, '#5b7a90', '#3a4f5e']} position={[0, -0.001, 0]} />
        </>
      )}

      <Marks field={field} time={simTime} visible={showMarks} />

      <WindArrow heading={windHeading} speed={windSpeed} follow={boatPosition} />
      <ChaseCamera follow={boatPosition} enabled={follow} />
    </>
  )
}

/** Keeps the orbit target on the boat so it cannot sail off the screen. */
function ChaseCamera({
  follow,
  enabled,
}: {
  follow: { current: Vec3 }
  enabled: boolean
}): JSX.Element {
  const controls = useThree((state) => state.controls) as
    | { target: Vector3; update: () => void }
    | null
  const previous = useRef(new Vector3())
  const camera = useThree((state) => state.camera)

  useFrame(() => {
    if (!enabled || controls === null) return
    const [x, y, z] = follow.current
    const next = new Vector3(x, y, z)
    // Move the camera by however far the target moved, so the user keeps
    // whatever angle and distance they orbited to.
    const delta = next.clone().sub(previous.current)
    if (previous.current.lengthSq() !== 0) camera.position.add(delta)
    controls.target.copy(next)
    controls.update()
    previous.current.copy(next)
  })

  return <OrbitControls makeDefault enableDamping dampingFactor={0.12} target={[0, 0.5, 0]} />
}

/** A floating arrow showing which way the true wind is blowing. */
function WindArrow({
  heading,
  speed,
  follow,
}: {
  heading: number
  speed: number
  follow: { current: Vec3 }
}): JSX.Element {
  const group = useRef<import('three').Group>(null)

  useFrame(() => {
    if (group.current === null) return
    const [x, , z] = follow.current
    group.current.position.set(x, 4.5, z)
    // Heading 0 points along +x; the arrow model points along -z, so this is a
    // quarter turn plus the heading, negated for the +Y sense.
    group.current.rotation.y = -heading - Math.PI / 2
  })

  return (
    <group ref={group} name="wind-arrow" visible={speed > 0.05}>
      <mesh position={[0, 0, 0.6]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.05, 0.05, 1.6, 8]} />
        <meshStandardMaterial color="#ffd166" emissive="#ffd166" emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[0, 0, -0.45]} rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.16, 0.5, 10]} />
        <meshStandardMaterial color="#ffd166" emissive="#ffd166" emissiveIntensity={0.4} />
      </mesh>
    </group>
  )
}
