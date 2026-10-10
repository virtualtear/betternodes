import { expect, onTestFinished, test, vi } from 'vitest'
import type { Point, Rect } from '../src/geometry/rect'
import { flow, type Flow, type FlowOptions } from '../src/index'
import { click, container, frame, pointer, press } from './util'

const mini = (el: HTMLElement) => el.querySelector<HTMLCanvasElement>('.bn-minimap')

interface Internals {
  view: { mini: { shown: Rect; area: Rect; map: { x: number; y: number; k: number } } }
}
const internals = (f: Flow) => (f as unknown as Internals).view.mini

/** Screen point of a world point in the minimap. */
function screen(el: HTMLElement, f: Flow, [x, y]: Point) {
  const r = mini(el)!.getBoundingClientRect()
  const { map } = internals(f)
  return { x: r.left + map.x + x * map.k, y: r.top + map.y + y * map.k }
}

/** Colour of the minimap pixel under a screen point. */
function pixel(el: HTMLElement, { x, y }: { x: number; y: number }) {
  const canvas = mini(el)!
  const r = canvas.getBoundingClientRect()
  const [px, py] = [Math.floor(((x - r.left) * canvas.width) / r.width), Math.floor(((y - r.top) * canvas.height) / r.height)]
  return [...canvas.getContext('2d')!.getImageData(px, py, 1, 1).data]
}

// The visible area is drawn over the nodes in a 7% tint of the accent, so colours shift a little.
const tinted = (got: number[], want: number[]) => got.every((c, i) => Math.abs(c - want[i]) <= 20)

/** Nodes a at 0,0 and b at 1500,1000 in an 800x600 root, the minimap on, with status colours. */
async function setup(options: FlowOptions = {}) {
  const style = document.createElement('style')
  style.textContent = '.bn-mini-node { fill: rgb(0 0 255) } .bn-mini-node.error { fill: rgb(255 0 0) }'
  document.head.append(style)
  onTestFinished(() => style.remove())
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
  expect(mini(el)).not.toBeNull()
  f.set({ minimap: false })
  await frame()
  expect(mini(el)).toBeNull()
})

test('draws every node where it is, in the colour of its classes', async () => {
  const { el, f } = await setup()
  expect(tinted(pixel(el, screen(el, f, [80, 18])), [0, 0, 255, 255])).toBe(true)
  expect(tinted(pixel(el, screen(el, f, [1580, 1018])), [255, 0, 0, 255])).toBe(true)
  // Between them: nothing but the minimap's background, which CSS draws behind the canvas.
  expect(pixel(el, screen(el, f, [800, 500]))[3]).toBeLessThan(40)
})

test('follows moved nodes and clears deleted ones', async () => {
  const { el, f } = await setup({ mode: 'edit' })
  f.node('a').at(200, 100)
  await frame()
  expect(tinted(pixel(el, screen(el, f, [280, 118])), [0, 0, 255, 255])).toBe(true)
  expect(pixel(el, screen(el, f, [20, 10]))[3]).toBeLessThan(40)
  await click(el.querySelector('[data-node="a"] .bn-title')!)
  press(el, 'Delete')
  await frame()
  expect(pixel(el, screen(el, f, [280, 118]))[3]).toBeLessThan(40)
})

test('the visible area follows pans', async () => {
  const { f } = await setup()
  f.viewport({ x: -100, y: -50, zoom: 2 })
  await frame()
  expect(internals(f).area).toEqual([50, 25, 400, 300])
})

test('a click centres the view there and fires no click event', async () => {
  const { el, f } = await setup()
  const clicked = vi.fn()
  f.on('click', clicked)
  await click(screen(el, f, [1580, 1018]))
  const { x, y, zoom } = f.viewport()
  // The world point under the click (b's centre) now sits in the middle of the 800x600 root.
  expect(1580 * zoom + x).toBeCloseTo(400, -1)
  expect(1018 * zoom + y).toBeCloseTo(300, -1)
  expect(clicked).not.toHaveBeenCalled()
  expect(f.selection()).toEqual({ nodes: [] })
})

test('dragging in it keeps its scale until released', async () => {
  const { el, f } = await setup()
  const shown = internals(f).shown
  const r = mini(el)!.getBoundingClientRect()
  pointer('pointerdown', { x: r.left + 20, y: r.top + 20 })
  pointer('pointermove', { x: r.left + 5, y: r.top + 5 })
  await frame()
  expect(internals(f).shown).toEqual(shown)
  pointer('pointerup', { x: r.left + 5, y: r.top + 5 })
  await frame()
  // The view now reaches past the nodes, so the overview grows to show both.
  expect(internals(f).shown).not.toEqual(shown)
})

test('pan: false ignores it', async () => {
  const { el, f } = await setup({ pan: false })
  const before = f.viewport()
  await click(screen(el, f, [1580, 1018]))
  expect(f.viewport()).toEqual(before)
})

test('destroy() removes it', async () => {
  const { el, f } = await setup()
  f.destroy()
  expect(mini(el)).toBeNull()
})
