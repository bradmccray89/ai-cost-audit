import { z } from "zod";
import type { Config, Plan, PlanAdvice, PlanOption, UsageProfile } from "./types.js";
import bundled from "./data/plans.json" with { type: "json" };

const planSchema = z.object({
  id: z.string(),
  label: z.string(),
  monthlyUSD: z.number().nonnegative(),
  note: z.string().optional(),
});

const plansTableSchema = z.object({
  asOf: z.string(),
  source: z.string(),
  disclaimer: z.string().optional(),
  plans: z.array(planSchema),
});

export interface PlansTable {
  asOf: string;
  source: string;
  plans: Plan[];
}

export function bundledPlans(): PlansTable {
  const parsed = plansTableSchema.parse(bundled);
  return { asOf: parsed.asOf, source: parsed.source, plans: parsed.plans };
}

const DAYS_PER_MONTH = 30;

/**
 * Compare the user's measured usage (priced at API rates) against subscription
 * tiers, per developer. A subscription is a flat fee; API pay-as-you-go scales
 * with usage — so the cheapest option depends on how heavily the developer uses
 * the tool. Returns null when there is no measured usage to reason from.
 */
export function computePlanAdvice(
  measured: UsageProfile,
  cfg: Config,
  table: PlansTable,
): PlanAdvice {
  const turnsPerDay = Math.max(1, Math.round(measured.turnsPerDay));
  const apiEquivMonthly = measured.actualCostPerTurn * turnsPerDay * DAYS_PER_MONTH;

  const currentIsApi = cfg.plan === "api";
  const currentId = typeof cfg.plan === "string" ? cfg.plan : null;
  const customCurrent = cfg.plan !== null && typeof cfg.plan === "object" ? cfg.plan : null;

  const options: PlanOption[] = table.plans.map((p) => ({
    id: p.id,
    label: p.label,
    monthlyUSD: p.monthlyUSD,
    isCurrent: p.id === currentId,
    isApi: false,
  }));

  if (customCurrent) {
    options.push({
      id: "custom",
      label: customCurrent.label,
      monthlyUSD: customCurrent.monthlyUSD,
      isCurrent: true,
      isApi: false,
    });
  }

  options.push({
    id: "api",
    label: "API pay-as-you-go",
    monthlyUSD: apiEquivMonthly,
    isCurrent: currentIsApi,
    isApi: true,
  });

  options.sort((a, b) => a.monthlyUSD - b.monthlyUSD);

  const cheapest = options[0]!;
  const current = options.find((o) => o.isCurrent) ?? null;
  const savingsVsCurrent = current ? current.monthlyUSD - cheapest.monthlyUSD : null;

  return {
    apiEquivMonthly,
    turnsPerDay,
    options,
    cheapest,
    current,
    savingsVsCurrent,
    asOf: table.asOf,
  };
}
