import { expect, test } from 'vitest'
import { flow } from '../src/index'
import { container, frame } from './util'

// A row of nodes 300px apart, far wider than the 800px container.
async function row(options = {}) {
  const el = container()
  const f = flow(el, { fit: false, ...options })
  for (let i = 0; i < 40; i++) f.node(`n${i}`).at(i * 300, 0)
  for (let i = 1; i < 40; i++) f.connect(`n${i - 1}.e`, `n${i}.w`)
  await frame()
  const shown = () => [...el.querySelectorAll<HTMLElement>('[data-node]')].map(n => n.dataset.node)
  return { el, f, shown }
}

test('only nodes in or near the view have elements, and panning brings the others in', async () => {
  const { f, shown } = await row()
  // The 800px view plus half of it on each side: x from -400 to 1200, so n4 only touches it.
  expect(shown()).toEqual(['n0', 'n1', 'n2', 'n3'])
  f.viewport({ x: -6000 })
  await frame()
  // Now x from 5600 to 7200: n18 ends at 5560.
  expect(shown()).toEqual(['n19', 'n20', 'n21', 'n22', 'n23'])
  expect(f.state().positions.n0).toEqual([0, 0])
})

test('virtual: false keeps every node mounted, and turning it back on unmounts the far ones', async () => {
  const { f, shown } = await row({ virtual: false })
  expect(shown()).toHaveLength(40)
  f.set({ virtual: true })
  await frame()
  expect(shown()).toHaveLength(4)
  f.set({ virtual: false })
  await frame()
  expect(shown()).toHaveLength(40)
})

test('a node keeps its element while it holds focus, even out of view', async () => {
  const { el, f, shown } = await row()
  const input = document.createElement('input')
  f.node('n1').content(input)
  await frame()
  input.focus()
  f.viewport({ x: -6000 })
  await frame()
  expect(shown()).toContain('n1')
  expect(el.contains(input)).toBe(true)
})

test('only wires near the view have elements, and turning culling off brings all of them', async () => {
  const { el, f } = await row()
  const wires = () => [...el.querySelectorAll<SVGGElement>('g[data-wire]')].map(g => g.dataset.wire)
  // A wire's span reaches 130px past its nodes, so n4 -> n5 at x 1200 is in, n5 -> n6 is not.
  expect(wires()).toEqual(['n0.e>n1.w', 'n1.e>n2.w', 'n2.e>n3.w', 'n3.e>n4.w', 'n4.e>n5.w'])
  f.set({ virtual: false })
  await frame()
  expect(wires()).toHaveLength(39)
})

test('a packet travels along wires that have no element', async () => {
  const { f } = await row()
  // n30 to n33 lies far right of the view: no element, so the wires get routes just for the packet.
  expect(await f.send('n30', 'n33', { speed: 2400 })).toEqual(['n33'])
})
