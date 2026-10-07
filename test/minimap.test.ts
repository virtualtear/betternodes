import { expect, test, vi } from 'vitest'
import { flow, type FlowOptions } from '../src/index'
import { center, click, container, frame, pointer, press } from './util'

const mini = (el: HTMLElement) => el.querySelector<SVGSVGElement>('.bn-minimap')
const rect = (el: HTMLElement, i: number) => el.querySelectorAll<SVGRectElement>('.bn-mini-node')[i]

/** Nodes a at 0,0 and b at 1500,1000 in an 800x600 root, the minimap on. */
async function setup(options: FlowOptions = {}) {
  const el = container()
  const f = flow(el, { minimap: true, ...options })
  f.node('a').title('A').at(0, 0)
  f.node('b').title('B').at(1500, 1000).class('error')
  await frame()
  return { el, f }
}

test('off by default; set() shows and hides it', async () => {
  const el = container()
  const f = flow(el)
  f.node('a')
  await frame()
  expect(mini(el)).toBeNull()
  f.set({ minimap: true })
  await frame()
  expect(el.querySelectorAll('.bn-mini-node')).toHaveLength(1)
  f.set({ minimap: false })
  await frame()
  expect(mini(el)).toBeNull()
})

test('draws every node in world px, with its classes', async () => {
  const { el } = await setup()
  const b = rect(el, 1)
  expect([b.getAttribute('x'), b.getAttribute('y')]).toEqual(['1500', '1000'])
  expect(b.classList.contains('error')).toBe(true)
  expect(Number(b.getAttribute('width'))).toBeGreaterThan(100)
})

test('follows moved nodes and drops deleted ones', async () => {
  const { el, f } = await setup({ mode: 'edit' })
  f.node('a').at(200, 100)
  await frame()
  expect([rect(el, 0).getAttribute('x'), rect(el, 0).getAttribute('y')]).toEqual(['200', '100'])
  await click(el.querySelector('[data-node="a"] .bn-title')!)
  press(el, 'Delete')
  await frame()
  expect(el.querySelectorAll('.bn-mini-node')).toHaveLength(1)
})

test('the visible area follows pans', async () => {
  const { el, f } = await setup()
  f.viewport({ x: -100, y: -50, zoom: 2 })
  await frame()
  const view = el.querySelector('.bn-mini-view')!
  expect(['x', 'y', 'width', 'height'].map(a => Number(view.getAttribute(a)))).toEqual([50, 25, 400, 300])
})

test('a click centres the view there and fires no click event', async () => {
  const { el, f } = await setup()
  const clicked = vi.fn()
  f.on('click', clicked)
  const target = center(rect(el, 1))
  await click(target)
  const [x, y] = [f.viewport().x, f.viewport().y]
  const { zoom } = f.viewport()
  const b = rect(el, 1)
  // The world point under the click (b's centre) now sits in the middle of the 800x600 root.
  const bx = Number(b.getAttribute('x')) + Number(b.getAttribute('width')) / 2
  const by = Number(b.getAttribute('y')) + Number(b.getAttribute('height')) / 2
  expect(bx * zoom + x).toBeCloseTo(400, -1)
  expect(by * zoom + y).toBeCloseTo(300, -1)
  expect(clicked).not.toHaveBeenCalled()
  expect(f.selection()).toEqual({ nodes: [] })
})

test('dragging in it keeps its scale until released', async () => {
  const { el } = await setup()
  const box = mini(el)!.getAttribute('viewBox')
  const r = mini(el)!.getBoundingClientRect()
  pointer('pointerdown', { x: r.left + 20, y: r.top + 20 })
  pointer('pointermove', { x: r.left + 5, y: r.top + 5 })
  await frame()
  expect(mini(el)!.getAttribute('viewBox')).toBe(box)
  pointer('pointerup', { x: r.left + 5, y: r.top + 5 })
  await frame()
  // The view now reaches past the nodes, so the overview grows to show both.
  expect(mini(el)!.getAttribute('viewBox')).not.toBe(box)
})

test('pan: false ignores it', async () => {
  const { el, f } = await setup({ pan: false })
  const before = f.viewport()
  await click(center(rect(el, 1)))
  expect(f.viewport()).toEqual(before)
})

test('destroy() removes it', async () => {
  const { el, f } = await setup()
  f.destroy()
  expect(mini(el)).toBeNull()
})
