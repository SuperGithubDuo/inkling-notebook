/** Minimal typed event emitter. `on` returns an unsubscribe function. */
export type Listener<T> = (payload: T) => void

export class Emitter<M extends object> {
  private readonly map = new Map<keyof M, Set<Listener<never>>>()

  on<K extends keyof M>(event: K, fn: Listener<M[K]>): () => void {
    let set = this.map.get(event)
    if (!set) this.map.set(event, (set = new Set()))
    set.add(fn as Listener<never>)
    return () => this.off(event, fn)
  }

  off<K extends keyof M>(event: K, fn: Listener<M[K]>): void {
    this.map.get(event)?.delete(fn as Listener<never>)
  }

  emit<K extends keyof M>(event: K, payload: M[K]): void {
    const set = this.map.get(event)
    if (!set) return
    for (const fn of [...set]) {
      try {
        ;(fn as Listener<M[K]>)(payload)
      } catch (err) {
        // One faulty subscriber must never break the input pipeline.
        console.error(`[wisp] listener for "${String(event)}" threw`, err)
      }
    }
  }

  listenerCount(event: keyof M): number {
    return this.map.get(event)?.size ?? 0
  }

  clear(): void {
    this.map.clear()
  }
}
