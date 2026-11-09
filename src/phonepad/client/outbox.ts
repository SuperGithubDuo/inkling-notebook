/**
 * Messages the desktop hasn't confirmed yet. Ink and commands stay here until
 * acknowledged, and are sent again, in order, after a reconnect; the desktop
 * drops duplicates. View gestures (pan/zoom) are never queued.
 */
export interface Queued {
  id: string
  seq: number
  message: object
}

export class Outbox {
  private items: Queued[] = []

  constructor(private readonly limit = 20000) {}

  push(id: string, seq: number, message: object): void {
    this.items.push({ id, seq, message })
    // A phone offline for a very long time keeps its newest writing.
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit)
  }

  /** Everything of `id` up to and including `seq` has arrived. */
  ack(id: string, seq: number): void {
    this.items = this.items.filter((q) => q.id !== id || q.seq > seq)
  }

  pending(): object[] {
    return this.items.map((q) => q.message)
  }

  has(id: string): boolean {
    return this.items.some((q) => q.id === id)
  }

  get size(): number {
    return this.items.length
  }
}
