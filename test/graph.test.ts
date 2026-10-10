import { expect, test } from 'vitest'
import { Graph } from '../src/model/graph'
import { wireKey } from '../src/model/state'

test('wiresAt() follows connect, disconnect, remove and load', () => {
  const graph = new Graph()
  for (const id of ['a', 'b', 'c']) graph.add(id)
  graph.connect('a.e', 'b.w')
  graph.connect('b', 'c')
  expect([...graph.wiresAt('b')]).toEqual([wireKey('a.e', 'b.w'), wireKey('b', 'c')])
  graph.disconnect('a.e', 'b.w')
  expect([...graph.wiresAt('a')]).toEqual([])
  graph.remove(['c'])
  expect([...graph.wiresAt('b')]).toEqual([])
  graph.load({ positions: {}, edges: [['a', 'b']] })
  expect([...graph.wiresAt('a')]).toEqual([wireKey('a', 'b')])
  expect([...graph.wiresAt('c')]).toEqual([])
})

test('setMembers() moves a node out of its old group', () => {
  const graph = new Graph()
  for (const id of ['a', 'b']) graph.add(id)
  graph.setMembers('g', ['a', 'b'])
  graph.setMembers('h', ['b'])
  expect([graph.membersOf('g'), graph.membersOf('h')]).toEqual([['a'], ['b']])
  graph.setMembers('g', [])
  expect(graph.memberOf.has('a')).toBe(false)
  expect([...graph.members().keys()]).toEqual(['h'])
})
