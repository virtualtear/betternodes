import { inflate, union, type Point, type Rect } from '../geometry/rect'
import { h } from './dom'
import type { Paints } from './sketch'
import type { View } from './view'

// Side of the cache canvas in px: nodes are drawn into it once, then scaled into view every frame.
const CACHE = 512

const css = (c: ArrayLike<number>) => `rgb(${c[0]} ${c[1]} ${c[2]} / ${c[3] / 255})`

/**
 * An overview of every node and the visible area, drawn on a canvas in a corner of the root.
 * @remarks Nodes are drawn once into an offscreen cache at a fixed scale. A node that moves only
 * clears and redraws the spots it left and took, through the view's index, and every frame scales
 * the cache into view, so a frame costs what moved, not the graph.
 */
export class Minimap {
  readonly el = h('canvas', 'bn-minimap')
  private readonly cache = new OffscreenCanvas(CACHE, CACHE)
  private readonly g = this.cache.getContext('2d')!
  // The world area the cache covers, a square, and cache px per world px.
  private covered: Rect = [0, 0, 1, 1]
  private scale = 1
  // Bounds of all nodes: exact after a full draw, grown by moves in between.
  private nodes?: Rect
  // The world area shown, which stays put while held, and how it maps to canvas px.
  private shown: Rect = [0, 0, 1, 1]
  private map = { x: 0, y: 0, k: 1 }
  // The visible area of the view, in world px.
  private area: Rect = [0, 0, 0, 0]
  private full = true
  private held = false
  // Fill styles by class list, and the one the cache context has: setting a style parses it.
  private readonly styles = new Map<string, string>()
  private style = ''

  constructor(private readonly view: View, private readonly paints: Paints) {
    view.root.append(this.el)
  }

  /** Redraws the spots of nodes whose rect changed or that went, and the visible area after a pan. */
  render(shifted: ReadonlyMap<string, Rect | undefined>, gone: readonly Rect[], panned: boolean) {
    if (!shifted.size && !gone.length && !panned && !this.full) return
    const { rects } = this.view
    for (const id of shifted.keys()) {
      const r = rects.get(id)!
      this.nodes = this.nodes ? union([this.nodes, r]) : r
    }
    const c = this.covered
    const n = this.nodes
    if (this.full || (n && (n[0] < c[0] || n[1] < c[1] || n[0] + n[2] > c[0] + c[2] || n[1] + n[3] > c[1] + c[3]))) this.redraw()
    else {
      for (const r of gone) this.mend(r)
      for (const [id, old] of shifted) {
        if (old) this.mend(old)
        this.mend(rects.get(id)!)
      }
    }
    this.full = false
    this.draw()
  }

  /** Draws everything again on the next frame, e.g. after a theme switch. */
  repaint() {
    this.full = true
    this.styles.clear()
  }

  /** World point under a screen point. */
  toWorld(clientX: number, clientY: number): Point {
    const r = this.el.getBoundingClientRect()
    const { x, y, k } = this.map
    return [(clientX - r.left - x) / k, (clientY - r.top - y) / k]
  }

  /** Keeps the scale fixed while true; letting go fits the overview again on the next frame. */
  hold(on: boolean) {
    this.held = on
    if (!on) this.full = true
    this.view.update()
  }

  destroy() {
    this.el.remove()
  }

  // Every node, into a cache that covers them with room to grow.
  private redraw() {
    const rects = [...this.view.rects.values()]
    this.nodes = rects.length ? union(rects) : undefined
    const [x, y, w, h] = this.nodes ?? [0, 0, 1, 1]
    const side = Math.max(w, h) * 1.5 || 1
    this.covered = [x + w / 2 - side / 2, y + h / 2 - side / 2, side, side]
    this.scale = CACHE / side
    this.g.clearRect(0, 0, CACHE, CACHE)
    this.style = ''
    for (const [id, r] of this.view.rects) this.fill(id, r)
  }

  // Clears a spot in the cache and draws the nodes that overlap it again. Whole nodes, without a
  // clip: a node drawn over itself in its own colour leaves the pixels around the spot as they were.
  private mend(spot: Rect) {
    const area = inflate(spot, 2 / this.scale)
    const [x, y, w, h] = this.px(area)
    this.g.clearRect(x, y, w, h)
    this.view.index.near(area, (id, r) => this.fill(id, r))
  }

  private fill(id: string, r: Rect) {
    const n = this.view.graph.nodes.get(id)
    if (!n) return
    const classes = n.classes?.length ? n.classes.join(' ') : ''
    let style = this.styles.get(classes)
    if (!style) this.styles.set(classes, (style = css(this.paints.look(`bn-mini-node ${classes}`)[0])))
    if (style !== this.style) this.g.fillStyle = this.style = style
    // At least a pixel, so far-out nodes still show.
    const [x, y, w, h] = this.px(r)
    this.g.fillRect(x, y, Math.max(w, 1), Math.max(h, 1))
  }

  // A world rect in cache px.
  private px([x, y, w, h]: Rect): Rect {
    const [cx, cy] = this.covered
    return [(x - cx) * this.scale, (y - cy) * this.scale, w * this.scale, h * this.scale]
  }

  private draw() {
    const { x, y, k, width, height } = this.view
    this.area = [-x / k, -y / k, width / k, height / k]
    if (!this.held) {
      // Shows the nodes and the visible area, however far apart they are.
      const s = union(this.nodes ? [this.nodes, this.area] : [this.area])
      this.shown = inflate(s, Math.max(s[2], s[3]) * 0.05)
    }
    // Its CSS size, without reading layout: min(200px, 35%) of the root wide, 4:3.
    const cw = Math.min(200, 0.35 * width)
    const ch = (cw * 3) / 4
    const dpr = devicePixelRatio
    const [pw, ph] = [Math.round(cw * dpr), Math.round(ch * dpr)]
    if (this.el.width !== pw || this.el.height !== ph) Object.assign(this.el, { width: pw, height: ph })
    // The shown area, centred and scaled to fit, as an SVG viewBox would.
    const [sx, sy, sw, sh] = this.shown
    const s = Math.min(cw / sw, ch / sh)
    this.map = { x: (cw - sw * s) / 2 - sx * s, y: (ch - sh * s) / 2 - sy * s, k: s }
    const g = this.el.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, cw, ch)
    const at = ([rx, ry, rw, rh]: Rect): Rect => [this.map.x + rx * s, this.map.y + ry * s, rw * s, rh * s]
    const [cx, cy, cs] = at(this.covered)
    g.drawImage(this.cache, cx, cy, cs, cs)
    const box = (r: Rect, className: string) => {
      const [fill, stroke, width] = this.paints.look(className)
      const [bx, by, bw, bh] = at(r)
      g.fillStyle = css(fill)
      g.fillRect(bx, by, bw, bh)
      if (!width) return
      g.strokeStyle = css(stroke)
      g.lineWidth = width
      g.strokeRect(bx, by, bw, bh)
    }
    for (const r of this.view.frames().values()) box(r, 'bn-mini-group')
    box(this.area, 'bn-mini-view')
  }
}
