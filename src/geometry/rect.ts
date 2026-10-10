/** A point or vector in world px. */
export type Point = [x: number, y: number]

/** Axis-aligned rectangle in world px; read-only, since cached rects are shared. */
export type Rect = readonly [x: number, y: number, w: number, h: number]

/** Grid spacing in world px: background dots, node snapping and auto-layout all use it. */
export const GRID = 20

/**
 * Largest distance from the origin a node may be placed at, in world px. Bounds the grid math of
 * routing and spatial lookups, and leaves room for auto-layouts of very large graphs.
 */
export const WORLD = 1e9

/** Room a group frame leaves around its members: on the sides and bottom, and on top for its title. */
export const FRAME = { side: GRID, top: 2 * GRID }

export const snap = (v: number, grid = GRID) => Math.round(v / grid) * grid

/** `v` limited to `lo..hi`; `lo` wins when the two cross. */
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** `r` with `m` px added on every side. */
export const inflate = ([x, y, w, h]: Rect, m: number): Rect => [x - m, y - m, w + 2 * m, h + 2 * m]

/** Whether two rects' interiors overlap; touching edges don't count. */
// Index access, not destructuring: this runs millions of times in routing and free-spot searches.
export const overlap = (a: Rect, b: Rect) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]

/** Bounding box of a list of points. */
export function bounds(points: Iterable<Point>): Rect {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of points) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  return [x0, y0, x1 - x0, y1 - y0]
}

/** Bounding box of a list of rects. */
export function union(rects: Iterable<Rect>): Rect {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y, w, h] of rects) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x + w)
    y1 = Math.max(y1, y + h)
  }
  return [x0, y0, x1 - x0, y1 - y0]
}

/** A group frame around member rects. */
export function frameAround(rects: Iterable<Rect>): Rect {
  const [x, y, w, h] = union(rects)
  return [x - FRAME.side, y - FRAME.top, w + 2 * FRAME.side, h + FRAME.side + FRAME.top]
}

/** Pan offset and zoom that center `rect` in a `width` x `height` screen, `pad` px from its edges. */
export function fitInto([x, y, w, h]: Rect, width: number, height: number, pad: number, zoom: [min: number, max: number]) {
  const k = clamp(Math.min((width - 2 * pad) / w, (height - 2 * pad) / h), ...zoom)
  return { x: (width - w * k) / 2 - x * k, y: (height - h * k) / 2 - y * k, k }
}

/** The point halfway along a polyline. */
export function halfway(points: Point[]): Point {
  const lengths = points.slice(1).map((q, i) => Math.hypot(q[0] - points[i][0], q[1] - points[i][1]))
  let left = lengths.reduce((sum, len) => sum + len, 0) / 2
  for (const [i, len] of lengths.entries()) {
    if (len && left <= len) {
      const [p, q] = [points[i], points[i + 1]]
      return [p[0] + ((q[0] - p[0]) * left) / len, p[1] + ((q[1] - p[1]) * left) / len]
    }
    left -= len
  }
  return points[points.length - 1]
}
