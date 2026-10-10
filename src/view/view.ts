import { Buckets } from '../geometry/buckets'
import { GRID, clamp, fitInto, frameAround, overlap, union, type Point, type Rect } from '../geometry/rect'
import { reach, route, STUB } from '../geometry/route'
import { curve } from '../geometry/svg-path'
import { layout } from '../layout/columns'
import { untangle } from '../layout/untangle'
import { anchorOf, nodeOf, type Graph, type NodeDef } from '../model/graph'
import type { WireKey } from '../model/state'
import type { Settings } from '../options'
import { anchorAt, axis, facing, outward } from './anchors'
import { anchorDots, arrowDefs, h, svg, swapClass } from './dom'
import { Groups } from './groups'
import { Minimap } from './minimap'
import { Dots } from './packets/dots'
import { Paints, Sketch } from './sketch'
import { Wires } from './wires'

// Screen px between a fitted graph and the root's border.
const FIT_PAD = 40
// Size assumed for a node that has no element to measure, until any node has been measured.
const GUESS: Readonly<Point> = [160, 40]
// Mount area while the root has no size yet, or while the view is far out: NaN overlaps nothing.
const NOWHERE: Rect = [NaN, NaN, 0, 0]
// Below this zoom titles are under 6px tall: nodes and wires are drawn as plain shapes on the GPU.
const FAR = 0.4

/** Renders a graph into a root element, batching DOM writes into one animation frame. */
export class View {
  /** Pan offset in screen px. */
  x = 0
  y = 0
  /** Zoom factor: screen px per world px. */
  k = 1
  /** Root size in screen px, as of the last frame that read it: fits, the minimap, packets and culling do. */
  width = 0
  height = 0
  /** Nodes being dragged right now; they may overlap others until they are dropped. */
  dragging = new Set<string>()
  /** Selected nodes, or one selected wire by key; never both. Change it with {@link View.select}. */
  selected: { nodes: Set<string>; wire?: WireKey } = { nodes: new Set() }
  /** Present while the `minimap` option is on; created and removed by the next frame. */
  mini?: Minimap
  onSelect?: () => void
  /** Runs at the end of every frame, after wires got this frame's geometry. */
  onFrame?: (now: number) => void
  /** Runs once per frame in which the pan offset or zoom changed. */
  onViewport?: () => void
  /** Set by {@link View.destroy}; a destroyed view runs no more frames. */
  destroyed = false
  /** Each node's rect as of the last frame, the same rects {@link View.index} holds. */
  readonly rects = new Map<string, Rect>()
  /** Spatial index of {@link View.rects}, by node id, kept up to date frame by frame. */
  readonly index = new Buckets<string>()

