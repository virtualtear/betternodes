import { GRID, type Point } from '../../geometry/rect'
import { land } from './drags'
import type { Input } from './interact'

const ARROWS = new Map<string, Point>([['ArrowLeft', [-1, 0]], ['ArrowRight', [1, 0]], ['ArrowUp', [0, -1]], ['ArrowDown', [0, 1]]])

/** Editor keys: undo and redo, select all, arrow nudges, Escape and Delete. */
export function onKey(input: Input, e: KeyboardEvent) {
  const { view, graph, s, ops } = input
  // Only keys aimed at the root itself, never ones typed into inputs inside node content.
  if (!s.keys || e.target !== view.root || view.root.dataset.mode !== 'edit') return
  const key = e.key.toLowerCase()
  const mod = e.ctrlKey || e.metaKey
  if (mod && (key === 'z' || key === 'y')) {
    e.preventDefault()
    return key === 'y' || e.shiftKey ? ops.redo() : ops.undo()
  }
  if (mod && key === 'a' && s.select) {
    e.preventDefault()
    return view.select(graph.nodes.keys())
  }
  const arrow = ARROWS.get(e.key)
  if (arrow && s.move && view.selected.nodes.size) {
    e.preventDefault()
    return nudge(input, arrow)
  }
  if (e.key === 'Escape') return s.select && view.select()
  if (s.remove && (e.key === 'Delete' || e.key === 'Backspace') && removeSelected(input)) e.preventDefault()
}

// Moves the selected nodes one grid step (1px without snapping) as one edit.
function nudge(input: Input, [dx, dy]: Point) {
  const { view, graph, s } = input
  const before = graph.toState()
  const step = s.snap ? GRID : 1
  const nodes = [...view.selected.nodes].map(id => graph.nodes.get(id)!)
  const starts = nodes.map(n => [n.x, n.y])
  for (const n of nodes) Object.assign(n, { x: n.x + dx * step, y: n.y + dy * step, placed: true })
  land(input, nodes, starts, before)
}

// Deletes the selected wire or nodes as one edit; returns whether anything was selected.
function removeSelected({ view, graph, ops }: Input) {
  const { nodes, wire } = view.selected
  const edge = wire && graph.edges.get(wire)
  if (!edge && !nodes.size) return false
  const before = graph.toState()
  // Cleared first, so drop() doesn't shrink the selection one node (and event) at a time.
  view.select()
  if (edge) graph.disconnect(...edge)
  for (const id of graph.remove(nodes)) view.drop(id)
  ops.changed(before)
  return true
}
