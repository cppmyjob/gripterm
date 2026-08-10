/**
 * The only source of "now" in the domain.
 *
 * It exists so that a test can state a time instead of tolerating one. Every
 * timestamp this extension stores -- `createdAt`, `lastEventAt`, a heartbeat --
 * is read through here, and a direct `new Date()` anywhere in `packages/core`
 * is a defect, not a shortcut.
 */
export interface Clock {
  now: () => Date;
}
