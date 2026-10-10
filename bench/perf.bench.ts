import { expect, test } from 'vitest'
import { Graph, type NodeDef } from '../src/model/graph'
import { Journal } from '../src/model/history'
import { flow, type Flow } from '../src/index'
import { layout } from '../src/layout/columns'
import { untangle } from '../src/layout/untangle'
import { separate } from '../src/geometry/lanes'
import type { Point, Rect } from '../src/geometry/rect'
import { route } from '../src/geometry/route'
import { pointer } from '../test/util'
import { fps, measure } from './harness'
import '../src/style.css'

// Deterministic pseudo-random numbers, so every run benchmarks the same graphs.
function random(seed = 7) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647
}

// The demo's stress grid: 1000 nodes in 32 columns, each wired to its right-hand neighbour.
const COLS = 32
const gridAt = (i: number): Point => [(i % COLS) * 240, Math.floor(i / COLS) * 120]
const gridRects = (n: number) => Array.from({ length: n }, (_, i): Rect => [...gridAt(i), 160, 37])

// Frames normally run on requestAnimationFrame; benchmarks call the frame function directly so
// they time the work itself, not the wait for the next display refresh.
interface Internals {
  view: { flush(now: number): void; viewport(x: number, y: number, k: number): void; place(id: string): void; dragging: Set<string>; x: number }
  graph: Graph
  commit(journal: Journal): void
}
const view = (f: Flow) => (f as unknown as Internals).view
const graphOf = (f: Flow) => (f as unknown as Internals).graph
const frameNow = (f: Flow) => view(f).flush(performance.now())

function mount(n: number) {
  const el = document.createElement('div')
  el.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:600px'
  document.body.append(el)
  const f = flow(el).mode('edit')
  for (let i = 0; i < n; i++) f.node(`n${i}`).title(`Node ${i}`).at(...gridAt(i))
  for (let i = 1; i < n; i++) if (i % COLS) f.connect(`n${i - 1}.e`, `n${i}.w`)
  return { el, f }
}

test('route: 1000 short wires between neighbours', async () => {
  const rects = gridRects(1000)
  await measure('route: 1000 short wires (fast path)', {
    budget: 50,
    run: () => {
      for (let i = 1; i < 1000; i++) {
        const [a, b] = [rects[i - 1], rects[i]]
        route([a[0] + 160, a[1] + 18], [1, 0], [b[0], b[1] + 18], [-1, 0], rects)
      }
    },
  })
})

test('route: 300 long random wires among 200 scattered nodes', async () => {
  const rand = random()
  const cols = Math.ceil(Math.sqrt(200 * 1.6))
  const rects = Array.from({ length: 200 }, (_, i): Rect =>
    [(i % cols) * 230 + Math.round(rand() * 40), Math.floor(i / cols) * 110 + Math.round(rand() * 30), 160, 37])
  const pairs = Array.from({ length: 300 }, () => [Math.floor(rand() * 200), Math.floor(rand() * 200)]).filter(([a, b]) => a !== b)
  await measure('route: 300 long random wires (worst case)', {
    budget: 600,
    runs: 5,
    warmup: 1,
    run: () => {
      for (const [i, j] of pairs) route([rects[i][0] + 160, rects[i][1] + 18], [1, 0], [rects[j][0], rects[j][1] + 18], [-1, 0], rects)
    },
  })
})

test('separate: 1000 wires sharing lanes', async () => {
  // Groups of 10 Z-shaped wires that all bend down the same vertical line.
  const wires = new Map<string, Point[]>()
  for (let i = 0; i < 1000; i++) {
    const [x, y] = [Math.floor(i / 10) * 300, (i % 10) * 15]
    wires.set(`w${i}`, [[x, y], [x + 120, y], [x + 120, y + 400], [x + 240, y + 400]])
  }
  await measure('separate: 1000 wires in shared lanes', { budget: 5, run: () => separate(wires) })
})

test('layout: 1000 new nodes', async () => {
  const graph = new Graph()
  const sizes = new Map<string, Point>()
  for (let i = 0; i < 1000; i++) {
    graph.nodes.set(`n${i}`, { id: `n${i}`, title: '', x: 0, y: 0 } as NodeDef)
    sizes.set(`n${i}`, [160, 37])
    if (i) graph.connect(`n${Math.floor((i - 1) / 2)}`, `n${i}`) // a binary tree: wide columns
  }
  await measure('layout: 1000 new nodes (binary tree)', { budget: 5, run: () => layout(graph, sizes, 20) })
})

