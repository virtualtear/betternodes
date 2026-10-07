import { ANCHORS, anchorOf, nodeOf, type Graph, type NodeDef } from '../model/graph'
import { GRID, bounds, frameAround, type Point, type Rect } from '../geometry/rect'
import { route } from '../geometry/route'
import { curve } from '../geometry/svg-path'
import { layout } from '../layout/columns'
import type { Settings } from '../options'
import { untangle } from '../layout/untangle'
import { anchorDots, arrowDefs, h, svg, swapClass } from './dom'
import { Dots } from './dots'
import { Minimap } from './minimap'
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
  /** Root size in screen px, as of the last frame that fitted, drew the minimap or drew packets. */
  width = 0
  height = 0
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
  // Set in the constructor from the `fit` option, so the first render shows the whole graph.
  private fitting: boolean
  // Nodes the pending fit shows; undefined for all of them.
  private fitIds?: string[]
  // Packets ride above the wires but below the nodes, so they slide into a node when they arrive.
  private packets = svg('g')
  /** Packet dots, drawn at the end of every frame. */
  readonly dots = new Dots(this.packets, this.svg)
  /** Runs at the end of every frame, after wires got this frame's geometry. */
  onFrame?: (now: number) => void
  /** Runs once per frame in which the pan offset or zoom changed. */
  onViewport?: () => void
  /** Present while the `minimap` option is on; created and removed by the next frame. */
  mini?: Minimap
  private ghost?: { fixed: string; to: Point; hide?: string }
  private lifted: Element[] = []
  private highlighted: Element[] = []
  // Wire notes, drawn above every wire.
  private notes = svg('g')
  // Selection box in world px while the user draws one, and its element in screen space, so its
  // border stays 1px at any zoom.
  private bandRect?: Rect
  private band = h('div', 'bn-band')
  // Group frames by group id, and whether a group definition changed since the last frame.
  private groupEls = new Map<string, HTMLElement>()
  private regroup = false

  // Whether we made the root focusable, so destroy() knows to undo it.
  private tabbed: boolean

  constructor(readonly root: HTMLElement, readonly graph: Graph, readonly settings: Settings) {
    this.fitting = settings.fit
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
    this.dots.destroy()
    this.mini?.destroy()
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
    this.mini?.drop(id)
    if (this.graph.memberOf.has(id)) this.regroup = true
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

  /** Schedules redrawing the group frames, e.g. after a title or membership changed. */
  markGroups() {
    this.regroup = true
    this.update()
  }

  /** Frame rect in world px of every group with members shown. */
  frames() {
    const out = new Map<string, Rect>()
    for (const [g, ids] of this.graph.members()) out.set(g, frameAround(ids.map(id => this.box(id))))
    return out
  }

  /** Schedules a position and class update; no rebuild, so cheap enough for every drag frame. */
  place(id: string) {
    if (!this.graph.nodes.has(id)) return
    this.moved.add(id)
    this.update()
  }

  /** Sets pan offset and zoom, applied on the next frame; cancels a pending fit. */
  viewport(x: number, y: number, k: number) {
    Object.assign(this, { x, y, k })
    this.panned = true
    this.fitting = false
    this.update()
  }

  /** Zooms to `k`, clamped to the zoom options, keeping the point at screen px `px`, `py` in place. */
  zoomAt(px: number, py: number, k: number) {
    k = Math.min(this.settings.maxZoom, Math.max(this.settings.minZoom, k))
    const ratio = k / this.k
    this.viewport(px - (px - this.x) * ratio, py - (py - this.y) * ratio, k)
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

  /**
   * Zooms (never past 100%, never below `minZoom`) and pans so these nodes, or all of them, are
   * visible, on the next frame.
   */
  fit(ids?: string[]) {
    this.fitting = true
    this.fitIds = ids
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

  /** The track of a wire's visible path, once it has been drawn. */
  track(key: string) {
    return this.wires.track(key)
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
    // Read before this frame's writes, which a read would otherwise have to lay out first.
    if (this.fitting || this.settings.minimap || this.dots.size) Object.assign(this, { width: this.root.clientWidth, height: this.root.clientHeight })
    if (this.panned) this.applyViewport()
    for (const id of this.dirty) this.renderNode(this.graph.nodes.get(id)!)
    for (const id of this.moved) {
      const n = this.graph.nodes.get(id)!
      this.els.get(id)!.className = ['bn-node', ...n.classes ?? [], ...(this.dragging.has(id) ? ['bn-dragging'] : [])].join(' ')
      this.move(n, n.x, n.y)
    }
    for (const id of this.stale) if (this.measure(id)) this.moved.add(id)
    this.autoLayout()
    this.pullApart()
    if (this.regroup || this.moved.size) this.renderGroups()
    const fitted = this.fitting && this.fitAll()
    this.toggleMinimap()
    this.mini?.render(this.moved, this.panned || fitted)
    this.wires.render(this.moved, this.dragging)
    this.renderOverlays()
    this.dirty.clear()
    this.moved.clear()
    this.stale.clear()
    if (this.panned || fitted) this.onViewport?.()
    this.panned = false
    this.onFrame?.(now)
    if (this.dots.draw(now, this.x, this.y, this.k, this.width, this.height)) this.update()
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

  // Follows the `minimap` option, which Flow.set() may have changed since the last frame.
  private toggleMinimap() {
    if (this.settings.minimap && !this.mini) this.mini = new Minimap(this)
    else if (!this.settings.minimap && this.mini) {
      this.mini.destroy()
      this.mini = undefined
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
  // Returns whether it did; it stays pending while there is nothing to fit.
  private fitAll() {
    const { width: w, height: h } = this
    const ids = (this.fitIds ?? [...this.graph.nodes.keys()]).filter(id => this.graph.nodes.has(id))
    // Fitting nodes that got deleted meanwhile is dropped, not kept for when undo brings them back.
    if (this.fitIds && !ids.length) this.fitting = false
    if (!ids.length || !w || !h) return false
    // The whole graph includes the group frames, so their titles stay in view.
    const rects = [...ids.map(id => this.box(id)), ...(this.fitIds ? [] : this.frames().values())]
    const [x0, y0, bw, bh] = bounds(rects.flatMap(([x, y, w, h]): Point[] => [[x, y], [x + w, y + h]]))
    const [x1, y1] = [x0 + bw, y0 + bh]
    const pad = 40
    const { minZoom, maxZoom } = this.settings
    const k = Math.max(minZoom, Math.min(1, maxZoom, (w - 2 * pad) / (x1 - x0), (h - 2 * pad) / (y1 - y0)))
    Object.assign(this, { x: (w - (x1 - x0) * k) / 2 - x0 * k, y: (h - (y1 - y0) * k) / 2 - y0 * k, k })
    this.fitting = false
    this.applyViewport()
    return true
  }

  // Frames sit right before the wire layer: behind wires and nodes. Only their titles take pointer
  // events, so a press inside a frame acts on the background.
  private renderGroups() {
    this.regroup = false
    const frames = this.frames()
    for (const [id, el] of this.groupEls) {
      if (this.graph.groups.has(id)) continue
      el.remove()
      this.groupEls.delete(id)
    }
    for (const g of this.graph.groups.values()) {
      let el = this.groupEls.get(g.id)
      if (!el) {
        el = h('div', '')
        el.dataset.group = g.id
        el.append(h('div', 'bn-group-title'))
        this.groupEls.set(g.id, el)
        this.svg.before(el)
      }
      // Every drag frame gets here, so only real changes are written.
      const className = ['bn-group', ...g.classes ?? []].join(' ')
      if (el.className !== className) el.className = className
      if (el.firstChild!.textContent !== g.title) el.firstChild!.textContent = g.title
      const [x, y, width, height] = frames.get(g.id) ?? []
      const style = x === undefined ? { display: 'none' }
        : { display: '', transform: `translate(${x}px, ${y}px)`, width: `${width}px`, height: `${height}px` }
      for (const [name, value] of Object.entries(style)) if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value)
    }
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
