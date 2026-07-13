/**
 * Fundora platform constants shared by API handlers.
 * Kept small so business rules stay discoverable in one place.
 */
export const CREDIT_PACKAGES = {
  "100": { credits: 100, price: 10, label: "100 credits" },
  "300": { credits: 300, price: 25, label: "300 credits" },
  "800": { credits: 800, price: 60, label: "800 credits" },
  "1500": { credits: 1500, price: 110, label: "1500 credits" },
} as const;

export const REGISTRATION_CREDITS = {
  supporter: 50,
  creator: 20,
  admin: 0,
} as const;

/** Supporters buy credits cheaper than creators can withdraw — platform spread. */
export const PURCHASE_CREDITS_PER_DOLLAR = 10;
export const WITHDRAW_CREDITS_PER_DOLLAR = 20;
export const MIN_WITHDRAWAL_CREDITS = 200;

export const CAMPAIGN_CATEGORIES = [
  "Technology",
  "Art",
  "Community",
  "Health",
  "Education",
  "Environment",
  "Social Impact",
] as const;
