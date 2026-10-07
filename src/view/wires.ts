import { nodeOf, type Graph } from '../model/graph'
import { Buckets } from '../geometry/buckets'
import { separate } from '../geometry/lanes'
import { bounds, halfway, overlap, type Point, type Rect } from '../geometry/rect'
import { CLEAR } from '../geometry/route'
import { rounded } from '../geometry/svg-path'
import { svg } from './dom'

// `r` with `m` px added on every side.
const grow = ([x, y, w, h]: Rect, m: number): Rect => [x - m, y - m, w + 2 * m, h + 2 * m]

/**
 * Where a wire's note goes: the middle of its longest inner segment where `fits` says the note is
 * clear of nodes, else of its longest one. Inner segments keep notes away from the first and last
 * ones, which wires fanning in or out of one anchor share. Halfway along wires without any.
 */
export function notePoint(points: Point[], fits: (at: Point) => boolean): Point {
  const mids: [length: number, mid: Point][] = []
  for (let i = 1; i < points.length - 2; i++) {
    const [p, q] = [points[i], points[i + 1]]
    mids.push([Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]), [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]])
  }
  if (!mids.length) return halfway(points)
  mids.sort((a, b) => b[0] - a[0])
  return (mids.find(([, mid]) => fits(mid)) ?? mids[0])[1]
}

/** Draws every wire of a graph as SVG and re-routes only the wires a node change can affect. */
export class Wires {
  // One <g data-wire> per wire: a visible path plus a wide transparent one to grab it by.
  private groups = new Map<string, SVGGElement>()
  // Each wire's routed bounding box, and every node's rect as of the last render: together they
  // tell which wires a moving node may now block or free.
  private boxes = new Map<string, Rect>()
  private rects = new Map<string, Rect>()
  // Spots of nodes removed since the last render: wires that went around them can straighten out.
  private freed: Rect[] = []
  // Routed waypoints per wire, before and after lane separation.
  private routes = new Map<string, Point[]>()
  private drawn = new Map<string, Point[]>()
  // The <text data-wire> of every wire that shows a note.
  private notes = new Map<string, SVGTextElement>()
  // Classes from Graph.classes as last applied to each wire's elements.
  private applied = new Map<string, string[]>()
  // Graph version at the last render; a different one means wires may have been added or removed.
  private seen = -1

  /**
   * @param layer - holds the notes; wire groups go right before it, so notes are drawn over every
   * wire and no other wire's grab area covers them.
   * @param box - a node's current rect in world px.
   * @param route - waypoints for a wire between two refs, around `obstacles`.
   */
  constructor(
    private graph: Graph,
    private layer: SVGGElement,
    private box: (id: string) => Rect,
    private route: (from: string, to: string, obstacles: Rect[]) => Point[],
  ) {}

  /** A drawn wire's elements: its `<g data-wire>` group, plus its note if it has one. */
  parts(key: string) {
    return [this.groups.get(key), this.notes.get(key)].filter(el => el !== undefined)
  }

  /** The visible path of a wire, once it has been drawn. */
  path(key: string) {
    return this.groups.get(key)?.firstElementChild as SVGPathElement | undefined
  }

  /** Remembers where a removed node was, so wires that went around it get re-routed. */
  free(id: string) {
    const rect = this.rects.get(id)
    if (rect) this.freed.push(rect)
  }

