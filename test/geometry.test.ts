import { expect, test } from 'vitest'
import { flow } from '../src/index'
import { center, container, drag, frame, pointer, wirePoint } from './util'

type Point = { x: number; y: number }

/** Screen-space start and end points of a rendered wire path. */
function ends(path: SVGPathElement) {
  const m = path.getScreenCTM()!
  const at = (len: number) => path.getPointAtLength(len).matrixTransform(m)
  return [at(0), at(path.getTotalLength())]
}

/** Where an anchor ref like `b.nw` should sit: on the node's border, by compass direction. */
function borderPoint(el: HTMLElement, ref: string): Point {
  const [id, dir] = ref.split('.')
  const r = el.querySelector(`[data-node="${id}"]`)!.getBoundingClientRect()
  const fx = dir.includes('w') ? 0 : dir.includes('e') ? 1 : 0.5
  const fy = dir.includes('n') ? 0 : dir.includes('s') ? 1 : 0.5
  return { x: r.left + fx * r.width, y: r.top + fy * r.height }
}

function expectNear(p: Point, q: Point) {
  expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(1)
}

function expectWireOnAnchors(el: HTMLElement, from: string, to: string) {
  const [start, end] = ends(el.querySelector(`[data-wire="${from}>${to}"] .bn-wire`)!)
  expectNear(start, borderPoint(el, from))
  expectNear(end, borderPoint(el, to))
}

/** Screen points every 4px along a wire. */
function samples(el: HTMLElement, key: string) {
  const path = el.querySelector<SVGPathElement>(`[data-wire="${key}"] .bn-wire`)!
  const m = path.getScreenCTM()!
  const out: Point[] = []
  for (let l = 0; l <= path.getTotalLength(); l += 4) out.push(path.getPointAtLength(l).matrixTransform(m))
  return out
}

/** Whether any point of the wire lies inside node `id` (1px inset, so touching its border is fine). */
function crosses(el: HTMLElement, key: string, id: string) {
  const r = el.querySelector(`[data-node="${id}"]`)!.getBoundingClientRect()
  return samples(el, key).some(p => p.x > r.left + 1 && p.x < r.right - 1 && p.y > r.top + 1 && p.y < r.bottom - 1)
}

/** A, B, C in a row; B is tall, so it blocks the straight line from A to C. */
async function row(bAt = -40) {
  const el = container()
  const f = flow(el).mode('edit')
  const tall = document.createElement('div')
  tall.style.height = '60px'
  f.node('a').title('A').at(0, 0)
  f.node('b').title('B').content(tall).at(240, bAt)
  f.node('c').title('C').at(480, 0)
  f.connect('a.e', 'c.w')
  await frame()
  return { el, f }
}

async function setup(from = 'a.e', to = 'b.w') {
  const el = container()
  const f = flow(el).mode('edit')
  f.node('a').title('A').at(20, 20)
  f.node('b').title('B').at(320, 160)
  f.connect(from, to)
  await frame()
  return { el, f }
}

test.each([
  ['a.e', 'b.w'],
  ['a.s', 'b.n'],
  ['a.se', 'b.nw'],
])('wire %s -> %s runs between those border points', async (from, to) => {
  const { el } = await setup(from, to)
  expectWireOnAnchors(el, from, to)
})

test('wires follow a dragged node', async () => {
  const { el } = await setup()
  await drag(el.querySelector('[data-node="b"] .bn-title')!, { x: 200, y: 400 })
  expectWireOnAnchors(el, 'a.e', 'b.w')
})

test('wires stay on anchors after zooming', async () => {
  const { el } = await setup()
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: 100, clientY: 100, bubbles: true, cancelable: true }))
  await frame()
  expectWireOnAnchors(el, 'a.e', 'b.w')
})

test('wires re-anchor when node content changes size', async () => {
  const el = container()
  const f = flow(el)
  const content = document.createElement('div')
  content.style.height = '10px'
  f.node('a').at(20, 20).content(content)
  f.node('b').at(320, 20)
  f.connect('a.s', 'b.w')
  await frame()
  content.style.height = '120px'
  await frame()
  await frame()
  expectWireOnAnchors(el, 'a.s', 'b.w')
})

test('dragging from an anchor previews a wire to the pointer until the drop', async () => {
  const { el } = await setup()
  pointer('pointerdown', el.querySelector('[data-anchor="a.s"]')!)
  pointer('pointermove', { x: 500, y: 450 })
  await frame()
  const preview = el.querySelector<SVGPathElement>('.bn-preview')!
  const [start, end] = ends(preview)
  expectNear(start, borderPoint(el, 'a.s'))
  expectNear(end, { x: 500, y: 450 })
  pointer('pointerup', { x: 500, y: 450 })
  await frame()
  expect(preview).not.toBeVisible()
})

test('grabbing a wire hides it and previews from its fixed end', async () => {
  const { el } = await setup()
  pointer('pointerdown', wirePoint(el, 'a.e>b.w', 'to'))
  pointer('pointermove', { x: 500, y: 450 })
  await frame()
  const [start, end] = ends(el.querySelector('.bn-preview')!)
  expectNear(start, borderPoint(el, 'a.e'))
  expectNear(end, { x: 500, y: 450 })
  expect(el.querySelector('[data-wire="a.e>b.w"]')).not.toBeVisible()
  pointer('pointerup', { x: 500, y: 450 })
})