  private readonly world = h('div', 'bn-world')
  private readonly svg = svg('svg', 'bn-wires')
  private readonly notes = svg('g')
  private readonly preview = svg('path', 'bn-preview')
  // Above the wires but below the nodes, so packets slide into a node when they arrive.
  private readonly packets = svg('g')
  // In screen space, so its border stays 1px at any zoom.
  private readonly band = h('div', 'bn-band')
  readonly dots = new Dots(this.packets, this.svg)
  private readonly wires: Wires
  private readonly groups: Groups
  private readonly els = new Map<string, HTMLElement>()
  // Custom content each node element shows, so a re-render can tell whether it changed.
  private readonly contents = new Map<string, HTMLElement>()
  // Node border-box sizes in world px.
  private readonly sizes = new Map<string, Point>()
  // Nodes needing a full rebuild, a position and class update, and a re-measure on the next frame.
  private readonly dirty = new Set<string>()
  private readonly moved = new Set<string>()
  private readonly stale = new Set<string>()
  // This frame's nodes whose rect changed, with the rect they had before; undefined for new ones.
  private readonly shifted = new Map<string, Rect | undefined>()
  // Nodes waiting for auto-layout.
  private readonly unplaced = new Set<string>()
  // The area nodes have covered so far. It only grows, so a later layout batch never lands on them.
  private extent?: Rect
  private readonly resize = new ResizeObserver(entries => {
    for (const e of entries) {
      if (e.target === this.root) this.resized = true
      else this.stale.add((e.target as HTMLElement).dataset.node!)
    }
    this.update()
  })
  private resized = false
  // Nodes and wires as shapes for far zoom levels: made the first time the view goes far, then kept
  // up to date. `repaint` holds nodes whose look changed with the selection.
  private sketch?: Sketch
  private paints?: Paints
  private readonly repaint = new Set<string>()
  // When the theme was last checked: reading it forces a style recalc, so not every frame. While far
  // out or with the minimap on, a timer brings a frame now and then to look, since CSS can't recolour
  // what canvases drew.
  private themed = 0
  private poll = 0
  // Rects of nodes deleted since the last frame, for the minimap to clear.
  private gone: Rect[] = []
  // Each group's frame, kept between frames and made again only for groups whose members moved.
  private readonly framed = new Map<string, Rect>()
  // Size of a node without a measurement: the first one measured stands in for the rest.
  private guess = GUESS
  // World area whose nodes have elements, and the zoom it was made for; unset until the root has a size.
  private area?: Rect
  private areaK = 0
  private readonly tabbed: boolean
  private queued = false
  private frame = 0
  private panned = false
  private regroup = false
  private fitting: boolean
  // Nodes the pending fit shows; undefined for all of them.
  private fitIds?: string[]
  private ghost?: { fixed: string; to: Point; hide?: WireKey }
  private bandRect?: Rect
  private lifted: Element[] = []
  private highlighted: Element[] = []

  constructor(readonly root: HTMLElement, readonly graph: Graph, readonly settings: Settings) {
    this.fitting = settings.fit
    root.classList.add('bn')
    // Focusable, so a click inside it lets Delete and Escape reach its keydown listener.
    this.tabbed = !root.hasAttribute('tabindex')
    if (this.tabbed) root.tabIndex = -1
    this.resize.observe(root)
    this.wires = new Wires(graph, this.notes, this.rects, this.index, (from, to, near) => this.wire(from, to, near))
    this.groups = new Groups(graph, this.svg)
    this.svg.append(arrowDefs(), this.notes, this.preview, this.packets)
    this.world.append(this.svg)
    this.band.style.display = 'none'
    root.append(this.world, this.band)
  }

  /** Whether the view is far out, where nodes and wires are shapes on the GPU instead of elements. */
  get far() {
    return this.settings.virtual && this.k < FAR && this.dots.gpu()
  }

  /** The top node under a client point, found through the index: far out, nodes have no elements. */
  nodeAt(clientX: number, clientY: number) {
    const [x, y] = this.toWorld(clientX, clientY)
    let top: NodeDef | undefined
    this.index.near([x, y, 0, 0], id => {
      const n = this.graph.nodes.get(id)
      if (n && (!top || n.seq > top.seq)) top = n
    })
    return top?.id
  }

  /** Removes everything this view added to the root. */
  destroy() {
    clearTimeout(this.poll)
    this.paints?.destroy()
    this.dots.destroy()
    this.mini?.destroy()
    this.resize.disconnect()
    this.world.remove()
    this.band.remove()
    const { root } = this
    root.classList.remove('bn')
    if (this.tabbed) root.removeAttribute('tabindex')
    if (!root.classList.length) root.removeAttribute('class')
    root.style.removeProperty('background-position')
    root.style.removeProperty('background-size')
    if (!root.style.length) root.removeAttribute('style')
    cancelAnimationFrame(this.frame)
    this.destroyed = true
  }

  /** Removes a deleted node's element; its wires disappear with the next frame's reconcile. */
  drop(id: string) {
    const rect = this.rects.get(id)
    if (rect) {
      this.index.remove(rect, id)
      this.rects.delete(id)
      this.wires.free(rect)
      if (this.mini) this.gone.push(rect)
    }
    this.sketch?.nodes.delete(id)
    this.shifted.delete(id)
    const el = this.els.get(id)
    if (el) {
      this.resize.unobserve(el)
      el.remove()
    }
    if (this.graph.memberOf.has(id)) this.regroup = true
    this.els.delete(id)
    this.contents.delete(id)
    this.sizes.delete(id)
    for (const set of [this.dirty, this.moved, this.stale]) set.delete(id)
    if (this.selected.nodes.has(id)) this.select([...this.selected.nodes].filter(other => other !== id))
    this.update()
  }

