import { Graph, diff, type Anchor, type Diff, type Edge, type NodeDef, type State } from './model/graph'
import { History } from './model/history'
import { settle, type FlowOptions, type Settings } from './options'
import { attach, type Hit } from './view/interact'
import { Packets, type SendOptions } from './view/packets'
import { View } from './view/view'

/**
 * A wire end: `'nodeId.anchor'`, or a bare `'nodeId'`. String literals are checked, so a typo like
 * `'a.x'` fails to compile; non-literal strings pass and are validated at runtime.
 */
export type End<S extends string> = S extends `${infer Id}.${infer A}` ? (A extends Anchor ? S : `${Id}.${Anchor}`) : S

export type { Hit }

/** Pan offset (where the world origin sits, in screen px from the root's top-left) and zoom factor. */
export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** What is selected: any number of nodes, or one wire. */
export interface Selection {
  nodes: string[]
  /** Only present while a wire is selected; `nodes` is empty then. */
  wire?: Edge
}

/** Fluent handle for defining one node. */
export class NodeBuilder {
  constructor(private def: NodeDef, private view: View) {}

  private set(patch: Partial<NodeDef>) {
    Object.assign(this.def, patch)
    this.view.mark(this.def.id)
    return this
  }

  /** Sets the node's title text. */
  title(text: string) {
    return this.set({ title: text })
  }

  /** Places the node's top-left corner at world coordinates. */
  at(x: number, y: number) {
    Object.assign(this.def, { x, y, placed: true })
    this.view.place(this.def.id)
    return this
  }

  /** Sets extra CSS classes on the node, replacing earlier ones; e.g. a status like `'error'`. */
  class(...names: string[]) {
    this.def.classes = names
    this.view.place(this.def.id)
    return this
  }

  /** Mounts custom markup below the title; render it with any framework. */
  content(el: HTMLElement) {
    return this.set({ content: el })
  }
}

/** A node graph mounted in a DOM element. Starts in view mode unless the `mode` option says otherwise. */
export class Flow extends EventTarget {
  private graph = new Graph()
  private view: View
  private detach: () => void
  private packets: Packets
  // Snapshots from before each user edit, and from before each undo.
  private history: History<State>
  // Shared with the view and the input handlers, which read it on every event; set() updates it in place.
  private settings: Settings

  /**
   * Mounts a graph in `root`; prefer {@link flow}.
   * @throws if `minZoom` is above `maxZoom`.
   */
  constructor(private root: HTMLElement, options: FlowOptions = {}) {
    super()
    this.settings = settle(options)
    this.history = new History(this.settings.history)
    this.view = new View(root, this.graph, this.settings)
    this.packets = new Packets(this.view, this.graph)
    this.view.onSelect = () => this.fire('select', this.selection())
    this.view.onViewport = () => this.fire('viewport', this.viewport())
    this.detach = attach(this.view, this.graph, {
      changed: before => this.commit(before),
      undo: () => this.undo(),
      redo: () => this.redo(),
      pointer: (type, hit, e) => this.fire(type, hit, e),
      hover: hit => this.fire('hover', hit),
    })
    this.mode(options.mode ?? 'view')
    this.lock()
  }

  /**
   * Changes options while the graph is shown; fields left out keep their current value.
   * @remarks `fit` only matters before the first render; call {@link Flow.fit} to fit later.
   * Lowering `history` drops the oldest undo steps.
   * @throws if `minZoom` would end up above `maxZoom`; nothing changes then.
   */
  set(options: FlowOptions) {
    Object.assign(this.settings, settle(options, this.settings))
    this.history.resize(this.settings.history)
    if (options.mode) this.mode(options.mode)
    this.lock()
    this.view.update() // e.g. to show or hide the minimap
    return this
  }

  // Lists the edit rights that are off on the root, so CSS can hide anchors and grab cursors.
  private lock() {
    const off = (['connect', 'move', 'remove'] as const).filter(right => !this.settings[right])
    if (off.length) this.root.dataset.lock = off.join(' ')
    else delete this.root.dataset.lock
  }

  /** Switches between read-only viewing and editing wires and positions. */
  mode(mode: 'view' | 'edit') {
    this.root.dataset.mode = mode
    this.view.select()
    return this
  }

  /**
   * Defines a node, or returns a builder for an existing one.
   * @remarks For a node the user deleted it returns a builder for the stored definition without
   * bringing the node back; only undo or `load()` restore it.
   */
  node(id: string) {
    if (id.includes('.')) throw new Error(`betternodes: node id "${id}" must not contain "."`)
    let def = this.graph.nodes.get(id) ?? this.graph.trash.get(id)
    if (!def) {
      def = { id, title: id, x: 0, y: 0 }
      this.graph.nodes.set(id, def)
      this.view.mark(id)
    }
    return new NodeBuilder(def, this.view)
  }

