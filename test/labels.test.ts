import { expect, test } from 'vitest'
import { Buckets } from '../src/geometry/buckets'
import type { Point, Rect } from '../src/geometry/rect'
import { flow } from '../src/index'
import { Graph } from '../src/model/graph'
import { svg } from '../src/view/dom'
import { notePoint, Wires } from '../src/view/wires'
import { center, click, container, drag, frame, press, wirePoint } from './util'

/** A at 20,20 and B at 320,140, with a noted wire from `a.e` to `b.w`, mounted and rendered. */
async function setup(label = 'yes') {
  const el = container()
  const f = flow(el).mode('edit')
  f.node('a').title('A').at(20, 20)
  f.node('b').title('B').at(320, 140)
  f.connect('a.e', 'b.w', { label })
  await frame()
  const note = () => el.querySelector<SVGTextElement>('.bn-label[data-wire="a.e>b.w"]')
  return { el, f, note }
}

/** Screen distance from a note's center to the nearest point of its wire's drawn path. */
function offWire(el: HTMLElement, note: Element) {
  const path = el.querySelector<SVGPathElement>(`[data-wire="${note.getAttribute('data-wire')}"] .bn-wire`)!
  const [c, m] = [center(note), path.getScreenCTM()!]
  let best = Infinity
  for (let l = 0; l <= path.getTotalLength(); l++) {
    const p = path.getPointAtLength(l).matrixTransform(m)
    best = Math.min(best, Math.hypot(p.x - c.x, p.y - c.y))
  }
  return best
}

test('connect() with a label shows it as plain text on the wire', async () => {
  const { el, note } = await setup('<b>ok</b>')
  expect(note()!.textContent).toBe('<b>ok</b>')
  expect(el.querySelector('[data-wire] b')).toBeNull()
  expect(offWire(el, note()!)).toBeLessThan(1)
})

test('notes on wires that fan out of one anchor sit apart, each on its own branch', async () => {
  // The demo's IF node: both wires leave through if.e and share their first stretch.
  const el = container()
  const f = flow(el)
  f.node('if').title('IF').at(20, 100)
  f.node('mail').title('Send mail').at(320, 20)
  f.node('log').title('Log').at(320, 180)
  f.connect('if', 'mail', { label: 'true' }).connect('if', 'log', { label: 'false' })
  await frame()
  const [yes, no] = ['if>mail', 'if>log'].map(key => el.querySelector(`.bn-label[data-wire="${key}"]`)!)
  const [a, b] = [yes.getBoundingClientRect(), no.getBoundingClientRect()]
  expect(a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left).toBe(true)
  expect(offWire(el, yes)).toBeLessThan(1)
  expect(offWire(el, no)).toBeLessThan(1)
})

test('label() changes or removes a wire\'s note, and throws for a missing wire', async () => {
  const { f, note } = await setup()
  f.label('a.e', 'b.w', 'no')
  await frame()
  expect(note()!.textContent).toBe('no')
  f.label('a.e', 'b.w')
  await frame()
  expect(note()).toBeNull()
  expect(() => f.label('b.w', 'a.e', 'x')).toThrow()
  expect(f.state().edges).toEqual([['a.e', 'b.w']]) // notes stay out of the saved state
})

test('a note follows its wire when a node moves', async () => {
  const { el, note } = await setup()
  const title = el.querySelector('[data-node="b"] .bn-title')!
  const { x, y } = center(title)
  await drag(title, { x: x + 100, y: y + 120 })
  await frame()
  expect(offWire(el, note()!)).toBeLessThan(1)
})

test('a deleted wire gets its note back with undo', async () => {
  const { el, f, note } = await setup()
  await click(note()!) // clicking the note selects its wire
  press(el, 'Delete')
  await frame()
  expect(f.state().edges).toEqual([])
  f.undo()
  await frame()
  expect(note()!.textContent).toBe('yes')
})

test('a note moves along when the user drags one of its wire\'s ends elsewhere', async () => {
  const { el, f } = await setup()
  await drag(wirePoint(el, 'a.e>b.w', 'to'), el.querySelector('[data-anchor="b.n"]')!)
  expect(f.state().edges).toEqual([['a.e', 'b.n']])
  expect(el.querySelector('.bn-label[data-wire="a.e>b.n"]')?.textContent).toBe('yes')
  f.undo()
  await frame()
  expect(el.querySelector('.bn-label[data-wire="a.e>b.w"]')?.textContent).toBe('yes')
})

