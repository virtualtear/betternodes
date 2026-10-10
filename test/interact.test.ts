import { expect, test, vi } from 'vitest'
import { flow, type Flow } from '../src/index'
import { center, click, container, drag, frame, pointer, press, wirePoint } from './util'

const anchor = (el: HTMLElement, ref: string) => el.querySelector(`[data-anchor="${ref}"]`)!

/** Nodes a at 20,20, b at 320,20 and c at 320,220, mounted and rendered. */
async function setup(mode: 'view' | 'edit') {
  const el = container()
  const f = flow(el).mode(mode)
  f.node('a').title('A').at(20, 20)
  f.node('b').title('B').at(320, 20)
  f.node('c').title('C').at(320, 220)
  const changes = vi.fn()
  // Listeners get only the diff; the state is read the way an app would.
  f.on('change', diff => changes(f.state(), diff))
  await frame()
  return { el, f, changes }
}

test('view mode ignores wire drags', async () => {
  const { el, f, changes } = await setup('view')
  await drag(anchor(el, 'a.e'), anchor(el, 'b.w'))
  expect(f.state().edges).toEqual([])
  expect(changes).not.toHaveBeenCalled()
})

test('edit mode: dragging an anchor onto another node\'s anchor creates a wire', async () => {
  const { el, changes } = await setup('edit')
  await drag(anchor(el, 'a.e'), anchor(el, 'b.w'))
  expect(changes).toHaveBeenCalledExactlyOnceWith({
    positions: { a: [20, 20], b: [320, 20], c: [320, 220] },
    edges: [['a.e', 'b.w']],
  }, expect.anything())
})

test('edit mode: dropping on a node body makes a floating wire end', async () => {
  const { el, changes } = await setup('edit')
  const b = el.querySelector('[data-node="b"]')!.getBoundingClientRect()
  await drag(anchor(el, 'a.e'), { x: b.left + 40, y: b.top + b.height / 2 })
  expect(changes).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ edges: [['a.e', 'b']] }), expect.anything())
})

test('edit mode: grabbing a floating wire near its target end moves that end', async () => {
  const { el, f, changes } = await setup('edit')
  f.connect('a', 'b')
  await frame()
  await drag(wirePoint(el, 'a>b', 'to'), anchor(el, 'c.w'))
  expect(changes).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ edges: [['a', 'c.w']] }), expect.anything())
})

test.each([
  ['an anchor of the same node', (el: HTMLElement) => anchor(el, 'a.w')],
  ['empty space', () => ({ x: 700, y: 500 })],
])('edit mode: dropping a wire on %s does nothing', async (_, target) => {
  const { el, f, changes } = await setup('edit')
  await drag(anchor(el, 'a.e'), target(el))
  expect(f.state().edges).toEqual([])
  expect(changes).not.toHaveBeenCalled()
})

async function wired() {
  const s = await setup('edit')
  s.f.connect('a.e', 'b.w')
  await frame()
  return s
}

test('edit mode: grabbing a wire near its target end moves that end', async () => {
  const { el, changes } = await wired()
  await drag(wirePoint(el, 'a.e>b.w', 'to'), anchor(el, 'c.w'))
  expect(changes).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ edges: [['a.e', 'c.w']] }), expect.anything())
})

test('edit mode: grabbing a wire near its source end moves that end', async () => {
  const { el, changes } = await wired()
  await drag(wirePoint(el, 'a.e>b.w', 'from'), anchor(el, 'c.e'))
  expect(changes).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ edges: [['c.e', 'b.w']] }), expect.anything())
})

test('edit mode: dropping a grabbed wire on empty space puts it back', async () => {
  const { el, f, changes } = await wired()
  await drag(wirePoint(el, 'a.e>b.w', 'to'), { x: 700, y: 500 })
  expect(f.state().edges).toEqual([['a.e', 'b.w']])
  expect(changes).not.toHaveBeenCalled()
})

test.each(['Delete', 'Backspace'])('edit mode: clicking a wire and pressing %s removes it', async key => {
  const { el, changes } = await wired()
  await click(wirePoint(el, 'a.e>b.w', 'from', 40))
  press(el, key)
  expect(changes).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ edges: [] }), expect.anything())
})

