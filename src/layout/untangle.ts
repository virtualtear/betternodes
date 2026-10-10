import type { Buckets } from '../geometry/buckets'
import type { Point, Rect } from '../geometry/rect'

// Index value of rects placed during one search; '.' can't be a node id.
const PLACED = '.'

/**
 * Where nodes dropped at `rects` settle: each right there if it keeps `gap` (rounded to the grid)
 * from every rect in `taken` and from the ones settled before it, else the nearest grid position
 * that does. Searches ring by ring outward on the grid; gives up (keeps the drop position) after
 * 50 rings. Leaves `taken` as it found it.
 */
export function freeSpots(rects: Rect[], taken: Buckets<string>, gap: number, grid: number): Point[] {
  const placed: Rect[] = []
  const spots = rects.map(rect => {
    const [spot] = nearestFree(rect, taken, gap, grid, 50)
    const r: Rect = [...spot, rect[2], rect[3]]
    taken.add(r, PLACED)
    placed.push(r)
    return spot
  })
  for (const r of placed) taken.remove(r, PLACED)
  return spots
}

// Nearest grid point to `rect`'s corner (searched ring by ring, from ring `from` up to `rings` out)
// where the rect keeps `gap` away from everything in `taken`, with `gap` rounded to the grid:
// positions snap to it but node sizes don't, so one grid step of space is rarely exactly `gap` px.
// Requiring all of it would push nodes a whole step further than where they visibly fit. Returns
// the spot and the ring it was found in.
function nearestFree([x, y, w, h]: Rect, taken: Buckets<unknown>, gap: number, grid: number, rings: number, from = 1): [Point, number] {
  const margin = gap - grid / 2
  const free = (px: number, py: number) => taken.empty([px - margin, py - margin, w + 2 * margin, h + 2 * margin])
  if (from <= 1 && free(x, y)) return [[x, y], 0]
  let best: Point = [x, y]
  let [bestDistance, ring] = [Infinity, 0]
  // Ring r holds points r..r*sqrt(2) grid steps away, so keep going until r passes the best so far.
  for (let r = Math.max(1, from); r <= rings && r <= bestDistance; r++) {
    for (let i = -r; i <= r; i++) {
      for (const [dx, dy] of [[i, -r], [i, r], [-r, i], [r, i]]) {
        const d = Math.hypot(dx, dy)
        if (d < bestDistance && free(x + dx * grid, y + dy * grid)) {
          best = [x + dx * grid, y + dy * grid]
          bestDistance = d
          ring = r
        }
      }
    }
  }
  return [best, ring]
}

/**
 * New positions that pull overlapping nodes apart. Only overlaps involving a `changed` node are
 * considered; of two overlapping nodes the one with the higher `rank` moves, to the nearest free
 * spot `gap` away from the nodes that stay. `pinned` (nodes being dragged) are ignored entirely.
 * @param index - every node's rect from `rects`, by id; left as it was found.
 * @remarks Nodes stacked on one spot search on from the ring where the previous one found room,
 * so k of them cost about k^1.5 lookups instead of k^2, at the price of skipping a gap an inner
 * ring might still have.
 */
export function untangle(
  changed: Iterable<string>,
  rects: ReadonlyMap<string, Rect>,
  index: Buckets<string>,
  rank: (id: string) => number,
  gap: number,
  grid: number,
  pinned: ReadonlySet<string> = new Set(),
) {
  const out = new Map<string, Point>()
  const moving = new Set<string>()
  for (const id of changed) {
    const r = rects.get(id)
    if (!r || pinned.has(id)) continue
    index.near(r, other => {
      if (other !== id && !pinned.has(other)) moving.add(rank(id) > rank(other) ? id : other)
    })
  }
  if (!moving.size) return out

  for (const id of moving) index.remove(rects.get(id)!, id)
  const placed: Rect[] = []
  const resume = new Map<string, number>()
  for (const id of [...moving].sort((a, b) => rank(a) - rank(b))) {
    const rect = rects.get(id)!
    const origin = `${rect[0]},${rect[1]}`
    // Up to 500 rings out, so even hundreds of nodes stacked on one spot all find room.
    const [spot, ring] = nearestFree(rect, index, gap, grid, 500, resume.get(origin))
    resume.set(origin, ring)
    out.set(id, spot)
    const r: Rect = [...spot, rect[2], rect[3]]
    index.add(r, PLACED)
    placed.push(r)
  }
  for (const r of placed) index.remove(r, PLACED)
  for (const id of moving) index.add(rects.get(id)!, id)
  return out
}
