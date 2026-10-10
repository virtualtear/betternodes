import { Buckets } from '../geometry/buckets'
import { separate } from '../geometry/lanes'
import { bounds, halfway, inflate, overlap, type Point, type Rect } from '../geometry/rect'
import { CLEAR, MARGIN } from '../geometry/route'
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

// Once moved spots outnumber this share of the wires on screen, testing each of those wires beats
// a lookup per spot. ponytail: a ratio from the 1000-node bench; measure again if spans grow.
const SPOT_SHARE = 1 / 16

const same = (a: Point[] | undefined, b: Point[]) =>
  a === b || (a?.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]))

/**
 * Draws the wires near the view as SVG and re-routes only the wires a node change can affect.
 * @remarks Every wire has a span: its two nodes' rects grown by how far routing looks around them,
 * plus its route once it has one. Spans are indexed by area, so finding the wires in view, or near
 * a moved node, costs what is there, not the graph. Wires outside the area have no element, route
 * or note until they come into view.
 */
export class Wires {
  // One <g data-wire> per mounted wire: a visible path plus a wide transparent one to grab it by.
  private readonly groups = new Map<WireKey, SVGGElement>()
  // Each mounted wire's routed bounding box: it tells which wires a moving node may now block or free.
  private readonly boxes = new Map<WireKey, Rect>()
  // Every wire's span, and the same by area.
  private readonly spans = new Map<WireKey, Rect>()
  private readonly reaches = new Buckets<WireKey>()
  // Wires between two nodes of a dragged group: always mounted, their spans updated on the drop.
  private readonly held = new Set<WireKey>()
  // The dragged group `held` was worked out for.
  private rigid: ReadonlySet<string> = new Set()
  // Each wire's two node ids, so frames don't split refs again.
  private readonly ends = new Map<WireKey, [from: string, to: string]>()
  // Spots of nodes removed since the last render: wires that went around them can straighten out.
  private readonly freed: Rect[] = []
  // Wires moved along with a dragged group instead of routed; routed again once it is dropped.
  private readonly carried = new Set<WireKey>()
  // Waypoints per mounted wire, before and after lane separation.
  private readonly routes = new Map<WireKey, Point[]>()
  private drawn = new Map<WireKey, Point[]>()
  // Built when a packet first needs one, dropped on every re-route.
  private readonly tracks = new Map<WireKey, Track>()
  // Tracks of wires without an element that packets travel on, routed without lanes.
  private readonly loose = new Map<WireKey, Track>()
  private readonly notes = new Map<WireKey, SVGTextElement>()
  // Classes from Graph.classes as last applied to each wire's elements.
  private readonly applied = new Map<WireKey, string[]>()
  // World area whose wires get elements; undefined for all of them.
  private area?: Rect

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

  /** The track of a wire's path, drawn or, for a wire without an element, routed just for this. */
  track(key: WireKey) {
    const points = this.drawn.get(key)
    if (points) {
      let track = this.tracks.get(key)
      if (!track) this.tracks.set(key, (track = new Track(points)))
      return track
    }
    const edge = this.graph.edges.get(key)
    if (!edge) return
    let track = this.loose.get(key)
    if (!track) this.loose.set(key, (track = new Track(this.route(...edge, this.near))))
    return track
  }

  /** Remembers where a removed node was, so wires that went around it get re-routed. */
  free(rect: Rect) {
    this.freed.push(rect)
  }

