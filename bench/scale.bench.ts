import { expect, test } from 'vitest'
import type { Graph } from '../src/model/graph'
import { flow, type Flow } from '../src/index'
import { press } from '../test/util'
import { fps, measure } from './harness'
import '../src/style.css'

// How frame and edit costs grow with the graph. Each size gets the same scenarios; the last test
// compares the largest size with the smallest.
const SIZES = [1000, 10_000, 100_000]

interface Internals {
  view: { flush(now: number): void; place(id: string): void; dragging: Set<string> }
  graph: Graph
}
const view = (f: Flow) => (f as unknown as Internals).view
const graphOf = (f: Flow) => (f as unknown as Internals).graph
const frameNow = (f: Flow) => view(f).flush(performance.now())

// A square-ish grid, each node wired to its right-hand neighbour.
function grid(n: number) {
  const cols = Math.ceil(Math.sqrt(n * 2))
  const at = (i: number): [number, number] => [(i % cols) * 240, Math.floor(i / cols) * 120]
  const el = document.createElement('div')
  el.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:600px'
  document.body.append(el)
  const f = flow(el, { minZoom: 0.005 }).mode('edit')
  for (let i = 0; i < n; i++) f.node(`n${i}`).title(`Node ${i}`).at(...at(i))
  for (let i = 1; i < n; i++) if (i % cols) f.connect(`n${i - 1}.e`, `n${i}.w`)
  return { el, f, cols, at }
}

const medians = new Map<number, Record<string, number>>()

for (const n of SIZES) {
  test(`scale: ${n} nodes`, async () => {
    const big = n >= 100_000
    let mounted: ReturnType<typeof grid> | undefined
    await measure(`scale: mount (${n} nodes)`, {
      runs: big ? 1 : 3,
      warmup: big ? 0 : 1,
      setup: () => {
        mounted?.f.destroy()
        mounted?.el.remove()
      },
      run: () => {
        mounted = grid(n)
        frameNow(mounted.f)
      },
    })
    const { el, f, cols, at } = mounted!
    frameNow(f)
    const mid = Math.floor(n / 2)
    const [mx, my] = at(mid)
    // Zoomed in on the middle of the graph, where users work.
    f.viewport({ x: 500 - mx, y: 300 - my, zoom: 1 })
    frameNow(f)
    const got: Record<string, number> = {}
    let step = 0
    const node = graphOf(f).nodes.get(`n${mid}`)!
    got.drag1 = (await measure(`scale: frame dragging one node (${n} nodes)`, {
      runs: 20,
      run: () => {
        view(f).dragging = new Set([node.id])
        Object.assign(node, { x: mx + (++step % 10) * 20, y: my + 60 })
        view(f).place(node.id)
        frameNow(f)
      },
    })).median
    view(f).dragging = new Set()
    Object.assign(node, { x: mx, y: my })
    view(f).place(node.id)
    frameNow(f)
    // A 10 x 10 block around the middle.
    const block = Array.from({ length: 100 }, (_, i) => mid + (Math.floor(i / 10) - 5) * cols + (i % 10) - 5)
    view(f).dragging = new Set(block.map(i => `n${i}`))
    got.drag100 = (await measure(`scale: frame dragging 100 nodes (${n} nodes)`, {
      runs: 20,
      run: () => {
        const dx = (++step % 10) * 20
        for (const i of block) {
          Object.assign(graphOf(f).nodes.get(`n${i}`)!, { x: at(i)[0] + dx, y: at(i)[1] })
          view(f).place(`n${i}`)
        }
        frameNow(f)
      },
    })).median
    view(f).dragging = new Set()
    for (const i of block) {
      Object.assign(graphOf(f).nodes.get(`n${i}`)!, { x: at(i)[0], y: at(i)[1] })
      view(f).place(`n${i}`)
    }
    frameNow(f)
    // One user edit: an arrow-key nudge of a selected node, with its change event and undo step.
    // Left and right in turn, so the node stays in the gap to its neighbours and every nudge moves it.
    const nudge = () => {
      f.select(node.id)
      press(el, ++step % 2 ? 'ArrowRight' : 'ArrowLeft')
    }
    got.edit = (await measure(`scale: nudge one node, an edit (${n} nodes)`, {
      runs: 10,
      run: () => {
        nudge()
        frameNow(f)
      },
    })).median
    got.undo = (await measure(`scale: undo one nudge (${n} nodes)`, {
      runs: 10,
      setup: () => {
        nudge()
        frameNow(f)
      },
      run: () => {
        f.undo()
        frameNow(f)
      },
    })).median
    await measure(`scale: delete 100 selected nodes (${n} nodes)`, {
      runs: 5,
      setup: () => f.select(...block.map(i => `n${i}`)),
      run: () => {
        press(el, 'Delete')
        frameNow(f)
      },
      teardown: () => {
        f.undo()
        frameNow(f)
      },
    })
    f.select()
    frameNow(f)
    await fps(`scale: pan, zoom 1 (${n} nodes)`, { frames: 30, step: i => f.viewport({ x: 500 - mx - (i % 30) * 15 }) })
    f.fit()
    frameNow(f)
    const { x: fx, zoom } = f.viewport()
    await fps(`scale: pan, whole graph fitted at zoom ${zoom.toFixed(3)} (${n} nodes)`, {
      frames: 30,
      step: i => f.viewport({ x: fx - (i % 30) * 15 }),
    })
    // Last, since packets keep frames running for as long as they fly.
    f.viewport({ x: 500 - mx, y: 300 - my, zoom: 1 })
    for (let i = 0; i < 200; i++) void f.send(`n${mid + i - 100}`, `n${mid + i - 97}`, { speed: 1 })
    frameNow(f)
    got.packets = (await measure(`scale: frame with 200 packets (${n} nodes)`, { runs: 20, run: () => frameNow(f) })).median
    medians.set(n, got)
    f.destroy()
    el.remove()
  })
}

// The goal: what a frame or an edit costs doesn't depend on how many nodes there are.
test.fails('scale: frame and edit costs at the largest size stay close to the smallest', () => {
  const [small, large] = [medians.get(SIZES[0])!, medians.get(SIZES[SIZES.length - 1])!]
  for (const key of Object.keys(small)) expect(large[key], key).toBeLessThanOrEqual(small[key] * 1.5 + 0.5)
})