  /**
   * Wires one node anchor to another, e.g. `connect('a.e', 'b.w')`.
   * Anchors: `nw n ne e se s sw w`.
   * @param options - `label` is a plain-text note shown halfway along the wire, `class` an extra
   * CSS class on it, see {@link Flow.wireClass}.
   * @throws if an anchor doesn't exist, both sit on the same node, or the wire exists.
   */
  connect<F extends string, T extends string>(from: End<F>, to: End<T>, options: { label?: string; class?: string } = {}) {
    this.graph.connect(from, to)
    if (options.label) this.graph.label(from, to, options.label)
    if (options.class) this.graph.classify(from, to, [options.class])
    this.view.update()
    return this
  }

  /**
   * Sets the plain-text note shown halfway along a wire; no `text` removes it.
   * @remarks Notes are part of your code, not of `state()`. A wire the user deletes keeps its note,
   * so undo brings both back.
   * @throws if there is no such wire.
   */
  label<F extends string, T extends string>(from: End<F>, to: End<T>, text?: string) {
    this.wire(from, to)
    this.graph.label(from, to, text)
    this.view.update()
    return this
  }

  /**
   * Sets extra CSS classes on a wire, replacing earlier ones; no names clear them. They go on the
   * wire's `<g>` and its note, e.g. `'error'` for a status, or the built-in `'bn-two-way'` and
   * `'bn-no-arrow'` arrowheads.
   * @remarks Like notes they belong to your code, survive deleting the wire, and move with a
   * wire end the user moves.
   * @throws if there is no such wire.
   */
  wireClass<F extends string, T extends string>(from: End<F>, to: End<T>, ...names: string[]) {
    this.wire(from, to)
    this.graph.classify(from, to, names)
    this.view.update()
    return this
  }

  private wire(from: string, to: string) {
    if (!this.graph.edges.has(`${from}>${to}`)) throw new Error(`betternodes: no wire ${from} -> ${to}`)
  }

  /**
   * Removes the wire from one anchor to another, e.g. `disconnect('a.e', 'b.w')`.
   * @throws if there is no such wire.
   */
  disconnect<F extends string, T extends string>(from: End<F>, to: End<T>) {
    if (!this.graph.disconnect(from, to)) throw new Error(`betternodes: no wire ${from} -> ${to}`)
    this.view.update()
    return this
  }

  /**
   * Deletes a node and its wires. It is listed in `state().removed`, so a saved state keeps it
   * deleted after a reload even though your code still defines it.
   * @throws if there is no such node.
   */
  remove(id: string) {
    if (!this.graph.remove(id)) throw new Error(`betternodes: no node "${id}"`)
    this.view.drop(id)
    return this
  }

  /**
   * Restores positions and wires saved from {@link Flow.state}; `null` is a no-op.
   * @remarks Wires to nodes or anchors that no longer exist are dropped with a console warning.
   */
  load(state: State | null | undefined) {
    if (!state) return this
    const shown = new Set(this.graph.nodes.keys())
    this.graph.load(state)
    for (const id of shown) if (!this.graph.nodes.has(id)) this.view.drop(id)
    // Restored nodes need their element rebuilt; the rest only move.
    for (const id of this.graph.nodes.keys()) {
      if (shown.has(id)) this.view.place(id)
      else this.view.mark(id)
    }
    return this
  }

  /**
   * Reverts the last user edit and emits `change`.
   * @remarks Restores the state from just before that edit, so code changes made since then are
   * reverted too. History keeps the last 100 edits unless the `history` option says otherwise.
   */
  undo() {
    return this.travel('undo')
  }

  /** Re-applies the last undone edit and emits `change`. */
  redo() {
    return this.travel('redo')
  }

  private travel(direction: 'undo' | 'redo') {
    const now = this.state()
    const target = this.history[direction](now)
    if (!target) return this
    // Cleared first, so load() dropping selected nodes doesn't shrink the selection one event at a time.
    this.view.select()
    this.load(target)
    this.emit(now)
    return this
  }

  private commit(before: State) {
    this.history.push(before)
    this.emit(before)
  }

