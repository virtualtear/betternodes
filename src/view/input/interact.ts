import type { Graph } from '../../model/graph'
import type { Journal } from '../../model/history'
import type { Edge, WireKey } from '../../model/state'
import type { Settings } from '../../options'
import { dataOf } from '../dom'
import type { View } from '../view'
import { dragNodes, dragWire, grabWire, marquee, pan, steer } from './drags'
import { gesture, isClick } from './gesture'
import { onKey } from './keys'

/** What a pointer event landed on; all fields absent means the background. */
export interface Hit {
  node?: string
  /** A copy of the wire. */
  wire?: Edge
  /** A group, hit on its frame's title. */
  group?: string
}

/** Listener arguments of the pointer events, which fire in both modes whatever the options say. */
export interface InputEvents {
  /** A press that moved less than 4px, so drags never count. */
  click: [hit: Hit, event: MouseEvent]
  dblclick: [hit: Hit, event: MouseEvent]
  /** Call `event.preventDefault()` in a listener to hide the browser's menu. */
  contextmenu: [hit: Hit, event: MouseEvent]
  /** The pointer moved onto another node or wire; `{}` means the background or outside. */
  hover: [hit: Hit]
}

/** Every event of the map `E` as an argument list: its type, then its listener arguments. */
export type Emitted<E extends { [K in keyof E]: unknown[] }> = { [K in keyof E]: [type: K, ...args: E[K]] }[keyof E]

/** Callbacks from user input back to the Flow. */
export interface Ops {
  /** A user edit happened, recorded in `journal`. */
  changed(journal: Journal): void
  undo(): void
  redo(): void
  /** Fires a pointer event to the flow's listeners. */
  emit(...event: Emitted<InputEvents>): void
}

/** What every input handler works with. */
export interface Input {
  readonly view: View
  readonly graph: Graph
  /** Read on every event, so `Flow.set()` takes effect without re-attaching. */
  readonly s: Settings
  readonly ops: Ops
  /** Ends every listener, including those of a gesture in progress. */
  readonly signal: AbortSignal
}

/** Wires pointer and keyboard input on the view's root to the graph; returns a detach function. */
export function attach(view: View, graph: Graph, ops: Ops) {
  const life = new AbortController()
  const { signal } = life
  const input: Input = { view, graph, s: view.settings, ops, signal }

  const hitAt = (e: MouseEvent): Hit => {
    const el = e.target as Element
    const node = nodeAt(view, e)
    if (node) return { node }
    const group = dataOf(el, 'group')
    if (group) return { group }
    const edge = graph.edges.get(dataOf(el, 'wire') as WireKey)
    return edge ? { wire: [...edge] } : {}
  }

  const down = (e: PointerEvent) => {
    if (e.button !== 0) return
    // The minimap only navigates: no clicks, no selection.
    if (view.mini?.el.contains(e.target as Node)) return input.s.pan && steer(input, e)
    press(input, e)
    // Registered after the press's own gesture, so a click sees the selection it made.
    const hit = hitAt(e)
    gesture(() => {}, up => isClick(e, up) && ops.emit('click', hit, up), signal)
  }

  // Zooms around the cursor: the world point under it stays put. Without `zoom` the page scrolls.
  const wheel = (e: WheelEvent) => {
    if (!input.s.zoom) return
    e.preventDefault()
    const r = view.root.getBoundingClientRect()
    view.zoomAt(e.clientX - r.left, e.clientY - r.top, view.k * Math.exp(-e.deltaY / 500))
  }

  const native = (e: MouseEvent) => ops.emit(e.type as 'dblclick' | 'contextmenu', hitAt(e), e)

  // pointerover fires per element entered, so only changes of what it hit are reported.
  let hovered = '{}'
  const over = (hit: Hit) => {
    const key = JSON.stringify(hit)
    if (key === hovered) return
    hovered = key
    ops.emit('hover', hit)
  }

  const { root } = view
  root.addEventListener('pointerdown', down, { signal })
  root.addEventListener('dblclick', native, { signal })
  root.addEventListener('contextmenu', native, { signal })
  root.addEventListener('pointerover', e => over(hitAt(e)), { signal })
  // Far out, nodes have no elements to enter, so moves over the drawn shapes count instead.
  root.addEventListener('pointermove', e => view.far && over(hitAt(e)), { signal })
  root.addEventListener('pointerleave', () => over({}), { signal })
  root.addEventListener('wheel', wheel, { passive: false, signal })
  root.addEventListener('keydown', e => onKey(input, e), { signal })
  return () => life.abort()
}

// The node an event landed on: its element, or far out, where nodes have none, the drawn shape.
const nodeAt = (view: View, e: MouseEvent) => dataOf(e.target as Element, 'node') ?? (view.far ? view.nodeAt(e.clientX, e.clientY) : undefined)

// Starts what a left press does, by mode, options and what it landed on.
function press(input: Input, e: PointerEvent) {
  const { view, graph, s } = input
  const target = e.target as Element
  const node = nodeAt(view, e)
  const group = dataOf(target, 'group')
  const members = group ? graph.membersOf(group) : []
  // View mode: every drag pans, a click selects a node or a group, or clears the selection.
  if (view.root.dataset.mode !== 'edit') return pan(input, e, () => s.select && view.select(node ? [node] : members))
  // Data attributes hold wire keys as plain strings.
  const wire = dataOf(target, 'wire') as WireKey | undefined
  // Without `connect`, an anchor is just part of its node.
  const anchor = s.connect && dataOf(target, 'anchor')
  if (anchor) {
    if (s.select) view.select()
    return dragWire(input, anchor, dropped => [anchor, dropped])
  }
  if (wire) {
    if (s.select) view.select([], wire)
    return s.connect ? grabWire(input, e, wire) : pan(input, e)
  }
  if (group) {
    if (s.select) view.select(members)
    return s.move && members.length ? dragNodes(input, e, members[0], new Set(members)) : pan(input, e)
  }
  if (!node) return e.shiftKey && s.select ? marquee(input, e) : pan(input, e, () => s.select && view.select())
  const { nodes } = view.selected
  if (e.shiftKey && s.select) return view.select(nodes.has(node) ? [...nodes].filter(id => id !== node) : [...nodes, node])
  // Pressing an unselected node selects just it; pressing a selected one drags the whole selection.
  if (s.select && !nodes.has(node)) view.select([node])
  if (!s.move) return pan(input, e)
  dragNodes(input, e, node, nodes.has(node) ? new Set(nodes) : new Set([node]))
}