  /**
   * Brings wire elements in line with the graph and the view, and re-routes wires near nodes whose
   * rect changed.
   * @param shifted - those nodes, each with its rect before the change; undefined for new ones.
   * @param rigid - nodes dragged together. Wires between two of them move along with the group
   * instead of re-routing, until a render without them, e.g. on the drop.
   * @param area - the world area whose wires get elements; undefined for every wire.
   */
  render(shifted: ReadonlyMap<string, Rect | undefined>, rigid: ReadonlySet<string> = new Set(), area?: Rect) {
    const panned = area !== this.area
    this.area = area
    const { dirty } = this.graph
    // Idle frames skip all wire work, unless a group drag just ended.
    if (!shifted.size && !this.freed.length && !dirty.size && !panned && rigid === this.rigid && (!this.carried.size || rigid.size)) return
    // Wires at nodes whose rect changed. They become the set of wires to route or shift along, once
    // the wires near the moved spots, the carried and the newly mounted ones join them below.
    const near = new Set<WireKey>()
    for (const id of shifted.keys()) for (const key of this.graph.wiresAt(id)) near.add(key)
    const within = (key: WireKey) => {
      const [f, t] = this.endsOf(key)
      return rigid.has(f) && rigid.has(t)
    }
    // A drop or a new drag: spans held back for the last group catch up, and those wires route again.
    if (rigid !== this.rigid) {
      this.rigid = rigid
      for (const key of this.held) {
        if (this.graph.edges.has(key) && within(key)) continue
        this.held.delete(key)
        near.add(key)
      }
    }
    // Wires changed in the graph: added, deleted, noted or classed.
    const edited = new Set(dirty)
    dirty.clear()
    // Whether lanes need spreading again: a wire got or lost an element or a route.
    let redraw = false
    // Wires that may get or lose an element; mounted ones inside the dragged group keep theirs.
    const check: WireKey[] = []
    const update = (key: WireKey) => {
      this.loose.delete(key)
      if (!this.graph.edges.has(key)) {
        redraw ||= this.groups.has(key)
        if (this.spans.has(key)) this.drop(key)
      } else if (within(key) && this.spans.has(key)) {
        this.held.add(key)
        if (!this.groups.has(key)) check.push(key)
      } else {
        this.respan(key)
        check.push(key)
      }
    }
    for (const key of near) update(key)
    for (const key of edited) if (!near.has(key)) update(key)
    // Mount and unmount: the wires the area now holds, or the changed ones when it stayed put.
    const fresh = new Set<WireKey>()
    let consider: Iterable<WireKey> = check
    if (panned && area) {
      const hits = new Set([...this.groups.keys(), ...check])
      this.reaches.near(area, key => hits.add(key))
      consider = hits
    } else if (panned) consider = this.graph.edges.keys() // culling just turned off
    for (const key of consider) {
      const want = this.graph.edges.has(key) && (!area || this.held.has(key) || overlap(this.spans.get(key)!, area))
      if (want && !this.groups.has(key)) {
        this.create(key)
        fresh.add(key)
      } else if (!want && this.groups.has(key)) {
        this.forget(key)
        redraw = true
      }
    }
    // Old and new spots of every node that moved, resized or went: mounted wires passing there need
    // a new route. Found through the span index, so a drag costs the wires near it.
    const spots = [...this.freed.splice(0)]
    for (const [id, old] of shifted) {
      if (old) spots.push(old)
      spots.push(this.rects.get(id)!)
    }
    if (spots.length > this.boxes.size * SPOT_SHARE) {
      // Many spots for the wires on screen, as in a group drag: test each wire against the spots.
      const hash = new Buckets<null>()
      for (const spot of spots) hash.add(spot, null)
      for (const [key, box] of this.boxes) if (!near.has(key) && !hash.empty(inflate(box, CLEAR))) near.add(key)
    } else {
      for (const spot of spots) {
        this.reaches.near(inflate(spot, CLEAR), key => {
          const box = this.boxes.get(key)
          if (box && overlap(inflate(box, CLEAR), spot)) near.add(key)
        })
      }
    }
    for (const key of this.carried) near.add(key)
    for (const key of fresh) near.add(key)
    // Undefined if the node is new or changed size.
    const shift = (id: string): Point | undefined => {
      const [a, b] = [shifted.get(id), this.rects.get(id)!]
      return a && a[2] === b[2] && a[3] === b[3] ? [b[0] - a[0], b[1] - a[1]] : undefined
    }
    for (const key of near) {
      if (!this.groups.has(key)) continue
      const [from, to] = this.graph.edges.get(key)!
      const [f, t] = this.endsOf(key)
      if (!fresh.has(key) && rigid.has(f) && rigid.has(t)) {
        // Both ends moved by the same offset: shift the route along instead of searching a new one.
        const [d, e] = [shift(f), shift(t)]
        if (d && e && d[0] === e[0] && d[1] === e[1]) {
          if (!d[0] && !d[1]) continue
          this.translate(key, d)
          this.carried.add(key)
          redraw = true
          continue
        }
      }
      const points = this.route(from, to, this.near)
      this.boxes.set(key, bounds(points))
      this.routes.set(key, points)
      this.carried.delete(key)
      if (!this.held.has(key)) this.fit(key)
      redraw = true
    }
    const redrawn = redraw ? this.redraw() : new Set<WireKey>()
    this.renderNotes(redrawn, spots, edited)
    for (const key of fresh) this.renderClasses(key)
    for (const key of edited) if (!fresh.has(key)) this.renderClasses(key)
  }