test('route: 10 wires across 1000 scattered nodes', async () => {
  // Long wires over a dense, unaligned layout: the sparse grid gets a line per obstacle edge.
  const rand = random(11)
  const rects = Array.from({ length: 1000 }, (): Rect => [Math.round(rand() * 7000), Math.round(rand() * 4000), 160, 37])
  await measure('route: 10 long wires across 1000 scattered nodes', {
    budget: 300,
    runs: 3,
    warmup: 1,
    run: () => {
      for (let i = 0; i < 10; i++) route([-200, i * 400], [1, 0], [7400, 4000 - i * 400], [-1, 0], rects)
    },
  })
})

test('remove: 1000 nodes at once', async () => {
  const ids = Array.from({ length: 1000 }, (_, i) => `n${i}`)
  await measure('remove: 1000 nodes at once (999 wires)', {
    budget: 2,
    setup: () => {
      const graph = new Graph()
      for (const id of ids) graph.nodes.set(id, { id, title: '', x: 0, y: 0 } as NodeDef)
      for (let i = 1; i < 1000; i++) graph.connect(`n${i - 1}`, `n${i}`)
      return graph
    },
    run: graph => {
      graph.remove(ids)
    },
  })
})

test('untangle: overlap check when every node changed', async () => {
  const rects = new Map(gridRects(1000).map((r, i) => [`n${i}`, r]))
  const order = [...rects.keys()]
  await measure('untangle: 1000 nodes, no overlaps', { budget: 5, run: () => untangle(order, rects, new Set(order), 20, 20) })
})

test('untangle: many nodes stacked on one spot', async () => {
  const rects = new Map(Array.from({ length: 300 }, (_, i) => [`n${i}`, [0, 0, 160, 37] as Rect]))
  const order = [...rects.keys()]
  await measure('untangle: 300 nodes stacked on one spot', { budget: 400, runs: 5, warmup: 1, run: () => untangle(order, rects, new Set(order), 20, 20) })
})

test('first frame: mount 1000 nodes and 970 wires', async () => {
  let mounted: ReturnType<typeof mount>
  await measure('frame: mount 1000 nodes + 970 wires', {
    budget: 500,
    runs: 8,
    warmup: 2,
    run: () => {
      mounted = mount(1000)
      frameNow(mounted.f)
    },
    teardown: () => {
      mounted.f.destroy()
      mounted.el.remove()
    },
  })
})

test('frames on a 1000-node graph', async () => {
  const { el, f } = mount(1000)
  frameNow(f)
  frameNow(f)
  let step = 0
  // What a real drag does per pointer move: update the position, schedule a cheap re-place.
  const dragged = graphOf(f).nodes.get('n500')!
  await measure('frame: dragging one node (1000 nodes)', {
    budget: 8,
    runs: 60,
    run: () => {
      view(f).dragging = new Set(['n500'])
      dragged.x = gridAt(500)[0] + (++step % 10) * 20
      dragged.y = gridAt(500)[1] + 60
      view(f).place('n500')
      frameNow(f)
    },
  })
  // A group drag: a selected 10x10 block of nodes moves together.
  const block = Array.from({ length: 100 }, (_, i) => (10 + Math.floor(i / 10)) * COLS + 10 + (i % 10))
  const ids = block.map(i => `n${i}`)
  const dragBlock = () => {
    view(f).dragging = new Set(ids)
    const dx = (++step % 10) * 20
    for (const i of block) {
      Object.assign(graphOf(f).nodes.get(`n${i}`)!, { x: gridAt(i)[0] + dx, y: gridAt(i)[1] + 60 })
      view(f).place(`n${i}`)
    }
    frameNow(f)
  }
  f.select(...ids)
  await measure('frame: dragging 100 selected nodes (1000 nodes)', { budget: 8, runs: 60, run: dragBlock })
  // The minimap redraws the moved nodes and re-measures the bounds of all of them. It reads the
  // root size at frame start, which costs nothing in real frames but a layout here: back-to-back
  // flushes have no paint in between to clean up the previous frame's writes.
  f.set({ minimap: true })
  frameNow(f)
  await measure('frame: dragging 100 selected nodes, minimap on (1000 nodes)', { budget: 8, runs: 60, run: dragBlock })
  f.set({ minimap: false })
  frameNow(f)
  // Everything selected and dragged: wires inside the group move along instead of re-routing.
  const all = Array.from({ length: 1000 }, (_, i) => `n${i}`)
  f.select(...all)
  await measure('frame: dragging all 1000 nodes', {
    budget: 8,
    runs: 60,
    run: () => {
      view(f).dragging = new Set(all)
      const dx = (++step % 10) * 20
      all.forEach((id, i) => {
        Object.assign(graphOf(f).nodes.get(id)!, { x: gridAt(i)[0] + dx, y: gridAt(i)[1] + 60 })
        view(f).place(id)
      })
      frameNow(f)
    },
  })
  f.select()
  view(f).dragging = new Set()
  // Undo of a one-node move: only that node and its wires should need work.
  const internals = f as unknown as Internals
  await measure('frame: undo of a one-node move (1000 nodes)', {
    budget: 10,
    runs: 30,
    setup: () => {
      const journal = new Journal()
      const node = graphOf(f).nodes.get('n500')!
      journal.track([node])
      node.x += 40
      view(f).place('n500')
      frameNow(f)
      internals.commit(journal)
    },
    run: () => {
      f.undo()
      frameNow(f)
    },
  })
  await measure('frame: panning (1000 nodes)', {
    budget: 8,
    runs: 60,
    run: () => {
      view(f).viewport(-(++step % 50) * 10, 0, 0.6)
      frameNow(f)
    },
  })
  for (let i = 0; i < 200; i++) void f.send(`n${i * 5}`, `n${i * 5 + 3}`, { speed: 1 })
  frameNow(f)
  await measure('frame: 200 packets in flight (1000 nodes)', { budget: 8, runs: 60, run: () => frameNow(f) })
  f.destroy()
  el.remove()
})

