import { expect, test, vi } from 'vitest'
import { flow, type FlowOptions } from '../src/index'
import { center, click, container, drag, frame, press } from './util'

const frameEl = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-group="${id}"]`)!
const titleOf = (el: HTMLElement, id: string) => frameEl(el, id).querySelector('.bn-group-title')!
const box = (el: Element) => el.getBoundingClientRect()
const hits = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** Edit mode with a and b at 20,60 and 240,60 in group g ("Stage"), and c at 520,60 outside it. */
async function setup(options: FlowOptions = {}) {
  const el = container()
  const f = flow(el, { mode: 'edit', fit: false, ...options })
  f.node('a').title('A').at(20, 60)
  f.node('b').title('B').at(240, 60)
  f.node('c').title('C').at(520, 60)
  f.group('g').title('Stage').nodes('a', 'b').class('running')
  const changes = vi.fn()
  // Listeners get only the diff; the state is read the way an app would.
  f.on('change', diff => changes(f.state(), diff))
  await frame()
  return { el, f, changes }
}

test('a frame encloses its members, 20px around and a title line on top', async () => {
  const { el } = await setup()
  const [g, a, b] = [box(frameEl(el, 'g')), box(el.querySelector('[data-node="a"]')!), box(el.querySelector('[data-node="b"]')!)]
  expect([g.left, g.top, g.right]).toEqual([a.left - 20, a.top - 40, b.right + 20])
  expect(g.bottom).toBe(Math.max(a.bottom, b.bottom) + 20)
  expect(titleOf(el, 'g').textContent).toBe('Stage')
  expect(frameEl(el, 'g').classList.contains('running')).toBe(true)
})

test('the frame follows its members and hides without any', async () => {
  const { el, f } = await setup()
  f.node('b').at(240, 300)
  await frame()
  expect(box(frameEl(el, 'g')).bottom).toBe(box(el.querySelector('[data-node="b"]')!).bottom + 20)
  f.group('g').nodes('x') // not defined yet
  await frame()
  expect(frameEl(el, 'g').style.display).toBe('none')
  f.node('x').at(0, 400)
  await frame()
  expect(frameEl(el, 'g').style.display).toBe('')
})

test('dragging the title moves every member in one edit; undo puts them back', async () => {
  const { el, f, changes } = await setup()
  const { x, y } = center(titleOf(el, 'g'))
  await drag(titleOf(el, 'g'), { x, y: y + 200 })
  expect(changes).toHaveBeenCalledOnce()
  const { a, b, c } = f.state().positions
  expect([a, b, c]).toEqual([[20, 260], [240, 260], [520, 60]])
  expect(f.selection().nodes.toSorted()).toEqual(['a', 'b'])
  f.undo()
  expect(f.state().positions.a).toEqual([20, 60])
})

test('a title click selects the members and reports the group', async () => {
  const { el, f } = await setup({ mode: 'view' })
  const clicked = vi.fn()
  f.on('click', clicked)
  await click(titleOf(el, 'g'))
  expect(f.selection().nodes.toSorted()).toEqual(['a', 'b'])
  expect(clicked).toHaveBeenCalledExactlyOnceWith({ group: 'g' }, expect.anything())
})

test('a press inside a frame but off the title acts on the background', async () => {
  const { el, f } = await setup()
  const g = box(frameEl(el, 'g'))
  const before = f.viewport()
  await drag({ x: g.left + 5, y: g.bottom - 5 }, { x: g.left + 55, y: g.bottom - 5 })
  expect(f.viewport().x).toBe(before.x + 50)
})

test('a user-deleted member leaves the frame and comes back with undo', async () => {
  const { el, f } = await setup()
  const width = box(frameEl(el, 'g')).width
  await click(el.querySelector('[data-node="b"] .bn-title')!)
  press(el, 'Delete')
  await frame()
  expect(box(frameEl(el, 'g')).width).toBeLessThan(width)
  f.undo()
  await frame()
  expect(box(frameEl(el, 'g')).width).toBe(width)
})

test('a node is in one group at most; ungroup() removes the frame', async () => {
  const { el, f } = await setup()
  f.group('h').nodes('b')
  await frame()
  expect(box(frameEl(el, 'g')).right).toBe(box(el.querySelector('[data-node="a"]')!).right + 20)
  f.ungroup('g')
  await frame()
  expect(el.querySelector('[data-group="g"]')).toBeNull()
  expect(() => f.ungroup('g')).toThrow(/no group "g"/)
})

test('a node dropped onto another group\'s frame settles outside it', async () => {
  const { el, f } = await setup()
  const c = el.querySelector('[data-node="c"] .bn-title')!
  const { x, y } = center(c)
  // To 240,0: in the frame's title margin, yet over 20px clear of b, so only the frame is in the way.
  await drag(c, { x: x - 280, y: y - 60 })
  await frame()
  const [g, cBox] = [box(frameEl(el, 'g')), box(el.querySelector('[data-node="c"]')!)]
  expect(hits(g, cBox)).toBe(false)
  expect(f.state().positions.c).not.toEqual([240, 0])
})

test('a dragged group settles clear of other nodes', async () => {
  const { el } = await setup()
  const { x, y } = center(titleOf(el, 'g'))
  await drag(titleOf(el, 'g'), { x: x + 300, y }) // the frame would cover c
  await frame()
  expect(hits(box(frameEl(el, 'g')), box(el.querySelector('[data-node="c"]')!))).toBe(false)
})

test('auto layout keeps other nodes out of frames', async () => {
  const el = container()
  const f = flow(el)
  // Two columns: s feeds p and q, which feed t; p and t form a group spanning both columns.
  for (const id of ['s', 'p', 'q', 't', 'u']) f.node(id)
  f.connect('s', 'p').connect('s', 'q').connect('p', 't').connect('q', 't').connect('s', 'u')
  f.group('g').nodes('p', 't')
  await frame()
  const g = box(frameEl(el, 'g'))
  for (const id of ['s', 'q', 'u']) expect(hits(g, box(el.querySelector(`[data-node="${id}"]`)!)), id).toBe(false)
})

test('fit() keeps a frame title at the top in view', async () => {
  const el = container()
  const f = flow(el)
  f.node('a').at(0, 0)
  f.group('g').title('Top').nodes('a')
  await frame()
  expect(box(titleOf(el, 'g')).top).toBeGreaterThanOrEqual(0)
  expect(f.viewport().zoom).toBe(1)
})

test('the minimap draws frames', async () => {
  const { el } = await setup({ minimap: true })
  expect(el.querySelectorAll('.bn-mini-group')).toHaveLength(1)
})
