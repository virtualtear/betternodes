import { FRAME, snap, type Point } from '../geometry/rect'
import { nodeOf, type Graph } from '../model/graph'

const GAP_X = 80
const GAP_Y = 40

/**
 * Positions for nodes that have none yet (`placed` unset); the view then marks them placed, so each
 * node is laid out once. Columns follow the longest wire path from a source node, rows keep
 * insertion order, columns are centered vertically, results snap to `grid`. Each group gets a band
 * of its own, stacked top to bottom with room for its frame, so no frame reaches over other nodes.
 * @param sizes - measured node sizes in world px.
 */
// ponytail: no crossing minimization; swap in elkjs or dagre if dense graphs come out tangled.
// Positions are fixed at first measure; f.layout() re-runs it when content has grown since.
export function layout(graph: Graph, sizes: Map<string, Point>, grid: number) {
  const out = new Map<string, Point>()
  const todo = [...graph.nodes.values()].filter(n => !n.placed)
  if (!todo.length) return out

  const incoming = Map.groupBy(graph.edges.values(), ([, to]) => nodeOf(to))
  const depths = new Map<string, number>()
  const visiting = new Set<string>()
  // Longest wire path into `root`, depth first. An explicit stack, not recursion: a chain wired
  // against insertion order overflowed the call stack at a few thousand nodes.
  const depth = (root: string) => {
    const known = depths.get(root)
    if (known !== undefined) return known
    const stack = [{ id: root, from: incoming.get(root) ?? [], next: 0, d: 0 }]
    visiting.add(root)
    while (stack.length) {
      const top = stack[stack.length - 1]
      if (top.next < top.from.length) {
        const id = nodeOf(top.from[top.next++][0])
        const d = depths.get(id)
        // A node still being walked closes a cycle: that wire counts as coming from depth -1.
        if (d !== undefined || visiting.has(id)) top.d = Math.max(top.d, (d ?? -1) + 1)
        else {
          visiting.add(id)
          stack.push({ id, from: incoming.get(id) ?? [], next: 0, d: 0 })
        }
        continue
      }
      stack.pop()
      visiting.delete(top.id)
      depths.set(top.id, top.d)
      const below = stack[stack.length - 1]
      if (below) below.d = Math.max(below.d, top.d + 1)
    }
    return depths.get(root)!
  }

  const columns: string[][] = []
  for (const n of todo) (columns[depth(n.id)] ??= []).push(n.id)
  const size = (id: string) => sizes.get(id) ?? [0, 0]
  const height = (col: string[]) => col.reduce((sum, id) => sum + size(id)[1] + GAP_Y, -GAP_Y)
  // One band per group in order of first appearance, '' for ungrouped nodes. Without groups there
  // is one band, and columns are centered as a whole.
  const bandOf = (id: string) => graph.memberOf.get(id) ?? ''
  const bands = [...new Set(todo.map(n => bandOf(n.id)))]
  const cell = (col: string[], band: string) => col.filter(id => bandOf(id) === band)

  // A batch added after the first layout starts right of the placed nodes, never on top of them.
  let [x, top] = [-Infinity, Infinity]
  for (const n of graph.nodes.values()) {
    if (!n.placed) continue
    x = Math.max(x, n.x + size(n.id)[0] + GAP_X)
    top = Math.min(top, n.y)
  }
  if (top === Infinity) [x, top] = [0, 0]
  // Each band is as tall as its tallest column; frames get their margins on top of the gap.
  const spans = new Map<string, [top: number, height: number]>()
  for (const band of bands) {
    // Loops instead of Math.max(...list): spreading thousands of arguments can overflow the stack.
    let tallest = -Infinity
    for (const col of columns) if (col) tallest = Math.max(tallest, height(cell(col, band)))
    if (band) top += FRAME.top
    spans.set(band, [top, tallest])
    top += tallest + GAP_Y + (band ? FRAME.side : 0)
  }
  for (const col of columns) {
    if (!col) continue
    let width = 0
    for (const band of bands) {
      const ids = cell(col, band)
      const [bandTop, tallest] = spans.get(band)!
      let y = bandTop + (tallest - height(ids)) / 2
      for (const id of ids) {
        out.set(id, [snap(x, grid), snap(y, grid)])
        y += size(id)[1] + GAP_Y
        width = Math.max(width, size(id)[0])
      }
    }
    x += width + GAP_X
  }
  return out
}
