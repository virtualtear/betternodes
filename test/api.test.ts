import { expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import { flow, type State } from '../src/index'
import { center, container, drag, frame } from './util'

test('renders nodes in view mode by default', async () => {
  const el = container()
  flow(el).node('a').title('Webhook')
  await expect.element(page.getByText('Webhook')).toBeVisible()
  expect(el.dataset.mode).toBe('view')
})

test('connect wires two node anchors together', () => {
  const f = flow(container())
  f.node('a')
  f.node('b')
  f.connect('a.e', 'b.w')
  expect(f.state().edges).toEqual([['a.e', 'b.w']])
})

test.each([
  ['unknown anchor', 'a.x', 'b.w'],
  ['unknown node', 'x.e', 'b.w'],
  ['unknown bare node', 'x', 'b'],
  ['same node', 'a.e', 'a.w'],
])('connect throws for %s', (_, from, to) => {
  const f = flow(container())
  f.node('a')
  f.node('b')
  expect(() => f.connect(from, to)).toThrow()
})

test('connect accepts bare node ids for floating wire ends', () => {
  const f = flow(container())
  f.node('a')
  f.node('b')
  f.connect('a', 'b').connect('a.s', 'b')
  expect(f.state().edges).toEqual([['a', 'b'], ['a.s', 'b']])
})

test('connect throws for a duplicate wire', () => {
  const f = flow(container())
  f.node('a')
  f.node('b')
  f.connect('a.e', 'b.w')
  expect(() => f.connect('a.e', 'b.w')).toThrow()
})

test('disconnect removes a wire', () => {
  const f = flow(container())
  f.node('a')
  f.node('b')
  f.connect('a.e', 'b.w').connect('a.s', 'b.n')
  f.disconnect('a.e', 'b.w')
  expect(f.state().edges).toEqual([['a.s', 'b.n']])
})

test('disconnect throws for a wire that does not exist', () => {
  const f = flow(container())
  f.node('a')
  f.node('b')
  f.connect('a.e', 'b.w')
  expect(() => f.disconnect('b.w', 'a.e')).toThrow()
})

test('remove() deletes a node with its wires and records it in state', async () => {
  const el = container()
  const f = flow(el)
  f.node('a').at(0, 0)
  f.node('b').at(300, 0)
  f.node('c').at(600, 0)
  f.connect('a', 'b').connect('b', 'c').connect('a', 'c')
  await frame()
  f.remove('b')
  await frame()
  expect(f.state()).toEqual({ positions: { a: [0, 0], c: [600, 0] }, edges: [['a', 'c']], removed: ['b'] })
  expect([el.querySelector('[data-node="b"]'), el.querySelector('[data-wire="a>b"]')]).toEqual([null, null])
})

test('load() hides nodes listed as removed and brings back the rest', async () => {
  const el = container()
  const f = flow(el)
  f.node('a')
  f.node('b')
  f.load({ positions: {}, edges: [], removed: ['b'] })
  await frame()
  expect(el.querySelector('[data-node="b"]')).toBeNull()
  f.load({ positions: {}, edges: [] })
  await frame()
  expect(el.querySelector('[data-node="b"]')).not.toBeNull()
})

test('node() for a deleted node does not bring it back', async () => {
  const el = container()
  const f = flow(el)
  f.node('a')
  f.node('b')
  f.remove('a')
  f.node('a').title('Updated while deleted')
  await frame()
  expect([el.querySelector('[data-node="a"]'), f.state().removed]).toEqual([null, ['a']])
})

test('remove() throws for an unknown node', () => {
  expect(() => flow(container()).remove('x')).toThrow()
})

test('node ids must not contain "." or ">", which separate anchors and wire ends', () => {
  expect(() => flow(container()).node('a.b')).toThrow()
  // Otherwise the wires a -> b>c and a>b -> c would share the key "a>b>c".
  expect(() => flow(container()).node('a>b')).toThrow()
})

test('at() sets the position reported in state', () => {
  const f = flow(container())
  f.node('a').at(120, -40)
  expect(f.state().positions).toEqual({ a: [120, -40] })
})

function twoNodes() {
  const f = flow(container())
  f.node('a')
  f.node('b')
  f.connect('a.e', 'b.w')
  return f
}

test('load() replaces positions and wires with saved ones', () => {
  const f = twoNodes()
  f.load({ positions: { a: [10, 20], b: [300, 40] }, edges: [['a.s', 'b.n']] })
  expect(f.state()).toEqual({ positions: { a: [10, 20], b: [300, 40] }, edges: [['a.s', 'b.n']] })
})

test('node() rejects the id __proto__, which state().positions could not hold', () => {
  expect(() => flow(container()).node('__proto__')).toThrow(/reserved/)
})

test('load() drops wires to anchors or nodes that no longer exist, with a warning', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const f = twoNodes()
  f.load({ positions: { gone: [1, 2] }, edges: [['a.s', 'b.n'], ['a.out', 'b.in'], ['gone.e', 'b.w']] })
  expect(f.state()).toEqual({ positions: { a: [0, 0], b: [0, 0] }, edges: [['a.s', 'b.n']] })
  expect(warn).toHaveBeenCalledTimes(2)
})

