/** A point or vector in world px. */
export type Point = [x: number, y: number]

/** Axis-aligned rectangle in world px. */
export type Rect = [x: number, y: number, w: number, h: number]

/** Grid spacing in world px: background dots, node snapping and auto-layout all use it. */
export const GRID = 20

export const snap = (v: number, grid = GRID) => Math.round(v / grid) * grid

/** Room a group frame leaves around its members in world px: on the sides and bottom, and on top for its title. */
export const FRAME = { side: GRID, top: 2 * GRID }

/** A group frame around member rects. */
export function frameAround(rects: Rect[]): Rect {
  const [x, y, w, h] = bounds(rects.flatMap(([x, y, w, h]): Point[] => [[x, y], [x + w, y + h]]))
  return [x - FRAME.side, y - FRAME.top, w + 2 * FRAME.side, h + FRAME.side + FRAME.top]
}

// Index access, not destructuring: this runs millions of times in routing and free-spot searches.
/**
 * Whether two rects' interiors overlap; touching edges don't count. With a `margin`, anything
 * closer than that counts as overlapping too.
 */
export const overlap = (a: Rect, b: Rect, margin = 0) =>
  a[0] - margin < b[0] + b[2] && b[0] < a[0] + a[2] + margin && a[1] - margin < b[1] + b[3] && b[1] < a[1] + a[3] + margin

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

/** Bounding box of a list of points. */
export function bounds(points: Point[]): Rect {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of points) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  return [x0, y0, x1 - x0, y1 - y0]
}
