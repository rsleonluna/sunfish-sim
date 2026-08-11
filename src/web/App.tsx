import { Component, type ErrorInfo, type JSX, type ReactNode, Suspense, useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { Leva } from 'leva'
import { Hud } from './Hud.tsx'
import { Scene } from './Scene.tsx'
import type { BoatFrame } from './useBoatSim.ts'

export default function App(): JSX.Element {
  // The simulation writes here every frame; the HUD reads it on its own rAF.
  // Nothing about the boat goes through React state.
  const frame = useRef<BoatFrame | null>(null)

  return (
    <>
      <Leva collapsed titleBar={{ title: 'sunfish-sim' }} />
      <LoadErrorBoundary>
        <Canvas
          // Looking out past the boat toward Tawas Point and the light.
          camera={{ position: [-9, 5, -11], fov: 50, near: 0.05, far: 20000 }}
          gl={{ antialias: true }}
        >
          <Suspense fallback={null}>
            <Scene hud={frame} />
          </Suspense>
        </Canvas>
      </LoadErrorBoundary>
      <Hud frame={frame} />
    </>
  )
}

interface BoundaryState {
  error: Error | null
}

/** Surfaces asset-loading failures in the page instead of a blank canvas. */
class LoadErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[sunfish-sim] scene failed to load', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="fatal">
          <h1>Scene failed to load</h1>
          <pre>{this.state.error.message}</pre>
          <p>Check that public/models/ holds sunfish-rig.json and sunfish.glb.</p>
        </div>
      )
    }
    return this.props.children
  }
}
