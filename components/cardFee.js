// Stripe's card fee, worked out the same way as the server (lib/server/rules.js cardFeeFor), so
// parents see the exact amount before they pay. Rule: { percent, fixedNzd } from the club's settings.
export const DEFAULT_CARD_FEE_RULE = { percent: 2.65, fixedNzd: 0.3 };

export function cardFeeFor(amountNzd, rule = DEFAULT_CARD_FEE_RULE) {
  const base = Math.round(Number(amountNzd || 0) * 100);
  if (!(base > 0)) return 0;
  const fixed = Math.round(rule.fixedNzd * 100);
  const gross = (base + fixed) / (1 - rule.percent / 100);
  return Math.max(0, Math.floor(gross - base)) / 100;
}
