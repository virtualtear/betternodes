import { Flow } from './flow'
import type { FlowOptions } from './options'

export { Flow, NodeBuilder, type End, type Hit, type Selection, type Viewport } from './flow'
export type { Anchor, Diff, Edge, State } from './model/graph'
export type { FlowOptions } from './options'
export type { SendOptions } from './view/packets'

/**
 * Mounts a node graph in `root`.
 * @throws if `minZoom` is above `maxZoom`.
 */
export const flow = (root: HTMLElement, options?: FlowOptions) => new Flow(root, options)
