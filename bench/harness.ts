import { afterAll, expect } from 'vitest'

interface Row {
  scenario: string
  'median ms': number
  'p95 ms': number
  fps: number | string
  budget: string
}

const rows: Row[] = []

// console.table output is not forwarded from the browser, so print a plain text table.
afterAll(() => {
  const cols = Object.keys(rows[0] ?? {}) as (keyof Row)[]
  const width = (c: keyof Row) => Math.max(c.length, ...rows.map(r => String(r[c]).length))
  const line = (cells: string[]) => cells.map((cell, i) => i ? cell.padStart(width(cols[i])) : cell.padEnd(width(cols[i]))).join('  ')
  console.log(['', line(cols), ...rows.map(r => line(cols.map(c => String(r[c]))))].join('\n'))
})

const round = (v: number) => Math.round(v * 100) / 100

/**
 * Times `run` repeatedly in the real browser and records median and 95th-percentile milliseconds.
 * `setup` and `teardown` run around every timed call but are not timed themselves.
 * @remarks With a `budget`, the benchmark fails when the median exceeds it. Budgets are set at
 * several times the measured median, so they catch real regressions, not machine noise.
 */
export async function measure<T>(scenario: string, steps: {
  setup?: () => T | Promise<T>
  run: (ctx: T) => unknown
  teardown?: (ctx: T) => unknown
  runs?: number
  warmup?: number
  budget?: number
}) {
  const { setup, run, teardown, runs = 20, warmup = 3, budget } = steps
  const times: number[] = []
  for (let i = 0; i < warmup + runs; i++) {
    const ctx = (await setup?.()) as T
    const start = performance.now()
    await run(ctx)
    const time = performance.now() - start
    await teardown?.(ctx)
    if (i >= warmup) times.push(time)
  }
  times.sort((a, b) => a - b)
  const result = { median: times[Math.floor(times.length / 2)], p95: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] }
  rows.push({ scenario, 'median ms': round(result.median), 'p95 ms': round(result.p95), fps: '-', budget: budget === undefined ? '-' : `${budget} ms` })
  if (budget !== undefined) expect(result.median, `${scenario}: median over budget`).toBeLessThan(budget)
  return result
}

/**
 * Calls `step` once per animation frame and records the frame rate the browser actually delivers,
 * including its own style, layout and paint work, not just ours. Median and p95 are frame intervals.
 * @remarks With `minFps`, the benchmark fails when the average frame rate drops below it. Headless
 * Chromium caps rAF at the display rate, so 60 fps means "never missed a frame".
 */
export async function fps(scenario: string, { step, frames = 120, warmup = 10, minFps }: {
  step?: (frame: number) => void
  frames?: number
  warmup?: number
  minFps?: number
}) {
  const gaps: number[] = []
  await new Promise<void>(done => {
    let [i, last] = [0, 0]
    const tick = (now: number) => {
      if (i > warmup) gaps.push(now - last)
      last = now
      if (i++ === warmup + frames) return done()
      step?.(i)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const rate = (gaps.length * 1000) / gaps.reduce((sum, gap) => sum + gap, 0)
  gaps.sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]
  const p95 = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))]
  rows.push({ scenario, 'median ms': round(median), 'p95 ms': round(p95), fps: Math.round(rate), budget: minFps === undefined ? '-' : `${minFps} fps` })
  if (minFps !== undefined) expect(rate, `${scenario}: frame rate under budget`).toBeGreaterThanOrEqual(minFps)
  return { fps: rate, median, p95 }
}
