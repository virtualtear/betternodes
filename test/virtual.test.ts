import { expect, onTestFinished, test, vi } from 'vitest'
import { flow } from '../src/index'
import type { Sketch } from '../src/view/sketch'
import { click, container, drag, frame } from './util'

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

test('far out, nodes are drawn on the GPU without elements, and still answer clicks and drags', async () => {
  const el = container()
  const f = flow(el, { fit: false }).mode('edit')
  f.node('a').at(0, 0)
  f.node('b').at(400, 0)
  f.connect('a.e', 'b.w')
  f.viewport({ x: 100, y: 100, zoom: 0.25 })
  await frame()
  expect(el.querySelector('[data-node]')).toBeNull()
  expect(el.querySelector('g[data-wire]')).toBeNull()
  // Node b covers screen x 200 to 240 at this zoom: 100 + 400 * 0.25.
  const clicks = vi.fn()
  f.on('click', clicks)
  const root = el.getBoundingClientRect()
  const at = { x: root.left + 210, y: root.top + 104 }
  await click(at)
  expect(f.selection().nodes).toEqual(['b'])
  expect(clicks).toHaveBeenCalledWith({ node: 'b' }, expect.anything())
  await drag(at, { x: at.x + 40, y: at.y })
  expect(f.state().positions.b).toEqual([560, 0])
  // Back in close, the elements return.
  f.viewport({ zoom: 1 })
  await frame()
  expect(el.querySelectorAll('[data-node]')).toHaveLength(2)
})

// Painted pixels of the GPU layer in screen px; read right after a frame, before the browser shows it.
function painted(el: HTMLElement) {
  const canvas = el.querySelector<HTMLCanvasElement>('canvas.bn-packets')!
  const r = canvas.getBoundingClientRect()
  const g = new OffscreenCanvas(canvas.width, canvas.height).getContext('2d')!
  g.drawImage(canvas, 0, 0)
  const data = g.getImageData(0, 0, canvas.width, canvas.height).data
  return (x: number, y: number) => {
    const [px, py] = [Math.floor(((x - r.left) * canvas.width) / r.width), Math.floor(((y - r.top) * canvas.height) / r.height)]
    return [...data.subarray((py * canvas.width + px) * 4, (py * canvas.width + px) * 4 + 4)]
  }
}

test('far out, the GPU layer paints node fills, borders and wires in the stylesheet colours', async () => {
  const el = container()
  const f = flow(el, { fit: false })
  f.node('a').at(0, 0)
  f.node('b').at(400, 0).class('error')
  f.connect('a.e', 'b.w')
  const style = document.createElement('style')
  style.textContent = '.bn-node.error { background: rgb(255 0 0) }'
  document.head.append(style)
  onTestFinished(() => style.remove())
  f.viewport({ x: 100, y: 100, zoom: 0.25 })
  await frame()
  const at = painted(el)
  const root = el.getBoundingClientRect()
  // Inside a: the light theme's white fill. Inside b: its status class's red.
  expect(at(root.left + 120, root.top + 105)).toEqual([255, 255, 255, 255])
  expect(at(root.left + 220, root.top + 105)).toEqual([255, 0, 0, 255])
  // On the wire between them, which runs at y = 100 + 20 * 0.25: some of the wire colour.
  expect(at(root.left + 170, root.top + 105)[3]).toBeGreaterThan(0)
  // Nothing between the nodes above the wire.
  expect(at(root.left + 170, root.top + 101)[3]).toBe(0)
})

test('far out, a theme switch recolours the shapes without anything else happening', async () => {
  const el = container()
  const f = flow(el, { fit: false })
  f.node('a').at(0, 0)
  f.viewport({ x: 100, y: 100, zoom: 0.25 })
  await frame()
  // The fill as the GPU gets it: bytes 16 to 19 of the node's first vertex.
  const fill = () => [...(f as unknown as { view: { sketch: Sketch } }).view.sketch.nodes.bytes.subarray(16, 20)]
  expect(fill()).toEqual([255, 255, 255, 255])
  el.classList.add('bn-dark')
  // Nothing else asks for a frame; the view looks again within half a second. Dark fill: #18181b.
  await new Promise(r => setTimeout(r, 600))
  await frame()
  expect(fill()).toEqual([24, 24, 27, 255])
})

test('without WebGL2, far out nodes keep their elements', async () => {
  const real = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    return type === 'webgl2' ? null : real.call(this, type, ...(rest as []))
  } as typeof real
  onTestFinished(() => void (HTMLCanvasElement.prototype.getContext = real))
  const el = container()
  const f = flow(el, { fit: false })
  f.node('a').at(0, 0)
  f.viewport({ x: 100, y: 100, zoom: 0.25 })
  await frame()
  expect(el.querySelector('[data-node="a"]')).not.toBeNull()
})