test('floating wire ends face each other and re-pick their side when a node moves', async () => {
  const { el, f } = await setup()
  f.disconnect('a.e', 'b.w').connect('a', 'b')
  await frame()
  const [start, end] = ends(el.querySelector('[data-wire="a>b"] .bn-wire')!)
  expectNear(start, borderPoint(el, 'a.e'))
  expectNear(end, borderPoint(el, 'b.w'))
  const a = center(el.querySelector('[data-node="a"] .bn-title')!)
  await drag(el.querySelector('[data-node="b"] .bn-title')!, { x: a.x, y: a.y + 200 }) // b now below a
  const [start2, end2] = ends(el.querySelector('[data-wire="a>b"] .bn-wire')!)
  expectNear(start2, borderPoint(el, 'a.s'))
  expectNear(end2, borderPoint(el, 'b.n'))
})

test('wires route around a node that blocks the straight path', async () => {
  const { el } = await row()
  expect(crosses(el, 'a.e>c.w', 'b')).toBe(false)
})

test('the reported case: IF -> Log goes around a tall Send mail node', async () => {
  const el = container()
  const f = flow(el)
  const tall = document.createElement('div')
  tall.style.height = '220px'
  for (const id of ['hook', 'if', 'log']) f.node(id)
  f.node('mail').content(tall)
  f.connect('hook', 'if').connect('if', 'mail').connect('if', 'log')
  await frame()
  f.layout()
  await frame()
  expect(crosses(el, 'if>log', 'mail')).toBe(false)
})

test('wires leave and enter their anchors in a straight line', async () => {
  const { el } = await setup('a.e', 'b.w') // b is right of and below a
  const path = el.querySelector<SVGPathElement>('[data-wire="a.e>b.w"] .bn-wire')!
  const m = path.getScreenCTM()!
  const at = (l: number) => path.getPointAtLength(l).matrixTransform(m)
  const total = path.getTotalLength()
  const [s0, s1, e0, e1] = [at(0), at(10), at(total - 10), at(total)]
  expect([s1.y - s0.y, s1.x - s0.x, e1.y - e0.y, e1.x - e0.x].map(v => Math.round(v * 100) / 100)).toEqual([0, 10, 0, 10])
})

test('dragging a node into a wire re-routes that wire around it', async () => {
  const { el } = await row(220) // b starts well below the a -> c line
  await frame() // settle: the first resize observation re-measures every node once
  const title = el.querySelector('[data-node="b"] .bn-title')!
  const a = center(el.querySelector('[data-node="a"] .bn-title')!)
  const { x } = center(title)
  await drag(title, { x, y: a.y }) // b now sits across the line
  expect(crosses(el, 'a.e>c.w', 'b')).toBe(false)
})

/** Screen x of a wire's vertical run (where consecutive samples only move up or down). */
function verticalX(el: HTMLElement, key: string) {
  const pts = samples(el, key)
  const xs = pts.slice(1).filter((p, i) => Math.abs(p.x - pts[i].x) < 0.01 && Math.abs(p.y - pts[i].y) > 1).map(p => p.x)
  return xs[Math.floor(xs.length / 2)]
}

test('wires sharing a lane are drawn side by side instead of on top of each other', async () => {
  const el = container()
  const f = flow(el)
  f.node('a').at(0, 0)
  f.node('b').at(0, 100)
  f.node('c').at(400, 0)
  f.node('d').at(400, 100)
  f.connect('a.e', 'd.w').connect('b.e', 'c.w') // both cross over in the gap between the columns
  await frame()
  expect(Math.abs(verticalX(el, 'a.e>d.w') - verticalX(el, 'b.e>c.w'))).toBeGreaterThanOrEqual(4)
})

test('wires still route around nodes that sit close together', async () => {
  const el = container()
  const f = flow(el)
  const tall = document.createElement('div')
  tall.style.height = '100px'
  f.node('if').at(0, 100)
  f.node('mail').content(tall).at(240, 0) // 160 wide: its right edge is at x = 400
  f.node('log').at(420, 20) // only 20px right of mail, so wires into log.w squeeze past mail
  f.connect('if.e', 'log.w')
  await frame()
  expect(crosses(el, 'if.e>log.w', 'mail')).toBe(false)
})

test('wires inside a dragged group keep their shape until the drop, then route around nodes again', async () => {
  const { el, f } = await row(220) // b starts well below the a -> c line
  await frame()
  f.select('a', 'c')
  const title = el.querySelector('[data-node="a"] .bn-title')!
  const { x, y } = center(title)
  pointer('pointerdown', title)
  pointer('pointermove', { x, y: y + 260 }) // a and c move down, so their wire runs across b
  await frame()
  expect(crosses(el, 'a.e>c.w', 'b'), 'moved along with the group').toBe(true)
  pointer('pointerup', { x, y: y + 260 })
  await frame()
  expect(crosses(el, 'a.e>c.w', 'b'), 're-routed on drop').toBe(false)
})
