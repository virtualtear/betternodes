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