// Where the known limits show first: routing, wire scans and lanes grow with the graph.
test('first frame: mount 5000 nodes', async () => {
  let mounted: ReturnType<typeof mount>
  await measure('frame: mount 5000 nodes + 4843 wires', {
    budget: 3000,
    runs: 3,
    warmup: 1,
    run: () => {
      mounted = mount(5000)
      frameNow(mounted.f)
    },
    teardown: () => {
      mounted.f.destroy()
      mounted.el.remove()
    },
  })
})

test('frames on a 5000-node graph', async () => {
  const { el, f } = mount(5000)
  frameNow(f)
  frameNow(f)
  let step = 0
  const dragged = graphOf(f).nodes.get('n2500')!
  await measure('frame: dragging one node (5000 nodes)', {
    budget: 16,
    runs: 30,
    run: () => {
      view(f).dragging = new Set(['n2500'])
      dragged.x = gridAt(2500)[0] + (++step % 10) * 20
      dragged.y = gridAt(2500)[1] + 60
      view(f).place('n2500')
      frameNow(f)
    },
  })
  const block = Array.from({ length: 100 }, (_, i) => (60 + Math.floor(i / 10)) * COLS + 10 + (i % 10))
  view(f).dragging = new Set(block.map(i => `n${i}`))
  await measure('frame: dragging 100 selected nodes (5000 nodes)', {
    budget: 32,
    runs: 30,
    run: () => {
      const dx = (++step % 10) * 20
      for (const i of block) {
        Object.assign(graphOf(f).nodes.get(`n${i}`)!, { x: gridAt(i)[0] + dx, y: gridAt(i)[1] + 60 })
        view(f).place(`n${i}`)
      }
      frameNow(f)
    },
  })
  view(f).dragging = new Set()
  f.destroy()
  el.remove()
})

// Status classes on every wire, as an app colouring wires by state would set them.
test('frames with a class on every wire, 5000 nodes', async () => {
  const { el, f } = mount(5000)
  for (const [from, to] of graphOf(f).edges.values()) f.wireClass(from, to, 'ok')
  frameNow(f)
  frameNow(f)
  let step = 0
  const dragged = graphOf(f).nodes.get('n2500')!
  await measure('frame: dragging one node, every wire classed (5000 nodes)', {
    budget: 16,
    runs: 30,
    run: () => {
      view(f).dragging = new Set(['n2500'])
      dragged.x = gridAt(2500)[0] + (++step % 10) * 20
      dragged.y = gridAt(2500)[1] + 60
      view(f).place('n2500')
      frameNow(f)
    },
  })
  f.destroy()
  el.remove()
})

// Wire notes are placed clear of nodes, which checks node rects for every candidate spot. The wires
// bend (one row down, one column over), so each note has an inner segment to try.
function labelled(n: number, notes: number) {
  const mounted = mount(n)
  for (let k = 0, i = 0; k < notes && i + COLS + 1 < n; i++) {
    if (i % COLS === COLS - 1) continue
    mounted.f.connect(`n${i}.e`, `n${i + COLS + 1}.w`, { label: `step ${i}` })
    k++
  }
  return mounted
}

for (const [n, notes, budget] of [[1000, 200, 8], [5000, 1000, 16]]) {
  test(`frames with ${notes} labelled bent wires, ${n} nodes`, async () => {
    const { el, f } = labelled(n, notes)
    frameNow(f)
    frameNow(f)
    let step = 0
    const dragged = graphOf(f).nodes.get('n500')!
    await measure(`frame: dragging one node, ${notes} labelled bent wires (${n} nodes)`, {
      budget,
      runs: 30,
      run: () => {
        view(f).dragging = new Set(['n500'])
        dragged.x = gridAt(500)[0] + (++step % 10) * 20
        dragged.y = gridAt(500)[1] + 60
        view(f).place('n500')
        frameNow(f)
      },
    })
    f.destroy()
    el.remove()
  })
}

