import { describe, expect, onTestFinished, test, vi } from 'vitest'
import { flow } from '../src/index'
import { center, click, container, drag, frame, wirePoint } from './util'

const FAST = { speed: 4000 }
const SLOW = { speed: 60 }

type Spot = { x: number; y: number }
type Pixel = Spot & { rgba: number[] }

/**
 * Painted pixels of the WebGL packet layer, in screen px. Call it right after `await frame()`: a
 * WebGL canvas keeps a frame's drawing only until the browser shows it.
 */
function painted(el: HTMLElement): Pixel[] {
  const canvas = el.querySelector<HTMLCanvasElement>('canvas.bn-packets')
  if (!canvas?.width) return []
  const r = canvas.getBoundingClientRect()
  const g = new OffscreenCanvas(canvas.width, canvas.height).getContext('2d')!
  g.drawImage(canvas, 0, 0)
  const data = g.getImageData(0, 0, canvas.width, canvas.height).data
  const pixels: Pixel[] = []
  for (let i = 3; i < data.length; i += 4) {
    if (!data[i]) continue
    const p = (i - 3) / 4
    const [px, py] = [(p % canvas.width) + 0.5, Math.floor(p / canvas.width) + 0.5]
    pixels.push({ x: r.left + (px * r.width) / canvas.width, y: r.top + (py * r.height) / canvas.height, rgba: [...data.subarray(i - 3, i + 1)] })
  }
  return pixels
}

/** Center of the painted pixels: a single dot's center. */
function centroid(pixels: Pixel[]): Spot {
  expect(pixels.length, 'a packet is drawn').toBeGreaterThan(0)
  const sum = pixels.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 })
  return { x: sum.x / pixels.length, y: sum.y / pixels.length }
}

/** Colour of a single drawn dot at its center. */
function dotColour(el: HTMLElement) {
  const pixels = painted(el)
  const c = centroid(pixels)
  const near = (p: Pixel) => Math.hypot(p.x - c.x, p.y - c.y)
  return pixels.reduce((a, b) => (near(b) < near(a) ? b : a)).rgba
}

/** Screen points every 0.5px along the wire `key`, or along every wire. */
function along(el: HTMLElement, key?: string): Spot[] {
  const paths = el.querySelectorAll<SVGPathElement>(key ? `[data-wire="${key}"] .bn-wire` : '[data-wire] .bn-wire')
  return [...paths].flatMap(path => {
    const m = path.getScreenCTM()!
    const spots: Spot[] = []
    for (let l = 0; l <= path.getTotalLength(); l += 0.5) spots.push(path.getPointAtLength(l).matrixTransform(m))
    return spots
  })
}

const distance = (p: Spot, spots: Spot[]) => Math.min(...spots.map(q => Math.hypot(q.x - p.x, q.y - p.y)))

/** Edit-mode flow with nodes laid out in a row at 300px steps, wired `from -> to` as given. */
async function graph(ids: string[], wires: [string, string][]) {
  const el = container()
  const f = flow(el).mode('edit')
  ids.forEach((id, i) => f.node(id).title(id.toUpperCase()).at(i * 300, (i % 2) * 120))
  for (const [a, b] of wires) f.connect(a, b)
  await frame()
  return { el, f }
}

/** A stylesheet for the rest of the test. */
function css(text: string) {
  const style = document.head.appendChild(document.createElement('style'))
  style.textContent = text
  onTestFinished(() => style.remove())
}

test('a packet sent to a neighbour arrives there', async () => {
  const { f } = await graph(['a', 'b'], [['a', 'b']])
  expect(await f.send('a', 'b', FAST)).toEqual(['b'])
})

test('a packet in flight rides on its wire', async () => {
  const { el, f } = await graph(['a', 'b'], [['a', 'b']])
  void f.send('a', 'b', SLOW)
  for (let i = 0; i < 5; i++) await frame()
  expect(distance(centroid(painted(el)), along(el, 'a>b'))).toBeLessThan(1.5)
})

test('a packet stays on its wire after panning and zooming', async () => {
  const { el, f } = await graph(['a', 'b'], [['a', 'b']])
  void f.send('a', 'b', SLOW)
  await frame()
  f.viewport({ x: 120, y: 80, zoom: 0.5 })
  await frame()
  expect(distance(centroid(painted(el)), along(el, 'a>b'))).toBeLessThan(1.5)
})

test('a packet travels over several hops to its target', async () => {
  const { f } = await graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']])
  expect(await f.send('a', 'c', FAST)).toEqual(['c'])
})

