import { expect, test } from 'vitest'
import { overlap, type Point, type Rect } from '../src/geometry/rect'
import { route } from '../src/geometry/route'

// Deterministic pseudo-random numbers, the same generator the benchmarks use.
function random(seed = 7) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647
}

const crosses = (points: Point[], rects: Rect[]) => points.slice(1).some((q, i) => {
  const p = points[i]
  const segment: Rect = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1])]
  return rects.some(r => overlap(r, segment))
})

test('long wires through a crowded graph almost never fall back to crossing a node', () => {
  // The benchmark's worst case: 200 scattered nodes, 300 wires between random pairs.
  const rand = random()
  const cols = Math.ceil(Math.sqrt(200 * 1.6))
  const rects = Array.from({ length: 200 }, (_, i): Rect =>
    [(i % cols) * 230 + Math.round(rand() * 40), Math.floor(i / cols) * 110 + Math.round(rand() * 30), 160, 37])
  const pairs = Array.from({ length: 300 }, () => [Math.floor(rand() * 200), Math.floor(rand() * 200)]).filter(([a, b]) => a !== b)
  const crossing = pairs.filter(([i, j]) =>
    crosses(route([rects[i][0] + 160, rects[i][1] + 18], [1, 0], [rects[j][0], rects[j][1] + 18], [-1, 0], rects), rects))
  // 70 of 299 crossed before the search estimated bends; 6 do now, with room for small tuning.
  expect(crossing.length).toBeLessThanOrEqual(10)
})
