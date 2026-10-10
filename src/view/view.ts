import { GRID, clamp, fitInto, frameAround, union, type Point, type Rect } from '../geometry/rect'
import { route } from '../geometry/route'
import { curve } from '../geometry/svg-path'
import { layout } from '../layout/columns'
import { untangle } from '../layout/untangle'
import { anchorOf, nodeOf, type Graph, type NodeDef } from '../model/graph'
import type { Settings } from '../options'
import { anchorAt, axis, facing, outward } from './anchors'
import { anchorDots, arrowDefs, h, svg, swapClass } from './dom'
import { Groups } from './groups'
import { Minimap } from './minimap'
import { Dots } from './packets/dots'
import { Wires } from './wires'

// Screen px between a fitted graph and the root's border.
const FIT_PAD = 40
const UNMEASURED: Readonly<Point> = [0, 0]

/** Renders a graph into a root element, batching DOM writes into one animation frame. */
export class View {
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
  /** Selected nodes, or one selected wire by key; never both. Change it with {@link View.select}. */
  selected: { nodes: Set<string>; wire?: string } = { nodes: new Set() }
  /** Present while the `minimap` option is on; created and removed by the next frame. */
  mini?: Minimap
  onSelect?: () => void
  /** Runs at the end of every frame, after wires got this frame's geometry. */
  onFrame?: (now: number) => void
  /** Runs once per frame in which the pan offset or zoom changed. */
  onViewport?: () => void
  /** Set by {@link View.destroy}; a destroyed view runs no more frames. */
  destroyed = false

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
  private readonly resize = new ResizeObserver(entries => {
    for (const e of entries) this.stale.add((e.target as HTMLElement).dataset.node!)
    this.update()
  })
  private readonly tabbed: boolean
  private queued = false
  private frame = 0
  private panned = false
  private regroup = false
  private fitting: boolean
  // Nodes the pending fit shows; undefined for all of them.
  private fitIds?: string[]
  private ghost?: { fixed: string; to: Point; hide?: string }
  private bandRect?: Rect
  private lifted: Element[] = []
  private highlighted: Element[] = []

  constructor(readonly root: HTMLElement, readonly graph: Graph, readonly settings: Settings) {
    this.fitting = settings.fit
    root.classList.add('bn')
    // Focusable, so a click inside it lets Delete and Escape reach its keydown listener.
    this.tabbed = !root.hasAttribute('tabindex')
    if (this.tabbed) root.tabIndex = -1
    this.wires = new Wires(graph, this.notes, id => this.box(id), (from, to, obstacles) => this.wire(from, to, obstacles))
    this.groups = new Groups(graph, this.svg)
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
    this.wires.free(id)
    const el = this.els.get(id)
    if (el) {
      this.resize.unobserve(el)
      el.remove()
    }
    this.mini?.drop(id)
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
      this.stale.add(n.id)
    }
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
  drag(fixed?: string, to?: Point, hide?: string) {
    this.ghost = fixed && to ? { fixed, to, hide } : undefined
    this.update()
  }

  /** Selects these nodes, or else the wire with this key; no arguments clear the selection. */
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
    const [w, h] = this.sizes.get(id) ?? UNMEASURED
    return [x, y, w, h]
  }

  private wire(from: string, to: string, obstacles: Rect[]) {
    const [a, b] = [this.resolve(from, to), this.resolve(to, from)]
    return route(this.anchor(a), axis(anchorOf(a)), this.anchor(b), axis(anchorOf(b)), obstacles)
  }

  // One frame. All DOM writes come first, then all reads, so the browser lays out once per frame;
  // the steps after measuring only write transforms, which need no new layout.
  private flush(now: number) {
    this.queued = false
    // Read before this frame's writes, which a read would otherwise have to lay out first.
    if (this.fitting || this.settings.minimap || this.dots.size) {
      this.width = this.root.clientWidth
      this.height = this.root.clientHeight
    }
    if (this.panned) this.applyViewport()
    for (const id of this.dirty) this.renderNode(this.graph.nodes.get(id)!)
    for (const id of this.moved) this.renderPlace(this.graph.nodes.get(id)!)
    for (const id of this.stale) if (this.measure(id)) this.moved.add(id)
    // Unplaced nodes are always stale: node() and relayout() both mark them.
    if (this.stale.size) this.autoLayout()
    this.pullApart()
    if (this.regroup || this.moved.size) {
      this.regroup = false
      this.groups.render(this.frames())
    }
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

  // Runs after measuring, since it needs sizes. `placed` keeps later wire changes from moving a node again.
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

  // Applies the viewport right away so nothing flashes. Stays pending while there is nothing to fit.
  private fitAll() {
    const ids = (this.fitIds ?? [...this.graph.nodes.keys()]).filter(id => this.graph.nodes.has(id))
    // Fitting nodes that got deleted meanwhile is dropped, not kept for when undo brings them back.
    if (this.fitIds && !ids.length) this.fitting = false
    if (!ids.length || !this.width || !this.height) return false
    // The whole graph includes the group frames, so their titles stay in view.
    const rects = [...ids.map(id => this.box(id)), ...(this.fitIds ? [] : this.frames().values())]
    const { minZoom, maxZoom } = this.settings
    Object.assign(this, fitInto(union(rects), this.width, this.height, FIT_PAD, [minZoom, Math.min(1, maxZoom)]))
    this.fitting = false
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
    return !old || old[0] !== w || old[1] !== h
  }
}
