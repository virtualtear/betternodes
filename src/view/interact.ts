import type { Edge, Graph, State } from '../model/graph'
import { GRID, bounds, overlap, snap, type Rect } from '../geometry/rect'
import { freeSpots } from '../layout/untangle'
import type { View } from './view'

type Handler = (e: PointerEvent) => void

// Screen px inside the root's border where a drag pans the view, and the pan speed at the border
// itself in px per ms.
const EDGE = 40
const EDGE_SPEED = 0.6
// Pointer travel in screen px below which a press counts as a click.
const SLOP = 4

// Follows one pointer gesture on window, so moves and the drop register wherever the pointer goes.
// Avoids setPointerCapture, which would retarget pointerup to the drag source.
// `end` also runs on pointercancel; check `e.type` before treating it as a drop. Aborting `signal`
// (the flow was destroyed) drops the gesture without calling `end`. With `view`, holding the
// pointer near the root's border pans it, see edgePan().
function gesture(move: Handler, end: Handler, signal: AbortSignal, view?: View) {
  const own = new AbortController()
  const opts = { signal: AbortSignal.any([signal, own.signal]) }
  const done = (e: PointerEvent) => {
    own.abort()
    end(e)
  }
  addEventListener('pointermove', view ? edgePan(view, move, opts.signal) : move, opts)
  addEventListener('pointerup', done, opts)
  addEventListener('pointercancel', done, opts)
}

// Wraps a gesture's move handler: while the pointer is within EDGE px of the root's border, the
// view pans every frame and the last move is replayed, so whatever is dragged follows. Runs no
// frames anywhere else, and none after `signal` aborts.
function edgePan(view: View, move: Handler, signal: AbortSignal): Handler {
  // Read once: the root stays put during a drag, and a read per frame could force a layout.
  const r = view.root.getBoundingClientRect()
  // Faster the deeper into the zone, full speed beyond the border.
  const speed = (p: number, lo: number, hi: number) =>
    p < lo + EDGE ? -Math.min(1, (lo + EDGE - p) / EDGE) * EDGE_SPEED
    : p > hi - EDGE ? Math.min(1, (p - hi + EDGE) / EDGE) * EDGE_SPEED : 0
  const velocity = (e: PointerEvent) => [speed(e.clientX, r.left, r.right), speed(e.clientY, r.top, r.bottom)]
  let last: PointerEvent
  let frame = 0
  let then = 0
  const tick = (now: number) => {
    const [vx, vy] = velocity(last)
    if (!vx && !vy) {
      frame = 0
      return
    }
    // Requested before the writes below schedule the view's frame, so from now on this tick runs
    // first in each frame and its toWorld() reads come before the view's DOM writes.
    frame = requestAnimationFrame(tick)
    // Time-based, so the speed doesn't depend on the display rate. Capped after a tab switch.
    const dt = Math.min(50, Math.max(0, now - then))
    then = now
    view.viewport(view.x - vx * dt, view.y - vy * dt, view.k)
    move(last)
  }
  signal.addEventListener('abort', () => cancelAnimationFrame(frame))
  return e => {
    last = e
    move(e)
    if (frame || !velocity(e).some(Boolean)) return
    then = performance.now()
    frame = requestAnimationFrame(tick)
  }
}

/** Callbacks from user input back to the Flow. */
export interface Ops {
  /** A user edit happened; `before` is the state from just before it. */
  changed(before: State): void
  undo(): void
  redo(): void
}

