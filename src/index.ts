import { Flow } from './flow'
import type { FlowOptions } from './options'

export { GroupBuilder, NodeBuilder } from './builders'
export { Flow } from './flow'
export type { Anchor } from './model/graph'
export type { Diff, Edge, State } from './model/state'
export type { FlowOptions } from './options'
export type { End, FlowEvents, Selection, Viewport } from './types'
export type { Hit } from './view/input/interact'
export type { SendOptions } from './view/packets/packets'

/**
 * Mounts a node graph in `root`.
 * @throws if `minZoom` is above `maxZoom`.
 */
export const flow = (root: HTMLElement, options?: FlowOptions) => new Flow(root, options)