test('a packet with no route to its target reports that nothing arrived', async () => {
  const { el, f } = await graph(['a', 'b', 'c'], [['a', 'b'], ['c', 'b']])
  expect(await f.send('a', 'c', FAST)).toEqual([])
  await frame()
  expect(painted(el)).toEqual([])
})

test('sending from or to an unknown node throws', async () => {
  const { f } = await graph(['a', 'b'], [['a', 'b']])
  expect(() => f.send('x', 'b')).toThrow()
})

test('a flow spreads along every outgoing wire and reports the end nodes reached', async () => {
  const { f } = await graph(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd']])
  expect((await f.send('a', undefined, FAST)).sort()).toEqual(['c', 'd'])
})

test('a flow through a cycle ends instead of looping forever', async () => {
  const { f } = await graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'a'], ['b', 'c']])
  expect(await f.send('a', undefined, FAST)).toEqual(['c'])
})

test('a packet stays on its wire while the user drags a node and the wire re-routes', async () => {
  const { el, f } = await graph(['a', 'b'], [['a', 'b']])
  void f.send('a', 'b', SLOW)
  await frame()
  await frame()
  const title = el.querySelector('[data-node="b"] .bn-title')!
  const { x, y } = center(title)
  await drag(title, { x: x - 150, y: y + 200 }) // b moves below and left: a different route
  await frame()
  expect(distance(centroid(painted(el)), along(el, 'a>b'))).toBeLessThan(1.5)
})

test('when its wire is deleted mid-flight a packet re-plans from the last node', async () => {
  const { f } = await graph(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'd'], ['a', 'c'], ['c', 'd']])
  const arrived = f.send('a', 'd', { speed: 900 }) // takes a -> b first
  await frame()
  await frame()
  f.disconnect('a', 'b')
  expect(await arrived).toEqual(['d'])
})

test('a packet whose route is gone is dropped and fades away', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  onTestFinished(() => void vi.useRealTimers())
  const { el, f } = await graph(['a', 'b'], [['a', 'b']])
  const arrived = f.send('a', 'b', { speed: 300 })
  await frame()
  await frame()
  f.disconnect('a', 'b')
  expect(await arrived).toEqual([])
  await frame()
  expect(painted(el).length, 'fading').toBeGreaterThan(0)
  for (let i = 0; i < 30; i++) await frame() // the fade takes 200ms
  // An undrawn canvas reads as empty but still shows its last frame: only the layer's release
  // proves the dot is gone.
  vi.advanceTimersByTime(2000)
  expect(el.querySelector('canvas.bn-packets')).toBeNull()
})

test('deleting the target node mid-flight drops the packet', async () => {
  const { f } = await graph(['a', 'b'], [['a', 'b']])
  const arrived = f.send('a', 'b', { speed: 300 })
  await frame()
  await frame()
  f.remove('b')
  expect(await arrived).toEqual([])
})

test('a packet takes the colour CSS gives its class', async () => {
  css('.bn-packet.error { fill: rgb(255, 0, 0) }')
  const { el, f } = await graph(['a', 'b'], [['a', 'b']])
  void f.send('a', 'b', { ...SLOW, class: 'error' })
  await frame()
  await frame()
  expect(dotColour(el)).toEqual([255, 0, 0, 255])
})

test('packets in flight pick up a theme change', async () => {
  const { el, f } = await graph(['a', 'b'], [['a', 'b']])
  void f.send('a', 'b', SLOW)
  await frame()
  await frame()
  el.style.setProperty('--bn-packet', 'rgb(0, 160, 0)')
  await frame()
  expect(dotColour(el)).toEqual([0, 160, 0, 255])
})

test('packets are drawn without a DOM element each', async () => {
  const { el, f } = await graph(['a', 'b'], [['a', 'b']])
  for (let i = 0; i < 50; i++) void f.send('a', 'b', { speed: 20 + i * 4 })
  await frame()
  await frame()
  expect(painted(el).length).toBeGreaterThan(0)
  expect(el.querySelectorAll('.bn-packet').length).toBeLessThan(50)
})

test('a wire under packets in flight can still be clicked', async () => {
  const { el, f } = await graph(['a', 'b'], [['a', 'b']])
  void f.send('a', 'b', SLOW)
  await frame()
  await click(wirePoint(el, 'a>b', 'to', 40))
  expect(f.selection().wire).toEqual(['a', 'b'])
})