test('load() with nothing saved keeps the code-defined graph', () => {
  const f = twoNodes()
  f.load(null)
  expect(f.state().edges).toEqual([['a.e', 'b.w']])
})

test('load() drops positions that are not finite or too far out, with a warning, and keeps rendering', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const f = flow(container())
  for (const [i, id] of ['a', 'b', 'c', 'd', 'e'].entries()) f.node(id).at(i * 300, 0)
  // As parsed from storage: JSON turns 1e309 into Infinity.
  f.load(JSON.parse('{"positions":{"a":[1e309,0],"b":[3e18,0],"c":[0,"x"],"d":[1,2,3],"e":[40,200]},"edges":[]}'))
  f.load({ positions: { a: [NaN, 0] }, edges: [] })
  expect(f.state().positions).toEqual({ a: [0, 0], b: [300, 0], c: [600, 0], d: [900, 0], e: [40, 200] })
  expect(warn.mock.calls).toEqual([['betternodes: dropped saved positions: 4 malformed'], ['betternodes: dropped saved positions: 1 malformed']])
  // Without the check, such numbers make the spatial lookups of the next frame loop forever.
  await frame()
})

test('load() keeps the valid rest of a malformed saved state instead of stopping halfway', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const f = twoNodes()
  f.load(JSON.parse('{"positions":{"a":[10,20]},"edges":[["a.s","b.n"],["a.e"],[1,2],"x"],"removed":[3]}'))
  expect(f.state()).toEqual({ positions: { a: [10, 20], b: [0, 0] }, edges: [['a.s', 'b.n']] })
  expect(warn.mock.calls).toEqual([['betternodes: dropped saved removed ids: 1 malformed'], ['betternodes: dropped saved wires: 3 malformed']])
})

test('load() ignores a saved state of the wrong shape and keeps every wire', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const f = twoNodes()
  for (const bad of ['x', [], { positions: [], edges: [] }, { positions: {}, edges: {} }, { positions: {}, edges: [], removed: 'b' }]) {
    f.load(bad as unknown as State)
  }
  expect(f.state()).toEqual({ positions: { a: [0, 0], b: [0, 0] }, edges: [['a.e', 'b.w']] })
  expect(warn).toHaveBeenCalledTimes(5)
})

test('at(), viewport() and zoomBy() reject numbers that are not finite or too far out', () => {
  const f = flow(container())
  expect(() => f.node('a').at(Infinity, 0)).toThrow()
  expect(() => f.node('a').at(0, 1e10)).toThrow()
  expect(() => f.viewport({ x: NaN })).toThrow()
  expect(() => f.viewport({ zoom: 0 })).toThrow()
  expect(() => f.zoomBy(-1)).toThrow()
  expect(f.state().positions).toEqual({ a: [0, 0] })
})

test('class() sets status classes on a node, replacing earlier ones', async () => {
  const el = container()
  const node = flow(el).node('a').class('error')
  await frame()
  const div = el.querySelector('[data-node="a"]')!
  expect(div.classList.contains('error')).toBe(true)
  node.class('ok')
  await frame()
  expect([div.classList.contains('error'), div.classList.contains('ok')]).toEqual([false, true])
})

function unplaced() {
  const el = container()
  const f = flow(el)
  for (const id of ['a', 'b', 'c', 'd']) f.node(id).title(id.toUpperCase())
  f.connect('a', 'b').connect('b', 'c').connect('a', 'd')
  return { el, f }
}

test('nodes without at() are laid out in columns following the wires', async () => {
  const { f } = unplaced()
  await frame()
  const { a, b, c, d } = f.state().positions
  expect(a[0] < b[0] && b[0] === d[0] && d[0] < c[0] && b[1] !== d[1]).toBe(true)
})

