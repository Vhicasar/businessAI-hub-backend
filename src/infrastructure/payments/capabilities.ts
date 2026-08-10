import type { PaymentMethodKind } from '@prisma/client';
import type { PaymentProviderName } from './types';

/**
 * What each gateway can actually collect, as shipped.
 *
 * This is the *seed* for the ProviderCapability table, not the runtime answer —
 * an operator can turn a method off, add a currency or record a limit without a
 * deploy (§18). Keeping the shipped defaults here means a fresh install and a
 * new provider both start from something truthful rather than from nothing.
 *
 * Currencies/countries left empty mean "no restriction beyond what the gateway
 * itself settles"; the resolver reads empty as "any".
 */
export interface ProviderMethodSupport {
  method: PaymentMethodKind;
  currencies?: string[];
  countries?: string[];
  minAmount?: number;
  maxAmount?: number;
  notes?: string;
}

export const PROVIDER_CAPABILITIES: Record<PaymentProviderName, ProviderMethodSupport[]> = {
  paystack: [
    { method: 'CARD' },
    { method: 'BANK_TRANSFER', currencies: ['NGN'] },
    {
      method: 'VIRTUAL_ACCOUNT',
      currencies: ['NGN'],
      notes: 'Dedicated NUBAN. Held against the business or customer, not per charge.',
    },
    {
      method: 'USSD',
      currencies: ['NGN'],
      countries: ['NG'],
      maxAmount: 100_000,
      notes: 'Bank USSD ceilings apply; above this the customer is pushed to transfer.',
    },
    { method: 'QR_CODE', currencies: ['NGN'], countries: ['NG'] },
    { method: 'MOBILE_MONEY', currencies: ['GHS', 'KES'], countries: ['GH', 'KE'] },
    { method: 'PAY_WITH_BANK', currencies: ['NGN'], countries: ['NG'] },
    { method: 'PAYMENT_LINK' },
    { method: 'APPLE_PAY' },
  ],
  flutterwave: [
    { method: 'CARD' },
    { method: 'BANK_TRANSFER', currencies: ['NGN', 'GHS', 'KES', 'ZAR', 'UGX', 'TZS'] },
    { method: 'VIRTUAL_ACCOUNT', currencies: ['NGN'] },
    { method: 'USSD', currencies: ['NGN'], countries: ['NG'], maxAmount: 100_000 },
    { method: 'QR_CODE', currencies: ['NGN'], countries: ['NG'] },
    {
      method: 'MOBILE_MONEY',
      currencies: ['GHS', 'KES', 'UGX', 'TZS', 'RWF', 'XAF', 'XOF'],
      countries: ['GH', 'KE', 'UG', 'TZ', 'RW', 'CM', 'CI', 'SN'],
    },
    { method: 'PAY_WITH_BANK', currencies: ['NGN'], countries: ['NG'] },
    { method: 'PAYMENT_LINK' },
  ],
  stripe: [
    { method: 'CARD' },
    { method: 'APPLE_PAY' },
    { method: 'GOOGLE_PAY' },
    { method: 'DIRECT_DEBIT', currencies: ['USD', 'GBP', 'EUR'] },
    {
      method: 'BANK_TRANSFER',
      currencies: ['USD', 'GBP', 'EUR'],
      notes: 'Stripe bank transfers are region-gated; confirm on the account before enabling.',
    },
    { method: 'PAYMENT_LINK' },
  ],
  opay: [
    { method: 'CARD', currencies: ['NGN'], countries: ['NG'] },
    { method: 'BANK_TRANSFER', currencies: ['NGN'], countries: ['NG'] },
    {
      method: 'WALLET',
      currencies: ['NGN'],
      countries: ['NG'],
      notes: 'The customer’s own OPay wallet, not the Vhicasar wallet.',
    },
    { method: 'USSD', currencies: ['NGN'], countries: ['NG'], maxAmount: 100_000 },
    { method: 'QR_CODE', currencies: ['NGN'], countries: ['NG'] },
    { method: 'PAY_WITH_BANK', currencies: ['NGN'], countries: ['NG'] },
    { method: 'PAYMENT_LINK', currencies: ['NGN'], countries: ['NG'] },
  ],
  moniepoint: [
    { method: 'CARD', currencies: ['NGN'] },
    { method: 'BANK_TRANSFER', currencies: ['NGN'] },
    {
      method: 'VIRTUAL_ACCOUNT',
      currencies: ['NGN'],
      notes: 'Reserved account. Held against the business or customer, not minted per charge.',
    },
    { method: 'USSD', currencies: ['NGN'], countries: ['NG'], maxAmount: 100_000 },
    { method: 'PAY_WITH_BANK', currencies: ['NGN'], countries: ['NG'] },
    { method: 'PAYMENT_LINK', currencies: ['NGN'] },
  ],
};

/**
 * How a business labels the third credential its gateway needs.
 *
 * Both Nigerian gateways want an account identifier alongside the key pair, and
 * they call it different things — asking for "merchant id" when the dashboard
 * says "contract code" is how a business ends up pasting the wrong value.
 */
export const MERCHANT_ID_LABEL: Partial<Record<PaymentProviderName, string>> = {
  opay: 'Merchant ID',
  moniepoint: 'Contract code',
};

export const PROVIDER_LABELS: Record<PaymentProviderName, string> = {
  paystack: 'Paystack',
  flutterwave: 'Flutterwave',
  stripe: 'Stripe',
  opay: 'OPay',
  moniepoint: 'Moniepoint',
};

/**
 * Methods the platform settles itself, independent of any gateway.
 *
 * The Vhicasar wallet is ours: it needs no provider, so it is available to any
 * business that enables it. Cash on delivery collects nothing online at all —
 * it is here so a business can offer it and so the customer app can show it
 * without pretending a gateway is involved.
 */
export const PLATFORM_NATIVE_METHODS: ProviderMethodSupport[] = [
  { method: 'WALLET', notes: 'Vhicasar wallet. Settled internally, no gateway involved.' },
  { method: 'CASH_ON_DELIVERY', notes: 'Collected off-platform; never marks an intent PAID online.' },
];

/** Everything the platform knows how to represent, in display order. */
export const ALL_METHODS: PaymentMethodKind[] = [
  'CARD',
  'BANK_TRANSFER',
  'VIRTUAL_ACCOUNT',
  'USSD',
  'QR_CODE',
  'MOBILE_MONEY',
  'PAY_WITH_BANK',
  'WALLET',
  'PAYMENT_LINK',
  'DIRECT_DEBIT',
  'APPLE_PAY',
  'GOOGLE_PAY',
  'PAYPAL',
  'CRYPTO',
  'CASH_ON_DELIVERY',
];

export const METHOD_LABELS: Record<PaymentMethodKind, string> = {
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  VIRTUAL_ACCOUNT: 'Virtual account',
  USSD: 'USSD',
  QR_CODE: 'QR code',
  MOBILE_MONEY: 'Mobile money',
  PAY_WITH_BANK: 'Pay with bank',
  WALLET: 'Vhicasar wallet',
  PAYMENT_LINK: 'Payment link',
  DIRECT_DEBIT: 'Direct debit',
  APPLE_PAY: 'Apple Pay',
  GOOGLE_PAY: 'Google Pay',
  PAYPAL: 'PayPal',
  CRYPTO: 'Crypto',
  CASH_ON_DELIVERY: 'Cash on delivery',
};