  private endsOf(key: WireKey) {
    let ends = this.ends.get(key)
    if (!ends) {
      const [from, to] = this.graph.edges.get(key)!
      this.ends.set(key, (ends = [nodeOf(from), nodeOf(to)]))
    }
    return ends
  }

  // Indexes the wire by its two nodes' rects grown by the routing margin, which holds any route
  // that keeps clear of nodes, and by its route's box, which a detour around a big node can exceed.
  private respan(key: WireKey) {
    const [f, t] = this.endsOf(key)
    const [a, b] = [this.rects.get(f)!, this.rects.get(t)!]
    let [x0, y0] = [Math.min(a[0], b[0]), Math.min(a[1], b[1])]
    let [x1, y1] = [Math.max(a[0] + a[2], b[0] + b[2]), Math.max(a[1] + a[3], b[1] + b[3])]
    const box = this.boxes.get(key)
    if (box) [x0, y0, x1, y1] = [Math.min(x0, box[0]), Math.min(y0, box[1]), Math.max(x1, box[0] + box[2]), Math.max(y1, box[1] + box[3])]
    const span: Rect = [x0 - MARGIN, y0 - MARGIN, x1 - x0 + 2 * MARGIN, y1 - y0 + 2 * MARGIN]
    const old = this.spans.get(key)
    if (old) this.reaches.move(old, span, key)
    else this.reaches.add(span, key)
    this.spans.set(key, span)
  }

  // Grows the span after the route changed, if the route left it.
  private fit(key: WireKey) {
    const [s, b] = [this.spans.get(key)!, this.boxes.get(key)!]
    if (b[0] < s[0] || b[1] < s[1] || b[0] + b[2] > s[0] + s[2] || b[1] + b[3] > s[1] + s[3]) this.respan(key)
  }

  // A wire deleted from the graph: no span, element or route any more.
  private drop(key: WireKey) {
    const span = this.spans.get(key)
    if (span) this.reaches.remove(span, key)
    this.spans.delete(key)
    this.held.delete(key)
    this.ends.delete(key)
    this.forget(key)
  }

  private create(key: WireKey) {
    const g = svg('g')
    g.dataset.wire = key
    g.append(svg('path', 'bn-wire'), svg('path', 'bn-hit'))
    this.groups.set(key, g)
    this.layer.before(g)
  }

  // Takes a wire's elements and route away; its span stays while the wire exists.
  private forget(key: WireKey) {
    this.groups.get(key)?.remove()
    this.notes.get(key)?.remove()
    this.carried.delete(key)
    for (const map of [this.groups, this.boxes, this.routes, this.notes, this.tracks, this.applied]) map.delete(key)
  }

  private translate(key: WireKey, [dx, dy]: Point) {
    this.routes.set(key, this.routes.get(key)!.map(([x, y]): Point => [x + dx, y + dy]))
    const [x, y, w, h] = this.boxes.get(key)!
    this.boxes.set(key, [x + dx, y + dy, w, h])
  }

  // Lanes depend on every wire in a corridor, so all mounted ones are re-spread. Only wires whose
  // points changed get a new path and track: packets on the others keep theirs. Returns their keys.
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
  // bn-selected on the same elements.
  private renderClasses(key: WireKey) {
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

  // Only mounted wires have notes. A note moves only when it is new, its text changed, its wire was
  // redrawn, or a node moved or went near it (`spots`), since its spot depends on nothing else.
  private renderNotes(redrawn: ReadonlySet<WireKey>, spots: Rect[], edited: ReadonlySet<WireKey>) {
    const due: [key: WireKey, note: SVGTextElement, width: number][] = []
    for (const key of this.groups.keys()) {
      const text = this.graph.labels.get(key)
      let note = this.notes.get(key)
      if (text === undefined) {
        if (note) {
          note.remove()
          this.notes.delete(key)
        }
        continue
      }
      let newText = edited.has(key)
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
      const pad = inflate(this.boxes.get(key)!, w / 2 + 16)
      if (!newText && !redrawn.has(key) && !spots.some(spot => overlap(spot, pad))) continue
      due.push([key, note, w])
    }
    for (const [key, note, w] of due) {
      const fits = ([cx, cy]: Point) => this.index.empty([cx - w / 2, cy - 8, w, 16])
      const [x, y] = notePoint(this.drawn.get(key)!, fits)
      setAttrs(note, { x, y })
    }
  }
}
