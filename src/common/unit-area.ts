/**
 * Area rule for a unit EDIT (the create path checks `area > 0` directly).
 *
 * - A unit that stays/becomes a draft is exempt.
 * - An edit that sends `area` must send a positive one.
 * - Finalising a draft (draft → live) without sending `area` checks the area
 *   already on the row: a draft saved with no area may not go live on a bare
 *   `{ isDraft: false }`. An Ejar-imported unit (has `ejarId`) is exempt, as
 *   on create — Ejar is the source of truth and may not carry an area.
 * - A live unit edited without touching `area` is left alone, so older units
 *   that never had one stay editable.
 */
export function unitAreaViolates(p: {
  wasDraft: boolean;
  willBeDraft: boolean;
  areaSent: boolean;
  nextArea: unknown;
  isEjar: boolean;
}): boolean {
  if (p.willBeDraft) return false;
  const positive = Number(p.nextArea) > 0;
  if (p.areaSent) return !positive;
  if (p.wasDraft && !p.isEjar) return !positive;
  return false;
}
