import { ANCHORS, anchorOf, nodeOf, type Graph, type NodeDef } from '../model/graph'
import { GRID, type Point, type Rect } from '../geometry/rect'
import { route } from '../geometry/route'
import { curve } from '../geometry/svg-path'
import { layout } from '../layout/columns'
import { untangle } from '../layout/untangle'
import { anchorDots, arrowDefs, h, svg, swapClass } from './dom'
import { Wires } from './wires'

/** Unit vector pointing outward from a ref's anchor, e.g. `[1, 0]` for `e`. */
function outward(ref: string): Point {
  const [fx, fy] = ANCHORS[anchorOf(ref)]
  const [dx, dy] = [2 * fx - 1, 2 * fy - 1]
  const len = Math.hypot(dx, dy)
  return [dx / len, dy / len]
}

// Right-angled exit direction of an anchor; corners leave through their east or west side.
function axis(ref: string): Point {
  const [fx, fy] = ANCHORS[anchorOf(ref)]
  return fx !== 0.5 ? [fx > 0.5 ? 1 : -1, 0] : [0, fy > 0.5 ? 1 : -1]
}

/** Renders a graph into a root element, batching DOM writes into one animation frame. */
export class View {
  private world = h('div', 'bn-world')
  private svg = svg('svg', 'bn-wires')
  /** Pan offset in screen px. */
  x = 0
  y = 0
  /** Zoom factor: screen px per world px. */
  k = 1
  /** Nodes being dragged right now; they may overlap others until they are dropped. */
  dragging = new Set<string>()
  /** Selected nodes, or one selected wire by `from>to` key; never both. Change it with {@link View.select}. */
  selected: { nodes: Set<string>; wire?: string } = { nodes: new Set() }
  /** Runs after every actual selection change. */
  onSelect?: () => void
  private els = new Map<string, HTMLElement>()
  private preview = svg('path', 'bn-preview')
  private wires: Wires
  // Node border-box sizes in world px.
  private sizes = new Map<string, Point>()
  // Nodes needing a full rebuild, a position/class update, and a re-measure on the next frame.
  private dirty = new Set<string>()
  private moved = new Set<string>()
  private stale = new Set<string>()
  private resize = new ResizeObserver(entries => {
    for (const e of entries) this.stale.add((e.target as HTMLElement).dataset.node!)
    this.update()
  })
  private queued = false
  private frame = 0
  private panned = false
  // Starts true so the first render shows the whole graph.
  private fitting = true
  // Packets ride above the wires but below the nodes, so they slide into a node when they arrive.
  private packets = svg('g')
  /** Runs at the end of every frame, after wires got this frame's geometry. */
  onFrame?: (now: number) => void
  private ghost?: { fixed: string; to: Point; hide?: string }
  private lifted: Element[] = []
  private highlighted: Element[] = []
  // Wire notes, drawn above every wire.
  private notes = svg('g')
  // Selection box in world px while the user draws one, and its element in screen space, so its
  // border stays 1px at any zoom.
  private bandRect?: Rect
  private band = h('div', 'bn-band')

  // Whether we made the root focusable, so destroy() knows to undo it.
  private tabbed: boolean

  constructor(readonly root: HTMLElement, readonly graph: Graph) {
    root.classList.add('bn')
    // Focusable, so a click inside it lets Delete/Escape reach its keydown listener.
    this.tabbed = !root.hasAttribute('tabindex')
    if (this.tabbed) root.tabIndex = -1
    this.wires = new Wires(graph, this.notes, id => this.box(id), (from, to, obstacles) => this.wire(from, to, obstacles))
    this.svg.append(arrowDefs(), this.notes, this.preview, this.packets)
    this.world.append(this.svg)
    this.band.style.display = 'none'
    root.append(this.world, this.band)
  }

  /** Removes everything this view added to the root. */
  destroy() {
    this.resize.disconnect()
    this.world.remove()
    this.band.remove()
    this.root.classList.remove('bn')
    if (this.tabbed) this.root.removeAttribute('tabindex')
    if (!this.root.classList.length) this.root.removeAttribute('class')
    this.root.style.removeProperty('background-position')
    this.root.style.removeProperty('background-size')
    if (!this.root.style.length) this.root.removeAttribute('style')
    cancelAnimationFrame(this.frame)
    this.queued = true // blocks any later frame from touching the detached DOM
  }

  /** Removes a deleted node's element; its wires disappear with the next frame's reconcile. */
  drop(id: string) {
    this.wires.free(id)
    const el = this.els.get(id)
    if (el) {
      this.resize.unobserve(el)
      el.remove()
    }
    for (const map of [this.els, this.sizes]) map.delete(id)
    for (const set of [this.dirty, this.moved, this.stale]) set.delete(id)
    if (this.selected.nodes.has(id)) this.select([...this.selected.nodes].filter(other => other !== id))
    this.update()
  }

