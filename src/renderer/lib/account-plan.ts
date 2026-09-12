const planNames: Record<string, string> = {
  free: "ChatGPT Free",
  go: "ChatGPT Go",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  prolite: "ChatGPT Pro",
  team: "ChatGPT Business",
  business: "ChatGPT Business",
  enterprise: "ChatGPT Enterprise",
  edu: "ChatGPT Edu",
};

export function accountPlanLabel(plan: string): string {
  // Provider codes describe entitlements, not a billing quote. Keep unknown plans intact.
  return planNames[plan.toLowerCase()] ?? plan;
}
