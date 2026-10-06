import { nodeOf, type Graph } from '../model/graph'
import { snap, type Point } from '../geometry/rect'

const GAP_X = 80
const GAP_Y = 40

/**
 * Positions for nodes that have none yet (`placed` unset); the view then marks them placed, so each
 * node is laid out once. Columns follow the longest wire path from a source node, rows keep
 * insertion order, columns are centered vertically, results snap to `grid`.
 * @param sizes - measured node sizes in world px.
 */
// ponytail: no crossing minimization; swap in elkjs or dagre if dense graphs come out tangled.
// Positions are fixed at first measure; f.layout() re-runs it when content has grown since.
export function layout(graph: Graph, sizes: Map<string, Point>, grid: number) {
  const out = new Map<string, Point>()
  const todo = [...graph.nodes.values()].filter(n => !n.placed)
  if (!todo.length) return out

  const sources = new Map<string, string[]>()
  for (const [from, to] of graph.edges.values()) {
    const list = sources.get(nodeOf(to))
    if (list) list.push(nodeOf(from))
    else sources.set(nodeOf(to), [nodeOf(from)])
  }
  const depths = new Map<string, number>()
  const visiting = new Set<string>()
  const depth = (id: string): number => {
    if (depths.has(id)) return depths.get(id)!
    if (visiting.has(id)) return -1 // back edge of a cycle: ignore it
    visiting.add(id)
    let d = 0
    for (const source of sources.get(id) ?? []) d = Math.max(d, depth(source) + 1)
    visiting.delete(id)
    depths.set(id, d)
    return d
  }

  const columns: string[][] = []
  for (const n of todo) (columns[depth(n.id)] ??= []).push(n.id)
  const size = (id: string) => sizes.get(id) ?? [0, 0]
  const height = (col: string[]) => col.reduce((sum, id) => sum + size(id)[1] + GAP_Y, -GAP_Y)
  // Loops instead of Math.max(...list): spreading thousands of arguments can overflow the stack.
  let tallest = -Infinity
  for (const col of columns) if (col) tallest = Math.max(tallest, height(col))

  // A batch added after the first layout starts right of the placed nodes, never on top of them.
  let [x, top] = [-Infinity, Infinity]
  for (const n of graph.nodes.values()) {
    if (!n.placed) continue
    x = Math.max(x, n.x + size(n.id)[0] + GAP_X)
    top = Math.min(top, n.y)
  }
  if (top === Infinity) [x, top] = [0, 0]
  for (const col of columns) {
    if (!col) continue
    let [y, width] = [top + (tallest - height(col)) / 2, 0]
    for (const id of col) {
      out.set(id, [snap(x, grid), snap(y, grid)])
      y += size(id)[1] + GAP_Y
      width = Math.max(width, size(id)[0])
    }
    x += width + GAP_X
  }
  return out
}
