import { expect, test, vi } from 'vitest'
import { flow, type FlowOptions } from '../src/index'
import { center, click, container, drag, frame, pointer, press, wirePoint } from './util'

const anchor = (el: HTMLElement, ref: string) => el.querySelector(`[data-anchor="${ref}"]`)!
const title = (el: HTMLElement, id: string) => el.querySelector(`[data-node="${id}"] .bn-title`)!
const world = (el: HTMLElement) => el.querySelector<HTMLElement>('.bn-world')!.style.transform

/** Edit mode with options; nodes a at 20,20, b at 320,20, c at 320,220 and a wire a.e to b.w. */
async function setup(options: FlowOptions = {}) {
  const el = container()
  const f = flow(el, { mode: 'edit', ...options })
  f.node('a').title('A').at(20, 20)
  f.node('b').title('B').at(320, 20)
  f.node('c').title('C').at(320, 220)
  f.connect('a.e', 'b.w')
  const changes = vi.fn()
  f.on('change', changes)
  await frame()
  return { el, f, changes }
}

const wheel = (el: HTMLElement, deltaY = -100) => {
  const e = new WheelEvent('wheel', { deltaY, clientX: 300, clientY: 250, bubbles: true, cancelable: true })
  el.dispatchEvent(e)
  return e
}

test('defaults keep today\'s behaviour: view mode, fit, zoom', async () => {
  const el = container()
  flow(el).node('a').at(500, 500)
  await frame()
  expect(el.dataset.mode).toBe('view')
  expect(el.dataset.lock).toBeUndefined()
  expect(world(el)).not.toBe('')
  expect(wheel(el).defaultPrevented).toBe(true)
})

test('zoom: false leaves wheel events to the page', async () => {
  const { el } = await setup({ zoom: false })
  const before = world(el)
  const e = wheel(el)
  await frame()
  expect(e.defaultPrevented).toBe(false)
  expect(world(el)).toBe(before)
})

test('set() turns zoom off and on at runtime', async () => {
  const { el, f } = await setup()
  f.set({ zoom: false })
  expect(wheel(el).defaultPrevented).toBe(false)
  f.set({ zoom: true })
  expect(wheel(el).defaultPrevented).toBe(true)
})

test.each([
  ['maxZoom', -500, 'scale(2)'],
  ['minZoom', 500, 'scale(0.5)'],
])('the wheel stops at %s', async (_, deltaY, scale) => {
  const { el } = await setup({ minZoom: 0.5, maxZoom: 2 })
  for (let i = 0; i < 10; i++) wheel(el, deltaY)
  await frame()
  expect(world(el)).toContain(scale)
})

test('minZoom above maxZoom throws, and set() then changes nothing', async () => {
  expect(() => flow(container(), { minZoom: 3, maxZoom: 2 })).toThrow(/minZoom/)
  const { el, f } = await setup({ maxZoom: 2 })
  expect(() => f.set({ minZoom: 3 })).toThrow(/minZoom/)
  for (let i = 0; i < 10; i++) wheel(el, 500)
  await frame()
  expect(world(el)).toContain('scale(0.1)')
})

test('fit: false keeps the first render at the origin and 100%', async () => {
  const el = container()
  flow(el, { fit: false }).node('a').at(500, 500)
  await frame()
  expect(world(el)).toBe('')
  expect(el.querySelector('[data-node="a"]')!.getBoundingClientRect().left).toBe(500)
})

test('fit() never zooms below minZoom', async () => {
  const el = container()
  const f = flow(el, { minZoom: 0.8 })
  f.node('a').at(0, 0)
  f.node('b').at(3000, 3000)
  await frame()
  expect(world(el)).toContain('scale(0.8)')
})

test.each(['view', 'edit'] as const)('%s mode, pan: false: dragging the background does not pan', async mode => {
  const { el } = await setup({ mode, pan: false })
  const before = world(el)
  await drag({ x: 700, y: 500 }, { x: 600, y: 550 })
  expect(world(el)).toBe(before)
})

test('pan: false: a click still selects, and dragging a node at the edge does not pan', async () => {
  const { el, f } = await setup({ pan: false })
  await click(title(el, 'c'))
  expect(f.selection()).toEqual({ nodes: ['c'] })
  const before = world(el)
  pointer('pointerdown', title(el, 'a'))
  pointer('pointermove', { x: 795, y: 300 })
  for (let i = 0; i < 5; i++) await frame()
  expect(world(el)).toBe(before)
  pointer('pointerup', { x: 795, y: 300 })
})

