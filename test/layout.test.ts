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
  const out = layout(graph, [...graph.nodes.values()], sizes, 20)
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

const positionsOf = (ids: string[], wires: [string, string][]) => {
  const { graph, sizes } = graphOf(ids, wires)
  return layout(graph, [...graph.nodes.values()], sizes, 20)
}

test('rows are reordered when that uncrosses wires between columns', () => {
  // Inserted c before d, but a feeds d and b feeds c: d moves up, so the wires run side by side.
  const at = positionsOf(['a', 'b', 'c', 'd'], [['a', 'd'], ['b', 'c']])
  expect(at.get('a')![1]).toBeLessThan(at.get('b')![1])
  expect(at.get('d')![1]).toBeLessThan(at.get('c')![1])
})

test('a layout whose wires do not cross keeps insertion order', () => {
  // A binary tree, children inserted left to right: already free of crossings.
  const ids = Array.from({ length: 15 }, (_, i) => `n${i}`)
  const at = positionsOf(ids, ids.slice(1).map((id, i): [string, string] => [ids[Math.floor(i / 2)], id]))
  for (const column of Map.groupBy(ids, id => at.get(id)![0]).values()) {
    const ys = column.map(id => at.get(id)![1])
    expect(ys).toEqual([...ys].sort((p, q) => p - q))
  }
})

test('a later batch starts right of the placed nodes, with columns from wires within the batch', () => {
  const { graph, sizes } = graphOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']])
  graph.nodes.get('a')!.placed = true
  const batch = ['b', 'c'].map(id => graph.nodes.get(id)!)
  const out = layout(graph, batch, sizes, 20, [0, 0, 1000, 400])
  // b's wire from the placed a doesn't count: b opens the batch's first column.
  expect([out.get('b')![0], out.get('c')![0]]).toEqual([1080, 1320])
  expect(out.has('a')).toBe(false)
})