test('auto-laid-out nodes do not overlap', async () => {
  const { el } = unplaced()
  await frame()
  const rects = [...el.querySelectorAll('[data-node]')].map(n => n.getBoundingClientRect())
  const overlaps = rects.some((r, i) => rects.slice(i + 1).some(q =>
    r.left < q.right && q.left < r.right && r.top < q.bottom && q.top < r.bottom))
  expect(overlaps).toBe(false)
})

test('auto-laid-out nodes stay put when wires change later', async () => {
  const f = flow(container())
  for (const id of ['a', 'b', 'c']) f.node(id)
  f.connect('a', 'b').connect('a', 'c')
  await frame()
  const before = f.state().positions
  f.connect('b', 'c') // c now depends on b, which would put it one column further right
  await frame()
  expect(f.state().positions).toEqual(before)
})

test('a node added after the first layout goes right of the existing graph', async () => {
  const { el, f } = unplaced()
  await frame()
  const before = f.state().positions
  f.node('e').title('E')
  f.connect('c', 'e')
  await frame()
  const { e, ...rest } = f.state().positions
  const right = Math.max(...[...el.querySelectorAll('[data-node]:not([data-node="e"])')].map(n => n.getBoundingClientRect().right))
  expect([rest, el.querySelector('[data-node="e"]')!.getBoundingClientRect().left > right]).toEqual([before, true])
})

function overlapping(el: HTMLElement) {
  const rects = [...el.querySelectorAll('[data-node]')].map(n => n.getBoundingClientRect())
  return rects.some((r, i) => rects.slice(i + 1).some(q =>
    r.left < q.right && q.left < r.right && r.top < q.bottom && q.top < r.bottom))
}

test('layout() re-arranges nodes whose content grew into a neighbour', async () => {
  const el = container()
  const f = flow(el)
  const content = document.createElement('div')
  f.node('a')
  f.node('b').content(content)
  f.node('c')
  f.connect('a', 'b').connect('a', 'c') // b and c share a column, b above c
  await frame()
  content.style.height = '300px'
  await frame()
  expect(overlapping(el)).toBe(true)
  f.layout()
  expect(overlapping(el)).toBe(false)
})

test('layout() re-arranges every node and updates state() right away', () => {
  const f = flow(container())
  f.node('a').at(900, 900)
  f.node('b').at(0, 0)
  f.connect('a', 'b')
  f.layout()
  const { a, b } = f.state().positions
  expect(a[0] < b[0]).toBe(true) // a feeds b, so a gets the left column
})

test('auto-layout leaves positions from at() and load() alone', async () => {
  const { f } = unplaced()
  f.node('a').at(500, 500)
  f.load({ positions: { b: [700, 40] }, edges: [] })
  await frame()
  const { a, b } = f.state().positions
  expect([a, b]).toEqual([[500, 500], [700, 40]])
})

function inside(el: Element, box: DOMRect) {
  const r = el.getBoundingClientRect()
  return r.left >= box.left && r.top >= box.top && r.right <= box.right && r.bottom <= box.bottom
}

test('the first render fits the whole graph into view', async () => {
  const el = container()
  const f = flow(el)
  f.node('a').at(0, 0)
  f.node('b').at(2000, 1500)
  await frame()
  const box = el.getBoundingClientRect()
  expect([...el.querySelectorAll('[data-node]')].every(n => inside(n, box))).toBe(true)
})

test('fitting never enlarges a small graph and centers it', async () => {
  const el = container()
  flow(el).node('a').at(500, 500)
  await frame()
  const node = el.querySelector('[data-node="a"]')!
  const { x, y } = center(node)
  expect([node.getBoundingClientRect().width, Math.round(x), Math.round(y)]).toEqual([160, 400, 300])
})

test('fit() brings the graph back into view after panning away', async () => {
  const el = container()
  const f = flow(el)
  f.node('a').at(0, 0)
  await frame()
  await drag({ x: 700, y: 500 }, { x: 0, y: 0 })
  await drag({ x: 700, y: 500 }, { x: 0, y: 0 })
  // Panned that far, the node has no element at all.
  expect(el.querySelector('[data-node="a"]')).toBeNull()
  f.fit()
  await frame()
  expect(inside(el.querySelector('[data-node="a"]')!, el.getBoundingClientRect())).toBe(true)
})

