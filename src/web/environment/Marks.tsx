import { type JSX, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Group } from 'three'
import { sampleHeightAt, type WaveField } from '../../sim-core/gerstner.ts'

/**
 * Moored racing marks.
 *
 * These exist because a boat alone on open water has nothing to move against.
 * The camera follows the boat, the wave patch follows the boat, the far water
 * and the haze dome follow the boat, and the waves themselves travel downwind
 * at much the same speed the boat does — so the hull can be making three and a
 * half knots and the screen looks static. Anchored marks are the fixed
 * reference that makes the motion readable, and they give you something to sail
 * around.
 *
 * They ride the real wave field rather than sitting at y = 0, so they bob.
 */
export interface MarksProps {
  readonly field: WaveField
  readonly time: { current: number }
  readonly visible: boolean
}

/**
 * A short course, scattered so at least one mark is nearly always in shot.
 *
 * Deliberately close in. At a hundred metres a metre-tall buoy is a few pixels
 * and reads as nothing; the whole job here is to be an obvious fixed thing to
 * slide past, so the ring starts at thirty-five metres.
 */
const COURSE: ReadonlyArray<{ x: number; z: number; colour: string }> = [
  { x: 38, z: 14, colour: '#ff7043' },
  { x: -30, z: 34, colour: '#ffca28' },
  { x: 12, z: -44, colour: '#ffca28' },
  { x: -52, z: -28, colour: '#ff7043' },
  { x: 82, z: -62, colour: '#ffca28' },
  { x: -18, z: 96, colour: '#ff7043' },
  { x: 96, z: 74, colour: '#ff7043' },
  { x: -104, z: -80, colour: '#ffca28' },
]

export function Marks({ field, time, visible }: MarksProps): JSX.Element {
  const groups = useRef<Array<Group | null>>([])
  const marks = useMemo(() => COURSE, [])

  useFrame(() => {
    if (!visible) return
    for (let i = 0; i < marks.length; i++) {
      const group = groups.current[i]
      if (group == null) continue
      const mark = marks[i]
      // Sits on the surface it is actually floating on.
      group.position.set(mark.x, sampleHeightAt(field, mark.x, mark.z, time.current), mark.z)
    }
  })

  return (
    <group name="marks" visible={visible}>
      {marks.map((mark, index) => (
        <group
          key={`${mark.x},${mark.z}`}
          ref={(node) => {
            groups.current[index] = node
          }}
          position={[mark.x, 0, mark.z]}
        >
          {/* Inflatable racing mark: a fat cone on a white waterline collar,
              with a slim staff so it still catches the eye at a hundred metres. */}
          <mesh position={[0, 0.7, 0]}>
            <coneGeometry args={[0.7, 2.1, 12]} />
            <meshLambertMaterial color={mark.colour} emissive={mark.colour} emissiveIntensity={0.25} />
          </mesh>
          <mesh position={[0, -0.12, 0]}>
            <cylinderGeometry args={[0.75, 0.6, 0.55, 12]} />
            <meshLambertMaterial color="#f7f7f4" />
          </mesh>
          <mesh position={[0, 2.4, 0]}>
            <cylinderGeometry args={[0.06, 0.06, 1.6, 6]} />
            <meshLambertMaterial color="#2b2b2e" />
          </mesh>
        </group>
      ))}
    </group>
  )
}