test('edit mode: clicking a wire highlights it', async () => {
  const { el } = await wired()
  const path = el.querySelector('[data-wire="a.e>b.w"] .bn-wire')!
  const before = getComputedStyle(path).stroke
  await click(wirePoint(el, 'a.e>b.w', 'from', 40))
  expect(getComputedStyle(path).stroke).not.toBe(before)
})

test.each([
  ['Escape', (el: HTMLElement) => press(el, 'Escape')],
  ['a click on empty space', () => click({ x: 700, y: 500 })],
  ['switching to view mode and back', (_: HTMLElement, f: Flow) => f.mode('view').mode('edit')],
])('edit mode: %s deselects the wire', async (_, deselect) => {
  const { el, f, changes } = await wired()
  await click(wirePoint(el, 'a.e>b.w', 'from', 40))
  await deselect(el, f)
  press(el, 'Delete')
  expect(f.state().edges).toEqual([['a.e', 'b.w']])
  expect(changes).not.toHaveBeenCalled()
})

test('edit mode: Backspace typed into node content leaves the selected wire alone', async () => {
  const { el, f, changes } = await wired()
  const input = document.createElement('input')
  f.node('c').content(input)
  await click(wirePoint(el, 'a.e>b.w', 'from', 40))
  press(input, 'Backspace') // e.g. focus moved into the input with Tab
  expect(changes).not.toHaveBeenCalled()
})

test('edit mode: a wire stays selected after moving its end', async () => {
  const { el, f } = await wired()
  await drag(wirePoint(el, 'a.e>b.w', 'to'), anchor(el, 'c.w'))
  press(el, 'Delete')
  expect(f.state().edges).toEqual([])
})

test('edit mode: dragging a node moves it, snapped to the 20px grid', async () => {
  const { el, changes } = await setup('edit')
  const title = el.querySelector('[data-node="a"] .bn-title')!
  const { x, y } = center(title)
  await drag(title, { x: x + 103, y: y + 47 })
  expect(changes).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    positions: { a: [120, 60], b: [320, 20], c: [320, 220] },
  }), expect.anything())
})

test.each(['view', 'edit'] as const)('%s mode: dragging the background pans', async mode => {
  const { el } = await setup(mode)
  const node = el.querySelector('[data-node="a"]')!
  const before = node.getBoundingClientRect()
  await drag({ x: 700, y: 500 }, { x: 600, y: 550 })
  const after = node.getBoundingClientRect()
  expect([after.left - before.left, after.top - before.top]).toEqual([-100, 50])
})

test('wheel zooms around the cursor', async () => {
  const { el } = await setup('view')
  const node = el.querySelector('[data-node="a"]')!
  const before = node.getBoundingClientRect()
  const cursor = { x: 300, y: 250 }
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: cursor.x, clientY: cursor.y, bubbles: true, cancelable: true }))
  await frame()
  const after = node.getBoundingClientRect()
  const s = after.width / before.width
  // The point under the cursor stays put, so offsets from the cursor scale by the zoom factor.
  expect(s).toBeGreaterThan(1)
  expect(after.left - cursor.x).toBeCloseTo((before.left - cursor.x) * s, 1)
  expect(after.top - cursor.y).toBeCloseTo((before.top - cursor.y) * s, 1)
})

test.each([
  ['a new wire', async (el: HTMLElement) => {
    await drag(anchor(el, 'a.s'), anchor(el, 'c.n'))
  }, { added: [['a.s', 'c.n']], removed: [], moved: {}, nodesRemoved: [], nodesRestored: [] }],
  ['a moved wire end', async (el: HTMLElement) => {
    await drag(wirePoint(el, 'a.e>b.w', 'to'), anchor(el, 'c.w'))
  }, { added: [['a.e', 'c.w']], removed: [['a.e', 'b.w']], moved: {}, nodesRemoved: [], nodesRestored: [] }],
  ['a removed wire', async (el: HTMLElement) => {
    await click(wirePoint(el, 'a.e>b.w', 'from', 40))
    press(el, 'Delete')
  }, { added: [], removed: [['a.e', 'b.w']], moved: {}, nodesRemoved: [], nodesRestored: [] }],
  ['a moved node', async (el: HTMLElement) => {
    const title = el.querySelector('[data-node="a"] .bn-title')!
    const { x, y } = center(title)
    await drag(title, { x: x + 103, y: y + 47 })
  }, { added: [], removed: [], moved: { a: [120, 60] }, nodesRemoved: [], nodesRestored: [] }],
])('edit mode: change reports what %s did', async (_, edit, diff) => {
  const { el, changes } = await wired()
  await edit(el)
  expect(changes).toHaveBeenCalledExactlyOnceWith(expect.anything(), diff)
})

