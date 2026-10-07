import type { Point, Rect } from '../geometry/rect'
import { ANCHORS, type Anchor } from '../model/graph'

/** World position of `anchor` on a node at `box`. */
export function anchorAt([x, y, w, h]: Rect, anchor: Anchor): Point {
  const [fx, fy] = ANCHORS[anchor]
  return [x + fx * w, y + fy * h]
}

/** Unit vector pointing outward from an anchor, e.g. `[1, 0]` for `e`. */
export function outward(anchor: Anchor): Point {
  const [fx, fy] = ANCHORS[anchor]
  const [dx, dy] = [2 * fx - 1, 2 * fy - 1]
  const len = Math.hypot(dx, dy)
  return [dx / len, dy / len]
}

/** Right-angled exit direction of an anchor; corners leave through their east or west side. */
export function axis(anchor: Anchor): Point {
  const [fx, fy] = ANCHORS[anchor]
  return fx !== 0.5 ? [fx > 0.5 ? 1 : -1, 0] : [0, fy > 0.5 ? 1 : -1]
}

/** Side of `box` facing `other`: east or west when they are further apart sideways than vertically. */
export function facing([x, y, w, h]: Rect, [ox, oy, ow, oh]: Rect): Anchor {
  const dx = ox + ow / 2 - (x + w / 2)
  const dy = oy + oh / 2 - (y + h / 2)
  const sideways = Math.abs(dx) - (w + ow) / 2 >= Math.abs(dy) - (h + oh) / 2
  return sideways ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n'
}
