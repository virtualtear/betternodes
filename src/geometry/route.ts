import { Heap } from './heap'
import { bounds, inflate, overlap, type Point, type Rect } from './rect'

// Wires step this far straight out of a node before turning (less when another node is close).
const STUB = 20
/** Free space kept around every node where there is room for it, in world px. */
export const CLEAR = 10
// Obstacles further than this from the wire's bounding box are ignored.
const REGION = 100
// Extra cost per bend, in px of length: prefers fewer, longer segments.
const BEND = 40
// Search steps per wire before giving up; keeps the slowest wire around one frame.
const BUDGET = 8000
// Bits of the search table's size: at least twice the states a search can reach (each of BUDGET
// expanded states adds up to 3), so open addressing stays fast and never runs out of slots.
const BITS = Math.ceil(Math.log2(2 * (3 * BUDGET + 1)))
// Largest search grid, in cells: its blocked-edge maps take 2 bytes per cell. A long wire across 1000
// scattered nodes needs about 2.8M.
const MAX_GRID = 1 << 22

// Directions: 0 east, 1 west, 2 south, 3 north. `d ^ 1` is the opposite direction.
const STEP: Point[] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const dirOf = ([dx, dy]: Point) => (dx > 0 ? 0 : dx < 0 ? 1 : dy > 0 ? 2 : 3)

// Running along an edge is fine; only crossing an interior blocks.
function blocked(p: Point, q: Point, rects: Rect[]) {
  const seg = bounds([p, q])
  return rects.some(r => overlap(r, seg))
}

function simplify(points: Point[]) {
  const out: Point[] = []
  for (const p of points) {
    const [q, r] = [out[out.length - 1], out[out.length - 2]]
    if (q && q[0] === p[0] && q[1] === p[1]) continue
    if (q && r && ((r[0] === q[0] && q[0] === p[0]) || (r[1] === q[1] && q[1] === p[1]))) out.pop()
    out.push(p)
  }
  return out
}

/**
 * The area a wire from `a` to `b` is routed in: obstacles outside it are ignored.
 * @remarks Spans both full-length stubs plus a margin, so it holds every node a stub can hit.
 */
export const reach = (a: Point, b: Point) => inflate(bounds([a, b]), STUB + REGION + CLEAR)

/**
 * Waypoints of a right-angled wire from `a` to `b` that avoids `obstacles`.
 * @param da - axis-aligned direction the wire leaves `a` in.
 * @param db - axis-aligned direction pointing out of `b`'s node; the wire arrives against it.
 * @param obstacles - may be any superset of the ones within {@link reach}, duplicates included.
 * @returns at least `[a, b]`; never fails, but falls back to a simple Z shape (which may cross a
 * node) when no route is found within the search budget, or the area is too crowded to search.
 */
// ponytail: only nodes within reach() count; widen it if far detours start crossing nodes.
export function route(a: Point, da: Point, b: Point, db: Point, obstacles: Rect[]): Point[] {
  const area = reach(a, b)
  const nearby = obstacles.filter(r => overlap(r, area))
  const s = stub(a, da, nearby)
  const t = stub(b, db, nearby)
  // Full clearance where there is room; between close nodes, squeeze through a thin margin instead.
  for (const clear of [CLEAR, 2]) {
    const rects = nearby.map(r => inflate(r, clear))
    const path = attempt(a, s, t, b, dirOf(da), dirOf([-db[0], -db[1]]), rects)
    if (path) return path
  }
  const mx = (s[0] + t[0]) / 2
  return simplify([a, s, [mx, s[1]], [mx, t[1]], t, b])
}

// End of the straight piece that leaves anchor `p` along `d`: STUB long, but at most half the free
// gap to the next node ahead, so it never starts inside a close neighbour.
function stub(p: Point, d: Point, obstacles: Rect[]): Point {
  let free = 2 * STUB
  for (const [x, y, w, h] of obstacles) {
    const ahead = d[0] > 0 ? x - p[0] : d[0] < 0 ? p[0] - x - w : d[1] > 0 ? y - p[1] : p[1] - y - h
    const beside = d[0] ? p[1] > y && p[1] < y + h : p[0] > x && p[0] < x + w
    if (beside && ahead > 0) free = Math.min(free, ahead)
  }
  const len = Math.min(STUB, free / 2)
  return [p[0] + d[0] * len, p[1] + d[1] * len]
}