test('edit mode: Ctrl+Z undoes the last edit and Ctrl+Shift+Z redoes it', async () => {
  const { el, f, changes } = await setup('edit')
  await drag(anchor(el, 'a.e'), anchor(el, 'b.w'))
  press(el, 'z', { ctrlKey: true })
  expect(f.state().edges).toEqual([])
  expect(changes).toHaveBeenLastCalledWith(expect.anything(), { added: [], removed: [['a.e', 'b.w']], moved: {}, nodesRemoved: [], nodesRestored: [] })
  press(el, 'z', { ctrlKey: true, shiftKey: true })
  expect(f.state().edges).toEqual([['a.e', 'b.w']])
})

test('edit mode: undo puts a dragged node back', async () => {
  const { el, f } = await setup('edit')
  const title = el.querySelector('[data-node="a"] .bn-title')!
  const { x, y } = center(title)
  await drag(title, { x: x + 103, y: y + 47 })
  press(el, 'z', { metaKey: true })
  expect(f.state().positions.a).toEqual([20, 20])
})

test('edit mode: a new edit after undo clears the redo history', async () => {
  const { el, f } = await setup('edit')
  await drag(anchor(el, 'a.e'), anchor(el, 'b.w'))
  f.undo()
  await drag(anchor(el, 'a.s'), anchor(el, 'c.n'))
  f.redo()
  expect(f.state().edges).toEqual([['a.s', 'c.n']])
})

test('edit mode: connection points hide when zoomed out below 50%', async () => {
  const el = container()
  const f = flow(el).mode('edit')
  f.node('a').at(0, 0)
  // Still above the zoom where nodes become shapes without elements.
  f.viewport({ zoom: 0.45 })
  await frame()
  expect(anchor(el, 'a.e')).not.toBeVisible()
})

test('edit mode: a new wire does not re-arrange auto-laid-out nodes, so saved positions match the screen', async () => {
  const el = container()
  const f = flow(el).mode('edit')
  for (const id of ['hook', 'if', 'mail', 'log']) f.node(id)
  f.connect('hook', 'if').connect('if', 'mail').connect('if', 'log')
  const changes = vi.fn()
  // Listeners get only the diff; the state is read the way an app would.
  f.on('change', diff => changes(f.state(), diff))
  await frame()
  await drag(anchor(el, 'mail.e'), anchor(el, 'log.e')) // log now depends on mail
  await frame()
  expect(changes.mock.calls[0][0].positions).toEqual(f.state().positions)
})

test('edit mode: clicking a node and pressing Delete removes it with its wires', async () => {
  const { el, changes } = await wired()
  await click(el.querySelector('[data-node="b"] .bn-title')!)
  press(el, 'Delete')
  expect(el.querySelector('[data-node="b"]')).toBeNull()
  expect(changes).toHaveBeenLastCalledWith(expect.anything(),
    expect.objectContaining({ nodesRemoved: ['b'], removed: [['a.e', 'b.w']] }))
})

test('edit mode: undo brings a deleted node back with its wires', async () => {
  const { el, f, changes } = await wired()
  await click(el.querySelector('[data-node="b"] .bn-title')!)
  press(el, 'Delete')
  press(el, 'z', { ctrlKey: true })
  await frame()
  expect([el.querySelector('[data-node="b"]') !== null, f.state().edges]).toEqual([true, [['a.e', 'b.w']]])
  expect(changes).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ nodesRestored: ['b'] }))
})

