/**
 * Gedeelde detectie van terugkerende kosten (abonnementen/hosting/…) uit de
 * inkoopfacturen. Gebruikt door SubscriptionsPanel (opzeg-tracker) én
 * BalansPanel (schatting toekomstige kosten), zodat beide identiek rekenen.
 */

export type Freq = "monthly" | "quarterly" | "yearly" | "irregular";

export const FREQ_LABEL: Record<Freq, string> = {
  monthly: "Maandelijks",
  quarterly: "Per kwartaal",
  yearly: "Jaarlijks",
  irregular: "Onregelmatig",
};
export const FREQ_MONTHS: Record<Freq, number | null> = { monthly: 1, quarterly: 3, yearly: 12, irregular: null };
export const CATEGORIES = ["Software", "IT", "Telecom", "Hosting", "Energie", "Verzekering", "Accountant", "Administratie", "Overig"];

// Onderlinge doorbelasting + evidente retail — geen abonnement.
export const NON_SUBSCRIPTION = new Set(
  [
    "3bm bouwtechniek v.o.f.", "3bm bouwtechniek", "3bm bouwkunde", "3bm engineering",
    "3bm architectuur", "3bm bongers constructies", "jumbo supermarkten b.v.", "ikea",
    "bol.com", "123inkt.nl", "bakkerij noord", "café post", "cafe post",
    "chi-chi the golf venue", "puur events b.v.", "gemeente dordrecht", "v.o.f. in de bogaard",
  ].map((s) => s.toLowerCase()),
);

const CATEGORY_RULES: [string, string][] = [
  ["microsoft", "Software"], ["autodesk", "Software"], ["adobe", "Software"],
  ["hsbcad", "Software"], ["bjornlunden", "Software"], ["lettermint", "Software"],
  ["bitdefender", "Software"], ["dropbox", "Software"],
  ["lc ict", "IT"], ["more than just ict", "IT"],
  ["lesec", "Telecom"], ["verbonden", "Telecom"], ["kpn", "Telecom"],
  ["vodafone", "Telecom"], ["odido", "Telecom"], ["t-mobile", "Telecom"],
  ["transip", "Hosting"], ["hetzner", "Hosting"], ["cloudflare", "Hosting"],
  ["g2o", "Hosting"], ["prilk", "Hosting"],
  ["budget energie", "Energie"], ["eneco", "Energie"], ["vattenfall", "Energie"],
  ["essent", "Energie"], ["greenchoice", "Energie"],
  ["verzeker", "Verzekering"], ["saa ", "Verzekering"],
  ["aaff", "Accountant"], ["pcheck", "Administratie"], ["confianza", "Administratie"],
];

