import { expect, test, vi } from 'vitest'
import { flow, type FlowOptions } from '../src/index'
import { center, click, container, drag, frame, pointer, wirePoint } from './util'

const title = (el: HTMLElement, id: string) => el.querySelector(`[data-node="${id}"] .bn-title`)!

/** Nodes a at 20,20 and b at 320,20, a wire from `a.e` to `b.w`, and spies on the pointer events. */
async function setup(options: FlowOptions = {}) {
  const el = container()
  const f = flow(el, options)
  f.node('a').title('A').at(20, 20)
  f.node('b').title('B').at(320, 20)
  f.connect('a.e', 'b.w')
  const spy = { click: vi.fn(), dblclick: vi.fn(), contextmenu: vi.fn(), hover: vi.fn() }
  f.on('click', spy.click).on('dblclick', spy.dblclick).on('contextmenu', spy.contextmenu).on('hover', spy.hover)
  await frame()
  return { el, f, ...spy }
}

test.each(['view', 'edit'] as const)('%s mode: click reports the node, the wire or the background', async mode => {
  const { el, click: clicked } = await setup({ mode })
  await click(title(el, 'a'))
  await click(wirePoint(el, 'a.e>b.w', 'from', 40))
  await click({ x: 700, y: 500 })
  expect(clicked.mock.calls.map(([hit]) => hit)).toEqual([{ node: 'a' }, { wire: ['a.e', 'b.w'] }, {}])
  expect(clicked.mock.calls[0][1]).toBeInstanceOf(PointerEvent)
})

test('a drag is not a click', async () => {
  const { el, click: clicked } = await setup({ mode: 'edit' })
  const { x, y } = center(title(el, 'a'))
  await drag(title(el, 'a'), { x, y: y + 100 })
  await drag({ x: 700, y: 500 }, { x: 600, y: 500 })
  expect(clicked).not.toHaveBeenCalled()
})

test('click fires after the selection it made', async () => {
  const { el, f, click: clicked } = await setup({ mode: 'edit' })
  clicked.mockImplementation(() => expect(f.selection()).toEqual({ nodes: ['a'] }))
  await click(title(el, 'a'))
  expect(clicked).toHaveBeenCalledOnce()
})

test('click still fires with selection, panning and moving turned off', async () => {
  const { el, f, click: clicked } = await setup({ mode: 'edit', select: false, pan: false, move: false })
  await click(title(el, 'b'))
  expect(clicked).toHaveBeenCalledExactlyOnceWith({ node: 'b' }, expect.anything())
  expect(f.selection()).toEqual({ nodes: [] })
})

test('dblclick and contextmenu report what they hit; contextmenu can be cancelled', async () => {
  const { el, dblclick, contextmenu } = await setup()
  contextmenu.mockImplementation((_, e: MouseEvent) => e.preventDefault())
  title(el, 'a').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  el.dispatchEvent(menu)
  expect(dblclick).toHaveBeenCalledExactlyOnceWith({ node: 'a' }, expect.any(MouseEvent))
  expect(contextmenu).toHaveBeenCalledExactlyOnceWith({}, menu)
  expect(menu.defaultPrevented).toBe(true)
})

test('hover reports each change of what is under the pointer, once', async () => {
  const { el, hover } = await setup()
  const over = (target: Element) => target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  over(title(el, 'a'))
  over(el.querySelector('[data-node="a"]')!) // still node a
  over(el.querySelector('[data-wire="a.e>b.w"] .bn-hit')!)
  el.dispatchEvent(new PointerEvent('pointerleave'))
  expect(hover.mock.calls.map(([hit]) => hit)).toEqual([{ node: 'a' }, { wire: ['a.e', 'b.w'] }, {}])
})

test('a press cancelled by the browser is no click', async () => {
  const { el, click: clicked } = await setup()
  pointer('pointerdown', title(el, 'a'))
  dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }))
  await frame()
  expect(clicked).not.toHaveBeenCalled()
})
