// Unique Fundora extras — campaign momentum score for explore ranking helpers.
export function momentumScore(amountRaised: number, fundingGoal: number, deadline: Date): number {
  const progress = fundingGoal > 0 ? amountRaised / fundingGoal : 0;
  const daysLeft = Math.max(1, (deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  return Number((progress * 100 + Math.min(30, 30 / daysLeft)).toFixed(2));
}