  /** Schedules a full node re-render (title, content, anchors) on the next frame. */
  mark(id: string) {
    if (!this.graph.nodes.has(id)) return // deleted: its definition can change, but it isn't shown
    this.dirty.add(id)
    this.update()
  }

  /** Schedules a position and class update; no rebuild, so cheap enough for every drag frame. */
  place(id: string) {
    if (!this.graph.nodes.has(id)) return
    this.moved.add(id)
    this.update()
  }

  /** Sets pan offset and zoom, applied on the next frame. */
  viewport(x: number, y: number, k: number) {
    Object.assign(this, { x, y, k })
    this.panned = true
    this.update()
  }

  /** Re-runs auto-layout for every node now, with freshly measured sizes, instead of next frame. */
  relayout() {
    for (const n of this.graph.nodes.values()) {
      n.placed = false
      this.stale.add(n.id)
    }
    cancelAnimationFrame(this.frame)
    this.flush(performance.now())
  }

  /** Zooms (never past 100%) and pans so every node is visible, on the next frame. */
  fit() {
    this.fitting = true
    this.update()
  }

  /** Schedules a frame; wires are reconciled against the graph on every frame. */
  update() {
    if (this.queued) return
    this.queued = true
    this.frame = requestAnimationFrame(now => this.flush(now))
  }

  /**
   * Previews a wire being dragged from a fixed anchor to a world point; no arguments hides it.
   * @param hide - key (`from>to`) of an existing wire to hide meanwhile, e.g. one being moved.
   */
  drag(fixed?: string, to?: Point, hide?: string) {
    this.ghost = fixed && to ? { fixed, to, hide } : undefined
    this.update()
  }

  /** Selects these nodes, or else the wire with key `from>to`; no arguments clear the selection. */
  select(nodes: Iterable<string> = [], wire?: string) {
    const next = new Set(nodes)
    const { nodes: old, wire: was } = this.selected
    if (wire === was && next.size === old.size && [...next].every(id => old.has(id))) return
    this.selected = { nodes: next, wire }
    this.update()
    this.onSelect?.()
  }

  /** Shows the selection box over a world rect; no argument hides it. */
  marquee(rect?: Rect) {
    this.bandRect = rect
    this.update()
  }

  /** The visible path of a wire, once it has been drawn. */
  path(key: string) {
    return this.wires.path(key)
  }

  /** Creates a packet dot in the packet layer, hidden until it is first placed on its wire. */
  packetDot(className?: string) {
    const dot = svg('circle', 'bn-packet')
    if (className) dot.classList.add(className)
    dot.setAttribute('r', '5')
    // Without a position it would flash at the world origin for a frame.
    dot.setAttribute('visibility', 'hidden')
    this.packets.append(dot)
    return dot
  }

  /** Converts a client (screen) point to world coordinates. */
  toWorld(clientX: number, clientY: number): Point {
    const r = this.root.getBoundingClientRect()
    return [(clientX - r.left - this.x) / this.k, (clientY - r.top - this.y) / this.k]
  }

  /** World position of an anchor ref. */
  anchor(ref: string): Point {
    const n = this.graph.nodes.get(nodeOf(ref))!
    const [w, h] = this.sizes.get(n.id) ?? [0, 0]
    const [fx, fy] = ANCHORS[anchorOf(ref)]
    return [n.x + fx * w, n.y + fy * h]
  }

  /**
   * `ref` itself if it names an anchor. A bare node id gets the side facing `other` (a ref or a
   * world point): east/west when the two are further apart sideways than vertically, else south/north.
   */
  resolve(ref: string, other: string | Point): string {
    if (ref.includes('.')) return ref
    const [x, y, w, h] = this.box(ref)
    const [ox, oy, ow, oh] = typeof other !== 'string' ? [...other, 0, 0]
      : other.includes('.') ? [...this.anchor(other), 0, 0] : this.box(other)
    const dx = ox + ow / 2 - (x + w / 2)
    const dy = oy + oh / 2 - (y + h / 2)
    const sideways = Math.abs(dx) - (w + ow) / 2 >= Math.abs(dy) - (h + oh) / 2
    return `${ref}.${sideways ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n'}`
  }

  /** A node's rect in world px: position and measured size. */
  box(id: string): Rect {
    const n = this.graph.nodes.get(id)!
    return [n.x, n.y, ...this.sizes.get(id) ?? [0, 0]]
  }

  private wire(from: string, to: string, obstacles: Rect[]) {
    const [a, b] = [this.resolve(from, to), this.resolve(to, from)]
    return route(this.anchor(a), axis(a), this.anchor(b), axis(b), obstacles)
  }

