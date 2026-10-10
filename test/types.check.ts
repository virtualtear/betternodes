// Type-level checks, compiled by `tsc -p .` as part of `npm test`; never executed.
import { flow } from '../src/index'

const f = flow(document.createElement('div'))
f.connect('a.e', 'b.w')
f.connect('a', 'b')
f.connect('a.e', 'b')
const dynamic: string = 'a.e'
f.connect(dynamic, dynamic)
f.disconnect('a', 'b.w')

// @ts-expect-error unknown anchor
f.connect('a.x', 'b.w')
// @ts-expect-error unknown anchor
f.disconnect('a.q', 'b')
f.connect('a.e', 'b.w', { label: 'yes' })
f.label('a.e', 'b.w', 'no')
f.label('a', 'b')
// @ts-expect-error unknown anchor
f.label('a.x', 'b', 'no')

const g = flow(document.createElement('div'), { zoom: false, mode: 'edit', history: 0 })
g.set({ pan: false }).set({ minZoom: 0.5, maxZoom: 2 })
// @ts-expect-error options are booleans
flow(document.createElement('div'), { zoom: 'no' })
// @ts-expect-error unknown option
g.set({ bogus: 1 })
// @ts-expect-error unknown mode
g.set({ mode: 'locked' })

g.on('click', (hit, e) => [hit.node, hit.wire?.[0], e.clientX])
g.on('hover', hit => hit.node)
g.on('change', (state, diff) => [state.positions, diff.added])
g.on('select', ({ nodes, wire }) => [nodes.length, wire?.[1]])
// @ts-expect-error select listeners get a Selection
g.on('select', (selection: string) => selection)
g.on('viewport', v => v.zoom).viewport({ zoom: 2 }).zoomBy(1.2).fit('a', 'b')
const zoom: number = g.viewport().zoom
g.connect('a.e', 'b.w', { class: 'error' }).wireClass('a.e', 'b.w', 'ok', 'bn-two-way')
flow(document.createElement('div'), { canConnect: (from, to) => from !== to })
// @ts-expect-error canConnect must return a boolean
g.set({ canConnect: () => 'yes' })
// @ts-expect-error unknown event
g.on('drag', () => {})
// @ts-expect-error events are only fired by the flow itself, never forged from outside
g.dispatchEvent(new CustomEvent('change'))
// @ts-expect-error unknown anchor
g.wireClass('a.x', 'b', 'ok')
void zoom

g.group('stage').title('Stage 1').nodes('a', 'b').class('running')
g.ungroup('stage').on('click', ({ group }) => group?.toUpperCase())
// @ts-expect-error node ids are strings
g.group('stage').nodes(1)