  /**
   * Adds and removes wire elements to match the graph and re-routes wires near `touched` nodes.
   * @param rigid - nodes dragged together. Wires between two of them move along with the group
   * instead of re-routing, until a render without them, e.g. on the drop.
   */
  // ponytail: scans every wire when something changed; add a node->wires index past ~5k wires.
  render(touched: Set<string>, rigid: ReadonlySet<string> = new Set()) {
    // Idle frames (panning, packets) skip the per-node and per-wire scans entirely.
    if (!touched.size && !this.freed.length && this.seen === this.graph.version) return
    this.seen = this.graph.version
    const now = new Map([...this.graph.nodes.keys()].map(id => [id, this.box(id)]))
    const obstacles = [...now.values()]
    // Old and new spots of every node that moved or resized: wires passing there need a new route.
    // Bucketed, so dragging a group doesn't compare every wire with every spot.
    const spots = new Buckets<null>()
    for (const r of this.freed.splice(0)) spots.add(r, null)
    for (const id of touched) {
      const old = this.rects.get(id)
      if (old) spots.add(old, null)
      spots.add(now.get(id)!, null)
    }
    const last = this.rects
    this.rects = now
    // How far a node moved since the last render; undefined if it is new or changed size.
    const shift = (id: string) => {
      const [a, b] = [last.get(id), now.get(id)!]
      return a && a[2] === b[2] && a[3] === b[3] ? [b[0] - a[0], b[1] - a[1]] : undefined
    }
    let rerouted = false
    for (const [key, g] of this.groups) {
      if (this.graph.edges.has(key)) continue
      g.remove()
      this.notes.get(key)?.remove()
      this.groups.delete(key)
      this.boxes.delete(key)
      this.routes.delete(key)
      this.notes.delete(key)
      rerouted = true
    }
    for (const [key, [from, to]] of this.graph.edges) {
      const [f, t] = [nodeOf(from), nodeOf(to)]
      let g = this.groups.get(key)
      if (!g) {
        g = svg('g')
        g.dataset.wire = key
        g.append(svg('path', 'bn-wire'), svg('path', 'bn-hit'))
        this.groups.set(key, g)
        this.layer.before(g)
      } else if (!touched.has(f) && !touched.has(t) && spots.empty(grow(this.boxes.get(key)!, CLEAR))) continue
      else if (rigid.has(f) && rigid.has(t)) {
        // Both ends moved by the same offset: shift the route along instead of searching a new one.
        const [d, e] = [shift(f), shift(t)]
        if (d && e && d[0] === e[0] && d[1] === e[1]) {
          if (!d[0] && !d[1]) continue
          const [dx, dy] = d
          this.routes.set(key, this.routes.get(key)!.map(([x, y]): Point => [x + dx, y + dy]))
          const [bx, by, bw, bh] = this.boxes.get(key)!
          this.boxes.set(key, [bx + dx, by + dy, bw, bh])
          rerouted = true
          continue
        }
      }
      const points = this.route(from, to, obstacles)
      this.boxes.set(key, bounds(points))
      this.routes.set(key, points)
      rerouted = true
    }
    if (rerouted) {
      // Lanes depend on every wire in a corridor, so re-spread all and write only paths that changed.
      this.drawn = separate(this.routes)
      for (const [key, points] of this.drawn) {
        const d = rounded(points)
        const g = this.groups.get(key)!
        if (g.firstElementChild!.getAttribute('d') === d) continue
        for (const path of g.children) path.setAttribute('d', d)
      }
    }
    this.renderNotes()
    this.renderClasses()
  }

  // Adds and removes single classes, never rewriting the class attribute: the view toggles
  // bn-selected on the same elements. Only wires that have or had classes are visited.
  private renderClasses() {
    for (const key of new Set([...this.applied.keys(), ...this.graph.classes.keys()])) {
      const els = this.parts(key)
      const want = els.length ? this.graph.classes.get(key) ?? [] : []
      const had = this.applied.get(key) ?? []
      for (const el of els) {
        for (const name of had) if (!want.includes(name)) el.classList.remove(name)
        for (const name of want) if (!el.classList.contains(name)) el.classList.add(name)
      }
      if (want.length) this.applied.set(key, want)
      else this.applied.delete(key)
    }
  }

  // Only wires with a note are visited: usually a few.
  private renderNotes() {
    for (const [key, note] of this.notes) {
      if (this.graph.labels.has(key)) continue
      note.remove()
      this.notes.delete(key)
    }
    for (const [key, text] of this.graph.labels) {
      if (!this.groups.has(key)) continue // wire gone for now; undo may bring it back
      let note = this.notes.get(key)
      if (!note) {
        note = this.layer.appendChild(svg('text', 'bn-label'))
        note.dataset.wire = key
        this.notes.set(key, note)
      }
      if (note.textContent !== text) note.textContent = text
      // Estimated from the text rather than measured, which would cost a layout per note.
      const w = text.length * 6.5 + 6
      // ponytail: checks every node per candidate spot; bucket the nodes if notes x nodes gets big.
      const fits = ([cx, cy]: Point) => {
        const box: Rect = [cx - w / 2, cy - 8, w, 16]
        for (const r of this.rects.values()) if (overlap(r, box)) return false
        return true
      }
      const [x, y] = notePoint(this.drawn.get(key)!, fits).map(String)
      // Unchanged values are skipped: rewriting SVG geometry costs a layout even when equal.
      if (note.getAttribute('x') !== x) note.setAttribute('x', x)
      if (note.getAttribute('y') !== y) note.setAttribute('y', y)
    }
  }
}