  // One frame. All DOM writes come first, then all reads, so the browser lays out once per frame;
  // the steps after measuring only write transforms, which need no new layout.
  private flush(now: number) {
    this.queued = false
    if (this.panned) this.applyViewport()
    for (const id of this.dirty) this.renderNode(this.graph.nodes.get(id)!)
    for (const id of this.moved) {
      const n = this.graph.nodes.get(id)!
      this.els.get(id)!.className = ['bn-node', ...n.classes ?? []].join(' ')
      this.move(n, n.x, n.y)
    }
    for (const id of this.stale) if (this.measure(id)) this.moved.add(id)
    this.autoLayout()
    this.pullApart()
    if (this.fitting) this.fitAll()
    this.wires.render(this.moved, this.dragging)
    this.renderOverlays()
    this.dirty.clear()
    this.moved.clear()
    this.stale.clear()
    this.panned = false
    this.onFrame?.(now)
  }

  private move(n: NodeDef, x: number, y: number) {
    Object.assign(n, { x, y })
    this.els.get(n.id)!.style.transform = `translate(${x}px, ${y}px)`
    this.moved.add(n.id)
  }

  // Auto-layout needs measured sizes, so it runs after the reads. It places each node once:
  // `placed` keeps later wire changes from moving it again.
  private autoLayout() {
    for (const [id, [x, y]] of layout(this.graph, this.sizes, GRID)) {
      const n = this.graph.nodes.get(id)!
      n.placed = true
      if (n.x !== x || n.y !== y) this.move(n, x, y)
    }
  }

  // Pulls apart nodes that code, a saved state or growing content put on top of each other.
  private pullApart() {
    if ([...this.moved].every(id => this.dragging.has(id))) return
    const ids = [...this.graph.nodes.keys()]
    const rects = new Map(ids.map(id => [id, this.box(id)]))
    for (const [id, [x, y]] of untangle(ids, rects, this.moved, GRID, GRID, this.dragging)) {
      this.move(this.graph.nodes.get(id)!, x, y)
    }
  }

  // Wire preview while dragging, the wire being moved, the selection box and highlight.
  private renderOverlays() {
    const g = this.ghost
    this.preview.style.display = g ? '' : 'none'
    if (g) {
      const fixed = this.resolve(g.fixed, g.to)
      this.preview.setAttribute('d', curve(this.anchor(fixed), outward(fixed), g.to, [0, 0]))
    }
    this.lifted = swapClass('bn-lifted', this.lifted, g?.hide ? this.wires.parts(g.hide) : [])
    const band = this.bandRect
    this.band.style.display = band ? '' : 'none'
    if (band) {
      const [x, y, w, h] = band
      Object.assign(this.band.style, {
        transform: `translate(${x * this.k + this.x}px, ${y * this.k + this.y}px)`,
        width: `${w * this.k}px`,
        height: `${h * this.k}px`,
      })
    }
    if (this.selected.wire && !this.graph.edges.has(this.selected.wire)) this.select()
    const { nodes, wire } = this.selected
    const selected = wire ? this.wires.parts(wire)
      : [...nodes].map(id => this.els.get(id)).filter(el => el !== undefined)
    this.highlighted = swapClass('bn-selected', this.highlighted, selected)
  }

  private applyViewport() {
    const { x, y, k } = this
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${k})`
    // Anchors are too small to grab below 50%, and thousands of them on screen slow down panning.
    this.world.classList.toggle('bn-far', k < 0.5)
    // Keep the dotted grid background in sync with the world.
    this.root.style.backgroundPosition = `${x}px ${y}px`
    this.root.style.backgroundSize = `${GRID * k}px ${GRID * k}px`
  }

  // Runs inside flush, after measuring, and applies the viewport right away so nothing flashes.
  private fitAll() {
    const { clientWidth: w, clientHeight: h } = this.root
    if (!this.graph.nodes.size || !w || !h) return // stays pending until there is something to fit
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const id of this.graph.nodes.keys()) {
      const [x, y, bw, bh] = this.box(id)
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x + bw)
      y1 = Math.max(y1, y + bh)
    }
    const pad = 40
    const k = Math.min(1, Math.max(0.1, Math.min((w - 2 * pad) / (x1 - x0), (h - 2 * pad) / (y1 - y0))))
    Object.assign(this, { x: (w - (x1 - x0) * k) / 2 - x0 * k, y: (h - (y1 - y0) * k) / 2 - y0 * k, k })
    this.fitting = false
    this.applyViewport()
  }

  private renderNode(n: NodeDef) {
    let el = this.els.get(n.id)
    if (!el) {
      el = h('div', 'bn-node')
      el.dataset.node = n.id
      this.els.set(n.id, el)
      this.world.append(el)
      this.resize.observe(el)
    }
    el.replaceChildren(h('div', 'bn-title', n.title), ...(n.content ? [n.content] : []), ...anchorDots(n.id))
    this.moved.add(n.id)
    this.stale.add(n.id)
  }

  // Returns whether the size changed; unchanged nodes need no wire updates.
  private measure(id: string) {
    const r = this.els.get(id)!.getBoundingClientRect()
    const [w, h] = [r.width / this.k, r.height / this.k]
    const old = this.sizes.get(id)
    this.sizes.set(id, [w, h])
    return !old || old[0] !== w || old[1] !== h
  }
}