test('the packet layer is released when packets stop, and comes back for the next', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  onTestFinished(() => void vi.useRealTimers())
  const { el, f } = await graph(['a', 'b'], [['a', 'b']])
  await f.send('a', 'b', FAST)
  await frame()
  vi.advanceTimersByTime(2000)
  expect(el.querySelector('canvas.bn-packets'), 'released').toBeNull()
  void f.send('a', 'b', SLOW)
  await frame()
  await frame()
  expect(distance(centroid(painted(el)), along(el, 'a>b'))).toBeLessThan(1.5)
})

test('packets keep being drawn after the browser takes the WebGL context away', async () => {
  const { el, f } = await graph(['a', 'b'], [['a', 'b']])
  void f.send('a', 'b', SLOW)
  await frame()
  el.querySelector<HTMLCanvasElement>('canvas.bn-packets')!.getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext()
  await frame()
  await frame()
  expect(distance(centroid(painted(el)), along(el, 'a>b'))).toBeLessThan(1.5)
})

test('destroy() settles packets still in flight', async () => {
  const { f } = await graph(['a', 'b'], [['a', 'b']])
  const arrived = f.send('a', 'b', SLOW)
  await frame()
  f.destroy()
  expect(await arrived).toEqual([])
})

test('a packet never shows up away from a wire, not even for a frame', async () => {
  const { el, f } = await graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']])
  let done = false
  void f.send('a', 'c', { speed: 900 }).then(() => (done = true))
  const wires = along(el)
  // Dots are 12px wide: every painted pixel lies within 7px of a wire, antialiasing included.
  const strays = () => painted(el).filter(p => distance(p, wires) > 7).length
  const seen = [strays()] // right after sending, before any frame
  while (!done) {
    await frame()
    seen.push(strays()) // includes the frame where the packet switches from a -> b to b -> c
  }
  expect(Math.max(...seen)).toBe(0)
})

describe('without WebGL', () => {
  // As in browsers with WebGL turned off or blocklisted: packets fall back to SVG circles.
  function noWebGL() {
    const real = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      return type === 'webgl2' ? null : real.call(this, type, ...(rest as []))
    } as typeof real
    onTestFinished(() => void (HTMLCanvasElement.prototype.getContext = real))
  }

  const dotCenter = (el: HTMLElement) => center(el.querySelector('.bn-packet')!)

  test('a packet in flight rides on its wire as an SVG circle', async () => {
    noWebGL()
    const { el, f } = await graph(['a', 'b'], [['a', 'b']])
    void f.send('a', 'b', SLOW)
    for (let i = 0; i < 5; i++) await frame()
    expect(distance(dotCenter(el), along(el, 'a>b'))).toBeLessThan(1.5)
  })

  test('a packet carries the class it was sent with', async () => {
    noWebGL()
    const { el, f } = await graph(['a', 'b'], [['a', 'b']])
    void f.send('a', 'b', { ...SLOW, class: 'error' })
    await frame()
    expect(el.querySelector('.bn-packet.error')).not.toBeNull()
  })

  test('a packet whose route is gone fades away', async () => {
    noWebGL()
    const { el, f } = await graph(['a', 'b'], [['a', 'b']])
    const arrived = f.send('a', 'b', { speed: 300 })
    await frame()
    await frame()
    f.disconnect('a', 'b')
    expect(await arrived).toEqual([])
    await new Promise(r => setTimeout(r, 300))
    expect(el.querySelector('.bn-packet')).toBeNull()
  })

  test('a packet never shows up away from a wire, not even for a frame', async () => {
    noWebGL()
    const { el, f } = await graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']])
    let done = false
    void f.send('a', 'c', { speed: 900 }).then(() => (done = true))
    const wires = along(el)
    const strays = () => [...el.querySelectorAll('.bn-packet')]
      .filter(dot => getComputedStyle(dot).visibility !== 'hidden' && distance(center(dot), wires) > 1.5).length
    const seen = [strays()]
    while (!done) {
      await frame()
      seen.push(strays())
    }
    expect(Math.max(...seen)).toBe(0)
  })
})

test('send() rejects a packet class that is not one class name, and a speed that never arrives', () => {
  const f = flow(container())
  f.node('a')
  f.node('b')
  f.connect('a', 'b')
  expect(() => f.send('a', 'b', { class: 'a b' })).toThrow(/class/)
  for (const speed of [0, -5, NaN, Infinity]) expect(() => f.send('a', 'b', { speed })).toThrow(/speed/)
})
