// The Lexware API uses these lowercase strings as the authoritative canonical
// voucher status values. This function normalises user-supplied input (e.g.
// "OPEN", "Paid") to canonical form so that filter calls never silently return
// zero results due to a casing mismatch.
//
// Unknown values are lowercased as a best-effort fallback; the API rejects
// truly invalid status strings with a 400 error.
const KNOWN_STATUSES: Readonly<Record<string, string>> = {
  unchecked:   'unchecked',   // pending review
  open:        'open',        // open / due for payment
  paid:        'paid',        // paid
  paidoff:     'paidoff',     // settled
  voided:      'voided',      // voided / cancelled
  transferred: 'transferred', // transferred / posted
  sepadebit:   'sepadebit',   // SEPA direct debit
};

export function normalizeVoucherStatus(status: string): string {
  const key = status.toLowerCase().trim();
  return KNOWN_STATUSES[key] ?? key;
}