export function categorize(name: string): string {
  const n = name.toLowerCase();
  for (const [kw, cat] of CATEGORY_RULES) if (n.includes(kw)) return cat;
  return "Overig";
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function medianGapDays(dates: string[]): number | null {
  if (dates.length < 2) return null;
  const t = [...dates].sort().map((d) => new Date(d).getTime());
  const gaps: number[] = [];
  for (let i = 1; i < t.length; i++) gaps.push((t[i] - t[i - 1]) / 86_400_000);
  return median(gaps);
}

export function detectFreq(gap: number | null): Freq {
  if (gap == null) return "irregular";
  if (gap >= 20 && gap <= 45) return "monthly";
  if (gap >= 75 && gap <= 110) return "quarterly";
  if (gap >= 300 && gap <= 420) return "yearly";
  return "irregular";
}

export interface PurchaseInvoiceLite {
  supplier: string;
  supplier_name: string;
  posting_date: string;
  grand_total: number;
  net_total: number;
  docstatus: number;
}

export interface RecurringVendor {
  name: string;
  supplier: string;
  category: string;
  count: number;
  autoFreq: Freq;
  amount: number;      // typisch bedrag per factuur
  variable: boolean;   // bedragen wisselen te veel voor een vaste maandlast
  monthly: number | null;
  lastDate: string;
  active: boolean;
}

/** Groepeer inkoopfacturen per leverancier en leid frequentie + typisch bedrag
 *  af. Maandlast alleen als de bedragen rond de mediaan clusteren (>=60% binnen
 *  ±30%) én het ritme regelmatig is; anders "wisselend" (monthly = null). */
export function detectRecurring(invoices: PurchaseInvoiceLite[], inclBTW: boolean): RecurringVendor[] {
  const bySupplier = new Map<string, PurchaseInvoiceLite[]>();
  for (const p of invoices) {
    if (p.docstatus === 2) continue;
    const key = p.supplier_name || p.supplier;
    const arr = bySupplier.get(key) ?? [];
    arr.push(p);
    bySupplier.set(key, arr);
  }
  const now = Date.now();
  const out: RecurringVendor[] = [];
  for (const [name, invs] of bySupplier) {
    if (invs.length < 2) continue;
    const dates = invs.map((x) => x.posting_date).filter(Boolean);
    const amounts = invs.map((x) => (inclBTW ? x.grand_total : x.net_total) || 0).filter((a) => a > 0);
    const autoFreq = detectFreq(medianGapDays(dates));
    const amount = median(amounts);
    const stable = amount > 0 && amounts.filter((a) => a >= amount * 0.7 && a <= amount * 1.3).length / amounts.length >= 0.6;
    const months = FREQ_MONTHS[autoFreq];
    const lastDate = [...dates].sort().at(-1) ?? "";
    const daysSince = lastDate ? (now - new Date(lastDate).getTime()) / 86_400_000 : Infinity;
    const threshold = autoFreq === "monthly" ? 70 : autoFreq === "quarterly" ? 160 : autoFreq === "yearly" ? 450 : 120;
    out.push({
      name, supplier: invs[0].supplier, category: categorize(name), count: invs.length, autoFreq,
      amount, variable: !stable, monthly: months && stable ? amount / months : null,
      lastDate, active: daysSince <= threshold,
    });
  }
  return out;
}

export const isSubscription = (v: { name: string; monthly: number | null; category: string }): boolean =>
  !NON_SUBSCRIPTION.has(v.name.toLowerCase()) && (v.monthly != null || v.category !== "Overig");

// --- opzeg-administratie + handmatige abonnementen (localStorage) -------------

export interface CancelInfo { cancelled: boolean; cancelDate: string; endDate: string; freq: Freq | ""; }
export interface ManualSub {
  id: string; name: string; category: string; amount: number; freq: Freq;
  cancelled: boolean; cancelDate: string; endDate: string;
}
export const STORE_KEY = "coop_admin_subscriptions";
export const MANUAL_KEY = "coop_admin_subscriptions_manual";

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Geschatte terugkerende maandlast: gedetecteerde abonnementen (met eventuele
 *  frequentie-override, exclusief opgezegde) + handmatige abonnementen. */
export function estimateMonthlyRecurring(invoices: PurchaseInvoiceLite[], inclBTW: boolean): {
  monthly: number;
  items: { name: string; category: string; monthly: number }[];
} {
  const store = loadJSON<Record<string, CancelInfo>>(STORE_KEY, {});
  const manual = loadJSON<ManualSub[]>(MANUAL_KEY, []);
  const items: { name: string; category: string; monthly: number }[] = [];

  for (const v of detectRecurring(invoices, inclBTW)) {
    if (!isSubscription(v) || !v.active) continue;
    const info = store[v.name];
    if (info?.cancelled) continue;
    const freq: Freq = info?.freq || v.autoFreq;
    const months = FREQ_MONTHS[freq];
    // Alleen tellen als er een vaste maandlast te bepalen is (stabiel bedrag).
    if (!months || v.variable) continue;
    const monthly = v.amount / months;
    items.push({ name: v.name, category: v.category, monthly });
  }
  for (const m of manual) {
    if (m.cancelled) continue;
    const months = FREQ_MONTHS[m.freq];
    if (!months) continue;
    items.push({ name: m.name, category: m.category, monthly: m.amount / months });
  }
  items.sort((a, b) => b.monthly - a.monthly);
  return { monthly: items.reduce((s, x) => s + x.monthly, 0), items };
}
