import { Graph, diff, type Anchor, type Diff, type Edge, type NodeDef, type State } from './model/graph'
import { History } from './model/history'
import { attach } from './view/interact'
import { Packets, type SendOptions } from './view/packets'
import { View } from './view/view'

/**
 * A wire end: `'nodeId.anchor'`, or a bare `'nodeId'`. String literals are checked, so a typo like
 * `'a.x'` fails to compile; non-literal strings pass and are validated at runtime.
 */
export type End<S extends string> = S extends `${infer Id}.${infer A}` ? (A extends Anchor ? S : `${Id}.${Anchor}`) : S

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

/** A node graph mounted in a DOM element. Starts in view mode. */
export class Flow extends EventTarget {
  private graph = new Graph()
  private view: View
  private detach: () => void
  private packets: Packets
  // Snapshots from before each user edit, and from before each undo.
  private history = new History<State>()

  constructor(private root: HTMLElement) {
    super()
    this.view = new View(root, this.graph)
    this.packets = new Packets(this.view, this.graph)
    this.view.onSelect = () => this.fire('select', this.selection())
    this.detach = attach(this.view, this.graph, {
      changed: before => this.commit(before),
      undo: () => this.undo(),
      redo: () => this.redo(),
    })
    this.mode('view')
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
   * @param options - `label` is a plain-text note shown halfway along the wire.
   * @throws if an anchor doesn't exist, both sit on the same node, or the wire exists.
   */
  connect<F extends string, T extends string>(from: End<F>, to: End<T>, options: { label?: string } = {}) {
    this.graph.connect(from, to)
    if (options.label) this.graph.label(from, to, options.label)
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
    if (!this.graph.edges.has(`${from}>${to}`)) throw new Error(`betternodes: no wire ${from} -> ${to}`)
    this.graph.label(from, to, text)
    this.view.update()
    return this
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
   * reverted too. History keeps the last 100 edits.
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
    for (const id of ids) if (!this.graph.nodes.has(id)) throw new Error(`betternodes: no node "${id}"`)
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

  /** Zooms (never past 100%) and pans so the whole graph is visible; also runs on first render. */
  fit() {
    this.view.fit()
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
    for (const id of [from, to]) if (id !== undefined && !this.graph.nodes.has(id)) throw new Error(`betternodes: no node "${id}"`)
    return this.packets.send(from, to, opts)
  }

  /** Unmounts the graph and removes all listeners from the root element. */
  destroy() {
    this.packets.clear()
    this.detach()
    this.view.destroy()
    delete this.root.dataset.mode
  }

  /** Current positions and wires, ready to persist. */
  state() {
    return this.graph.toState()
  }
}