  /** Schedules a full node re-render (title, content, anchors) on the next frame. */
  mark(id: string) {
    const n = this.graph.nodes.get(id)
    if (!n) return // deleted: its definition can change, but it isn't shown
    if (!n.placed) this.unplaced.add(id)
    this.dirty.add(id)
    this.update()
  }

  /** Schedules a position and class update; no rebuild, so cheap enough for every drag frame. */
  place(id: string) {
    if (!this.graph.nodes.has(id)) return
    this.moved.add(id)
    this.update()
  }

  /** Schedules redrawing the group frames, e.g. after a title or membership changed. */
  markGroups() {
    this.regroup = true
    this.update()
  }

  /** Frame rect in world px of every group with members shown, as of the last frame. */
  frames(): ReadonlyMap<string, Rect> {
    return this.framed
  }

  /** A group's frame from where its members are right now; undefined while none is shown. */
  frameOf(group: string) {
    const ids = this.graph.membersOf(group)
    return ids.length ? frameAround(ids.map(id => this.box(id))) : undefined
  }

  /** Sets pan offset and zoom, applied on the next frame; cancels a pending fit. */
  viewport(x: number, y: number, k: number) {
    Object.assign(this, { x, y, k })
    this.panned = true
    this.fitting = false
    this.update()
  }

  /** Zooms to `k`, clamped to the zoom options, keeping the screen point `px`, `py` in place. */
  zoomAt(px: number, py: number, k: number) {
    k = clamp(k, this.settings.minZoom, this.settings.maxZoom)
    const ratio = k / this.k
    this.viewport(px - (px - this.x) * ratio, py - (py - this.y) * ratio, k)
  }

  /** Re-runs auto-layout for every node now, with freshly measured sizes. */
  relayout() {
    if (this.destroyed) return
    for (const n of this.graph.nodes.values()) {
      n.placed = false
      // Mounted for measuring, if they aren't: layout needs every node's size.
      this.dirty.add(n.id)
      this.stale.add(n.id)
      this.unplaced.add(n.id)
    }
    this.extent = undefined
    cancelAnimationFrame(this.frame)
    this.flush(performance.now())
  }

  /** Zooms and pans on the next frame so these nodes, or all of them, are visible. */
  fit(ids?: string[]) {
    this.fitting = true
    this.fitIds = ids
    this.update()
  }

  /** Schedules a frame; wires are reconciled against the graph on every frame. */
  update() {
    if (this.queued || this.destroyed) return
    this.queued = true
    this.frame = requestAnimationFrame(now => this.flush(now))
  }

  /**
   * Previews a wire being dragged from a fixed anchor to a world point; no arguments hides it.
   * @param hide - key of an existing wire to hide meanwhile, e.g. one being moved.
   */
  drag(fixed?: string, to?: Point, hide?: WireKey) {
    this.ghost = fixed && to ? { fixed, to, hide } : undefined
    this.update()
  }

