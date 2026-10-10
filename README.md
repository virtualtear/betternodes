# betternodes

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)
![Size: 24 kB min+gzip](https://img.shields.io/badge/size-24%20kB%20min%2Bgzip-informational.svg)
![TypeScript](https://img.shields.io/badge/types-TypeScript-3178c6.svg)

A node graph viewer and editor built on plain DOM and SVG, with no framework required. You define
nodes and wires in code, then show them read-only or let users edit them, draw.io style. Every user
edit comes out as JSON.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-dark.png">
  <img alt="A workflow graph with wire notes, an Output group and a minimap." src="docs/screenshots/overview-light.png">
</picture>

## Features

- No runtime dependencies, about 24 kB min+gzip
- Works with React, Vue, Svelte or no framework
- View and edit modes, with undo and redo
- Right-angled wires that route around nodes and carry notes
- Auto-layout, groups, a minimap, and light and dark themes
- Animated packets, drawn with WebGL
- JSON state and diffs for every user edit
- Large graphs stay smooth: only nodes and wires near the view are in the page, and zoomed far out
  the GPU draws them all. At 100k nodes a drag frame takes under a millisecond ([benchmarks](TECHNICAL.md#tests-and-benchmarks))

## Installation

```sh
npm install --allow-git=root github:virtualtear/betternodes#v0.2.0
```

betternodes is not on npm yet. npm 12 and later need `--allow-git=root`. npm builds the package
on install, which needs Node.js 20.19+ or 22.12+.

## Quick start

```ts
import { flow } from 'betternodes'
import 'betternodes/style.css'

const f = flow(document.getElementById('graph')!) // the element needs a size

f.node('hook').title('Webhook')
f.node('mail').title('Send mail')
f.connect('hook', 'mail', { label: 'new order' })

f.mode('edit')
f.on('change', () => localStorage.setItem('graph', JSON.stringify(f.state())))
```

Nodes without a position are laid out automatically, and the first render fits the graph into view.

## Usage

### Modes

`'view'` (default) is read-only: drag to pan, wheel to zoom, click to select. `'edit'` also lets
users move, connect and delete. Switch with `f.mode('edit')`.

### Wires and anchors

Each node has eight anchors: `nw n ne e se s sw w`. A wire end is either fixed (`'a.e'`) or
floating (`'a'`). A floating end attaches to the side facing the other end.

```ts
f.connect('a.e', 'b', { label: 'yes', class: 'error' })
f.label('a.e', 'b', 'no')                 // no text removes the note
f.wireClass('a.e', 'b', 'bn-two-way')     // arrowhead at both ends
```

Built-in wire classes: `bn-two-way` and `bn-no-arrow`.

### Groups

```ts
f.group('intake').title('Intake').nodes('hook', 'if')
f.ungroup('intake')   // removes the frame, keeps the nodes
```

### Saving and loading

Node definitions live in your code. The editor state holds only what users can change:

```ts
type State = {
  positions: Record<string, [x: number, y: number]>
  edges: [from: string, to: string][]
  removed?: string[]
}
```

```ts
f.load(JSON.parse(localStorage.getItem('graph') ?? 'null'))
f.on('change', () => localStorage.setItem('graph', JSON.stringify(f.state())))

// or send only what changed
f.on('change', diff => api.patch('/graph', diff))
```

```ts
type Diff = {
  added: Edge[]
  removed: Edge[]
  moved: Record<string, [x: number, y: number]>   // new positions
  nodesRemoved: string[]
  nodesRestored: string[]                          // deleted nodes brought back, e.g. by undo
}
```

`load()` drops invalid entries with a warning. A state with the wrong shape changes nothing.

### Packets

```ts
await f.send('hook', 'mail')                          // one packet: resolves ['mail'], or [] if unreachable
await f.send('hook')                                  // spreads along every outgoing wire
f.send('if', 'log', { class: 'error', speed: 400 })   // speed in px per second
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/burst-dark.gif">
  <img alt="600 packets flowing along the wires at once." src="docs/screenshots/burst-light.gif">
</picture>

### Custom content

Any element can go below a node's title. The node resizes with it.

```ts
const img = document.createElement('img')
img.src = 'preview.png'
img.width = 200
img.height = 140        // a fixed size keeps the layout from jumping when the image loads
img.draggable = false
f.node('image').title('Image').content(img)
```

Pressing inside content still drags the node. Controls that need the pointer should stop it:
`button.addEventListener('pointerdown', e => e.stopPropagation())`.

### With a framework

Mount once into a sized element and destroy on unmount:

```tsx
useEffect(() => {
  const f = flow(ref.current!)
  f.node('a').title('Source')
  f.node('b').title('Target')
  f.connect('a', 'b')
  return () => f.destroy()
}, [])
```

To show framework components in a node, render them into a plain element and pass it to `.content()`.

## API

### `flow(root, options?)`

Mounts a graph in `root` and returns a `Flow`.

### Options

Pass them to `flow()` or change them later with `f.set()`.

| Option | Default | Description |
| --- | --- | --- |
| `mode` | `'view'` | `'view'` or `'edit'` |
| `zoom` | `true` | Wheel and pinch zoom |
| `minZoom` / `maxZoom` | `0.1` / `4` | Zoom limits |
| `pan` | `true` | Drag to pan |
| `fit` | `true` | Fit the graph into view on the first render |
| `select` | `true` | Click, Shift+click and box selection |
| `keys` | `true` | Delete, undo, redo and Esc |
| `history` | `100` | Undo steps; `0` disables undo |
| `connect` | `true` | Users can draw and reconnect wires |
| `move` | `true` | Users can move nodes |
| `remove` | `true` | Users can delete nodes and wires |
| `snap` | `true` | Snap dropped nodes to a 20px grid |
| `minimap` | `false` | Overview in the bottom-right corner |
| `virtual` | `true` | Only nodes near the view get elements; `false` keeps every node in the page |
| `canConnect` | allows all | `(from, to) => boolean` for wires users draw |

Options only limit users. Calls from your code always work.

### Nodes

`f.node(id)` returns a chainable builder. Ids must not contain `.` or `>`, and `__proto__` is reserved.

| Method | Description |
| --- | --- |
| `.title(text)` | Title text, defaults to the id |
| `.at(x, y)` | Position in world px; without it, auto-layout places the node |
| `.content(el)` | Custom element below the title |
| `.class(...names)` | CSS classes on the node |

`f.remove(id)` deletes a node and its wires.

A node far from the view has no element, and below 40% zoom the GPU draws nodes as plain boxes
instead. Its `.content()` element stays with the node and comes back with it, but is out of the page
meanwhile, so a video in it stops. A node that holds focus keeps its element. Set `virtual: false`
to keep every node in the page.

### Groups

| Method | Description |
| --- | --- |
| `f.group(id).title(text)` | Frame title |
| `f.group(id).nodes(...ids)` | Members |
| `f.group(id).class(...names)` | CSS classes on the frame |
| `f.ungroup(id)` | Removes the frame |

### Wires

| Method | Description |
| --- | --- |
| `f.connect(from, to, { label?, class? })` | Adds a wire |
| `f.disconnect(from, to)` | Removes a wire |
| `f.label(from, to, text?)` | Sets or removes the note |
| `f.wireClass(from, to, ...names)` | Replaces the wire's CSS classes |

### Packets

| Method | Description |
| --- | --- |
| `f.send(from, to, { class?, speed? })` | One packet along the fewest hops |
| `f.send(from)` | A packet down every outgoing wire, each wire once |

Both return a promise with the ids of the nodes reached.

### Viewport and state

| Method | Description |
| --- | --- |
| `f.state()` / `f.load(state)` | Save or restore positions and wires |
| `f.undo()` / `f.redo()` | Undo or redo a user edit; changes your code made since stay |
| `f.layout()` | Re-run auto-layout |
| `f.fit(...ids)` | Fit these nodes, or all, into view |
| `f.viewport()` / `f.viewport({ x?, y?, zoom? })` | Read or set pan and zoom |
| `f.zoomBy(factor)` | Zoom around the center |
| `f.select(...ids)` / `f.selection()` | Set or read the selection |
| `f.mode(mode)` / `f.set(options)` | Change mode or options |
| `f.destroy()` | Remove everything from `root` |

### Events

```ts
f.on('click', ({ node }) => console.log(node))
f.on('change', () => save(f.state()), { signal })
```

| Event | Arguments | When |
| --- | --- | --- |
| `change` | `(diff)` | After every user edit, including undo and redo; never for calls from code. Call `f.state()` for the whole state |
| `select` | `({ nodes, wire? })` | The selection changed |
| `viewport` | `({ x, y, zoom })` | Pan or zoom changed |
| `click`, `dblclick`, `contextmenu` | `(hit, event)` | Pointer events |
| `hover` | `(hit)` | The pointer moved onto another node or wire |

`hit` is `{ node }`, `{ wire }`, `{ group }` or `{}` for the background.

### Types

`Flow`, `NodeBuilder`, `GroupBuilder`, `FlowOptions`, `FlowEvents`, `State`, `Diff`, `Edge`,
`Anchor`, `End`, `Selection`, `Hit`, `Viewport`, `SendOptions`.

Wire ends written as string literals are type-checked, so `'a.x'` fails to compile.

## Editor controls

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/editing-dark.png">
  <img alt="Edit mode: a node lifted mid-drag, its wires following it." src="docs/screenshots/editing-light.png">
</picture>

| Action | Input |
| --- | --- |
| Pan | Drag the background |
| Zoom | Wheel or pinch |
| Select | Click; Shift+click or Shift+drag for several |
| Select all | Ctrl+A / Cmd+A |
| Move | Drag a node, or a group by its title |
| Nudge | Arrow keys |
| New wire | Drag from an anchor to another node |
| Move a wire end | Drag the wire near that end |
| Delete | Delete or Backspace |
| Undo / redo | Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y |

## Theming

Light by default. Add `bn-dark` to the root for dark, or `bn-auto` to follow the system.
Override CSS variables on the root element:

| Variable | Used for |
| --- | --- |
| `--bn-bg`, `--bn-grid` | Background and grid dots |
| `--bn-node-bg`, `--bn-node-border`, `--bn-node-hover`, `--bn-shadow` | Nodes |
| `--bn-text`, `--bn-text-muted` | Text |
| `--bn-accent` | Selection and highlights |
| `--bn-wire`, `--bn-wire-hover` | Wires |
| `--bn-packet` | Packets |
| `--bn-radius`, `--bn-anchor` | Node corner radius, anchor size |
| `--bn-group-bg`, `--bn-group-border` | Group frames |
| `--bn-minimap-bg`, `--bn-minimap-node`, `--bn-minimap-view` | Minimap |

Elements: `.bn-node`, `.bn-title`, `.bn-selected`, `.bn-dragging`, `.bn-wire`, `.bn-label`,
`.bn-group`, `.bn-minimap`, `.bn-mini-node`, `.bn-packet`. Classes from `.class()`, `wireClass()` and
`send()` land on these.

Far out, and in the minimap, nodes and wires are drawn on a canvas in the colours these rules give
them: a node's background and `--bn-node-border`, a wire's stroke, and `fill` for `.bn-mini-node`.
A theme switch reaches the canvas within half a second.

```css
.bn-node.error { --bn-node-border: #f43f5e80; --bn-node-hover: #f43f5e; }
.error .bn-wire { stroke: #f43f5e; }
.bn-packet.error { fill: #f43f5e; }
```

## Browser support

Current Chrome, Edge, Firefox and Safari. Without WebGL2, packets fall back to SVG, and nodes show
as elements at every zoom.

## How it works

[TECHNICAL.md](TECHNICAL.md) covers how the library works inside and why it is built that way.

## Contributing

Bug reports and pull requests are welcome. Please run `npm test` before opening a pull request,
and `npm run bench` if you changed rendering or routing. The setup is described in
[TECHNICAL.md](TECHNICAL.md#development).

## License

[MIT](LICENSE)
