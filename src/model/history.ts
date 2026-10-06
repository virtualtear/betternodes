/** Bounded undo/redo stacks of snapshots. */
export class History<T> {
  private past: T[] = []
  private future: T[] = []

  constructor(private limit = 100) {}

  /** Records the snapshot from just before a new edit; clears the redo stack. */
  push(before: T) {
    this.past.push(before)
    // ponytail: whole snapshots; store inverse diffs if they get huge.
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
  }

  /** Trades the current snapshot `now` for the one before the last edit; undefined without history. */
  undo(now: T) {
    return this.move(this.past, this.future, now)
  }

  /** Trades `now` for the snapshot the last undo left; undefined when nothing was undone. */
  redo(now: T) {
    return this.move(this.future, this.past, now)
  }

  private move(from: T[], to: T[], now: T) {
    const target = from.pop()
    if (target !== undefined) to.push(now)
    return target
  }
}
