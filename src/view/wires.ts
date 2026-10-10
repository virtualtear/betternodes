import { Buckets } from '../geometry/buckets'
import { separate } from '../geometry/lanes'
import { bounds, halfway, inflate, overlap, type Point, type Rect } from '../geometry/rect'
import { CLEAR } from '../geometry/route'
import { rounded, Track } from '../geometry/svg-path'
import { nodeOf, type Graph } from '../model/graph'
import type { WireKey } from '../model/state'
import { setAttrs, svg } from './dom'

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

const same = (a: Point[] | undefined, b: Point[]) =>
  a === b || (a?.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]))

/** Draws every wire of a graph as SVG and re-routes only the wires a node change can affect. */
export class Wires {
  // One <g data-wire> per wire: a visible path plus a wide transparent one to grab it by.
  private readonly groups = new Map<WireKey, SVGGElement>()
  // Each wire's routed bounding box: it tells which wires a moving node may now block or free.
  private readonly boxes = new Map<WireKey, Rect>()
  // Spots of nodes removed since the last render: wires that went around them can straighten out.
  private readonly freed: Rect[] = []
  // Wires moved along with a dragged group instead of routed; routed again once it is dropped.
  private readonly carried = new Set<WireKey>()
  // Waypoints per wire, before and after lane separation.
  private readonly routes = new Map<WireKey, Point[]>()
  private drawn = new Map<WireKey, Point[]>()
  // Built when a packet first needs one, dropped on every re-route.
  private readonly tracks = new Map<WireKey, Track>()
  private readonly notes = new Map<WireKey, SVGTextElement>()
  // Classes from Graph.classes as last applied to each wire's elements.
  private readonly applied = new Map<WireKey, string[]>()
  // Graph version at the last render.
  private seen = -1

  /**
   * @param layer - holds the notes; wire groups go right before it, so notes are drawn over every
   * wire and no other wire's grab area covers them.
   * @param rects - every node's current rect in world px, and `index` the same by area.
   * @param route - waypoints for a wire between two refs, around the nodes `near` finds in an area.
   */
  constructor(
    private readonly graph: Graph,
    private readonly layer: SVGGElement,
    private readonly rects: ReadonlyMap<string, Rect>,
    private readonly index: Buckets<string>,
    private readonly route: (from: string, to: string, near: (area: Rect) => Rect[]) => Point[],
  ) {}

  // The node rects in an area; may repeat one.
  private readonly near = (area: Rect) => {
    const hits: Rect[] = []
    this.index.near(area, (_, r) => hits.push(r))
    return hits
  }

  /** A drawn wire's elements: its `<g data-wire>` group, plus its note if it has one. */
  parts(key: WireKey) {
    return [this.groups.get(key), this.notes.get(key)].filter(el => el !== undefined)
  }

  /** The track of a wire's visible path, once it has been drawn. */
  track(key: WireKey) {
    let track = this.tracks.get(key)
    const points = this.drawn.get(key)
    if (!track && points) this.tracks.set(key, (track = new Track(points)))
    return track
  }

  /** Remembers where a removed node was, so wires that went around it get re-routed. */
  free(rect: Rect) {
    this.freed.push(rect)
  }