test.each(['view', 'edit'] as const)('%s mode, select: false: clicks select nothing', async mode => {
  const { el, f } = await setup({ mode, select: false })
  const changed = vi.fn()
  f.on('select', changed)
  await click(title(el, 'a'))
  await click(title(el, 'b'), { shiftKey: true })
  if (mode === 'edit') await click(wirePoint(el, 'a.e>b.w', 'from', 40))
  expect(f.selection()).toEqual({ nodes: [] })
  expect(changed).not.toHaveBeenCalled()
})

test('select: false: Shift+drag pans instead of drawing a box, and select() from code still works', async () => {
  const { el, f } = await setup({ select: false })
  const before = world(el)
  await drag({ x: 700, y: 500 }, { x: 600, y: 550 }, { shiftKey: true })
  expect(f.selection()).toEqual({ nodes: [] })
  expect(world(el)).not.toBe(before)
  f.select('a')
  press(el, 'Escape')
  expect(f.selection()).toEqual({ nodes: ['a'] })
})

test('select: false: dragging a node still moves it', async () => {
  const { el, f, changes } = await setup({ select: false })
  const { x, y } = center(title(el, 'a'))
  await drag(title(el, 'a'), { x, y: y + 100 })
  expect(changes).toHaveBeenCalledOnce()
  expect(f.state().positions.a).toEqual([20, 120])
  expect(f.selection()).toEqual({ nodes: [] })
})

test('keys: false: Ctrl+Z and Delete do nothing', async () => {
  const { el, f, changes } = await setup({ keys: false })
  const { x, y } = center(title(el, 'a'))
  await drag(title(el, 'a'), { x, y: y + 100 })
  press(el, 'z', { ctrlKey: true })
  press(el, 'Delete')
  expect(changes).toHaveBeenCalledOnce()
  expect(f.state().positions.a).toEqual([20, 120])
})

test('history: 0 turns undo off', async () => {
  const { el, f, changes } = await setup({ history: 0 })
  await click(title(el, 'a'))
  press(el, 'Delete')
  f.undo()
  expect(changes).toHaveBeenCalledOnce()
  expect(f.state().removed).toEqual(['a'])
})

test('set({ history }) drops the oldest undo steps', async () => {
  const { el, f } = await setup()
  await click(title(el, 'a'))
  press(el, 'Delete')
  await click(title(el, 'b'))
  press(el, 'Delete')
  f.set({ history: 1 })
  f.undo().undo()
  expect(f.state().removed).toEqual(['a'])
})

test('connect: false: anchors neither start wires nor show, wire ends stay put', async () => {
  const { el, f, changes } = await setup({ connect: false })
  expect(el.dataset.lock).toBe('connect')
  expect(getComputedStyle(anchor(el, 'a.s')).visibility).toBe('hidden')
  await drag(anchor(el, 'c.w'), anchor(el, 'a.s'))
  await drag(wirePoint(el, 'a.e>b.w', 'to'), anchor(el, 'c.w'))
  expect(f.state().edges).toEqual([['a.e', 'b.w']])
  expect(changes.mock.calls.every(([state]) => state.edges.length === 1)).toBe(true)
})

test('move: false: dragging a node pans instead, and a click still selects it', async () => {
  const { el, f, changes } = await setup({ move: false })
  const before = world(el)
  const { x, y } = center(title(el, 'a'))
  await drag(title(el, 'a'), { x, y: y + 100 })
  expect(changes).not.toHaveBeenCalled()
  expect(f.state().positions.a).toEqual([20, 20])
  expect(world(el)).not.toBe(before)
  await click(title(el, 'b'))
  expect(f.selection()).toEqual({ nodes: ['b'] })
})

test('remove: false: Delete keeps the selected node and wire', async () => {
  const { el, f, changes } = await setup({ remove: false })
  await click(title(el, 'a'))
  press(el, 'Delete')
  await click(wirePoint(el, 'a.e>b.w', 'from', 40))
  press(el, 'Backspace')
  expect(changes).not.toHaveBeenCalled()
  expect(f.state().edges).toEqual([['a.e', 'b.w']])
})

test('snap: false: a node moves exactly as far as the pointer', async () => {
  const { el, f } = await setup({ snap: false })
  const { x, y } = center(title(el, 'a'))
  await drag(title(el, 'a'), { x: x + 7, y: y + 13 })
  expect(f.state().positions.a).toEqual([27, 33])
})

test('set() can switch modes, and data-lock follows the edit rights until destroy()', async () => {
  const { el, f } = await setup({ move: false, remove: false })
  expect(el.dataset.lock).toBe('move remove')
  f.set({ mode: 'view', move: true })
  expect(el.dataset.mode).toBe('view')
  expect(el.dataset.lock).toBe('remove')
  f.set({ remove: true })
  expect(el.dataset.lock).toBeUndefined()
  f.set({ connect: false })
  f.destroy()
  expect(el.dataset.lock).toBeUndefined()
})