  /**
   * Subscribes to user edits in edit mode; never fired by programmatic calls.
   * @param fn - gets the full new state, plus a diff of what this edit changed.
   * @param options - `signal` unsubscribes when aborted, e.g. in a framework effect's cleanup.
   */
  on(type: 'change', fn: (state: State, diff: Diff) => void, options?: { signal?: AbortSignal }): this
  /**
   * Subscribes to selection changes, whether the user or code made them, in both modes.
   * @remarks Never fires when the selection stayed the same, so calling `select()` from `fn` is safe.
   */
  on(type: 'select', fn: (selection: Selection) => void, options?: { signal?: AbortSignal }): this
  /**
   * Subscribes to clicks, double clicks or context menu events on nodes, wires or the background,
   * in both modes, whatever the options say.
   * @remarks A click is a press that moved less than 4px, so drags never count. Call
   * `event.preventDefault()` in a `contextmenu` listener to hide the browser's menu.
   */
  on(type: 'click' | 'dblclick' | 'contextmenu', fn: (hit: Hit, event: MouseEvent) => void, options?: { signal?: AbortSignal }): this
  /** Subscribes to the pointer moving onto another node or wire; `{}` means the background or outside. */
  on(type: 'hover', fn: (hit: Hit) => void, options?: { signal?: AbortSignal }): this
  /** Subscribes to pan and zoom changes, whether the user or code made them; at most once per frame. */
  on(type: 'viewport', fn: (viewport: Viewport) => void, options?: { signal?: AbortSignal }): this
  on(type: string, fn: (...args: never[]) => void, options?: { signal?: AbortSignal }) {
    this.addEventListener(type, e => fn(...(e as CustomEvent<never[]>).detail), options)
    return this
  }

  private fire(type: string, ...args: unknown[]) {
    this.dispatchEvent(new CustomEvent(type, { detail: args }))
  }

  private emit(before: State) {
    this.view.update()
    const state = this.state()
    this.fire('change', state, diff(before, state))
  }

  /**
   * Selects these nodes, replacing the current selection; no ids clear it.
   * @throws if an id is not a node.
   */
  select(...ids: string[]) {
    this.known(ids)
    this.view.select(ids)
    return this
  }

  /** The selected nodes or wire, as a copy. */
  selection(): Selection {
    const { nodes, wire } = this.view.selected
    const edge = wire ? this.graph.edges.get(wire) : undefined
    return edge ? { nodes: [], wire: [...edge] } : { nodes: [...nodes] }
  }

  /**
   * Re-arranges every node into columns that follow the wires, including nodes placed by `at()`,
   * `load()` or dragging. Runs immediately, so `state()` has the new positions right away.
   * @remarks Like other programmatic calls it emits no `change`; save `state()` yourself if needed.
   */
  layout() {
    this.view.relayout()
    return this
  }

  /**
   * Zooms (never past 100%) and pans so these nodes, or with no ids the whole graph, are visible;
   * applies on the next frame. Also runs on first render unless the `fit` option is off.
   * @throws if an id is not a node.
   */
  fit(...ids: string[]) {
    this.known(ids)
    this.view.fit(ids.length ? ids : undefined)
    return this
  }

  /** The current pan offset and zoom. */
  viewport(): Viewport
  /**
   * Pans and zooms; fields left out keep their value. Cancels the fit of the first render, so a
   * saved viewport can be restored right after mounting.
   */
  viewport(next: Partial<Viewport>): this
  viewport(next?: Partial<Viewport>) {
    const { x, y, k } = this.view
    if (!next) return { x, y, zoom: k }
    this.view.viewport(next.x ?? x, next.y ?? y, next.zoom ?? k)
    return this
  }

  /** Zooms by `factor` (e.g. 1.2 in, 1 / 1.2 out) around the middle of the view, within the zoom options. */
  zoomBy(factor: number) {
    this.view.zoomAt(this.root.clientWidth / 2, this.root.clientHeight / 2, this.view.k * factor)
    return this
  }

  /**
   * Sends a packet along the wires and resolves with the ids of the nodes it reached.
   * @remarks With `to`, it travels there over the fewest hops, picking each next wire when it gets
   * to a node, so edits made meanwhile are respected; it resolves `[to]`, or `[]` if no route is
   * left. Without `to` it flows: copies follow every outgoing wire (each wire once per send) and it
   * resolves with the end nodes reached, those without outgoing wires. Emits no `change`.
   * @throws if `from` or `to` is not a node.
   */
  send(from: string, to?: string, opts: SendOptions = {}) {
    this.known(to === undefined ? [from] : [from, to])
    return this.packets.send(from, to, opts)
  }

  private known(ids: string[]) {
    for (const id of ids) if (!this.graph.nodes.has(id)) throw new Error(`betternodes: no node "${id}"`)
  }

  /** Unmounts the graph and removes all listeners from the root element. */
  destroy() {
    this.packets.clear()
    this.detach()
    this.view.destroy()
    delete this.root.dataset.mode
    delete this.root.dataset.lock
  }

  /** Current positions and wires, ready to persist. */
  state() {
    return this.graph.toState()
  }
}
