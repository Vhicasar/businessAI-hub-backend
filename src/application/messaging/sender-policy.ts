/**
 * Who is allowed to send as Vhicasar.
 *
 * A business's customers should hear from the business, not from us. If an
 * invoice, a booking confirmation or a campaign went out of Vhicasar's mail
 * server, the customer sees an address they do not recognise, replies vanish
 * into a system nobody reads, and the business's own domain reputation never
 * gets used. So the default is: the business sends, through a channel it has
 * connected — and where it has not connected one, it is asked to, rather than
 * having the platform quietly stand in.
 *
 * The exceptions are the messages that are genuinely *from* Vhicasar, where
 * sending as the business would be wrong or impossible:
 *
 *  - Account security — email verification, password resets. These establish
 *    the platform account itself; a business channel cannot vouch for it, and
 *    a business must not be able to intercept them.
 *  - Team invitations — the recipient has no relationship with the business
 *    yet, only with the platform.
 *  - Platform notices to the business — settlement account changes, billing,
 *    an assignment landing on a colleague. The audience is the business's own
 *    staff and the sender really is Vhicasar.
 *  - Vhicasar consumer-app invitations — explicitly Vhicasar's own product.
 *
 * Everything a customer receives about their order, invoice, booking or
 * payment belongs to the business.
 */

export type SenderCategory =
  /** Vhicasar speaking as itself, to a platform user. */
  | 'PLATFORM_ACCOUNT'
  /** Vhicasar telling a business's staff something about their workspace. */
  | 'PLATFORM_NOTICE'
  /** The business speaking to its own customer. */
  | 'BUSINESS_TO_CUSTOMER';

/**
 * Whether the platform mail transport may carry this.
 *
 * Deliberately a function over an explicit category rather than a guess based
 * on the recipient: a staff member and a customer can share an address, and
 * what matters is who the message is *from*.
 */
export function mayUsePlatformSender(category: SenderCategory): boolean {
  return category !== 'BUSINESS_TO_CUSTOMER';
}

/** What to tell someone whose business has no channel connected. */
export const CONNECT_CHANNEL_HINT =
  'Connect an email, WhatsApp or SMS channel in Settings → Integrations so this is sent from your own address.';
