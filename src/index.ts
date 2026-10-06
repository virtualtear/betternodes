import { Flow } from './flow'

export { Flow, NodeBuilder, type End, type Selection } from './flow'
export type { Anchor, Diff, Edge, State } from './model/graph'
export type { SendOptions } from './view/packets'

/** Mounts a node graph in `root`. */
export const flow = (root: HTMLElement) => new Flow(root)
