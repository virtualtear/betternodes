import { Buckets } from '../geometry/buckets'
import type { Point, Rect } from '../geometry/rect'

/**
 * Where nodes dropped at `rects` settle: each right there if it keeps `gap` (rounded to the grid)
 * from every rect in `others` and from the ones settled before it, else the nearest grid position
 * that does. Searches ring by ring outward on the grid; gives up (keeps the drop position) after
 * 50 rings.
 */
export function freeSpots(rects: Rect[], others: Rect[], gap: number, grid: number): Point[] {
  const taken = new Buckets<null>()
  for (const r of others) taken.add(r, null)
  return rects.map(rect => {
    const spot = nearestFree(rect, taken, gap, grid, 50)
    taken.add([...spot, rect[2], rect[3]], null)
    return spot
  })
}

// Nearest grid point to `rect`'s corner (searched ring by ring, at most `rings` out) where the rect
// keeps `gap` away from everything in `taken`, with `gap` rounded to the grid: positions snap to it
// but node sizes don't, so one grid step of space is rarely exactly `gap` px. Requiring all of it
// would push nodes a whole step further than where they visibly fit.
function nearestFree([x, y, w, h]: Rect, taken: Buckets<unknown>, gap: number, grid: number, rings: number): Point {
  const margin = gap - grid / 2
  const free = (px: number, py: number) => taken.empty([px - margin, py - margin, w + 2 * margin, h + 2 * margin])
  if (free(x, y)) return [x, y]
  let best: Point = [x, y]
  let bestDistance = Infinity
  // Ring r holds points r..r*sqrt(2) grid steps away, so keep going until r passes the best so far.
  for (let r = 1; r <= rings && r <= bestDistance; r++) {
    for (let i = -r; i <= r; i++) {
      for (const [dx, dy] of [[i, -r], [i, r], [-r, i], [r, i]]) {
        const d = Math.hypot(dx, dy)
        if (d < bestDistance && free(x + dx * grid, y + dy * grid)) {
          best = [x + dx * grid, y + dy * grid]
          bestDistance = d
        }
      }
    }
  }
  return best
}

/**
 * New positions that pull overlapping nodes apart. Only overlaps involving a `changed` node are
 * considered; of two overlapping nodes the later one in `order` moves, to the nearest free spot
 * `gap` away from the nodes that stay. `pinned` (nodes being dragged) are ignored entirely.
 */
export function untangle(order: string[], rects: Map<string, Rect>, changed: Set<string>, gap: number, grid: number, pinned: ReadonlySet<string> = new Set()) {
  const out = new Map<string, Point>()
  const rank = new Map(order.map((id, i) => [id, i]))
  // Broad phase: bucket node ids so each changed node is only compared with its neighbours.
  const all = new Buckets<string>()
  for (const [id, r] of rects) all.add(r, id)
  const moving = new Set<string>()
  for (const id of changed) {
    const r = rects.get(id)
    if (!r || pinned.has(id)) continue
    all.near(r, other => {
      if (other !== id && !pinned.has(other)) moving.add(rank.get(id)! > rank.get(other)! ? id : other)
    })
  }
  if (!moving.size) return out

  const settled = new Buckets<string>()
  for (const id of order) if (!moving.has(id)) settled.add(rects.get(id)!, id)
  for (const id of [...moving].sort((a, b) => rank.get(a)! - rank.get(b)!)) {
    const [, , w, h] = rects.get(id)!
    // Up to 500 rings out, so even hundreds of nodes stacked on one spot all find room.
    const spot = nearestFree(rects.get(id)!, settled, gap, grid, 500)
    out.set(id, spot)
    settled.add([...spot, w, h], id)
  }
  return out
}
