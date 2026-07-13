import { PURCHASE_CREDITS_PER_DOLLAR, WITHDRAW_CREDITS_PER_DOLLAR } from "./constants";

export function creditsToPurchaseDollars(credits: number): number {
  return credits / PURCHASE_CREDITS_PER_DOLLAR;
}

export function creditsToWithdrawDollars(credits: number): number {
  return credits / WITHDRAW_CREDITS_PER_DOLLAR;
}