test('edit mode: a node dropped onto another settles next to it, 20px apart', async () => {
  const { el, f } = await setup('edit')
  const a = el.querySelector('[data-node="a"]')!
  await drag(a.querySelector('.bn-title')!, center(el.querySelector('[data-node="b"] .bn-title')!))
  await frame()
  const [ra, rb] = [a.getBoundingClientRect(), el.querySelector('[data-node="b"]')!.getBoundingClientRect()]
  const gap = Math.max(rb.left - ra.right, ra.left - rb.right, rb.top - ra.bottom, ra.top - rb.bottom)
  expect(gap).toBeGreaterThanOrEqual(19.5)
  expect(f.state().positions.a.map(v => v % 20 === 0)).toEqual([true, true]) // still on the grid
})

test('edit mode: a node dropped onto another settles at the nearest spot a drop would keep', async () => {
  // The demo's case: one grid step leaves 19.3px under the tall node, short of 20 but enough room.
  const el = container()
  const f = flow(el).mode('edit')
  const body = document.createElement('div')
  body.style.height = '66.5px'
  f.node('mail').title('Send mail').content(body).at(320, 20) // ends at y ≈ 120.7
  f.node('log').title('Log').at(320, 160)
  await frame()
  const title = el.querySelector('[data-node="log"] .bn-title')!
  const { x, y } = center(title)
  await drag(title, { x, y: y - 20 })
  expect(f.state().positions.log, 'one step up still fits').toEqual([320, 140])
  await drag(title, { x, y: y - 60 }) // two more steps: now it overlaps mail
  expect(f.state().positions.log, 'back to the closest spot that fit').toEqual([320, 140])
})

test('edit mode: a node dropped closer than half a grid step to another moves one step out', async () => {
  const { el, f } = await setup('edit')
  const title = el.querySelector('[data-node="c"] .bn-title')!
  const { x, y } = center(title)
  await drag(title, { x, y: y - 160 }) // c at y=60 would sit about 6px below b, which ends at y≈54
  expect(f.state().positions.c).toEqual([320, 80])
})

test('edit mode: while dragging, a node may pass over others', async () => {
  const { el } = await setup('edit')
  const title = el.querySelector('[data-node="a"] .bn-title')!
  pointer('pointerdown', title)
  pointer('pointermove', center(el.querySelector('[data-node="b"] .bn-title')!))
  await frame()
  await frame()
  const [ra, rb] = ['a', 'b'].map(id => el.querySelector(`[data-node="${id}"]`)!.getBoundingClientRect())
  expect(ra.left < rb.right && rb.left < ra.right && ra.top < rb.bottom && rb.top < ra.bottom).toBe(true)
  pointer('pointerup', center(el.querySelector('[data-node="b"] .bn-title')!))
})

test('edit mode: a change listener stops once its signal aborts', async () => {
  const { el, f, changes } = await setup('edit')
  const aborted = vi.fn()
  const ac = new AbortController()
  f.on('change', aborted, { signal: ac.signal })
  ac.abort()
  const title = el.querySelector('[data-node="a"] .bn-title')!
  const { x, y } = center(title)
  await drag(title, { x: x + 100, y: y + 100 })
  expect(changes).toHaveBeenCalledOnce()
  expect(aborted).not.toHaveBeenCalled()
})

test('edit mode: destroy() during a drag ends it without an edit', async () => {
  const { el, f, changes } = await setup('edit')
  const title = el.querySelector('[data-node="a"] .bn-title')!
  const { x, y } = center(title)
  pointer('pointerdown', title)
  f.destroy()
  pointer('pointermove', { x: x + 100, y: y + 100 })
  pointer('pointerup', { x: x + 100, y: y + 100 })
  await frame()
  expect(changes).not.toHaveBeenCalled()
})

const title = (el: HTMLElement, id: string) => el.querySelector(`[data-node="${id}"] .bn-title`)!

/** setup() plus a `select` listener. */
async function watched(mode: 'view' | 'edit') {
  const s = await setup(mode)
  const selects = vi.fn()
  s.f.on('select', selects)
  return { ...s, selects }
}

test('edit mode: clicking a node fires select once, even when clicked again', async () => {
  const { el, selects } = await watched('edit')
  await click(title(el, 'a'))
  await click(title(el, 'a'))
  expect(selects).toHaveBeenCalledExactlyOnceWith({ nodes: ['a'] })
})

