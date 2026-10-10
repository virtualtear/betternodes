import { GRID, bounds, overlap, snap, type Rect } from '../../geometry/rect'
import { freeSpots } from '../../layout/untangle'
import type { NodeDef } from '../../model/graph'
import { Journal } from '../../model/history'
import { wireKey, type Edge, type WireKey } from '../../model/state'
import { dataOf } from '../dom'
import { gesture, isClick } from './gesture'
import type { Input } from './interact'

// Gestures pan near the root's border only when panning is on.
const edgeView = ({ view, s }: Input) => (s.pan ? view : undefined)

// Drop target, drawio style: an anchor gives a fixed end, a node body a floating one (bare id).
function endAt(root: HTMLElement, e: PointerEvent) {
  const el = document.elementFromPoint(e.clientX, e.clientY)
  if (!el || !root.contains(el)) return
  return dataOf(el, 'anchor') ?? dataOf(el, 'node')
}

/**
 * Drags a loose wire end from the `fixed` anchor; `make` builds the wire from the drop target,
 * replacing `lifted` if given. Invalid drops leave the graph untouched.
 */
export function dragWire(input: Input, fixed: string, make: (dropped: string) => Edge, lifted?: Edge) {
  const { view, graph, s, ops, signal } = input
  const hide = lifted && wireKey(...lifted)
  gesture(e => view.drag(fixed, view.toWorld(e.clientX, e.clientY), hide), e => {
    view.drag()
    const dropped = e.type === 'pointerup' ? endAt(view.root, e) : undefined
    if (!dropped) return
    const [from, to] = make(dropped)
    if (!graph.canConnect(from, to) || !s.canConnect(from, to)) return
    const journal = new Journal()
    if (lifted && hide) {
      graph.disconnect(...lifted, journal)
      // The moved wire takes its note and classes along. The old key keeps them too, so undo restores both.
      const note = graph.labels.get(hide)
      if (note) graph.label(from, to, note)
      const classes = graph.classes.get(hide)
      if (classes) graph.classify(from, to, classes)
    }
    graph.connect(from, to, journal)
    if (s.select) view.select([], wireKey(from, to))
    ops.changed(journal)
  }, signal, edgeView(input))
}

/** Picks up the end of wire `key` nearer the pointer and drags it; the other end stays put. */
export function grabWire(input: Input, e: PointerEvent, key: WireKey) {
  const { view, graph } = input
  const wire = graph.edges.get(key)!
  const [from, to] = wire
  const [x, y] = view.toWorld(e.clientX, e.clientY)
  // Floating ends are resolved against the opposite end, where they are drawn.
  const dist = (ref: string, other: string) => {
    const [ax, ay] = view.anchor(view.resolve(ref, other))
    return Math.hypot(ax - x, ay - y)
  }
  if (dist(to, from) <= dist(from, to)) dragWire(input, from, dropped => [from, dropped], wire)
  else dragWire(input, to, dropped => [dropped, to], wire)
}

/**
 * Moves `group` by one offset that follows the pointer freely; on the drop it is rounded so
 * `grabbed` lands on the grid.
 */
export function dragNodes(input: Input, press: PointerEvent, grabbed: string, group: Set<string>) {
  const { view, graph, s, signal } = input
  const nodes = [...group].map(id => graph.nodes.get(id)!)
  const starts = nodes.map(n => [n.x, n.y])
  const { x: gx, y: gy } = graph.nodes.get(grabbed)!
  // Offsets come from world points, so zooming or edge panning mid-drag keeps nodes under the pointer.
  const [px, py] = view.toWorld(press.clientX, press.clientY)
  const journal = new Journal()
  journal.track(nodes)
  view.dragging = group
  const shift = (dx: number, dy: number) => nodes.forEach((n, i) => {
    Object.assign(n, { x: starts[i][0] + dx, y: starts[i][1] + dy, placed: true })
    view.place(n.id)
  })
  let [dx, dy] = [0, 0]
  gesture(e => {
    const [wx, wy] = view.toWorld(e.clientX, e.clientY)
    dx = wx - px
    dy = wy - py
    shift(dx, dy)
  }, e => {
    view.dragging = new Set()
    if (s.snap) shift(snap(gx + dx) - gx, snap(gy + dy) - gy)
    land(input, nodes, journal)
    // A click on one node of a group selects just that node.
    if (s.select && isClick(press, e)) view.select([grabbed])
  }, signal, edgeView(input))
}

/**
 * Settles moved `nodes` at the nearest free spot, so nodes never stay on top of each other, and
 * reports the edit `journal` tracks them in.
 * @remarks A group moved as a whole settles as one block, its frame; frames of groups that kept
 * still count as taken.
 */
export function land({ view, graph, ops }: Input, nodes: NodeDef[], journal: Journal) {
  const moved = new Set(nodes.map(n => n.id))
  const [members, frames] = [graph.members(), view.frames()]
  const units: { ids: string[]; rect: Rect }[] = []
  const others: Rect[] = []
  for (const [g, ids] of members) {
    const count = ids.filter(id => moved.has(id)).length
    if (count === ids.length) units.push({ ids, rect: frames.get(g)! })
    else if (!count) others.push(frames.get(g)!)
  }
  const whole = new Set(units.flatMap(u => u.ids))
  for (const id of moved) if (!whole.has(id)) units.push({ ids: [id], rect: view.box(id) })
  for (const id of graph.nodes.keys()) if (!moved.has(id)) others.push(view.box(id))
  freeSpots(units.map(u => u.rect), others, GRID, GRID).forEach(([x, y], i) => {
    const { ids, rect } = units[i]
    const [dx, dy] = [x - rect[0], y - rect[1]]
    for (const id of ids) {
      const n = graph.nodes.get(id)!
      Object.assign(n, { x: n.x + dx, y: n.y + dy })
      view.place(id)
    }
  })
  ops.changed(journal)
}

/** Draws a selection box; on release, adds every node it touches to the selection. */
export function marquee({ view, graph, signal }: Input, press: PointerEvent) {
  const start = view.toWorld(press.clientX, press.clientY)
  let box: Rect | undefined
  gesture(e => {
    box = bounds([start, view.toWorld(e.clientX, e.clientY)])
    view.marquee(box)
  }, e => {
    view.marquee()
    const area = box
    if (e.type !== 'pointerup' || !area) return
    const hits = [...graph.nodes.keys()].filter(id => overlap(view.box(id), area))
    view.select([...view.selected.nodes, ...hits])
  }, signal)
}

/** Pans by dragging if panning is on; a press that barely moves calls `click` instead. */
export function pan({ view, s, signal }: Input, press: PointerEvent, click?: () => void) {
  const [x0, y0] = [view.x, view.y]
  gesture(e => s.pan && view.viewport(x0 + e.clientX - press.clientX, y0 + e.clientY - press.clientY, view.k), e => {
    if (isClick(press, e)) click?.()
  }, signal)
}

/** Centres the view on the world point under the pointer in the minimap, following it until released. */
export function steer({ view, signal }: Input, press: PointerEvent) {
  const mini = view.mini!
  const follow = (e: PointerEvent) => {
    const [x, y] = mini.toWorld(e.clientX, e.clientY)
    view.viewport(view.root.clientWidth / 2 - x * view.k, view.root.clientHeight / 2 - y * view.k, view.k)
  }
  mini.hold(true)
  follow(press)
  gesture(follow, () => mini.hold(false), signal)
}
