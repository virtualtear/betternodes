import type { Point } from './rect'

/** SVG path data through right-angled waypoints, with corners rounded by up to `r`. */
export function rounded(points: Point[], r = 8) {
  let d = `M${points[0][0]} ${points[0][1]}`
  for (let i = 1; i < points.length - 1; i++) {
    const [p, q, n] = [points[i - 1], points[i], points[i + 1]]
    const [lin, lout] = [Math.hypot(q[0] - p[0], q[1] - p[1]), Math.hypot(n[0] - q[0], n[1] - q[1])]
    const k = Math.min(r, lin / 2, lout / 2)
    const enter = [q[0] - ((q[0] - p[0]) / lin) * k, q[1] - ((q[1] - p[1]) / lin) * k]
    const leave = [q[0] + ((n[0] - q[0]) / lout) * k, q[1] + ((n[1] - q[1]) / lout) * k]
    d += `L${enter[0]} ${enter[1]}Q${q[0]} ${q[1]} ${leave[0]} ${leave[1]}`
  }
  const last = points[points.length - 1]
  return `${d}L${last[0]} ${last[1]}`
}

/** SVG path data for a bezier wire leaving `p1` along `d1` and arriving at `p2` from `d2`. */
export function curve([x1, y1]: Point, [dx1, dy1]: Point, [x2, y2]: Point, [dx2, dy2]: Point) {
  const l = Math.max(40, Math.hypot(x2 - x1, y2 - y1) / 2)
  return `M${x1} ${y1}C${x1 + dx1 * l} ${y1 + dy1 * l} ${x2 + dx2 * l} ${y2 + dy2 * l} ${x2} ${y2}`
}