/** Wires pointer and keyboard input on the view's root to the graph; returns a detach function. */
export function attach(view: View, graph: Graph, { changed, undo, redo }: Ops) {
  const { root } = view
  // Every listener, including those of a gesture in progress, ends when this aborts.
  const life = new AbortController()
  const { signal } = life

  // Drop target, drawio style: an anchor gives a fixed end, a node body a floating one (bare id).
  const endAt = (e: PointerEvent) => {
    const el = document.elementFromPoint(e.clientX, e.clientY)
    if (!el || !root.contains(el)) return
    return el.closest<HTMLElement>('[data-anchor]')?.dataset.anchor ?? el.closest<HTMLElement>('[data-node]')?.dataset.node
  }

  // Drags a loose wire end from the `fixed` anchor; `make` builds the wire from the drop anchor,
  // replacing `lifted` if given. Invalid drops leave the graph untouched.
  const dragWire = (fixed: string, make: (dropped: string) => Edge, lifted?: Edge) => {
    const hide = lifted?.join('>')
    const before = graph.toState()
    gesture(e => view.drag(fixed, view.toWorld(e.clientX, e.clientY), hide), e => {
      view.drag()
      const dropped = e.type === 'pointerup' ? endAt(e) : undefined
      if (!dropped) return
      const [from, to] = make(dropped)
      if (!graph.canConnect(from, to)) return
      if (lifted) {
        graph.disconnect(...lifted)
        // The moved wire takes its note along. The old key keeps it too, so undo restores both.
        const note = graph.labels.get(hide!)
        if (note) graph.label(from, to, note)
      }
      graph.connect(from, to)
      view.select([], `${from}>${to}`)
      changed(before)
    }, signal, view)
  }

  // Moves every selected node by one offset, chosen so `grabbed` snaps to the grid. Offsets come
  // from world points, so zooming or edge panning mid-drag keeps the nodes under the pointer.
  const dragNodes = (e: PointerEvent, grabbed: string) => {
    const group = new Set(view.selected.nodes)
    const nodes = [...group].map(id => graph.nodes.get(id)!)
    const starts = nodes.map(n => [n.x, n.y])
    const { x: gx, y: gy } = graph.nodes.get(grabbed)!
    const [px, py] = view.toWorld(e.clientX, e.clientY)
    const [sx, sy] = [e.clientX, e.clientY]
    const before = graph.toState()
    view.dragging = group
    gesture(e => {
      const [wx, wy] = view.toWorld(e.clientX, e.clientY)
      const [dx, dy] = [snap(gx + wx - px) - gx, snap(gy + wy - py) - gy]
      nodes.forEach((n, i) => {
        Object.assign(n, { x: starts[i][0] + dx, y: starts[i][1] + dy, placed: true })
        view.place(n.id)
      })
    }, e => {
      // Nodes may pass over each other while dragging, but never stay on top of one another.
      view.dragging = new Set()
      const others = [...graph.nodes.keys()].filter(id => !group.has(id)).map(id => view.box(id))
      freeSpots(nodes.map(n => view.box(n.id)), others, GRID, GRID).forEach(([x, y], i) => {
        Object.assign(nodes[i], { x, y })
        view.place(nodes[i].id)
      })
      if (nodes.some((n, i) => n.x !== starts[i][0] || n.y !== starts[i][1])) changed(before)
      // A click on one node of a group selects just that node.
      if (e.type === 'pointerup' && Math.hypot(e.clientX - sx, e.clientY - sy) < SLOP) view.select([grabbed])
    }, signal, view)
  }

  // Shift+drag on the background: on release, adds every node the box touches to the selection.
  const marquee = (e: PointerEvent) => {
    const start = view.toWorld(e.clientX, e.clientY)
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
    }, signal, view)
  }

  // Pans by dragging; a press that barely moves is a click and calls `click` instead.
  const pan = (e: PointerEvent, click: () => void) => {
    const [x0, y0, sx, sy] = [view.x, view.y, e.clientX, e.clientY]
    gesture(e => view.viewport(x0 + e.clientX - sx, y0 + e.clientY - sy, view.k), e => {
      if (e.type === 'pointerup' && Math.hypot(e.clientX - sx, e.clientY - sy) < SLOP) click()
    }, signal)
  }

  const grabWire = (e: PointerEvent, key: string) => {
    const wire = graph.edges.get(key)!
    const [from, to] = wire
    const [x, y] = view.toWorld(e.clientX, e.clientY)
    // Distance to where the end is drawn; floating ends are resolved against the opposite end.
    const dist = (ref: string, other: string) => {
      const [ax, ay] = view.anchor(view.resolve(ref, other))
      return Math.hypot(ax - x, ay - y)
    }
    // The end nearer the pointer comes loose; the other one stays put.
    if (dist(to, from) <= dist(from, to)) dragWire(from, dropped => [from, dropped], wire)
    else dragWire(to, dropped => [dropped, to], wire)
  }

  const down = (e: PointerEvent) => {
    if (e.button !== 0) return
    const target = e.target as Element
    const node = target.closest<HTMLElement>('[data-node]')?.dataset.node
    // View mode: every drag pans, a click selects a node or clears the selection.
    if (root.dataset.mode !== 'edit') return pan(e, () => view.select(node ? [node] : []))
    const wire = target.closest<SVGElement>('[data-wire]')?.dataset.wire
    const anchor = target.closest<HTMLElement>('[data-anchor]')?.dataset.anchor
    if (anchor) {
      view.select()
      return dragWire(anchor, dropped => [anchor, dropped])
    }
    if (wire) {
      view.select([], wire)
      return grabWire(e, wire)
    }
    if (!node) return e.shiftKey ? marquee(e) : pan(e, () => view.select())
    const { nodes } = view.selected
    if (e.shiftKey) return view.select(nodes.has(node) ? [...nodes].filter(id => id !== node) : [...nodes, node])
    // Pressing an unselected node selects just it; pressing a selected one drags the whole group.
    if (!nodes.has(node)) view.select([node])
    dragNodes(e, node)
  }

  // Zooms around the cursor: the world point under it stays put.
  const wheel = (e: WheelEvent) => {
    e.preventDefault()
    const r = root.getBoundingClientRect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    const k = Math.min(4, Math.max(0.1, view.k * Math.exp(-e.deltaY / 500)))
    const s = k / view.k
    view.viewport(px - (px - view.x) * s, py - (py - view.y) * s, k)
  }

  // Only keys aimed at the root itself, never ones typed into inputs inside node content.
  const key = (e: KeyboardEvent) => {
    if (e.target !== root || root.dataset.mode !== 'edit') return
    const k = e.key.toLowerCase()
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
      e.preventDefault()
      return k === 'y' || e.shiftKey ? redo() : undo()
    }
    if (e.key === 'Escape') return view.select()
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    const { nodes, wire } = view.selected
    const edge = wire ? graph.edges.get(wire) : undefined
    if (!edge && !nodes.size) return
    e.preventDefault()
    const before = graph.toState()
    // Cleared first, so drop() below doesn't shrink the selection one node (and event) at a time.
    view.select()
    if (edge) graph.disconnect(...edge)
    for (const id of nodes) {
      graph.remove(id)
      view.drop(id)
    }
    changed(before)
  }

  root.addEventListener('pointerdown', down, { signal })
  root.addEventListener('wheel', wheel, { passive: false, signal })
  root.addEventListener('keydown', key, { signal })
  return () => life.abort()
}