test('wire classes go on the wire and its note, and replace earlier ones', async () => {
  const el = container()
  const f = flow(el).mode('edit')
  f.node('a').at(20, 20)
  f.node('b').at(320, 140)
  f.connect('a.e', 'b.w', { label: 'yes', class: 'error' })
  await frame()
  const g = el.querySelector('g[data-wire="a.e>b.w"]')!
  const note = el.querySelector('.bn-label[data-wire="a.e>b.w"]')!
  expect([g.classList.contains('error'), note.classList.contains('error')]).toEqual([true, true])
  await click(note) // selected: the wire classes must not wipe bn-selected, nor the other way round
  f.wireClass('a.e', 'b.w', 'ok', 'slow')
  await frame()
  expect([...g.classList].toSorted()).toEqual(['bn-selected', 'ok', 'slow'])
  f.wireClass('a.e', 'b.w')
  await frame()
  expect([...g.classList]).toEqual(['bn-selected'])
  expect(() => f.wireClass('a.e', 'b.n', 'x')).toThrow(/no wire/)
})

test('wire classes move with a dragged wire end and come back with undo', async () => {
  const { el, f } = await setup()
  f.wireClass('a.e', 'b.w', 'error')
  await frame()
  await drag(wirePoint(el, 'a.e>b.w', 'to'), el.querySelector('[data-anchor="b.n"]')!)
  expect(el.querySelector('g[data-wire="a.e>b.n"]')!.classList.contains('error')).toBe(true)
  f.undo()
  await frame()
  expect(el.querySelector('g[data-wire="a.e>b.w"]')!.classList.contains('error')).toBe(true)
})

test('bn-two-way and bn-no-arrow change the arrowheads', async () => {
  const { el, f } = await setup()
  const path = el.querySelector('[data-wire="a.e>b.w"] .bn-wire')!
  expect(getComputedStyle(path).markerStart).toBe('none')
  f.wireClass('a.e', 'b.w', 'bn-two-way')
  await frame()
  expect(getComputedStyle(path).markerStart).toContain('bn-arrow')
  el.classList.add('bn-no-arrow') // on the root it covers every wire
  expect([getComputedStyle(path).markerStart, getComputedStyle(path).markerEnd]).toEqual(['none', 'none'])
})

test('a note takes the longest inner stretch of its wire where it covers no node', () => {
  const points: [number, number][] = [[0, 0], [0, 20], [100, 20], [100, 300], [200, 300], [200, 320]]
  expect(notePoint(points, () => true)).toEqual([100, 160])
  // The longest is taken: the next longest goes, the first of equals winning.
  expect(notePoint(points, ([x, y]) => x !== 100 || y !== 160)).toEqual([50, 20])
  // Nowhere clear: back to the longest.
  expect(notePoint(points, () => false)).toEqual([100, 160])
})

test('wire classes must be single class names, so a bad one throws at the call instead of in every frame', async () => {
  const { el, f } = await setup()
  expect(() => f.wireClass('a.e', 'b.w', 'a b')).toThrow(/class/)
  expect(() => f.wireClass('a.e', 'b.w', '')).toThrow(/class/)
  f.node('c')
  expect(() => f.connect('b.e', 'c.w', { class: 'x y' })).toThrow(/class/)
  expect(f.state().edges).toEqual([['a.e', 'b.w']])
  f.wireClass('a.e', 'b.w', 'error')
  await frame()
  expect(el.querySelector('[data-wire="a.e>b.w"]')!.classList.contains('error')).toBe(true)
})

test('a node coming near a note moves it, even when the wire keeps its route', () => {
  const graph = new Graph()
  for (const id of ['a', 'b']) graph.add(id)
  graph.connect('a', 'b')
  graph.label('a', 'b', 'a long label text')
  const rects = new Map<string, Rect>([['a', [-100, -10, 100, 20]], ['b', [110, 140, 100, 20]]])
  const index = new Buckets<string>()
  for (const [id, r] of rects) index.add(r, id)
  // Its longest inner segment is the vertical one at x 100, just inside the wire's right edge.
  const points: Point[] = [[0, 0], [10, 0], [10, -50], [100, -50], [100, 150], [110, 150]]
  const layer = svg('g')
  const wires = new Wires(graph, layer, rects, index, () => points)
  const spot = () => ['x', 'y'].map(name => Number(layer.querySelector('.bn-label')!.getAttribute(name)))
  wires.render(new Map([['a', undefined], ['b', undefined]]))
  expect(spot()).toEqual([100, 50])
  // Too far from the wire to re-route it, but on the note's right half.
  graph.add('c')
  rects.set('c', [125, 40, 30, 20])
  index.add(rects.get('c')!, 'c')
  wires.render(new Map([['c', undefined]]))
  expect(spot()).toEqual([55, -50])
})
