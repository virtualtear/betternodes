import { expect, test } from 'vitest'
import type { Point } from '../src/geometry/rect'
import { layout } from '../src/layout/columns'
import { Graph, type NodeDef } from '../src/model/graph'

/** A graph of unplaced 160 x 40 nodes with the given wires between bare node ids. */
function graphOf(ids: string[], wires: [string, string][]) {
  const graph = new Graph()
  const sizes = new Map<string, Point>()
  for (const id of ids) {
    graph.nodes.set(id, { id, title: '', x: 0, y: 0 } as NodeDef)
    sizes.set(id, [160, 40])
  }
  for (const [from, to] of wires) graph.connect(from, to)
  return { graph, sizes }
}

const columnsOf = (ids: string[], wires: [string, string][]) => {
  const { graph, sizes } = graphOf(ids, wires)
  const out = layout(graph, sizes, 20)
  return ids.map(id => out.get(id)![0] / 240)
}

test('a node sits one column right of its deepest source', () => {
  expect(columnsOf(['a', 'b', 'c'], [['a', 'c'], ['b', 'c'], ['a', 'b']])).toEqual([0, 1, 2])
})

test('a cycle is cut where the walk from the first node meets it again', () => {
  expect(columnsOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']])).toEqual([2, 0, 1])
})

test('a chain far longer than the call stack is deep gets one column per node', () => {
  // Wired against insertion order, so finding the first node's depth walks the whole chain: the
  // recursive version overflowed the call stack between 2,000 and 5,000 nodes.
  const ids = Array.from({ length: 20_000 }, (_, i) => `n${i}`)
  const columns = columnsOf(ids, ids.slice(1).map((id, i) => [id, ids[i]]))
  expect([columns[0], columns[ids.length - 1]]).toEqual([ids.length - 1, 0])
})
