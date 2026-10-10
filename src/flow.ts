import { GroupBuilder, NodeBuilder } from './builders'
import { checkClasses, fail } from './check'
import { Graph } from './model/graph'
import { History } from './model/history'
import { diff, wireKey, type State } from './model/state'
import { settle, type FlowOptions, type Settings } from './options'
import type { End, FlowEvents, Selection, Viewport } from './types'
import { attach, type Emitted } from './view/input/interact'
import { Packets, type SendOptions } from './view/packets/packets'
import { View } from './view/view'

const RIGHTS = ['connect', 'move', 'remove'] as const satisfies readonly (keyof Settings)[]

/** A node graph mounted in a DOM element. Starts in view mode unless the `mode` option says otherwise. */
export class Flow extends EventTarget {
  private readonly graph = new Graph()
  private readonly view: View
  private readonly packets: Packets
  private readonly history: History<State>
  // Shared by reference with the view and the input handlers, so set() takes effect on their next event.
  private readonly settings: Settings
  private readonly detach: () => void

  /**
   * Mounts a graph in `root`; prefer {@link flow}.
   * @throws if `minZoom` is above `maxZoom`.
   */
  constructor(private readonly root: HTMLElement, options: FlowOptions = {}) {
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
      emit: (...event) => this.fire(...event),
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
    this.view.update()
    return this
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
    if (id.includes('.')) fail(`node id "${id}" must not contain "."`)
    let def = this.graph.nodes.get(id) ?? this.graph.trash.get(id)
    if (!def) {
      def = { id, title: id, x: 0, y: 0 }
      this.graph.nodes.set(id, def)
      this.view.mark(id)
    }
    return new NodeBuilder(def, this.view)
  }

  /**
   * Defines a group, or returns a builder for an existing one; see {@link GroupBuilder}.
   * @remarks Groups belong to your code like node titles: they are not part of `state()`.
   */
  group(id: string) {
    let def = this.graph.groups.get(id)
    if (!def) this.graph.groups.set(id, (def = { id, title: id }))
    return new GroupBuilder(def, this.graph, this.view)
  }

  /**
   * Removes a group's frame; its nodes stay.
   * @throws if there is no such group.
   */
  ungroup(id: string) {
    if (!this.graph.groups.delete(id)) fail(`no group "${id}"`)
    this.graph.setMembers(id, [])
    this.view.markGroups()
    return this
  }

