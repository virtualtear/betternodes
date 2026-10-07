import type { Edge, Graph, NodeDef, State } from '../model/graph'
import { GRID, bounds, overlap, snap, type Point, type Rect } from '../geometry/rect'
import { freeSpots } from '../layout/untangle'
import type { View } from './view'

type Handler = (e: PointerEvent) => void

// Screen px inside the root's border where a drag pans the view, and the pan speed at the border
// itself in px per ms.
const EDGE = 40
const EDGE_SPEED = 0.6
// Pointer travel in screen px below which a press counts as a click.
const SLOP = 4
// Arrow keys nudge the selected nodes one step this way.
const ARROWS = new Map<string, Point>([['ArrowLeft', [-1, 0]], ['ArrowRight', [1, 0]], ['ArrowUp', [0, -1]], ['ArrowDown', [0, 1]]])

/** What a pointer event landed on; all fields absent means the background. */
export interface Hit {
  node?: string
  /** A copy of the wire. */
  wire?: Edge
}

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
  /** A click (a press that barely moved), double click or context menu event landed on `hit`. */
  pointer(type: 'click' | 'dblclick' | 'contextmenu', hit: Hit, e: MouseEvent): void
  /** The pointer moved onto something else; `{}` for the background or outside the graph. */
  hover(hit: Hit): void
}

