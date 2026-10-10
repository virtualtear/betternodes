import type { Anchor } from './model/graph'
import type { Diff, Edge } from './model/state'
import type { InputEvents } from './view/input/interact'

/**
 * A wire end: `'nodeId.anchor'`, or a bare `'nodeId'`. String literals are checked, so a typo like
 * `'a.x'` fails to compile; non-literal strings pass and are validated at runtime.
 */
export type End<S extends string> = S extends `${infer Id}.${infer A}` ? (A extends Anchor ? S : `${Id}.${Anchor}`) : S

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

/** Listener arguments of every event `Flow.on()` subscribes to, by event type. */
export interface FlowEvents extends InputEvents {
  /**
   * A user edit in edit mode, with what it changed; code never fires it.
   * @remarks Call `state()` in the listener for the whole state; building it costs time in
   * proportion to the graph, so it isn't passed along.
   */
  change: [diff: Diff]
  /**
   * The selection changed, whether the user or code changed it, in both modes.
   * @remarks Never fires when the selection stayed the same, so calling `select()` from a listener is safe.
   */
  select: [selection: Selection]
  /** Pan or zoom changed, whether the user or code changed it; at most once per frame. */
  viewport: [viewport: Viewport]
}
