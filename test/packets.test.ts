import { expect, test } from 'vitest'
import { flow } from '../src/index'
import { center, container, drag, frame } from './util'

const FAST = { speed: 4000 }
const SLOW = { speed: 60 }

/** Screen distance from the (single) packet dot's center to the nearest point of a wire. */
function offWire(el: HTMLElement, key: string) {
  const r = el.querySelector('.bn-packet')!.getBoundingClientRect()
  const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2]
  const path = el.querySelector<SVGPathElement>(`[data-wire="${key}"] .bn-wire`)!
  const m = path.getScreenCTM()!
  let best = Infinity
  for (let l = 0; l <= path.getTotalLength(); l += 0.5) {
    const p = path.getPointAtLength(l).matrixTransform(m)
    best = Math.min(best, Math.hypot(p.x - cx, p.y - cy))
  }
  return best
}

/** Edit-mode flow with nodes laid out in a row at 300px steps, wired `from -> to` as given. */
async function graph(ids: string[], wires: [string, string][]) {
  const el = container()
  const f = flow(el).mode('edit')
  ids.forEach((id, i) => f.node(id).title(id.toUpperCase()).at(i * 300, (i % 2) * 120))
  for (const [a, b] of wires) f.connect(a, b)
  await frame()
  return { el, f }
}

test('a packet sent to a neighbour arrives there', async () => {
  const { f } = await graph(['a', 'b'], [['a', 'b']])
  expect(await f.send('a', 'b', FAST)).toEqual(['b'])
})

test('a packet in flight rides on its wire', async () => {
  const { el, f } = await graph(['a', 'b'], [['a', 'b']])
  void f.send('a', 'b', SLOW)
  for (let i = 0; i < 5; i++) await frame()
  expect(offWire(el, 'a>b')).toBeLessThan(1.5)
})

test('a packet travels over several hops to its target', async () => {
  const { f } = await graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']])
  expect(await f.send('a', 'c', FAST)).toEqual(['c'])
})

test('a packet with no route to its target reports that nothing arrived', async () => {
  const { el, f } = await graph(['a', 'b', 'c'], [['a', 'b'], ['c', 'b']])
  expect(await f.send('a', 'c', FAST)).toEqual([])
  expect(el.querySelector('.bn-packet')).toBeNull()
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
  expect(offWire(el, 'a>b')).toBeLessThan(1.5)
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
  const { el, f } = await graph(['a', 'b'], [['a', 'b']])
  const arrived = f.send('a', 'b', { speed: 300 })
  await frame()
  await frame()
  f.disconnect('a', 'b')
  expect(await arrived).toEqual([])
  await new Promise(r => setTimeout(r, 300))
  expect(el.querySelector('.bn-packet')).toBeNull()
})

test('deleting the target node mid-flight drops the packet', async () => {
  const { f } = await graph(['a', 'b'], [['a', 'b']])
  const arrived = f.send('a', 'b', { speed: 300 })
  await frame()
  await frame()
  f.remove('b')
  expect(await arrived).toEqual([])
})

test('a packet carries the class it was sent with', async () => {
  const { el, f } = await graph(['a', 'b'], [['a', 'b']])
  void f.send('a', 'b', { ...SLOW, class: 'error' })
  await frame()
  expect(el.querySelector('.bn-packet.error')).not.toBeNull()
})

test('a faster packet arrives before a slower one on the same wire', async () => {
  const { f } = await graph(['a', 'b'], [['a', 'b']])
  const slow = f.send('a', 'b', { speed: 300 }).then(() => 'slow')
  const fast = f.send('a', 'b', { speed: 1500 }).then(() => 'fast')
  expect(await Promise.race([slow, fast])).toBe('fast')
})

test('destroy() settles packets still in flight', async () => {
  const { f } = await graph(['a', 'b'], [['a', 'b']])
  const arrived = f.send('a', 'b', SLOW)
  await frame()
  f.destroy()
  expect(await arrived).toEqual([])
})

/** Visible packet dots that are not on any wire (more than 1.5px away). */
function strays(el: HTMLElement) {
  const wires = [...el.querySelectorAll<SVGPathElement>('[data-wire] .bn-wire')]
  return [...el.querySelectorAll('.bn-packet')].filter(dot => {
    if (getComputedStyle(dot).visibility === 'hidden') return false
    const r = dot.getBoundingClientRect()
    const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2]
    return !wires.some(path => {
      const m = path.getScreenCTM()!
      for (let l = 0; l <= path.getTotalLength(); l += 0.5) {
        const p = path.getPointAtLength(l).matrixTransform(m)
        if (Math.hypot(p.x - cx, p.y - cy) < 1.5) return true
      }
      return false
    })
  }).length
}

test('a packet never shows up away from a wire, not even for a frame', async () => {
  const { el, f } = await graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']])
  let done = false
  void f.send('a', 'c', { speed: 900 }).then(() => (done = true))
  const seen = [strays(el)] // right after sending, before any frame
  while (!done) {
    await frame()
    seen.push(strays(el)) // includes the frame where the packet switches from a -> b to b -> c
  }
  expect(Math.max(...seen)).toBe(0)
})
