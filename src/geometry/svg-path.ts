import type { Point } from './rect'

// Rounded corners of a path through right-angled waypoints: where the straight run into each
// waypoint stops, the waypoint as the curve's control point, and where the next run starts.
function* corners(points: Point[], r: number): Generator<[enter: Point, corner: Point, leave: Point]> {
  for (let i = 1; i < points.length - 1; i++) {
    const [p, q, n] = [points[i - 1], points[i], points[i + 1]]
    const [lin, lout] = [Math.hypot(q[0] - p[0], q[1] - p[1]), Math.hypot(n[0] - q[0], n[1] - q[1])]
    const k = Math.min(r, lin / 2, lout / 2)
    const enter: Point = [q[0] - ((q[0] - p[0]) / lin) * k, q[1] - ((q[1] - p[1]) / lin) * k]
    const leave: Point = [q[0] + ((n[0] - q[0]) / lout) * k, q[1] + ((n[1] - q[1]) / lout) * k]
    yield [enter, q, leave]
  }
}

/** SVG path data through right-angled waypoints, with corners rounded by up to `r`. */
export function rounded(points: Point[], r = 8) {
  let d = `M${points[0][0]} ${points[0][1]}`
  for (const [enter, q, leave] of corners(points, r)) d += `L${enter[0]} ${enter[1]}Q${q[0]} ${q[1]} ${leave[0]} ${leave[1]}`
  const last = points[points.length - 1]
  return `${d}L${last[0]} ${last[1]}`
}

// Chords per rounded corner: enough to stay within 0.1px of where the browser puts each point.
const CHORDS = 8

/**
 * The path {@link rounded} draws through `points`, as a polyline that finds the point at a given
 * distance in plain JS.
 * @remarks The browser's getTotalLength() and getPointAtLength() re-walk the curves on every call,
 * about 15µs each: too slow to place thousands of packets every frame.
 */
export class Track {
  /** Total length in world px. */
  readonly length: number
  private points: Point[] = []
  // Distance from the start to each of `points`.
  private dist: number[] = []

  constructor(points: Point[], r = 8) {
    this.points.push(points[0])
    for (const [enter, [qx, qy], leave] of corners(points, r)) {
      this.points.push(enter)
      for (let i = 1; i <= CHORDS; i++) {
        const [t, u] = [i / CHORDS, 1 - i / CHORDS]
        this.points.push([u * u * enter[0] + 2 * u * t * qx + t * t * leave[0], u * u * enter[1] + 2 * u * t * qy + t * t * leave[1]])
      }
    }
    if (points.length > 1) this.points.push(points[points.length - 1])
    let sum = 0
    this.dist = this.points.map((p, i) => (sum += i ? Math.hypot(p[0] - this.points[i - 1][0], p[1] - this.points[i - 1][1]) : 0))
    this.length = sum
  }

  /** The point `distance` px along, clamped to the ends. */
  at(distance: number): Point {
    const { points, dist } = this
    // Binary search for the last point at or before `distance`.
    let [lo, hi] = [0, points.length - 1]
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (dist[mid] <= distance) lo = mid
      else hi = mid - 1
    }
    if (lo === points.length - 1) return points[lo]
    const [p, q] = [points[lo], points[lo + 1]]
    const f = Math.max(0, (distance - dist[lo]) / (dist[lo + 1] - dist[lo] || 1))
    return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]
  }
}

/** SVG path data for a bezier wire leaving `p1` along `d1` and arriving at `p2` from `d2`. */
export function curve([x1, y1]: Point, [dx1, dy1]: Point, [x2, y2]: Point, [dx2, dy2]: Point) {
  const l = Math.max(40, Math.hypot(x2 - x1, y2 - y1) / 2)
  return `M${x1} ${y1}C${x1 + dx1 * l} ${y1 + dy1 * l} ${x2 + dx2 * l} ${y2 + dy2 * l} ${x2} ${y2}`
}
