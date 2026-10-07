import { expect, test, vi } from 'vitest'
import { flow, type FlowOptions } from '../src/index'
import { container, frame } from './util'

const world = (el: HTMLElement) => el.querySelector<HTMLElement>('.bn-world')!.style.transform

/** Nodes a at 0,0 and b at 1500,1000 in an 800x600 root. */
async function setup(options: FlowOptions = {}) {
  const el = container()
  const f = flow(el, options)
  f.node('a').title('A').at(0, 0)
  f.node('b').title('B').at(1500, 1000)
  await frame()
  return { el, f }
}

test('viewport() reads the pan and zoom the first fit chose', async () => {
  const { el, f } = await setup()
  const { x, y, zoom } = f.viewport()
  expect(zoom).toBeLessThan(1)
  // The style rounds to a few decimals.
  const [tx, ty, k] = world(el).match(/-?[\d.]+/g)!.map(Number)
  expect([tx - x, ty - y, k - zoom].every(d => Math.abs(d) < 1e-3)).toBe(true)
})

test('viewport() set right after mounting wins over the first fit', async () => {
  const el = container()
  const f = flow(el)
  f.node('a').at(500, 500)
  f.viewport({ x: -100, y: 50, zoom: 2 })
  await frame()
  expect(world(el)).toBe('translate(-100px, 50px) scale(2)')
  expect(f.viewport()).toEqual({ x: -100, y: 50, zoom: 2 })
})

test('viewport() keeps the fields left out', async () => {
  const { f } = await setup()
  const { zoom } = f.viewport()
  f.viewport({ x: 10, y: 20 })
  expect(f.viewport()).toEqual({ x: 10, y: 20, zoom })
})

test('zoomBy() keeps the middle of the view in place and stays within the zoom options', async () => {
  const { f } = await setup({ maxZoom: 2 })
  f.viewport({ x: 0, y: 0, zoom: 1 })
  f.zoomBy(1.5)
  expect(f.viewport()).toEqual({ x: -200, y: -150, zoom: 1.5 }) // world point 400,300 stays at 400,300
  f.zoomBy(10)
  expect(f.viewport().zoom).toBe(2)
})

test('fit(...ids) shows just those nodes', async () => {
  const { el, f } = await setup()
  f.fit('b')
  await frame()
  const b = el.querySelector('[data-node="b"]')!.getBoundingClientRect()
  expect(f.viewport().zoom).toBe(1)
  expect(b.left + b.width / 2).toBeCloseTo(400, 0)
  expect(b.top + b.height / 2).toBeCloseTo(300, 0)
  expect(() => f.fit('nope')).toThrow(/no node "nope"/)
})

test('the viewport event fires once per frame, for the wheel and for code', async () => {
  const { el, f } = await setup()
  const changed = vi.fn()
  f.on('viewport', changed)
  for (let i = 0; i < 3; i++) el.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, clientX: 300, clientY: 200, bubbles: true, cancelable: true }))
  await frame()
  expect(changed).toHaveBeenCalledExactlyOnceWith(f.viewport())
  f.viewport({ x: 1, y: 2, zoom: 1 })
  await frame()
  expect(changed).toHaveBeenLastCalledWith({ x: 1, y: 2, zoom: 1 })
  await frame()
  expect(changed).toHaveBeenCalledTimes(2)
})