/** Wires pointer and keyboard input on the view's root to the graph; returns a detach function. */
export function attach(view: View, graph: Graph, { changed, undo, redo, pointer, hover }: Ops) {
  // Options are read on every event, so Flow.set() takes effect without re-attaching.
  const { root, settings: s } = view
  // Gestures only pan near the border when panning is on.
  const borderPan = () => (s.pan ? view : undefined)
  // Every listener, including those of a gesture in progress, ends when this aborts.
  const life = new AbortController()
  const { signal } = life

  const hitAt = (el: Element): Hit => {
    const node = el.closest<HTMLElement>('[data-node]')?.dataset.node
    if (node) return { node }
    const edge = graph.edges.get(el.closest<SVGElement>('[data-wire]')?.dataset.wire ?? '')
    return edge ? { wire: [...edge] } : {}
  }

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
      if (!graph.canConnect(from, to) || !s.canConnect(from, to)) return
      if (lifted) {
        graph.disconnect(...lifted)
        // The moved wire takes its note and classes along. The old key keeps them too, so undo
        // restores both.
        const note = graph.labels.get(hide!)
        if (note) graph.label(from, to, note)
        const classes = graph.classes.get(hide!)
        if (classes) graph.classify(from, to, classes)
      }
      graph.connect(from, to)
      if (s.select) view.select([], `${from}>${to}`)
      changed(before)
    }, signal, borderPan())
  }

  // Moves `group` by one offset, chosen so `grabbed` snaps to the grid. Offsets come from world
  // points, so zooming or edge panning mid-drag keeps the nodes under the pointer.
  const dragNodes = (e: PointerEvent, grabbed: string, group: Set<string>) => {
    const nodes = [...group].map(id => graph.nodes.get(id)!)
    const starts = nodes.map(n => [n.x, n.y])
    const { x: gx, y: gy } = graph.nodes.get(grabbed)!
    const [px, py] = view.toWorld(e.clientX, e.clientY)
    const [sx, sy] = [e.clientX, e.clientY]
    const before = graph.toState()
    view.dragging = group
    gesture(e => {
      const [wx, wy] = view.toWorld(e.clientX, e.clientY)
      const [dx, dy] = s.snap ? [snap(gx + wx - px) - gx, snap(gy + wy - py) - gy] : [wx - px, wy - py]
      nodes.forEach((n, i) => {
        Object.assign(n, { x: starts[i][0] + dx, y: starts[i][1] + dy, placed: true })
        view.place(n.id)
      })
    }, e => {
      view.dragging = new Set()
      land(nodes, starts, before)
      // A click on one node of a group selects just that node.
      if (s.select && e.type === 'pointerup' && Math.hypot(e.clientX - sx, e.clientY - sy) < SLOP) view.select([grabbed])
    }, signal, borderPan())
  }

  // Nodes may pass over each other while moving, but never stay on top of one another: moved
  // `nodes` settle at the nearest free spot. Reports an edit if any ended up off its `starts`.
  const land = (nodes: NodeDef[], starts: number[][], before: State) => {
    const moved = new Set(nodes.map(n => n.id))
    const others = [...graph.nodes.keys()].filter(id => !moved.has(id)).map(id => view.box(id))
    freeSpots(nodes.map(n => view.box(n.id)), others, GRID, GRID).forEach(([x, y], i) => {
      Object.assign(nodes[i], { x, y })
      view.place(nodes[i].id)
    })
    if (nodes.some((n, i) => n.x !== starts[i][0] || n.y !== starts[i][1])) changed(before)
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
    }, signal, borderPan())
  }

  // Pans by dragging (if panning is on); a press that barely moves is a click and calls `click` instead.
  const pan = (e: PointerEvent, click: () => void) => {
    const [x0, y0, sx, sy] = [view.x, view.y, e.clientX, e.clientY]
    gesture(e => s.pan && view.viewport(x0 + e.clientX - sx, y0 + e.clientY - sy, view.k), e => {
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

  // Centres the view on the world point under the pointer in the minimap, following it until
  // released; the minimap keeps its scale meanwhile.
  const steer = (e: PointerEvent) => {
    const mini = view.mini!
    const follow = (e: PointerEvent) => {
      const [x, y] = mini.toWorld(e.clientX, e.clientY)
      view.viewport(root.clientWidth / 2 - x * view.k, root.clientHeight / 2 - y * view.k, view.k)
    }
    mini.hold(true)
    follow(e)
    gesture(follow, () => mini.hold(false), signal)
  }

  const down = (e: PointerEvent) => {
    if (e.button !== 0) return
    // The minimap only navigates: no clicks, no selection.
    if (view.mini?.el.contains(e.target as Node)) return s.pan && steer(e)
    press(e)
    // Registered after the press's own gesture, so a click sees the selection it made.
    const hit = hitAt(e.target as Element)
    gesture(() => {}, up => {
      if (up.type === 'pointerup' && Math.hypot(up.clientX - e.clientX, up.clientY - e.clientY) < SLOP) pointer('click', hit, up)
    }, signal)
  }

  const press = (e: PointerEvent) => {
    const target = e.target as Element
    const node = target.closest<HTMLElement>('[data-node]')?.dataset.node
    // View mode: every drag pans, a click selects a node or clears the selection.
    if (root.dataset.mode !== 'edit') return pan(e, () => s.select && view.select(node ? [node] : []))
    const wire = target.closest<SVGElement>('[data-wire]')?.dataset.wire
    // Without `connect`, an anchor is just part of its node.
    const anchor = s.connect && target.closest<HTMLElement>('[data-anchor]')?.dataset.anchor
    if (anchor) {
      if (s.select) view.select()
      return dragWire(anchor, dropped => [anchor, dropped])
    }
    if (wire) {
      if (s.select) view.select([], wire)
      return s.connect ? grabWire(e, wire) : pan(e, () => {})
    }
    if (!node) return e.shiftKey && s.select ? marquee(e) : pan(e, () => s.select && view.select())
    const { nodes } = view.selected
    if (e.shiftKey && s.select) return view.select(nodes.has(node) ? [...nodes].filter(id => id !== node) : [...nodes, node])
    // Pressing an unselected node selects just it; pressing a selected one drags the whole group.
    if (s.select && !nodes.has(node)) view.select([node])
    // Without `move`, dragging a node pans, as in view mode.
    if (!s.move) return pan(e, () => {})
    dragNodes(e, node, nodes.has(node) ? new Set(nodes) : new Set([node]))
  }

  // Zooms around the cursor: the world point under it stays put. Without `zoom` the page scrolls.
  const wheel = (e: WheelEvent) => {
    if (!s.zoom) return
    e.preventDefault()
    const r = root.getBoundingClientRect()
    view.zoomAt(e.clientX - r.left, e.clientY - r.top, view.k * Math.exp(-e.deltaY / 500))
  }

  const native = (e: MouseEvent) => pointer(e.type as 'dblclick' | 'contextmenu', hitAt(e.target as Element), e)

  // pointerover fires per element entered, so compare what it hit to report changes only.
  let hovered = '{}'
  const over = (hit: Hit) => {
    const key = JSON.stringify(hit)
    if (key === hovered) return
    hovered = key
    hover(hit)
  }

  // Moves the selected nodes one grid step (1px without snapping) as one edit.
  const nudge = ([dx, dy]: Point) => {
    const before = graph.toState()
    const step = s.snap ? GRID : 1
    const nodes = [...view.selected.nodes].map(id => graph.nodes.get(id)!)
    const starts = nodes.map(n => [n.x, n.y])
    for (const n of nodes) Object.assign(n, { x: n.x + dx * step, y: n.y + dy * step, placed: true })
    land(nodes, starts, before)
  }

  // Only keys aimed at the root itself, never ones typed into inputs inside node content.
  const key = (e: KeyboardEvent) => {
    if (!s.keys || e.target !== root || root.dataset.mode !== 'edit') return
    const k = e.key.toLowerCase()
    const mod = e.ctrlKey || e.metaKey
    if (mod && (k === 'z' || k === 'y')) {
      e.preventDefault()
      return k === 'y' || e.shiftKey ? redo() : undo()
    }
    if (mod && k === 'a' && s.select) {
      e.preventDefault()
      return view.select(graph.nodes.keys())
    }
    const arrow = ARROWS.get(e.key)
    if (arrow && s.move && view.selected.nodes.size) {
      e.preventDefault()
      return nudge(arrow)
    }
    if (e.key === 'Escape') return s.select && view.select()
    if (!s.remove || (e.key !== 'Delete' && e.key !== 'Backspace')) return
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
  root.addEventListener('dblclick', native, { signal })
  root.addEventListener('contextmenu', native, { signal })
  root.addEventListener('pointerover', e => over(hitAt(e.target as Element)), { signal })
  root.addEventListener('pointerleave', () => over({}), { signal })
  root.addEventListener('wheel', wheel, { passive: false, signal })
  root.addEventListener('keydown', key, { signal })
  return () => life.abort()
}
