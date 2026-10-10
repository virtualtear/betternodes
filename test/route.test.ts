import { expect, test } from 'vitest'
import { Buckets } from '../src/geometry/buckets'
import { overlap, type Point, type Rect } from '../src/geometry/rect'
import { reach, route } from '../src/geometry/route'

// Deterministic pseudo-random numbers, the same generator the benchmarks use.
function random(seed = 7) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647
}

const crosses = (points: Point[], rects: Rect[]) => points.slice(1).some((q, i) => {
  const p = points[i]
  const segment: Rect = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1])]
  return rects.some(r => overlap(r, segment))
})

// The benchmark's worst case: 200 scattered nodes, 300 wires between random pairs.
function scattered() {
  const rand = random()
  const cols = Math.ceil(Math.sqrt(200 * 1.6))
  const rects = Array.from({ length: 200 }, (_, i): Rect =>
    [(i % cols) * 230 + Math.round(rand() * 40), Math.floor(i / cols) * 110 + Math.round(rand() * 30), 160, 37])
  const pairs = Array.from({ length: 300 }, () => [Math.floor(rand() * 200), Math.floor(rand() * 200)]).filter(([a, b]) => a !== b)
  return { rects, pairs }
}

test('long wires through a crowded graph almost never fall back to crossing a node', () => {
  const { rects, pairs } = scattered()
  const crossing = pairs.filter(([i, j]) =>
    crosses(route([rects[i][0] + 160, rects[i][1] + 18], [1, 0], [rects[j][0], rects[j][1] + 18], [-1, 0], rects), rects))
  // Without bends in the search's estimate, 70 of 299 cross; with them 6 do. The bound leaves room for small tuning.
  expect(crossing.length).toBeLessThanOrEqual(10)
})

test('routing around the spatial hash hits within reach() gives the same wires as around every node', () => {
  const { rects, pairs } = scattered()
  const index = new Buckets<Rect>()
  for (const r of rects) index.add(r, r)
  for (const [i, j] of pairs) {
    const [a, b]: Point[] = [[rects[i][0] + 160, rects[i][1] + 18], [rects[j][0], rects[j][1] + 18]]
    const hits: Rect[] = []
    index.near(reach(a, b), r => hits.push(r))
    expect(route(a, [1, 0], b, [-1, 0], hits)).toEqual(route(a, [1, 0], b, [-1, 0], rects))
  }
})
