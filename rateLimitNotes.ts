# Rate limiting guidance for production Fundora deployments.
# Prefer edge/WAF throttling in front of Vercel, then add Redis-backed limits for:
# - POST /api/auth/sign-in/email
# - POST /api/contributions
# - POST /api/payments/create-checkout
export const SENSITIVE_ROUTES = [
  "/api/auth/sign-in/email",
  "/api/contributions",
  "/api/payments/create-checkout",
  "/api/withdrawals",
] as const;
