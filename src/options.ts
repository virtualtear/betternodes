/** Behaviour switches for {@link flow} and {@link Flow.set}; every field is optional. */
export interface FlowOptions {
  /**
   * Mode to start in; in `set()` it switches modes like {@link Flow.mode}.
   * @defaultValue `'view'`
   */
  mode?: 'view' | 'edit'
  /**
   * Zooming with the mouse wheel or a trackpad pinch. Off, wheel events reach the page, so it
   * scrolls past the graph.
   * @defaultValue `true`
   */
  zoom?: boolean
  /**
   * Smallest zoom factor for the wheel and for `fit()`.
   * @defaultValue `0.1`
   */
  minZoom?: number
  /**
   * Largest zoom factor for the wheel; `fit()` never zooms past 1 either way.
   * @defaultValue `4`
   */
  maxZoom?: number
  /**
   * Panning by dragging, and scrolling the view while dragging near its edge.
   * @defaultValue `true`
   */
  pan?: boolean
  /**
   * Fitting the whole graph into view on the first render.
   * @defaultValue `true`
   */
  fit?: boolean
  /**
   * Selecting by clicking, Shift+clicking, drawing a box or pressing Esc. `select()` from code
   * works either way.
   * @defaultValue `true`
   */
  select?: boolean
  /**
   * Editor keys: Delete and Backspace, Ctrl+Z and Ctrl+Y, Esc.
   * @defaultValue `true`
   */
  keys?: boolean
  /**
   * How many edits undo can revert; 0 turns undo and redo off.
   * @defaultValue `100`
   */
  history?: number
  /**
   * Edit mode: drawing new wires and moving wire ends.
   * @defaultValue `true`
   */
  connect?: boolean
  /**
   * Edit mode: dragging nodes.
   * @defaultValue `true`
   */
  move?: boolean
  /**
   * Edit mode: deleting nodes and wires.
   * @defaultValue `true`
   */
  remove?: boolean
  /**
   * Snapping dropped nodes to the 20px grid; while dragged they follow the pointer freely.
   * @defaultValue `true`
   */
  snap?: boolean
  /**
   * An overview of the whole graph in the bottom-right corner; click or drag in it to pan.
   * @defaultValue `false`
   */
  minimap?: boolean
  /**
   * Decides whether a wire the user draws or reconnects may exist; return false to reject it.
   * Gets the ends as they would be stored: `'node.anchor'`, or a bare node id for a floating end.
   * Wires from code are never checked.
   * @defaultValue allows every wire
   */
  canConnect?: (from: string, to: string) => boolean
}

/** Resolved options, shared by reference between the flow, its view and its input handling. */
export type Settings = Required<Omit<FlowOptions, 'mode'>>

const DEFAULTS: Settings = {
  zoom: true,
  minZoom: 0.1,
  maxZoom: 4,
  pan: true,
  fit: true,
  select: true,
  keys: true,
  history: 100,
  connect: true,
  move: true,
  remove: true,
  snap: true,
  minimap: false,
  canConnect: () => true,
}

/**
 * A copy of `base` with `options` applied, ignoring `mode` and fields set to `undefined`.
 * @throws if `minZoom` would end up above `maxZoom`.
 */
export function settle(options: FlowOptions, base = DEFAULTS): Settings {
  const out = { ...base }
  const { mode: _, ...rest } = options
  for (const [key, value] of Object.entries(rest)) if (value !== undefined) Object.assign(out, { [key]: value })
  if (out.minZoom > out.maxZoom) throw new Error(`betternodes: minZoom ${out.minZoom} is above maxZoom ${out.maxZoom}`)
  return out
}
