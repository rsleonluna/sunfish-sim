/**
 * Browser entry point for the parity check. Loaded by `/parity.html`.
 *
 * Publishes the report on `window.__parity` so `scripts/parity.mjs` can read it
 * over the DevTools protocol, and renders it to the page for a human.
 */

import { runParity, type ParityReport } from './parity.ts'

declare global {
  interface Window {
    __parity?: ParityReport | { error: string }
  }
}

const output = document.getElementById('output')!

function line(text: string): void {
  output.textContent += `${text}\n`
}

/** Query-param overrides, so a range can be probed without editing code. */
function numberParam(name: string): number | undefined {
  const raw = new URLSearchParams(window.location.search).get(name)
  if (raw === null) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`parity: ${name}=${raw} is not a number`)
  return value
}

try {
  const report = runParity({
    sampleCount: numberParam('samples'),
    seed: numberParam('seed'),
    extent: numberParam('extent'),
    duration: numberParam('duration'),
    depth: numberParam('depth'),
    tolerance: numberParam('tolerance'),
  })
  window.__parity = report

  line(`renderer   ${report.renderer}`)
  line(`samples    ${report.sampleCount} (seed 0x${report.seed.toString(16)})`)
  line(`tolerance  ${report.tolerance}`)
  line('')
  line(`displacement max delta  ${report.maxDisplacementDelta.toExponential(3)}`)
  line(`  per axis  x ${report.displacementByAxis[0].toExponential(3)}  y ${report.displacementByAxis[1].toExponential(3)}  z ${report.displacementByAxis[2].toExponential(3)}`)
  line(`normal max delta        ${report.maxNormalDelta.toExponential(3)}`)
  line(`  per axis  x ${report.normalByAxis[0].toExponential(3)}  y ${report.normalByAxis[1].toExponential(3)}  z ${report.normalByAxis[2].toExponential(3)}`)
  line(`pipeline noise floor    ${report.passthroughDelta.toExponential(3)}  (no wave maths)`)
  line('')

  if (report.worst !== null) {
    const w = report.worst
    line(
      `worst sample  #${w.index} ${w.quantity}[${w.axis}] at (${w.x.toFixed(3)}, ${w.z.toFixed(3)}) t=${w.t.toFixed(3)}`,
    )
    line(`              cpu ${w.cpu}  gpu ${w.gpu}`)
  }

  for (const failure of report.failures) {
    line(
      `FAIL #${failure.index} ${failure.quantity}[${failure.axis}] delta ${failure.delta.toExponential(3)}`,
    )
  }

  line('')
  line(report.passed ? `PASS in ${report.durationMs.toFixed(0)} ms` : 'FAIL')
  output.className = report.passed ? 'pass' : 'fail'
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  window.__parity = { error: message }
  output.className = 'fail'
  line(`ERROR ${message}`)
  throw error
}
