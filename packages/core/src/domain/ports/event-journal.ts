import type { HookDelivery } from '../entities/hook-delivery';

/**
 * Where events go so that they are still there tomorrow.
 *
 * This is the one item of §10.1а that M1 implements rather than merely names,
 * and the reason is asymmetry: the other four cost a schema migration if we get
 * them wrong, while an event consumed and not written is simply gone. The
 * strategy the product is aimed at -- "keep track of what the agent is doing
 * right now, whether it has started making mistakes, whether it is starting to
 * inflate the scope" -- is answerable from a history and from nothing else. A
 * snapshot cannot answer it, however complete.
 *
 * Append-only by shape. There is no read side here yet, and that is deliberate:
 * the reader belongs to whoever first has a question to ask of the history, and
 * inventing its interface now would be designing by imagination.
 */
export interface EventJournal {
  append: (delivery: HookDelivery) => Promise<void>;
}