test('edit mode: clicking a wire fires select with that wire, Escape clears it', async () => {
  const { el, f, selects } = await watched('edit')
  f.connect('a.e', 'b.w')
  await frame()
  await click(wirePoint(el, 'a.e>b.w', 'from', 40))
  expect(selects).toHaveBeenLastCalledWith({ nodes: [], wire: ['a.e', 'b.w'] })
  press(el, 'Escape')
  expect(selects).toHaveBeenLastCalledWith({ nodes: [] })
})

test('view mode: clicking a node selects and highlights it', async () => {
  const { el, selects } = await watched('view')
  await click(title(el, 'a'))
  expect(selects).toHaveBeenCalledExactlyOnceWith({ nodes: ['a'] })
  expect(el.querySelector('[data-node="a"]')).toHaveClass('bn-selected')
})

test('view mode: dragging on a node pans without selecting it', async () => {
  const { el, selects } = await watched('view')
  const { x, y } = center(title(el, 'a'))
  await drag(title(el, 'a'), { x: x + 100, y })
  expect(selects).not.toHaveBeenCalled()
})

test('edit mode: panning keeps the selection', async () => {
  const { el, f } = await setup('edit')
  await click(title(el, 'a'))
  await drag({ x: 700, y: 500 }, { x: 600, y: 550 })
  press(el, 'Delete')
  expect(f.state().removed).toEqual(['a'])
})

test('edit mode: Shift+click adds a node to the selection and toggles it off again', async () => {
  const { el, f } = await setup('edit')
  await click(title(el, 'a'))
  await click(title(el, 'b'), { shiftKey: true })
  expect(f.selection()).toEqual({ nodes: ['a', 'b'] })
  await click(title(el, 'b'), { shiftKey: true })
  expect(f.selection()).toEqual({ nodes: ['a'] })
})

test('edit mode: Delete removes every selected node in one edit, and one undo restores them', async () => {
  const { el, f, changes } = await setup('edit')
  await click(title(el, 'a'))
  await click(title(el, 'b'), { shiftKey: true })
  press(el, 'Delete')
  expect(changes).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ nodesRemoved: ['a', 'b'] }))
  press(el, 'z', { ctrlKey: true })
  expect(f.state().removed).toBeUndefined()
})

test('edit mode: Shift+drag on the background adds the nodes the box touches to the selection', async () => {
  const { el, f } = await setup('edit')
  await click(title(el, 'c'))
  const [ra, rb] = ['a', 'b'].map(id => el.querySelector(`[data-node="${id}"]`)!.getBoundingClientRect())
  await drag({ x: ra.left - 10, y: ra.top - 10 }, { x: rb.left + 10, y: rb.top + 10 }, { shiftKey: true })
  expect(f.selection().nodes.toSorted()).toEqual(['a', 'b', 'c'])
  expect(el.querySelector<HTMLElement>('.bn-band')!.style.display).toBe('none')
})

test('edit mode: dragging one of several selected nodes moves them all in one edit', async () => {
  const { el, changes } = await setup('edit')
  await click(title(el, 'a'))
  await click(title(el, 'b'), { shiftKey: true })
  const { x, y } = center(title(el, 'a'))
  await drag(title(el, 'a'), { x: x + 100, y: y + 100 })
  expect(changes).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    positions: { a: [120, 120], b: [420, 120], c: [320, 220] },
  }), expect.anything())
})

test('edit mode: clicking one of several selected nodes selects only that node', async () => {
  const { el, f } = await setup('edit')
  await click(title(el, 'a'))
  await click(title(el, 'b'), { shiftKey: true })
  await click(title(el, 'a'))
  expect(f.selection()).toEqual({ nodes: ['a'] })
})

test('edit mode: a group dropped onto another node only moves the member that collides', async () => {
  const { el, f } = await setup('edit')
  await click(title(el, 'a'))
  await click(title(el, 'b'), { shiftKey: true })
  const { x, y } = center(title(el, 'a'))
  await drag(title(el, 'a'), { x, y: y + 200 }) // b lands right on c
  const { a, b, c } = f.state().positions
  expect([a, c]).toEqual([[20, 220], [320, 220]])
  expect([[320, 20], [320, 220]]).not.toContainEqual(b) // moved with the group, then off c
})