  /**
   * Wires one node anchor to another, e.g. `connect('a.e', 'b.w')`.
   * Anchors: `nw n ne e se s sw w`.
   * @param options - `label` is a plain-text note shown halfway along the wire, `class` an extra
   * CSS class on it, see {@link Flow.wireClass}.
   * @throws if an anchor doesn't exist, both sit on the same node, the wire exists, or `class` is
   * not one class name.
   */
  connect<F extends string, T extends string>(from: End<F>, to: End<T>, options: { label?: string; class?: string } = {}) {
    if (options.class) checkClasses([options.class])
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
   * @throws if there is no such wire, or a name is not one class name (empty or with spaces).
   */
  wireClass<F extends string, T extends string>(from: End<F>, to: End<T>, ...names: string[]) {
    checkClasses(names)
    this.wire(from, to)
    this.graph.classify(from, to, names)
    this.view.update()
    return this
  }

  /**
   * Removes the wire from one anchor to another, e.g. `disconnect('a.e', 'b.w')`.
   * @throws if there is no such wire.
   */
  disconnect<F extends string, T extends string>(from: End<F>, to: End<T>) {
    if (!this.graph.disconnect(from, to)) fail(`no wire ${from} -> ${to}`)
    this.view.update()
    return this
  }

  /**
   * Deletes a node and its wires. It is listed in `state().removed`, so a saved state keeps it
   * deleted after a reload even though your code still defines it.
   * @throws if there is no such node.
   */
  remove(id: string) {
    if (!this.graph.remove(id)) fail(`no node "${id}"`)
    this.view.drop(id)
    return this
  }

  /**
   * Restores positions and wires saved from {@link Flow.state}; `null` is a no-op.
   * @remarks Wires to nodes or anchors that no longer exist are dropped with a console warning. So
   * are malformed entries, e.g. from a corrupted save; a state of the wrong shape changes nothing.
   */
  load(state: State | null | undefined) {
    if (!state) return this
    // Where each shown node was: only nodes that came back or moved need work, since every node
    // handed to the view re-routes its wires on the next frame.
    const was = new Map<string, [x: number, y: number]>()
    for (const n of this.graph.nodes.values()) was.set(n.id, [n.x, n.y])
    if (!this.graph.load(state)) return this
    for (const id of was.keys()) if (!this.graph.nodes.has(id)) this.view.drop(id)
    for (const n of this.graph.nodes.values()) {
      const old = was.get(n.id)
      // Restored nodes need their element rebuilt; moved ones only a new position.
      if (!old) this.view.mark(n.id)
      else if (old[0] !== n.x || old[1] !== n.y) this.view.place(n.id)
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

  /**
   * Subscribes to an event; {@link FlowEvents} lists every type with its listener arguments.
   * @param options - `signal` unsubscribes when aborted, e.g. in a framework effect's cleanup.
   */
  on<K extends keyof FlowEvents>(type: K, fn: (...args: FlowEvents[K]) => void, options?: { signal?: AbortSignal }) {
    this.addEventListener(type, e => fn(...(e as CustomEvent<FlowEvents[K]>).detail), options)
    return this
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
    const edge = wire && this.graph.edges.get(wire)
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
   * @throws if a number is not finite, or the zoom is not above 0.
   */
  viewport(next: Partial<Viewport>): this
  viewport(next?: Partial<Viewport>) {
    const { x, y, k } = this.view
    if (!next) return { x, y, zoom: k }
    const [nx, ny, zoom] = [next.x ?? x, next.y ?? y, next.zoom ?? k]
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !(Number.isFinite(zoom) && zoom > 0)) {
      fail(`invalid viewport ${nx}, ${ny} at zoom ${zoom}`)
    }
    this.view.viewport(nx, ny, zoom)
    return this
  }

  /**
   * Zooms by `factor` (e.g. 1.2 in, 1 / 1.2 out) around the middle of the view, within the zoom options.
   * @throws if `factor` is not a finite number above 0.
   */
  zoomBy(factor: number) {
    if (!(Number.isFinite(factor) && factor > 0)) fail(`invalid zoom factor ${factor}`)
    this.view.zoomAt(this.root.clientWidth / 2, this.root.clientHeight / 2, this.view.k * factor)
    return this
  }

  /**
   * Sends a packet along the wires and resolves with the ids of the nodes it reached.
   * @remarks With `to`, it travels there over the fewest hops, picking each next wire when it gets
   * to a node, so edits made meanwhile are respected; it resolves `[to]`, or `[]` if no route is
   * left. Without `to` it flows: copies follow every outgoing wire (each wire once per send) and it
   * resolves with the end nodes reached, those without outgoing wires. Emits no `change`.
   * @throws if `from` or `to` is not a node, `class` is not one class name, or `speed` is not a
   * finite number above 0.
   */
  send(from: string, to?: string, opts: SendOptions = {}) {
    this.known(to === undefined ? [from] : [from, to])
    if (opts.class) checkClasses([opts.class])
    // A packet that never arrives would keep frames running forever.
    if (opts.speed !== undefined && !(Number.isFinite(opts.speed) && opts.speed > 0)) fail(`invalid packet speed ${opts.speed}`)
    return this.packets.send(from, to, opts)
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

  // Lists the edit rights that are off on the root, so CSS can hide anchors and grab cursors.
  private lock() {
    const off = RIGHTS.filter(right => !this.settings[right])
    if (off.length) this.root.dataset.lock = off.join(' ')
    else delete this.root.dataset.lock
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

  private emit(before: State) {
    this.view.update()
    const state = this.state()
    this.fire('change', state, diff(before, state))
  }

  private fire(...[type, ...args]: Emitted<FlowEvents>) {
    this.dispatchEvent(new CustomEvent(type, { detail: args }))
  }

  private wire(from: string, to: string) {
    if (!this.graph.edges.has(wireKey(from, to))) fail(`no wire ${from} -> ${to}`)
  }

  private known(ids: string[]) {
    for (const id of ids) if (!this.graph.nodes.has(id)) fail(`no node "${id}"`)
  }
}
