import { expect, test } from 'vitest'
import { flow } from '../src/index'
import { Graph } from '../src/model/graph'
import { History, Journal, type Step } from '../src/model/history'
import { container, frame, press } from './util'

const sorted = <T>(list: T[]) => list.map(item => JSON.stringify(item)).sort()

test('a journal keeps what one edit changed, with a wire removed and added back cancelling out', () => {
  const graph = new Graph()
  for (const id of ['a', 'b', 'c']) graph.add(id)
  graph.connect('a', 'b')
  graph.connect('b', 'c')
  const journal = new Journal()
  const a = graph.nodes.get('a')!
  journal.track([a, graph.nodes.get('c')!])
  a.x = 40
  graph.disconnect('a', 'b', journal)
  graph.connect('a', 'b', journal)
  graph.remove(['c'], journal)
  expect(journal.close(graph)).toEqual({
    diff: { added: [], removed: [['b', 'c']], moved: { a: [40, 0] }, nodesRemoved: ['c'], nodesRestored: [] },
    was: new Map([['a', [0, 0]]]),
  })
})

test('the history keeps the newest steps within its limit, and a new edit clears redo', () => {
  const step = (id: string): Step => ({ diff: { added: [], removed: [], moved: {}, nodesRemoved: [id], nodesRestored: [] }, was: new Map() })
  const history = new History(2)
  for (const id of ['a', 'b', 'c']) history.push(step(id))
  expect([history.undo(), history.undo(), history.undo()].map(s => s?.diff.nodesRemoved)).toEqual([['c'], ['b'], undefined])
  expect(history.redo()?.diff.nodesRemoved).toEqual(['b'])
  history.push(step('d'))
  expect(history.redo()).toBeUndefined()
  history.resize(0)
  expect(history.undo()).toBeUndefined()
})

test('undo brings back a deleted node with its wires and keeps wires code added since', async () => {
  const el = container()
  const f = flow(el).mode('edit')
  for (const [id, x] of [['a', 0], ['b', 300], ['c', 600]] as const) f.node(id).at(x, 0)
  f.connect('a.e', 'b.w').connect('b.e', 'c.w')
  await frame()
  const before = f.state()
  f.select('b')
  press(el, 'Delete')
  f.connect('a.s', 'c.s')
  f.undo()
  const after = f.state()
  expect(after.positions).toEqual(before.positions)
  expect(sorted(after.edges)).toEqual(sorted([...before.edges, ['a.s', 'c.s']]))
  expect(after.removed).toBeUndefined()
  f.redo()
  expect(f.state().positions.b).toBeUndefined()
  expect(sorted(f.state().edges)).toEqual(sorted([['a.s', 'c.s']]))
})

test('undo skips what no longer applies, such as moving a node deleted since', async () => {
  const el = container()
  const f = flow(el).mode('edit')
  f.node('a').at(0, 0)
  f.node('b').at(300, 0)
  await frame()
  const diffs: unknown[] = []
  f.on('change', diff => diffs.push(diff))
  f.select('a', 'b')
  press(el, 'ArrowRight')
  f.remove('a')
  f.undo()
  expect(f.state().positions).toEqual({ b: [300, 0] })
  expect(diffs[1]).toEqual({ added: [], removed: [], moved: { b: [300, 0] }, nodesRemoved: [], nodesRestored: [] })
})
