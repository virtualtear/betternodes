import { bounds, type Point, type Rect } from '../geometry/rect'
import { svg } from './dom'
import type { View } from './view'

// Rewriting SVG geometry costs style and layout work even when the value stays the same.
function attrs(el: Element, values: Record<string, string | number>) {
  for (const [name, value] of Object.entries(values)) if (el.getAttribute(name) !== `${value}`) el.setAttribute(name, `${value}`)
}

/** An overview of every node and the visible area, drawn in a corner of the root. */
export class Minimap {
  readonly el = svg('svg', 'bn-minimap')
  private visible = svg('rect', 'bn-mini-view')
  private rects = new Map<string, SVGRectElement>()
  // Group frames, redrawn whenever any node moved.
  private frames = svg('g')
  // Bounds of all nodes in world px, kept between frames in which no node moved; none without nodes.
  private nodes?: Rect
  // Every node needs drawing, e.g. right after the minimap was turned on.
  private full = true
  // While held (a drag on the minimap), the scale stays put, so the pointer maps steadily to the world.
  private held = false

  constructor(private view: View) {
    this.el.append(this.frames, this.visible)
    view.root.append(this.el)
  }

  /** Redraws `moved` nodes and, after a pan or zoom, the visible area. */
  render(moved: Set<string>, panned: boolean) {
    if (!moved.size && !panned && !this.full) return
    const { graph } = this.view
    const ids = this.full ? graph.nodes.keys() : moved
    for (const id of ids) {
      const n = graph.nodes.get(id)
      if (!n) continue
      let rect = this.rects.get(id)
      if (!rect) {
        rect = svg('rect')
        this.rects.set(id, rect)
        this.visible.before(rect)
      }
      const [x, y, width, height] = this.view.box(id)
      attrs(rect, { class: ['bn-mini-node', ...n.classes ?? []].join(' '), x, y, width, height })
    }
    if (moved.size || this.full) {
      const corners: Point[] = []
      for (const id of graph.nodes.keys()) {
        const [x, y, w, h] = this.view.box(id)
        corners.push([x, y], [x + w, y + h])
      }
      this.nodes = corners.length ? bounds(corners) : undefined
      this.frames.replaceChildren(...[...this.view.frames().values()].map(([x, y, width, height]) => {
        const rect = svg('rect', 'bn-mini-group')
        attrs(rect, { x, y, width, height })
        return rect
      }))
    }
    this.full = false
    const { x, y, k, width, height } = this.view
    const area: Rect = [-x / k, -y / k, width / k, height / k]
    attrs(this.visible, { x: area[0], y: area[1], width: area[2], height: area[3] })
    if (this.held) return
    // Shows the nodes and the visible area, however far apart they are.
    const [nx, ny, nw, nh] = this.nodes ?? area
    const [bx, by] = [Math.min(nx, area[0]), Math.min(ny, area[1])]
    const [bw, bh] = [Math.max(nx + nw, area[0] + area[2]) - bx, Math.max(ny + nh, area[1] + area[3]) - by]
    const pad = Math.max(bw, bh) * 0.05
    attrs(this.el, { viewBox: `${bx - pad} ${by - pad} ${bw + 2 * pad} ${bh + 2 * pad}` })
  }

  /** World point under a screen point. */
  toWorld(clientX: number, clientY: number): Point {
    const p = new DOMPoint(clientX, clientY).matrixTransform(this.el.getScreenCTM()!.inverse())
    return [p.x, p.y]
  }

  /** Keeps the scale fixed while true; letting go fits the overview again on the next frame. */
  hold(on: boolean) {
    this.held = on
    if (!on) this.full = true
    this.view.update()
  }

  drop(id: string) {
    this.rects.get(id)?.remove()
    this.rects.delete(id)
  }

  destroy() {
    this.el.remove()
  }
}