  /** Selects these nodes, or else the wire with this key; no arguments clear the selection. */
  select(nodes: Iterable<string> = [], wire?: WireKey) {
    const next = new Set(nodes)
    const { nodes: old, wire: was } = this.selected
    if (wire === was && next.size === old.size && [...next].every(id => old.has(id))) return
    if (this.sketch) {
      for (const id of old) if (!next.has(id)) this.repaint.add(id)
      for (const id of next) if (!old.has(id)) this.repaint.add(id)
    }
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
  track(key: WireKey) {
    return this.wires.track(key)
  }

  /** Converts a client (screen) point to world coordinates. */
  toWorld(clientX: number, clientY: number): Point {
    const r = this.root.getBoundingClientRect()
    return [(clientX - r.left - this.x) / this.k, (clientY - r.top - this.y) / this.k]
  }

  /** World position of an anchor ref. */
  anchor(ref: string) {
    return anchorAt(this.box(nodeOf(ref)), anchorOf(ref))
  }

  /** `ref` itself if it names an anchor; for a bare node id, its side facing `other` (a ref or a world point). */
  resolve(ref: string, other: string | Point): string {
    if (ref.includes('.')) return ref
    const target: Rect = typeof other !== 'string' ? [...other, 0, 0]
      : other.includes('.') ? [...this.anchor(other), 0, 0] : this.box(other)
    return `${ref}.${facing(this.box(ref), target)}`
  }

  /** A node's rect in world px: position and measured size. */
  box(id: string): Rect {
    const { x, y } = this.graph.nodes.get(id)!
    const [w, h] = this.sizes.get(id) ?? this.guess
    return [x, y, w, h]
  }

  private wire(from: string, to: string, near: (area: Rect) => Rect[]) {
    const [a, b] = [this.resolve(from, to), this.resolve(to, from)]
    const [pa, pb] = [this.anchor(a), this.anchor(b)]
    return route(pa, axis(anchorOf(a)), pb, axis(anchorOf(b)), near(reach(pa, pb)))
  }

  // One frame. All DOM writes come first, then all reads, so the browser lays out once per frame;
  // the steps after measuring only write transforms, which need no new layout.
  private flush(now: number) {
    this.queued = false
    // Read before this frame's writes, which a read would otherwise have to lay out first.
    if (this.fitting || this.settings.minimap || this.dots.size || this.resized || (this.settings.virtual && !this.width)) {
      this.width = this.root.clientWidth
      this.height = this.root.clientHeight
    }
    // A first guess at the fit, from what is known before measuring, so the right nodes get elements.
    if (this.fitting) this.fitAll(true)
    if (this.panned) this.applyViewport()
    for (const id of this.cull(this.resized)) this.dirty.add(id)
    this.resized = false
    for (const id of this.dirty) {
      // Nodes without an element still get a rect, from their position and a guessed size.
      if (this.els.has(id) || this.wanted(id)) this.renderNode(this.graph.nodes.get(id)!)
      else this.moved.add(id)
    }
    for (const id of this.moved) if (this.els.has(id)) this.renderPlace(this.graph.nodes.get(id)!)
    for (const id of this.stale) if (this.els.has(id) && this.measure(id)) this.moved.add(id)
    // After measuring: unplaced nodes are always stale, since node() and relayout() mark them.
    if (this.unplaced.size) this.autoLayout()
    for (const id of this.moved) this.sync(id)
    this.pullApart()
    this.reframe()
    const fitted = this.fitting && this.fitAll()
    const far = this.far
    // A theme switch: canvases redraw everything in the new colours.
    let themed = false
    if ((far || this.settings.minimap) && !this.moved.size && now - this.themed > 500) {
      this.themed = now
      themed = this.paint().changed()
    }
    // Moved in or out of the mount area, or into view by the fit: new elements wait for next frame.
    const late = fitted ? this.cull(true) : []
    for (const id of this.moved) {
      const want = this.wanted(id)
      if (!want && this.els.has(id)) this.unmount(id)
      else if (want && !this.els.has(id)) late.push(id)
    }
    if (this.regroup || this.moved.size) {
      this.regroup = false
      this.groups.render(this.framed)
    }
    this.toggleMinimap()
    if (themed) this.mini?.repaint()
    this.mini?.render(this.shifted, this.gone.splice(0), this.panned || fitted)
    // Read before the wires take the graph's changed wire keys.
    const edited = this.sketch ? [...this.graph.dirty] : []
    this.wires.render(this.shifted, this.dragging, this.settings.virtual ? this.area ?? NOWHERE : undefined)
    this.paintSketch(edited, themed)
    this.renderOverlays()
    this.dirty.clear()
    this.moved.clear()
    this.stale.clear()
    this.shifted.clear()
    this.repaint.clear()
    for (const id of late) this.dirty.add(id)
    if (late.length) this.update()
    if (this.panned || fitted) this.onViewport?.()
    this.panned = false
    this.onFrame?.(now)
    if (this.dots.draw(now, this.x, this.y, this.k, this.width, this.height, far ? this.sketch : undefined)) this.update()
    clearTimeout(this.poll)
    if (far || this.mini) this.poll = setTimeout(() => this.update(), 500)
  }

  private move(n: NodeDef, x: number, y: number) {
    Object.assign(n, { x, y })
    const el = this.els.get(n.id)
    if (el) el.style.transform = `translate(${x}px, ${y}px)`
    this.moved.add(n.id)
  }

  // Whether a node should have an element: it meets the mount area, waits for layout (which needs
  // its size), is being dragged or holds focus. Without the `virtual` option, every node has one;
  // far out, only nodes waiting for layout or holding focus do, since the GPU draws dragged ones.
  private wanted(id: string) {
    const n = this.graph.nodes.get(id)!
    if (!this.settings.virtual || !n.placed) return true
    if (!this.area) return false
    if (this.dragging.has(id) && this.area !== NOWHERE) return true
    const r = this.rects.get(id) ?? [n.x, n.y, ...this.guess]
    return overlap(r, this.area) || !!this.els.get(id)?.contains(document.activeElement)
  }

  // Unmounts the nodes outside the mount area and returns the ones in it that need an element. The
  // area is the view grown by half its size on every side, made anew only once the view leaves its
  // inner part or zooms in a lot, so most pans touch no element. Costs what the area holds.
  private cull(force: boolean): string[] {
    if (!this.settings.virtual) {
      // Turned off since the last frame: every node gets its element back.
      const all = this.area ? [...this.graph.nodes.keys()].filter(id => !this.els.has(id)) : []
      this.area = undefined
      return all
    }
    if (!this.width || !this.height) return []
    if (this.far) {
      // Far out: shapes on the GPU instead of elements.
      if (this.area !== NOWHERE) {
        this.area = NOWHERE
        for (const id of [...this.els.keys()]) if (!this.wanted(id)) this.unmount(id)
      }
      return []
    }
    const [w, h] = [this.width / this.k, this.height / this.k]
    const [vx, vy] = [-this.x / this.k, -this.y / this.k]
    const a = this.area
    const inside = a && vx >= a[0] + a[2] / 8 && vy >= a[1] + a[3] / 8 && vx + w <= a[0] + a[2] * 7 / 8 && vy + h <= a[1] + a[3] * 7 / 8
    if (!force && inside && this.k < this.areaK * 1.5) return []
    this.area = [vx - w / 2, vy - h / 2, 2 * w, 2 * h]
    this.areaK = this.k
    const next = new Set<string>()
    this.index.near(this.area, id => next.add(id))
    for (const id of [...this.els.keys()]) if (!next.has(id) && !this.wanted(id)) this.unmount(id)
    return [...next].filter(id => !this.els.has(id))
  }

  // Keeps the shapes of nodes and wires in step with the graph: all of them the first time the view
  // goes far or the theme switches, then only what changed, so later frames cost what changed.
  private paintSketch(edited: WireKey[], themed: boolean) {
    const all = !this.sketch || themed
    if (!this.sketch) {
      if (!this.far) return
      this.sketch = new Sketch()
    }
    if (all) {
      for (const id of this.graph.nodes.keys()) this.paintNode(id)
      for (const key of this.graph.edges.keys()) this.paintWire(key)
      return
    }
    for (const id of this.moved) this.paintNode(id)
    for (const id of this.repaint) this.paintNode(id)
    const wires = new Set(edited)
    for (const id of this.shifted.keys()) for (const key of this.graph.wiresAt(id)) wires.add(key)
    for (const key of wires) this.paintWire(key)
  }

  private paintNode(id: string) {
    const n = this.graph.nodes.get(id)
    if (!n) return this.sketch!.nodes.delete(id)
    const [fill, border] = this.paint().node(n.classes ?? [], this.selected.nodes.has(id))
    this.sketch!.node(id, this.rects.get(id) ?? this.box(id), fill, border)
  }

  // Far out a wire is the shape routing falls back to: a stub out of each anchor, joined by a Z.
  private paintWire(key: WireKey) {
    const edge = this.graph.edges.get(key)
    if (!edge) return this.sketch!.wires.delete(key)
    const [a, b] = [this.resolve(edge[0], edge[1]), this.resolve(edge[1], edge[0])]
    const [pa, pb, da, db] = [this.anchor(a), this.anchor(b), axis(anchorOf(a)), axis(anchorOf(b))]
    const s: Point = [pa[0] + da[0] * STUB, pa[1] + da[1] * STUB]
    const t: Point = [pb[0] + db[0] * STUB, pb[1] + db[1] * STUB]
    const mx = (s[0] + t[0]) / 2
    this.sketch!.wire(key, [pa, s, [mx, s[1]], [mx, t[1]], t, pb], this.paint().wire(this.graph.classes.get(key) ?? []))
  }

  // Colours from the stylesheet for what canvases draw.
  private paint() {
    if (!this.paints) {
      this.paints = new Paints(this.world, this.svg)
      this.paints.changed()
    }
    return this.paints
  }

  // Takes a node's element out of the page; its content element stays with the node definition.
  private unmount(id: string) {
    const el = this.els.get(id)!
    this.resize.unobserve(el)
    el.remove()
    this.els.delete(id)
    // So mounting again inserts the content again.
    this.contents.delete(id)
  }

  // Runs after measuring, since it needs sizes. `placed` keeps later wire changes from moving a node again.
  private autoLayout() {
    const todo = [...this.unplaced].flatMap(id => this.graph.nodes.get(id) ?? []).filter(n => !n.placed)
    this.unplaced.clear()
    for (const [id, [x, y]] of layout(this.graph, todo, this.sizes, GRID, this.extent)) {
      const n = this.graph.nodes.get(id)!
      n.placed = true
      if (n.x !== x || n.y !== y) this.move(n, x, y)
    }
  }

  // Brings the cached rect and the index in line with the node, remembering the old rect for this
  // frame's wire work.
  private sync(id: string) {
    const n = this.graph.nodes.get(id)!
    const [w, h] = this.sizes.get(id) ?? this.guess
    const old = this.rects.get(id)
    if (old && old[0] === n.x && old[1] === n.y && old[2] === w && old[3] === h) return
    const rect: Rect = [n.x, n.y, w, h]
    if (old) this.index.move(old, rect, id)
    else this.index.add(rect, id)
    this.rects.set(id, rect)
    const e = this.extent
    const inside = e && e[0] <= rect[0] && e[1] <= rect[1] && e[0] + e[2] >= rect[0] + w && e[1] + e[3] >= rect[1] + h
    if (!inside) this.extent = e ? union([e, rect]) : rect
    if (!this.shifted.has(id)) this.shifted.set(id, old)
  }

  // Makes the frames of groups whose members moved again; all of them after membership changes.
  private reframe() {
    const groups = this.regroup ? this.graph.groups.keys() : new Set(this.moved).values()
    const done = new Set<string>()
    for (const key of groups) {
      // Moved ids name nodes: their group, if any, is what to frame.
      const g = this.regroup ? key : this.graph.memberOf.get(key)
      if (g === undefined || done.has(g)) continue
      done.add(g)
      const frame = this.frameOf(g)
      if (frame) this.framed.set(g, frame)
      else this.framed.delete(g)
    }
    if (this.regroup) for (const g of this.framed.keys()) if (!this.graph.groups.has(g)) this.framed.delete(g)
  }

  // Pulls apart nodes that code, a saved state or growing content put on top of each other.
  private pullApart() {
    const changed = [...this.moved].filter(id => !this.dragging.has(id))
    if (!changed.length) return
    const rank = (id: string) => this.graph.nodes.get(id)!.seq
    for (const [id, [x, y]] of untangle(changed, this.rects, this.index, rank, GRID, GRID, this.dragging)) {
      this.move(this.graph.nodes.get(id)!, x, y)
      this.sync(id)
    }
  }

  // Follows the `minimap` option, which Flow.set() may have changed since the last frame.
  private toggleMinimap() {
    if (this.settings.minimap && !this.mini) this.mini = new Minimap(this, this.paint())
    else if (!this.settings.minimap && this.mini) {
      this.mini.destroy()
      this.mini = undefined
    }
  }

  // Wire preview while dragging, the wire being moved, the selection box and the selection highlight.
  private renderOverlays() {
    const { ghost, bandRect } = this
    this.preview.style.display = ghost ? '' : 'none'
    if (ghost) {
      const fixed = this.resolve(ghost.fixed, ghost.to)
      this.preview.setAttribute('d', curve(this.anchor(fixed), outward(anchorOf(fixed)), ghost.to, [0, 0]))
    }
    this.lifted = swapClass('bn-lifted', this.lifted, ghost?.hide ? this.wires.parts(ghost.hide) : [])
    this.band.style.display = bandRect ? '' : 'none'
    if (bandRect) {
      const [x, y, w, h] = bandRect
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
    this.root.style.backgroundPosition = `${x}px ${y}px`
    this.root.style.backgroundSize = `${GRID * k}px ${GRID * k}px`
  }

  // Applies the viewport right away so nothing flashes. Stays pending while there is nothing to fit,
  // and after a `rough` fit, which uses guessed sizes for nodes not measured yet.
  private fitAll(rough = false) {
    const ids = (this.fitIds ?? [...this.graph.nodes.keys()]).filter(id => this.graph.nodes.has(id))
    // Fitting nodes that got deleted meanwhile is dropped, not kept for when undo brings them back.
    if (this.fitIds && !ids.length) this.fitting = false
    if (!ids.length || !this.width || !this.height) return false
    // The whole graph includes the group frames, so their titles stay in view.
    const rects = [...ids.map(id => this.box(id)), ...(this.fitIds ? [] : this.frames().values())]
    const { minZoom, maxZoom } = this.settings
    Object.assign(this, fitInto(union(rects), this.width, this.height, FIT_PAD, [minZoom, Math.min(1, maxZoom)]))
    if (!rough) this.fitting = false
    this.applyViewport()
    return true
  }

  private renderNode(n: NodeDef) {
    let el = this.els.get(n.id)
    if (!el) {
      el = h('div', 'bn-node')
      el.dataset.node = n.id
      el.append(h('div', 'bn-title'), ...anchorDots(n.id))
      this.els.set(n.id, el)
      this.world.append(el)
      this.resize.observe(el)
    }
    // Changed in place: re-inserting the content would take focus away from an input inside it.
    const title = el.firstElementChild!
    if (title.textContent !== n.title) title.textContent = n.title
    const shown = this.contents.get(n.id)
    if (shown !== n.content) {
      // Unless the host moved it into another node meanwhile.
      if (shown?.parentElement === el) shown.remove()
      if (n.content) {
        title.after(n.content)
        this.contents.set(n.id, n.content)
      } else this.contents.delete(n.id)
    }
    this.moved.add(n.id)
    this.stale.add(n.id)
  }

  // Includes bn-selected, and writes only a changed class list: dropping it here for the overlay pass to
  // add back cost two style invalidations per selected node in every frame of a drag.
  private renderPlace(n: NodeDef) {
    const classes = ['bn-node', ...n.classes ?? []]
    if (this.dragging.has(n.id)) classes.push('bn-dragging')
    if (this.selected.nodes.has(n.id)) classes.push('bn-selected')
    const className = classes.join(' ')
    const el = this.els.get(n.id)!
    if (el.className !== className) el.className = className
    this.move(n, n.x, n.y)
  }

  // Returns whether the size changed; unchanged nodes need no wire updates.
  private measure(id: string) {
    const r = this.els.get(id)!.getBoundingClientRect()
    const [w, h] = [r.width / this.k, r.height / this.k]
    const old = this.sizes.get(id)
    this.sizes.set(id, [w, h])
    if (this.guess === GUESS) this.guess = [w, h]
    return !old || old[0] !== w || old[1] !== h
  }
}