// Group frames are redrawn in the minimap on every frame in which a node moved.
test('frames with 20 groups and the minimap', async () => {
  const { el, f } = mount(1000)
  for (let g = 0; g < 20; g++) f.group(`g${g}`).nodes(...Array.from({ length: 10 }, (_, i) => `n${g * 40 + i}`))
  f.set({ minimap: true })
  frameNow(f)
  frameNow(f)
  let step = 0
  const dragged = graphOf(f).nodes.get('n500')!
  await measure('frame: dragging one node, 20 groups, minimap on (1000 nodes)', {
    budget: 8,
    runs: 60,
    run: () => {
      view(f).dragging = new Set(['n500'])
      dragged.x = gridAt(500)[0] + (++step % 10) * 20
      dragged.y = gridAt(500)[1] + 60
      view(f).place('n500')
      frameNow(f)
    },
  })
  f.destroy()
  el.remove()
})

// Real frames driven by real pointer events: what a user on the ?n=1000 demo would see.
test('frame rate on a 1000-node graph', async () => {
  const { el, f } = mount(1000)
  await fps('fps: idle (1000 nodes)', { frames: 60, minFps: 30 })
  // Wiggle a node around its spot, one pointer move per frame.
  const title = el.querySelector('[data-node="n500"] .bn-title')!
  const r = title.getBoundingClientRect()
  const [x, y] = [r.left + r.width / 2, r.top + r.height / 2]
  pointer('pointerdown', { x, y })
  await fps('fps: dragging one node (1000 nodes)', {
    minFps: 30,
    step: i => pointer('pointermove', { x: x + 40 * Math.sin(i / 5), y: y + 40 * Math.cos(i / 5) }),
  })
  pointer('pointerup', { x, y })
  expect(f.state().positions.n500, 'the drag moved the node').not.toEqual(gridAt(500))
  f.mode('view') // dragging anywhere pans
  const panned = view(f).x
  pointer('pointerdown', { x: 500, y: 300 })
  await fps('fps: panning (1000 nodes)', {
    minFps: 30,
    step: i => pointer('pointermove', { x: 500 + 200 * Math.sin(i / 20), y: 300 }),
  })
  pointer('pointerup', { x: 500, y: 300 })
  expect(view(f).x, 'the drag panned the view').not.toBe(panned)
  let arrived = 0
  for (let i = 0; i < 200; i++) void f.send(`n${i * 5}`, `n${i * 5 + 3}`, { speed: 20 }).then(() => arrived++)
  await fps('fps: 200 packets in flight (1000 nodes)', { minFps: 30 })
  expect(arrived, 'packets were still in flight').toBeLessThan(100)
  f.destroy()
  el.remove()
})

// Ten wires with two bends each, between nodes in two columns.
function bentWires() {
  const el = document.createElement('div')
  el.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:600px'
  document.body.append(el)
  const f = flow(el)
  for (let i = 0; i < 10; i++) {
    f.node(`l${i}`).title(`Left ${i}`).at(0, i * 80)
    f.node(`r${i}`).title(`Right ${i}`).at(600, i * 80 + 40)
    f.connect(`l${i}.e`, `r${i}.w`)
  }
  return { el, f }
}

// Slow and staggered, so they spread along the wires and stay in flight for the whole benchmark.
function sendSlowly(f: Flow, n: number) {
  let arrived = 0
  for (let i = 0; i < n; i++) void f.send(`l${i % 10}`, `r${i % 10}`, { speed: 5 + (i % 50) }).then(() => arrived++)
  return () => arrived
}

// Packets on bent wires: each frame places every packet along its wire's curves and corners.
test('frame with 1000 packets on bent wires', async () => {
  const { el, f } = bentWires()
  frameNow(f)
  const arrived = sendSlowly(f, 1000)
  frameNow(f)
  await measure('frame: 1000 packets on bent wires', { budget: 8, runs: 60, run: () => frameNow(f) })
  expect(arrived(), 'packets were still in flight').toBe(0)
  f.destroy()
  el.remove()
})

// Real frames, so the browser's own work to show the packets counts too. Headless Chromium draws
// WebGL in software: there SVG circles manage about 15 fps here, the WebGL layer about 60.
test('frame rate with 2000 packets on bent wires', async () => {
  const { el, f } = bentWires()
  await fps('fps: idle (bent wires)', { frames: 10 })
  const arrived = sendSlowly(f, 2000)
  await fps('fps: 2000 packets on bent wires', { minFps: 30 })
  expect(arrived(), 'packets were still in flight').toBe(0)
  f.destroy()
  el.remove()
})
