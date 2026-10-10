import { FRAME, snap, type Point, type Rect } from '../geometry/rect'
import { nodeOf, type Graph, type NodeDef } from '../model/graph'
import type { Edge } from '../model/state'

const GAP_X = 80
const GAP_Y = 40

/**
 * Positions for the nodes in `todo`, which have none yet; the view then marks them placed, so each
 * node is laid out once. Columns follow the longest wire path within the batch, rows are ordered
 * to cut wire crossings (see {@link untwist}), columns are centered vertically, results snap to
 * `grid`. Each group gets a band of its own, stacked top to bottom with room for its frame, so no
 * frame reaches over other nodes.
 * @param sizes - measured node sizes in world px.
 * @param after - the area placed nodes cover; the batch starts right of it, never on top of them.
 * @remarks Only wires within the batch count, found through each node's own wires, so the cost
 * follows the batch, not the graph.
 */
// Positions are fixed at first measure; f.layout() re-runs it when content has grown since.
export function layout(graph: Graph, todo: NodeDef[], sizes: ReadonlyMap<string, Point>, grid: number, after?: Rect) {
  const out = new Map<string, Point>()
  if (!todo.length) return out

  const batch = new Set(todo.map(n => n.id))
  const edges: Edge[] = []
  for (const id of batch) {
    for (const key of graph.wiresAt(id)) {
      const edge = graph.edges.get(key)!
      if (nodeOf(edge[1]) === id && batch.has(nodeOf(edge[0]))) edges.push(edge)
    }
  }
  const incoming = Map.groupBy(edges, ([, to]) => nodeOf(to))
  const depths = new Map<string, number>()
  const visiting = new Set<string>()
  // Longest wire path into `root`, depth first. An explicit stack, not recursion, which overflows the
  // call stack on a chain of a few thousand nodes wired against insertion order.
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
  untwist(columns, edges)
  const size = (id: string) => sizes.get(id) ?? [0, 0]
  const height = (col: string[]) => col.reduce((sum, id) => sum + size(id)[1] + GAP_Y, -GAP_Y)
  // One band per group in order of first appearance, '' for ungrouped nodes. Without groups there
  // is one band, and columns are centered as a whole.
  const bandOf = (id: string) => graph.memberOf.get(id) ?? ''
  const bands = [...new Set(todo.map(n => bandOf(n.id)))]
  const cell = (col: string[], band: string) => col.filter(id => bandOf(id) === band)

  let [x, top] = after ? [after[0] + after[2] + GAP_X, after[1]] : [0, 0]
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

/**
 * Reorders the rows of each column to cut crossings between wires from one column to the next.
 * @remarks Barycenter sweeps, as in Sugiyama-style layouts: left to right, each node moves to the
 * mean row of its neighbours in the column before; then right to left with the column after. Rows
 * are fractions of their column, so columns of different heights compare. An ordering is kept only
 * if it has fewer crossings than the best so far, so the result never has more than insertion
 * order, which also breaks ties.
 */
// ponytail: wires that skip a column are ignored; add a dummy node per skipped column if long wires
// come out tangled.
function untwist(columns: string[][], edges: Iterable<Edge>) {
  const col = new Map<string, number>()
  columns.forEach((ids, c) => ids.forEach(id => col.set(id, c)))
  // Each node's neighbours one column to the left and one to the right, once per wire.
  const [left, right] = [new Map<string, string[]>(), new Map<string, string[]>()]
  const link = (map: Map<string, string[]>, id: string, other: string) => {
    const list = map.get(id)
    if (list) list.push(other)
    else map.set(id, [other])
  }
  for (const [from, to] of edges) {
    const [a, b] = [nodeOf(from), nodeOf(to)]
    const [ca, cb] = [col.get(a), col.get(b)]
    if (ca === undefined || cb === undefined || Math.abs(ca - cb) !== 1) continue
    const [l, r] = ca < cb ? [a, b] : [b, a]
    link(right, l, r)
    link(left, r, l)
  }
  const row = new Map<string, number>()
  const rank = (ids: string[]) => ids.forEach((id, i) => row.set(id, (i + 0.5) / ids.length))
  columns.forEach(rank)
  let fewest = crossings(columns, right)
  let best = columns.map(ids => [...ids])
  for (let sweep = 0; sweep < 4 && fewest; sweep++) {
    const down = sweep % 2 === 0
    const by = down ? left : right
    for (let k = 0; k < columns.length; k++) {
      const ids = columns[down ? k : columns.length - 1 - k]
      if (!ids) continue
      const key = new Map<string, number>()
      for (const id of ids) {
        const near = by.get(id)
        key.set(id, near ? near.reduce((sum, n) => sum + row.get(n)!, 0) / near.length : row.get(id)!)
      }
      ids.sort((a, b) => key.get(a)! - key.get(b)!)
      rank(ids)
    }
    const count = crossings(columns, right)
    if (count < fewest) {
      fewest = count
      best = columns.map(ids => [...ids])
    }
  }
  best.forEach((ids, c) => {
    columns[c] = ids
  })
}

// Crossings between wires from each column to the next: with wires sorted by their left end, then
// their right end, each one crosses every earlier wire that ends lower. A Fenwick tree over the right
// column counts those in O(log n) per wire.
function crossings(columns: string[][], right: Map<string, string[]>) {
  let total = 0
  for (let c = 0; c + 1 < columns.length; c++) {
    const [ids, next] = [columns[c], columns[c + 1]]
    if (!ids || !next) continue
    const at = new Map(next.map((id, i) => [id, i]))
    const tree = new Int32Array(next.length + 1)
    let seen = 0
    for (const id of ids) {
      for (const end of (right.get(id) ?? []).map(n => at.get(n)!).sort((p, q) => p - q)) {
        let above = 0 // earlier wires ending at or above this one
        for (let i = end + 1; i > 0; i -= i & -i) above += tree[i]
        total += seen++ - above
        for (let i = end + 1; i <= next.length; i += i & -i) tree[i]++
      }
    }
  }
  return total
}
