/**
 * Selection store with optional source attribution.
 *
 * `source` records what triggered the selection — used by views that
 * need to render "the source of the query" differently from the rest
 * of the selection, and by the Sankey diagram which only appears when
 * the source is an employer.
 */

type Listener = (selection: Selection) => void;

export type SelectionSource =
  | { kind: "employer"; employerId: number }
  | { kind: "building"; buildingId: number }
  | { kind: "chart"; label?: string }
  | null;

export class Selection {
  readonly participantIds: ReadonlySet<number>;
  readonly source: SelectionSource;

  constructor(ids: Iterable<number> = [], source: SelectionSource = null) {
    this.participantIds = new Set(ids);
    this.source = source;
  }

  get isEmpty(): boolean {
    return this.participantIds.size === 0;
  }

  has(id: number): boolean {
    return this.participantIds.has(id);
  }

  includes(id: number): boolean {
    return this.isEmpty || this.participantIds.has(id);
  }
}

class Store {
  private current = new Selection();
  private listeners = new Set<Listener>();

  get(): Selection {
    return this.current;
  }

  set(next: Selection): void {
    this.current = next;
    for (const fn of this.listeners) fn(this.current);
  }

  setIds(ids: Iterable<number>, source: SelectionSource = null): void {
    this.set(new Selection(ids, source));
  }

  clear(): void {
    this.set(new Selection());
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const selection = new Store();

/**
 * Global "top friends per person" slider value used by the Sankey diagram.
 * Default 5; range 1-20.
 */
type TopNListener = (n: number) => void;

class TopNStore {
  private current = 5;
  private listeners = new Set<TopNListener>();

  get(): number {
    return this.current;
  }

  set(n: number): void {
    const clamped = Math.max(1, Math.min(20, Math.round(n)));
    if (clamped === this.current) return;
    this.current = clamped;
    for (const fn of this.listeners) fn(this.current);
  }

  subscribe(fn: TopNListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const topN = new TopNStore();
