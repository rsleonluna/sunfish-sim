/**
 * Runs the CPU/GPU wave parity check on demand: `npm run parity`.
 *
 * The check needs a real WebGL2 context with float render targets, which the
 * node-environment vitest process does not have. So this starts Vite, drives a
 * headless Chrome to /parity.html, reads window.__parity back over the DevTools
 * protocol and exits non-zero if anything is over tolerance.
 *
 * Pass --headful to watch it in a visible window, or open /parity.html yourself
 * against a running dev server.
 */

import { spawn } from 'node:child_process'
import process from 'node:process'

const HEADFUL = process.argv.includes('--headful')

/** Forwards `--extent=200 --samples=2000` style flags to the page as query params. */
const QUERY = process.argv
  .slice(2)
  .filter((arg) => arg.startsWith('--') && arg.includes('='))
  .map((arg) => arg.slice(2))
  .join('&')
const VITE_PORT = 51730
const DEVTOOLS_PORT = 51731
const PAGE_TIMEOUT_MS = 120_000

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function findChrome() {
  const { access } = await import('node:fs/promises')
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate)
      return candidate
    } catch {
      /* keep looking */
    }
  }
  throw new Error(
    `No Chrome found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to override.`,
  )
}

async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await probe()
    if (result) return result
    await sleep(200)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.onopen = () => resolve(socket)
    socket.onerror = reject
  })
}

async function main() {
  const chromePath = await findChrome()

  const vite = spawn(
    'npx',
    ['vite', '--port', String(VITE_PORT), '--strictPort', '--clearScreen', 'false'],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )

  const chromeArgs = [
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    `--remote-debugging-port=${DEVTOOLS_PORT}`,
    '--user-data-dir=' + process.cwd() + '/node_modules/.parity-chrome',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]
  if (!HEADFUL) chromeArgs.unshift('--headless=new', '--disable-gpu')

  const chrome = spawn(chromePath, chromeArgs, { stdio: 'ignore' })

  const shutdown = () => {
    chrome.kill()
    vite.kill()
  }
  process.on('exit', shutdown)
  process.on('SIGINT', () => {
    shutdown()
    process.exit(130)
  })

  try {
    await waitFor(
      'the dev server',
      async () => {
        try {
          const response = await fetch(`http://localhost:${VITE_PORT}/parity.html`)
          return response.ok
        } catch {
          return false
        }
      },
      30_000,
    )

    const page = await waitFor(
      'the browser',
      async () => {
        try {
          const list = await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`)).json()
          return list.find((target) => target.type === 'page') ?? false
        } catch {
          return false
        }
      },
      30_000,
    )

    const socket = await connect(page.webSocketDebuggerUrl)
    let nextId = 0
    const pending = new Map()

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
      }
    }

    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })

    await send('Page.enable')
    await send('Runtime.enable')
    const pageUrl = `http://localhost:${VITE_PORT}/parity.html${QUERY ? `?${QUERY}` : ''}`
    console.log(`  page       ${pageUrl}`)
    await send('Page.navigate', { url: pageUrl })

    const report = await waitFor(
      'the parity report',
      async () => {
        const result = await send('Runtime.evaluate', {
          expression: 'window.__parity ? JSON.stringify(window.__parity) : null',
          returnByValue: true,
          awaitPromise: true,
        })
        const value = result.result.value
        return value ? JSON.parse(value) : false
      },
      PAGE_TIMEOUT_MS,
    )

    socket.close()

    if (report.error) {
      console.error(`\nparity: ${report.error}\n`)
      process.exitCode = 1
      return
    }

    const exp = (value) => value.toExponential(3)
    console.log('')
    console.log(`  renderer   ${report.renderer}`)
    console.log(`  samples    ${report.sampleCount}  (seed 0x${report.seed.toString(16)})`)
    console.log(`  tolerance  ${report.tolerance}`)
    console.log('')
    console.log(
      `  displacement  max ${exp(report.maxDisplacementDelta)}   ` +
        `x ${exp(report.displacementByAxis[0])}  y ${exp(report.displacementByAxis[1])}  z ${exp(report.displacementByAxis[2])}`,
    )
    console.log(
      `  normal        max ${exp(report.maxNormalDelta)}   ` +
        `x ${exp(report.normalByAxis[0])}  y ${exp(report.normalByAxis[1])}  z ${exp(report.normalByAxis[2])}`,
    )

    console.log(`  passthrough   max ${exp(report.passthroughDelta)}   (harness noise floor, no wave maths)`)

    if (report.worst) {
      const w = report.worst
      console.log('')
      console.log(
        `  worst  #${w.index} ${w.quantity}[${w.axis}] at (${w.x.toFixed(3)}, ${w.z.toFixed(3)}) t=${w.t.toFixed(3)}`,
      )
      console.log(`         cpu ${w.cpu}`)
      console.log(`         gpu ${w.gpu}`)
    }

    for (const failure of report.failures ?? []) {
      console.error(
        `  FAIL #${failure.index} ${failure.quantity}[${failure.axis}] delta ${exp(failure.delta)} ` +
          `(cpu ${failure.cpu}, gpu ${failure.gpu})`,
      )
    }

    console.log('')
    console.log(report.passed ? `  PASS in ${report.durationMs.toFixed(0)} ms` : '  FAIL')
    console.log('')
    if (!report.passed) process.exitCode = 1
  } finally {
    shutdown()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