test('undo() and redo() with no history do nothing', () => {
  const f = twoNodes()
  const changes = vi.fn()
  // Listeners get only the diff; the state is read the way an app would.
  f.on('change', diff => changes(f.state(), diff))
  f.undo().redo()
  expect([f.state().edges, changes.mock.calls.length]).toEqual([[['a.e', 'b.w']], 0])
})

test('nodes placed on top of each other by code are pulled apart; the earlier one stays', async () => {
  const el = container()
  const f = flow(el)
  f.node('a').at(100, 100)
  f.node('b').at(120, 110) // overlaps a
  await frame()
  expect(f.state().positions.a).toEqual([100, 100])
  expect(overlapping(el)).toBe(false)
})

test('overlapping positions from load() are pulled apart', async () => {
  const el = container()
  const f = flow(el)
  f.node('a')
  f.node('b')
  f.load({ positions: { a: [0, 0], b: [40, 0] }, edges: [] })
  await frame()
  expect(overlapping(el)).toBe(false)
})

test('a node whose content grows pushes the later node it now overlaps out of the way', async () => {
  const el = container()
  const f = flow(el)
  const content = document.createElement('div')
  f.node('a').content(content).at(0, 0)
  f.node('b').at(0, 100)
  await frame()
  content.style.height = '200px' // a now reaches down over b
  await frame()
  await frame()
  expect([f.state().positions.a, overlapping(el)]).toEqual([[0, 0], false])
})

test('updating a node from code keeps focus inside its custom content', async () => {
  const el = container()
  const f = flow(el)
  const input = document.createElement('input')
  f.node('a').content(input)
  await frame()
  input.focus()
  f.node('a').class('running') // e.g. a host showing a status while the user types
  await frame()
  expect(document.activeElement).toBe(input)
})

test('changing a node\'s title from code keeps focus inside its custom content', async () => {
  const el = container()
  const f = flow(el)
  const input = document.createElement('input')
  f.node('a').content(input)
  await frame()
  input.focus()
  f.node('a').title('Running') // e.g. a live status while the user types
  await frame()
  expect(document.activeElement).toBe(input)
  expect(el.querySelector('[data-node="a"] .bn-title')!.textContent).toBe('Running')
})

test('content() swaps the custom content', async () => {
  const el = container()
  const f = flow(el)
  const [one, two] = [document.createElement('p'), document.createElement('p')]
  f.node('a').content(one)
  await frame()
  f.node('a').content(two)
  await frame()
  expect([one.isConnected, two.parentElement?.dataset.node]).toEqual([false, 'a'])
})

test('mode() switches between edit and view', () => {
  const el = container()
  const f = flow(el).mode('edit')
  expect(el.dataset.mode).toBe('edit')
  f.mode('view')
  expect(el.dataset.mode).toBe('view')
})

test('destroy() leaves the container as it found it and stops listening', async () => {
  const el = container()
  const before = el.outerHTML
  const f = flow(el)
  f.node('a').title('A')
  await frame()
  f.destroy()
  expect(el.outerHTML).toBe(before)
  const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true })
  el.dispatchEvent(wheel)
  expect(wheel.defaultPrevented).toBe(false)
})

test('layout() and send() after destroy() change nothing, and the send settles', async () => {
  const el = container()
  const before = el.outerHTML
  const f = flow(el)
  f.node('a')
  f.node('b')
  f.connect('a', 'b')
  await frame()
  f.destroy()
  const saved = f.state()
  f.layout()
  await expect(f.send('a', 'b')).resolves.toEqual([])
  await frame()
  expect([el.outerHTML, f.state()]).toEqual([before, saved])
})

test('select() replaces the selection and fires select', async () => {
  const el = container()
  const f = flow(el)
  f.node('a')
  f.node('b')
  const selects = vi.fn()
  f.on('select', selects)
  f.select('a', 'b')
  expect(selects).toHaveBeenCalledExactlyOnceWith({ nodes: ['a', 'b'] })
  expect(f.selection()).toEqual({ nodes: ['a', 'b'] })
})

test('select() throws for an unknown node', () => {
  const f = flow(container())
  expect(() => f.select('x')).toThrow('no node "x"')
})

test('remove() of a selected node fires select without it', () => {
  const f = flow(container())
  f.node('a')
  f.node('b')
  f.select('a', 'b')
  const selects = vi.fn()
  f.on('select', selects)
  f.remove('a')
  expect(selects).toHaveBeenCalledExactlyOnceWith({ nodes: ['b'] })
})
