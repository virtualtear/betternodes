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
