import { CAMPAIGN_CATEGORIES } from "./constants.js";

export function isValidCategory(category: string): boolean {
  return (CAMPAIGN_CATEGORIES as readonly string[]).includes(category);
}