  /**
   * Adds and removes wire elements to match the graph and re-routes wires near nodes whose rect changed.
   * @param shifted - those nodes, each with its rect before the change; undefined for new ones.
   * @param rigid - nodes dragged together. Wires between two of them move along with the group
   * instead of re-routing, until a render without them, e.g. on the drop.
   */
  // ponytail: checks every wire against the moved spots, so a drag frame takes about 2 ms at 5000
  // nodes; index the wire boxes by area if graphs grow well past that.
  render(shifted: ReadonlyMap<string, Rect | undefined>, rigid: ReadonlySet<string> = new Set()) {
    // Wires, notes and classes only appear or go with a version bump; moves alone keep it.
    const changed = this.seen !== this.graph.version
    // Idle frames (panning, packets) skip the per-wire scan entirely, unless a group drag just ended.
    if (!shifted.size && !this.freed.length && !changed && (!this.carried.size || rigid.size)) return
    this.seen = this.graph.version
    // Old and new spots of every node that moved or resized: wires passing there need a new route.
    // Bucketed, so dragging a group doesn't compare every wire with every spot.
    const spots = new Buckets<null>()
    for (const r of this.freed.splice(0)) spots.add(r, null)
    for (const [id, old] of shifted) {
      if (old) spots.add(old, null)
      spots.add(this.rects.get(id)!, null)
    }
    // Undefined if the node is new or changed size.
    const shift = (id: string): Point | undefined => {
      const [a, b] = [shifted.get(id), this.rects.get(id)!]
      return a && a[2] === b[2] && a[3] === b[3] ? [b[0] - a[0], b[1] - a[1]] : undefined
    }
    let rerouted = false
    if (changed) {
      for (const key of this.groups.keys()) {
        if (this.graph.edges.has(key)) continue
        this.forget(key)
        rerouted = true
      }
    }
    // Collected first, so the obstacle lookup knows how many routes it serves.
    const pending: [key: WireKey, from: string, to: string][] = []
    for (const [key, [from, to]] of this.graph.edges) {
      const [f, t] = [nodeOf(from), nodeOf(to)]
      if (!this.groups.has(key)) this.create(key)
      else if (!shifted.has(f) && !shifted.has(t) && !this.carried.has(key) && spots.empty(inflate(this.boxes.get(key)!, CLEAR))) continue
      else if (rigid.has(f) && rigid.has(t)) {
        // Both ends moved by the same offset: shift the route along instead of searching a new one.
        const [d, e] = [shift(f), shift(t)]
        if (d && e && d[0] === e[0] && d[1] === e[1]) {
          if (!d[0] && !d[1]) continue
          this.translate(key, d)
          this.carried.add(key)
          rerouted = true
          continue
        }
      }
      pending.push([key, from, to])
      this.carried.delete(key)
    }
    for (const [key, from, to] of pending) {
      const points = this.route(from, to, this.near)
      this.boxes.set(key, bounds(points))
      this.routes.set(key, points)
    }
    const redrawn = rerouted || pending.length ? this.redraw() : new Set<WireKey>()
    this.renderNotes(redrawn, spots)
    if (changed) this.renderClasses()
  }

  private create(key: WireKey) {
    const g = svg('g')
    g.dataset.wire = key
    g.append(svg('path', 'bn-wire'), svg('path', 'bn-hit'))
    this.groups.set(key, g)
    this.layer.before(g)
  }

  private forget(key: WireKey) {
    this.groups.get(key)?.remove()
    this.notes.get(key)?.remove()
    this.carried.delete(key)
    for (const map of [this.groups, this.boxes, this.routes, this.notes, this.tracks]) map.delete(key)
  }

  private translate(key: WireKey, [dx, dy]: Point) {
    this.routes.set(key, this.routes.get(key)!.map(([x, y]): Point => [x + dx, y + dy]))
    const [x, y, w, h] = this.boxes.get(key)!
    this.boxes.set(key, [x + dx, y + dy, w, h])
  }

  // Lanes depend on every wire in a corridor, so all are re-spread. Only wires whose points changed
  // get a new path and track: packets on the others keep theirs. Returns the keys of those wires.
  private redraw() {
    const last = this.drawn
    const redrawn = new Set<WireKey>()
    this.drawn = separate(this.routes)
    for (const [key, points] of this.drawn) {
      if (same(last.get(key), points)) continue
      redrawn.add(key)
      this.tracks.delete(key)
      const d = rounded(points)
      for (const path of this.groups.get(key)!.children) path.setAttribute('d', d)
    }
    return redrawn
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

  // A note moves only when it is new, its text changed, its wire was redrawn, or a node moved or
  // went near it (`spots`), since its spot depends on nothing else.
  private renderNotes(redrawn: ReadonlySet<WireKey>, spots: Buckets<null>) {
    for (const [key, note] of this.notes) {
      if (this.graph.labels.has(key)) continue
      note.remove()
      this.notes.delete(key)
    }
    const due: [key: WireKey, note: SVGTextElement, width: number][] = []
    for (const [key, text] of this.graph.labels) {
      if (!this.groups.has(key)) continue // wire gone for now; undo may bring it back
      let note = this.notes.get(key)
      let newText = false
      if (!note) {
        note = this.layer.appendChild(svg('text', 'bn-label'))
        note.dataset.wire = key
        this.notes.set(key, note)
        newText = true
      }
      if (note.textContent !== text) {
        note.textContent = text
        newText = true
      }
      // Estimated from the text rather than measured, which would cost a layout per note.
      const w = text.length * 6.5 + 6
      // Every candidate box lies within this pad of the routed box: half the note's width, half its
      // height (8), and the 8 px lanes may shift a segment.
      if (!newText && !redrawn.has(key) && spots.empty(inflate(this.boxes.get(key)!, w / 2 + 16))) continue
      due.push([key, note, w])
    }
    for (const [key, note, w] of due) {
      const fits = ([cx, cy]: Point) => this.index.empty([cx - w / 2, cy - 8, w, 16])
      const [x, y] = notePoint(this.drawn.get(key)!, fits)
      setAttrs(note, { x, y })
    }
  }
}
