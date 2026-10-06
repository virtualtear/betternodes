import { expect, test } from 'vitest'
import { flow } from '../src/index'
import { center, click, container, drag, frame, press, wirePoint } from './util'

/** A at 20,20 and B at 320,140, wired `a.e` -> `b.w` with a note, mounted and rendered. */
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
