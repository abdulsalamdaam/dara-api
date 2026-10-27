/**
 * Who a message to a landlord or tenant actually goes to.
 *
 * A landlord (owners) or tenant row may carry a representative (وكيل / ممثل):
 * `isRepresentative = true` plus the representative's own name, ID, phone and
 * e-mail in the `original*` columns (originalOwner* / originalTenant*). That is
 * what the web forms label «اسم الممثل» and what the Ejar import writes from
 * the contract's representative object — despite the older schema comments,
 * the `original*` columns hold the REPRESENTATIVE, and the row's own
 * name/phone/email stay the party's.
 *
 * Owner note: reminders and every other message go to the representative when
 * the party has one. Per channel, the representative's contact wins when it is
 * set; when the representative has none for that channel the party's own
 * contact is used, so a half-filled representative never silences a message.
 *
 * The greeting follows the recipient: a message delivered to the
 * representative addresses the representative by name (falling back to the
 * party's name when the representative has none on file).
 *
 * Push is NOT routed here. A push goes to the device token of whoever signed
 * in to the app as that party (`fcm_token` on the row). Both the party and the
 * representative can sign in with their own phone (auth.service
 * findOwnerByLoginPhone / findTenantByLoginPhone), so the push reaches
 * whichever of them last signed in on a device.
 */

export interface PartyContactInput {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  isRepresentative?: boolean | null;
  representativeName?: string | null;
  representativePhone?: string | null;
  representativeEmail?: string | null;
}

export interface ChannelRecipient {
  /** Where to deliver; null when neither the representative nor the party has one. */
  to: string | null;
  /** Whom to greet. */
  name: string;
  /** True when `to` is the representative's contact rather than the party's. */
  viaRepresentative: boolean;
}

export interface PartyContact {
  email: ChannelRecipient;
  phone: ChannelRecipient;
}

const clean = (v: string | null | undefined): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s ? s : null;
};

function pick(p: PartyContactInput, own: string | null | undefined, rep: string | null | undefined): ChannelRecipient {
  const partyName = clean(p.name) ?? "";
  const repTo = p.isRepresentative ? clean(rep) : null;
  if (repTo) return { to: repTo, name: clean(p.representativeName) ?? partyName, viaRepresentative: true };
  return { to: clean(own), name: partyName, viaRepresentative: false };
}

/** Resolve the e-mail and SMS recipient of a landlord or tenant (see the file header). */
export function resolvePartyContact(p: PartyContactInput): PartyContact {
  return {
    email: pick(p, p.email, p.representativeEmail),
    phone: pick(p, p.phone, p.representativePhone),
  };
}

/** A landlord row (or the subset of it a query selected). */
export interface OwnerContactRow {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  isRepresentative?: boolean | null;
  originalOwnerName?: string | null;
  originalOwnerPhone?: string | null;
  originalOwnerEmail?: string | null;
}

export const resolveOwnerContact = (o: OwnerContactRow): PartyContact => resolvePartyContact({
  name: o.name, phone: o.phone, email: o.email, isRepresentative: o.isRepresentative,
  representativeName: o.originalOwnerName, representativePhone: o.originalOwnerPhone, representativeEmail: o.originalOwnerEmail,
});

/** A tenant row (or the subset of it a query selected). */
export interface TenantContactRow {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  isRepresentative?: boolean | null;
  originalTenantName?: string | null;
  originalTenantPhone?: string | null;
  originalTenantEmail?: string | null;
}

export const resolveTenantContact = (t: TenantContactRow): PartyContact => resolvePartyContact({
  name: t.name, phone: t.phone, email: t.email, isRepresentative: t.isRepresentative,
  representativeName: t.originalTenantName, representativePhone: t.originalTenantPhone, representativeEmail: t.originalTenantEmail,
});