// One routing try with obstacles already inflated: fast shapes first, then the grid search.
// Returns undefined when nothing fits, so the caller can retry with less clearance.
function attempt(a: Point, s: Point, t: Point, b: Point, start: number, end: number, rects: Rect[]) {
  const inside = ([px, py]: Point) => rects.some(r => overlap(r, [px, py, 0, 0]))
  if (inside(s) || inside(t)) return // unreachable: don't burn the search budget
  const [mx, my] = [(s[0] + t[0]) / 2, (s[1] + t[1]) / 2]

  // Straight, L and Z shapes: most wires need nothing more than these.
  const shapes: Point[][] = [
    [s, t],
    [s, [t[0], s[1]], t],
    [s, [s[0], t[1]], t],
    [s, [mx, s[1]], [mx, t[1]], t],
    [s, [s[0], my], [t[0], my], t],
  ]
  const fits = (pts: Point[]) => {
    const full = simplify([a, ...pts, b])
    for (let i = 1; i < full.length; i++) {
      const [p, q] = [full[i - 1], full[i]]
      if (p[0] !== q[0] && p[1] !== q[1]) return false
    }
    for (let i = 1; i < pts.length; i++) if (blocked(pts[i - 1], pts[i], rects)) return false
    // No U-turn right after leaving `a` or before entering `b`.
    const dirs = full.slice(1).map((q, i) => dirOf([q[0] - full[i][0], q[1] - full[i][1]]))
    return dirs[0] === start && dirs[dirs.length - 1] === end
  }
  const cost = (pts: Point[]) => {
    const full = simplify([a, ...pts, b])
    let length = 0
    for (let i = 1; i < full.length; i++) length += Math.abs(full[i][0] - full[i - 1][0]) + Math.abs(full[i][1] - full[i - 1][1])
    return length + (full.length - 2) * BEND
  }
  const easy = shapes.filter(fits).sort((p, q) => cost(p) - cost(q))[0]
  if (easy) return simplify([a, ...easy, b])

  const path = search(s, t, start, end, rects, [mx, my])
  if (path) return simplify([a, ...path, b])
}

