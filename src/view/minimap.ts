import { inflate, union, type Point, type Rect } from '../geometry/rect'
import { setAttrs, svg } from './dom'
import type { View } from './view'

/** An overview of every node and the visible area, drawn in a corner of the root. */
export class Minimap {
  readonly el = svg('svg', 'bn-minimap')
  private readonly visible = svg('rect', 'bn-mini-view')
  private readonly rects = new Map<string, SVGRectElement>()
  private readonly frames = svg('g')
  // Bounds of all nodes, kept between frames in which no node moved; none without nodes.
  private nodes?: Rect
  // Every node needs drawing, e.g. right after the minimap was turned on.
  private full = true
  // While held (a drag on the minimap) the scale stays put, so the pointer maps steadily to the world.
  private held = false

  constructor(private readonly view: View) {
    this.el.append(this.frames, this.visible)
    view.root.append(this.el)
  }

  /** Redraws `moved` nodes and, after a pan or zoom, the visible area. */
  render(moved: Set<string>, panned: boolean) {
    if (!moved.size && !panned && !this.full) return
    const { graph } = this.view
    if (moved.size || this.full) {
      for (const id of this.full ? graph.nodes.keys() : moved) this.renderNode(id)
      const boxes = [...graph.nodes.keys()].map(id => this.view.box(id))
      this.nodes = boxes.length ? union(boxes) : undefined
      this.frames.replaceChildren(...[...this.view.frames().values()].map(([x, y, width, height]) => {
        const rect = svg('rect', 'bn-mini-group')
        setAttrs(rect, { x, y, width, height })
        return rect
      }))
    }
    this.full = false
    const { x, y, k, width, height } = this.view
    const area: Rect = [-x / k, -y / k, width / k, height / k]
    setAttrs(this.visible, { x: area[0], y: area[1], width: area[2], height: area[3] })
    if (this.held) return
    // Shows the nodes and the visible area, however far apart they are.
    const shown = union(this.nodes ? [this.nodes, area] : [area])
    const [bx, by, bw, bh] = inflate(shown, Math.max(shown[2], shown[3]) * 0.05)
    setAttrs(this.el, { viewBox: `${bx} ${by} ${bw} ${bh}` })
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

  private renderNode(id: string) {
    const n = this.view.graph.nodes.get(id)
    if (!n) return
    let rect = this.rects.get(id)
    if (!rect) {
      rect = svg('rect')
      this.rects.set(id, rect)
      this.visible.before(rect)
    }
    const [x, y, width, height] = this.view.box(id)
    setAttrs(rect, { class: ['bn-mini-node', ...n.classes ?? []].join(' '), x, y, width, height })
  }
}