test('edit mode: holding a dragged node at the edge pans the view and the node follows', async () => {
  const { el, f } = await setup('edit')
  pointer('pointerdown', title(el, 'a'))
  pointer('pointermove', { x: 795, y: 300 })
  const reached = f.state().positions.a[0]
  for (let i = 0; i < 10; i++) await frame()
  expect(f.state().positions.a[0]).toBeGreaterThan(reached)
  // Back inside, the panning stops.
  pointer('pointermove', { x: 400, y: 300 })
  await frame()
  const settled = f.state().positions.a[0]
  for (let i = 0; i < 5; i++) await frame()
  expect(f.state().positions.a[0]).toBe(settled)
  pointer('pointerup', { x: 400, y: 300 })
})

test('edit mode: holding a dragged wire end at the edge pans the view', async () => {
  const { el } = await setup('edit')
  const node = el.querySelector('[data-node="a"]')!
  pointer('pointerdown', anchor(el, 'a.e'))
  pointer('pointermove', { x: 400, y: 595 })
  await frame()
  const before = node.getBoundingClientRect().top
  for (let i = 0; i < 10; i++) await frame()
  expect(node.getBoundingClientRect().top).toBeLessThan(before)
  pointer('pointerup', { x: 400, y: 595 })
})

test('edit mode: a node dragged while zooming stays under the pointer', async () => {
  const { el } = await setup('edit')
  pointer('pointerdown', title(el, 'a'))
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, clientX: 700, clientY: 500, bubbles: true, cancelable: true }))
  await frame()
  const to = { x: 300, y: 300 }
  pointer('pointermove', to)
  await frame()
  const at = center(title(el, 'a'))
  // Positions snap to the grid, so the node may sit up to half a step (at this zoom) off.
  expect(Math.abs(at.x - to.x)).toBeLessThan(16)
  expect(Math.abs(at.y - to.y)).toBeLessThan(16)
  pointer('pointerup', to)
})

test('edit mode: Ctrl+A selects every node', async () => {
  const { el, f } = await setup('edit')
  press(el, 'a', { ctrlKey: true })
  expect(f.selection().nodes.toSorted()).toEqual(['a', 'b', 'c'])
})

test('edit mode: arrow keys move the selected nodes one grid step per press, each one edit', async () => {
  const { el, f, changes } = await setup('edit')
  await click(title(el, 'a'))
  press(el, 'ArrowRight')
  press(el, 'ArrowDown')
  expect(f.state().positions.a).toEqual([40, 40])
  expect(changes).toHaveBeenCalledTimes(2)
  f.undo()
  expect(f.state().positions.a).toEqual([40, 20])
})

test('edit mode: a node nudged onto another settles next to it', async () => {
  const { el, f } = await setup('edit')
  f.node('a').at(140, 20) // b's left edge is at 320; a is 160 wide
  await frame()
  await click(title(el, 'a'))
  press(el, 'ArrowRight')
  press(el, 'ArrowRight')
  await frame()
  expect(f.state().positions.a).not.toEqual([180, 20]) // where two plain steps would put it, on b
  const a = el.querySelector('[data-node="a"]')!.getBoundingClientRect()
  const b = el.querySelector('[data-node="b"]')!.getBoundingClientRect()
  expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true)
})

test('edit mode: a dragged node follows the pointer freely, lifted, and snaps to the grid on drop', async () => {
  const { el, f } = await setup('edit')
  const node = el.querySelector('[data-node="a"]')!
  const { x, y } = center(title(el, 'a'))
  pointer('pointerdown', title(el, 'a'))
  pointer('pointermove', { x: x + 7, y: y + 13 })
  await frame()
  expect(f.state().positions.a).toEqual([27, 33])
  expect(node.classList.contains('bn-dragging')).toBe(true)
  pointer('pointerup', { x: x + 7, y: y + 13 })
  await frame()
  expect(f.state().positions.a).toEqual([20, 40])
  expect(node.classList.contains('bn-dragging')).toBe(false)
})