// A* over a sparse grid whose lines run through the stub ends, their midpoint and every obstacle
// edge. States are (grid point, direction of travel), so bends can be charged.
function search(s: Point, t: Point, start: number, end: number, rects: Rect[], [mx, my]: Point) {
  const xs = [...new Set([s[0], t[0], mx, ...rects.flatMap(r => [r[0], r[0] + r[2]])])].sort((p, q) => p - q)
  const ys = [...new Set([s[1], t[1], my, ...rects.flatMap(r => [r[1], r[1] + r[3]])])].sort((p, q) => p - q)
  const [nx, ny] = [xs.length, ys.length]
  if (nx * ny > MAX_GRID) return
  const xi = new Map(xs.map((v, i) => [v, i]))
  const yi = new Map(ys.map((v, i) => [v, i]))

  // Grid edges that cross an obstacle, rasterized once: h[j*nx+i] is (i,j)-(i+1,j), v[j*nx+i] is (i,j)-(i,j+1).
  const h = new Uint8Array(nx * ny)
  const v = new Uint8Array(nx * ny)
  for (const [x, y, w, hh] of rects) {
    const [i0, i1, j0, j1] = [xi.get(x)!, xi.get(x + w)!, yi.get(y)!, yi.get(y + hh)!]
    for (let j = j0 + 1; j < j1; j++) for (let i = i0; i < i1; i++) h[j * nx + i] = 1
    for (let i = i0 + 1; i < i1; i++) for (let j = j0; j < j1; j++) v[j * nx + i] = 1
  }
  const open = (i: number, j: number, d: number) =>
    d === 0 ? !h[j * nx + i] : d === 1 ? !h[j * nx + i - 1] : d === 2 ? !v[j * nx + i] : !v[(j - 1) * nx + i]

  const [ti, tj] = [xi.get(t[0])!, yi.get(t[1])!]
  // Lower bound on the cost left: distance plus the bends any path heading `d` needs to reach `t`
  // and leave it heading `end`, nodes ignored. That is the exact cost without obstacles, so A* still
  // finds the cheapest route, but it skips the many states that distance alone ranks too high.
  const [ex, ey] = STEP[end]
  const bends = (dx: number, dy: number, d: number) => {
    if (d === (end ^ 1)) return 2 // turn, then turn back
    const ahead = dx * ex + dy * ey // how far `t` lies ahead along `end`
    if (d === end) return ahead < 0 ? 4 : (ex ? dy : dx) === 0 ? 0 : 2
    if (!dx && !dy) return 0 // at `t` itself: a goal, whose last bend was charged on the way in
    return dx * STEP[d][0] + dy * STEP[d][1] >= 0 && ahead >= 0 ? 1 : 3
  }
  const guess = (i: number, j: number, d: number) => {
    const dx = t[0] - xs[i]
    const dy = t[1] - ys[j]
    return Math.abs(dx) + Math.abs(dy) + BEND * bends(dx, dy, d)
  }
  // States are (j * nx + i) * 4 + direction, kept in the shared table below.
  const table = Table.next(nx * ny * 4)
  const heap = new Heap()
  const [si, sj] = [xi.get(s[0])!, yi.get(s[1])!]
  const first = (sj * nx + si) * 4 + start
  const at = table.slot(first)
  table.cost[at] = 0
  table.prev[at] = -1
  heap.push(guess(si, sj, start), first)

  for (let steps = BUDGET; heap.size && steps--; ) {
    const state = heap.pop()
    const here = table.slot(state)
    if (table.done[here]) continue // a cheaper copy of this state was already expanded
    table.done[here] = 1
    const d = state & 3
    const cell = state >> 2
    const i = cell % nx
    const j = (cell - i) / nx
    if (i === ti && j === tj && d !== (end ^ 1)) {
      const path: Point[] = []
      for (let st = state; st !== -1; st = table.prev[table.slot(st)]) path.push([xs[(st >> 2) % nx], ys[Math.floor((st >> 2) / nx)]])
      return path.reverse()
    }
    const cost = table.cost[here]
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d ^ 1)) continue
      const ni = i + STEP[nd][0]
      const nj = j + STEP[nd][1]
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny || !open(i, j, nd)) continue
      const next = (nj * nx + ni) * 4 + nd
      const nc = cost + Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]) + (nd === d ? 0 : BEND)
        + (ni === ti && nj === tj && nd !== end ? BEND : 0) // the last stub into `b` would bend here
      const there = table.slot(next)
      if (nc < table.cost[there]) {
        table.cost[there] = nc
        table.prev[there] = state
        heap.push(nc + guess(ni, nj, nd), next)
      }
    }
  }
}

/**
 * Costs, back links and expanded flags of one search's states, in typed arrays shared by every
 * search: a search reaches at most about 3 * BUDGET states, however large its grid. Grid-sized
 * arrays instead took 143 MB and 70 ms to fill for a long wire across 1000 scattered nodes.
 */
class Table {
  static readonly SIZE = 1 << BITS
  private static shared?: Table
  readonly cost = new Float64Array(Table.SIZE)
  readonly prev = new Int32Array(Table.SIZE)
  readonly done = new Uint8Array(Table.SIZE)
  private readonly key = new Int32Array(Table.SIZE)
  // The search a slot belongs to; slots of earlier searches count as free, so nothing is cleared.
  private readonly owner = new Uint32Array(Table.SIZE)
  private search = 0
  // States index slots directly when they all fit, which needs no hashing or probing.
  private direct = false

  /** The shared table, emptied for a search over `states` states. */
  static next(states: number) {
    const t = (Table.shared ??= new Table())
    if (++t.search === 2 ** 32) {
      t.owner.fill(0)
      t.search = 1
    }
    t.direct = states <= Table.SIZE
    return t
  }

  /** The slot of `state`, taken for it with infinite cost if it has none yet. */
  slot(state: number) {
    // Fibonacci hashing: the top bits of the product spread neighbouring states apart.
    let i = this.direct ? state : Math.imul(state, 0x9e3779b1) >>> (32 - BITS)
    for (;; i = (i + 1) & (Table.SIZE - 1)) {
      if (this.owner[i] !== this.search) {
        this.owner[i] = this.search
        this.key[i] = state
        this.cost[i] = Infinity
        this.done[i] = 0
        return i
      }
      if (this.key[i] === state) return i
    }
  }
}
