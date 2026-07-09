import { useEffect, useMemo, useState } from "react";
import { RefreshCw, ExternalLink, RotateCcw, Plus, Trash2 } from "lucide-react";
import { yapp } from "./yapp-bridge";
import { SortHeader, sortRows, type SortState } from "./table-helpers";

/**
 * Abonnementen — terugkerende inkoopkosten (software/IT/telecom/energie/…) met
 * een opzeg-tracker. Bedrag/frequentie/laatste factuur komen live uit de
 * Purchase Invoices in ERPNext. De opzeg-administratie (opgezegd, datums,
 * frequentie-override) én handmatig toegevoegde abonnementen (voor kosten die
 * niet in ERPNext staan, bv. Bitdefender/Dropbox via een ander betaalkanaal)
 * staan in localStorage — de extensie schrijft bewust niet naar ERPNext.
 */

interface Props {
  company: string;
  erpAppUrl: string;
  inclBTW: boolean;
}

interface PurchaseInvoice {
  name: string;
  supplier: string;
  supplier_name: string;
  posting_date: string;
  grand_total: number;
  net_total: number;
  docstatus: number;
}

type Freq = "monthly" | "quarterly" | "yearly" | "irregular";

const FREQ_LABEL: Record<Freq, string> = {
  monthly: "Maandelijks",
  quarterly: "Per kwartaal",
  yearly: "Jaarlijks",
  irregular: "Onregelmatig",
};
const FREQ_MONTHS: Record<Freq, number | null> = { monthly: 1, quarterly: 3, yearly: 12, irregular: null };
const CATEGORIES = ["Software", "IT", "Telecom", "Hosting", "Energie", "Verzekering", "Accountant", "Administratie", "Overig"];

// Leveranciers die geen abonnement zijn: onderlinge doorbelasting + retail.
const NON_SUBSCRIPTION = new Set(
  [
    "3bm bouwtechniek v.o.f.", "3bm bouwtechniek", "3bm bouwkunde", "3bm engineering",
    "3bm architectuur", "3bm bongers constructies", "jumbo supermarkten b.v.", "ikea",
    "bol.com", "123inkt.nl", "bakkerij noord", "café post", "cafe post",
    "chi-chi the golf venue", "puur events b.v.", "gemeente dordrecht", "v.o.f. in de bogaard",
  ].map((s) => s.toLowerCase()),
);

// Categorie op leveranciernaam (keyword-match, lowercase).
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

function categorize(name: string): string {
  const n = name.toLowerCase();
  for (const [kw, cat] of CATEGORY_RULES) if (n.includes(kw)) return cat;
  return "Overig";
}

function fmtEur(n: number): string {
  return `€ ${n.toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function medianGapDays(dates: string[]): number | null {
  if (dates.length < 2) return null;
  const t = [...dates].sort().map((d) => new Date(d).getTime());
  const gaps: number[] = [];
  for (let i = 1; i < t.length; i++) gaps.push((t[i] - t[i - 1]) / 86_400_000);
  return median(gaps);
}

function detectFreq(gap: number | null): Freq {
  if (gap == null) return "irregular";
  if (gap >= 20 && gap <= 45) return "monthly";
  if (gap >= 75 && gap <= 110) return "quarterly";
  if (gap >= 300 && gap <= 420) return "yearly";
  return "irregular";
}

// --- opzeg-administratie voor ERPNext-leveranciers (localStorage) -------------

interface CancelInfo { cancelled: boolean; cancelDate: string; endDate: string; freq: Freq | ""; }
const STORE_KEY = "coop_admin_subscriptions";
const MANUAL_KEY = "coop_admin_subscriptions_manual";
const EMPTY: CancelInfo = { cancelled: false, cancelDate: "", endDate: "", freq: "" };

// --- handmatige abonnementen (niet in ERPNext) --------------------------------

interface ManualSub {
  id: string;
  name: string;
  category: string;
  amount: number;
  freq: Freq;
  cancelled: boolean;
  cancelDate: string;
  endDate: string;
}

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

interface SubRow {
  key: string;
  supplier: string;        // ERPNext supplier-id (voor de link); "" bij manueel
  name: string;
  category: string;
  count: number | null;    // null = handmatig
  autoFreq: Freq;
  freq: Freq;
  amount: number;
  monthly: number | null;
  variable: boolean;       // bedragen wisselen te veel voor een vaste maandlast
  lastDate: string;
  active: boolean;
  cancelled: boolean;
  cancelDate: string;
  endDate: string;
  manual: boolean;
}

export default function SubscriptionsPanel({ company, erpAppUrl, inclBTW }: Props) {
  const [pi, setPi] = useState<PurchaseInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [store, setStore] = useState<Record<string, CancelInfo>>(() => loadJSON(STORE_KEY, {}));
  const [manual, setManual] = useState<ManualSub[]>(() => loadJSON(MANUAL_KEY, []));
  const [onlySubs, setOnlySubs] = useState(true);
  const [hideCancelled, setHideCancelled] = useState(false);
  const [sort, setSort] = useState<SortState | null>({ field: "monthly", dir: "desc" });

  async function load() {
    setLoading(true);
    setError(null);
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 2);
    const from = cutoff.toISOString().slice(0, 10);
    const filters: unknown[][] = [["docstatus", "!=", 2], ["posting_date", ">=", from]];
    if (company) filters.unshift(["company", "=", company]);
    try {
      const rows = await yapp.fetchList<PurchaseInvoice>("Purchase Invoice", {
        fields: ["name", "supplier", "supplier_name", "posting_date", "grand_total", "net_total", "docstatus"],
        filters,
        limit_page_length: 5000,
        order_by: "posting_date asc",
      });
      setPi(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [company]);

  function patch(supplierName: string, p: Partial<CancelInfo>): void {
    setStore((prev) => {
      const cur = prev[supplierName] ?? EMPTY;
      const next = { ...prev, [supplierName]: { ...cur, ...p } };
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
      return next;
    });
  }

  function saveManual(next: ManualSub[]): void {
    setManual(next);
    localStorage.setItem(MANUAL_KEY, JSON.stringify(next));
  }
  function patchManual(id: string, p: Partial<ManualSub>): void {
    saveManual(manual.map((m) => (m.id === id ? { ...m, ...p } : m)));
  }
  function addManual(): void {
    saveManual([
      ...manual,
      { id: `m${Date.now()}`, name: "Nieuw abonnement", category: "Software", amount: 0, freq: "monthly", cancelled: false, cancelDate: "", endDate: "" },
    ]);
  }

  const erpRows = useMemo<SubRow[]>(() => {
    const bySupplier = new Map<string, PurchaseInvoice[]>();
    for (const p of pi) {
      if (p.docstatus === 2) continue;
      const key = p.supplier_name || p.supplier;
      const arr = bySupplier.get(key) ?? [];
      arr.push(p);
      bySupplier.set(key, arr);
    }
    const now = Date.now();
    const out: SubRow[] = [];
    for (const [name, invs] of bySupplier) {
      if (invs.length < 2) continue;
      const dates = invs.map((x) => x.posting_date).filter(Boolean);
      const amounts = invs.map((x) => (inclBTW ? x.grand_total : x.net_total) || 0).filter((a) => a > 0);
      const autoFreq = detectFreq(medianGapDays(dates));
      const info = store[name] ?? EMPTY;
      const freq: Freq = info.freq || autoFreq;
      const amount = median(amounts);
      const months = FREQ_MONTHS[freq];
      // Vaste maandlast alleen als de bedragen rond de mediaan clusteren
      // (>=60% binnen ±30%). Zo niet → projectfacturatie (bv. G2O): "wisselend",
      // geen extrapolatie, telt niet mee in het maandtotaal.
      const stable = amount > 0 && amounts.filter((a) => a >= amount * 0.7 && a <= amount * 1.3).length / amounts.length >= 0.6;
      const lastDate = [...dates].sort().at(-1) ?? "";
      const daysSince = lastDate ? (now - new Date(lastDate).getTime()) / 86_400_000 : Infinity;
      const threshold = freq === "monthly" ? 70 : freq === "quarterly" ? 160 : freq === "yearly" ? 450 : 120;
      out.push({
        key: name, supplier: invs[0].supplier, name, category: categorize(name), count: invs.length,
        autoFreq, freq, amount, monthly: months && stable ? amount / months : null, variable: !stable,
        lastDate, active: daysSince <= threshold, cancelled: info.cancelled, cancelDate: info.cancelDate,
        endDate: info.endDate, manual: false,
      });
    }
    return out;
  }, [pi, inclBTW, store]);

  const manualRows = useMemo<SubRow[]>(() =>
    manual.map((m) => {
      const months = FREQ_MONTHS[m.freq];
      return {
        key: m.id, supplier: "", name: m.name, category: m.category, count: null, autoFreq: m.freq,
        freq: m.freq, amount: m.amount, monthly: months ? m.amount / months : null, variable: false,
        lastDate: "", active: true, cancelled: m.cancelled, cancelDate: m.cancelDate, endDate: m.endDate, manual: true,
      };
    }), [manual]);

  const allRows = useMemo(() => [...manualRows, ...erpRows], [manualRows, erpRows]);

  // Toon onder "alleen abonnementen": handmatige regels, echte vaste abo's
  // (maandlast bepaald) en alles met een herkende categorie (ook wisselend,
  // bv. Hosting G2O/Prilk) — maar niet de onbekende, onregelmatige ruis.
  const isSub = (r: SubRow) =>
    r.manual || (!NON_SUBSCRIPTION.has(r.name.toLowerCase()) && (r.monthly != null || r.category !== "Overig"));

  const filtered = useMemo(() => {
    let r = allRows;
    if (onlySubs) r = r.filter(isSub);
    if (hideCancelled) r = r.filter((x) => !x.cancelled);
    return sortRows(r, sort);
  }, [allRows, onlySubs, hideCancelled, sort]);

  const summary = useMemo(() => {
    const base = allRows.filter(isSub);
    const activeMonthly = base.filter((x) => x.active).reduce((s, x) => s + (x.monthly ?? 0), 0);
    const cancelled = base.filter((x) => x.cancelled);
    const cancelledMonthly = cancelled.reduce((s, x) => s + (x.monthly ?? 0), 0);
    const remaining = base.filter((x) => x.active && !x.cancelled).reduce((s, x) => s + (x.monthly ?? 0), 0);
    return { activeMonthly, cancelledCount: cancelled.length, cancelledMonthly, remaining };
  }, [allRows]);

  const linkBase = erpAppUrl ? `${erpAppUrl}/app` : "";
  const supplierLink = (supplier: string) =>
    linkBase ? `${linkBase}/supplier/${encodeURIComponent(supplier)}` : "#";

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <span className="text-sm text-slate-500">
          Actieve maandlast: <b className="text-slate-800">{fmtEur(summary.remaining)}</b>
          {summary.cancelledCount > 0 && (
            <span className="text-slate-400"> (was {fmtEur(summary.activeMonthly)} · {summary.cancelledCount} opgezegd, {fmtEur(summary.cancelledMonthly)}/mnd bespaard)</span>
          )}
        </span>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="inline-flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
            <input type="checkbox" checked={onlySubs} onChange={(e) => setOnlySubs(e.target.checked)} className="accent-teal-600" />
            Alleen abonnementen
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
            <input type="checkbox" checked={hideCancelled} onChange={(e) => setHideCancelled(e.target.checked)} className="accent-teal-600" />
            Verberg opgezegde
          </label>
          <button onClick={addManual} className="flex items-center gap-2 px-3 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 cursor-pointer text-sm">
            <Plus size={15} /> Handmatig
          </button>
          <button onClick={load} disabled={loading} className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 cursor-pointer">
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} /> Vernieuwen
          </button>
        </div>
      </div>

      {error && <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>}

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <SortHeader field="name" label="Leverancier" sort={sort} onSort={setSort} />
              <SortHeader field="category" label="Categorie" sort={sort} onSort={setSort} />
              <SortHeader field="freq" label="Frequentie" sort={sort} onSort={setSort} />
              <SortHeader field="amount" label="Bedrag/keer" align="right" sort={sort} onSort={setSort} />
              <SortHeader field="monthly" label="~ Maandlast" align="right" sort={sort} onSort={setSort} />
              <SortHeader field="lastDate" label="Laatste" sort={sort} onSort={setSort} />
              <th className="px-3 py-2 text-center text-xs font-semibold text-slate-500 uppercase tracking-wide">Opgezegd</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Opzegdatum</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Einddatum</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-400">{loading ? "Laden…" : "Geen terugkerende leveranciers gevonden"}</td></tr>
            ) : filtered.map((r) => {
              const setCancelled = (checked: boolean) => {
                const cd = checked && !r.cancelDate ? new Date().toISOString().slice(0, 10) : r.cancelDate;
                if (r.manual) patchManual(r.key, { cancelled: checked, cancelDate: cd });
                else patch(r.name, { cancelled: checked, cancelDate: cd });
              };
              const setField = (p: Partial<CancelInfo>) => r.manual ? patchManual(r.key, p as Partial<ManualSub>) : patch(r.name, p);
              return (
                <tr key={r.key} className={`border-b border-slate-100 hover:bg-slate-50 ${r.cancelled ? "bg-slate-50 text-slate-400" : ""} ${!r.active && !r.cancelled ? "opacity-60" : ""}`}>
                  <td className="px-3 py-2 font-medium text-slate-700">
                    {r.manual ? (
                      <input value={r.name} onChange={(e) => patchManual(r.key, { name: e.target.value })}
                        className="bg-white border border-slate-200 rounded px-1.5 py-1 text-sm w-40 focus:outline-none focus:ring-1 focus:ring-teal-500" />
                    ) : (
                      <>{r.name}{!r.active && <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400">inactief</span>}</>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {r.manual ? (
                      <select value={r.category} onChange={(e) => patchManual(r.key, { category: e.target.value })}
                        className="bg-white border border-slate-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-500">
                        {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    ) : (
                      <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-slate-100 text-slate-600">{r.category}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={r.manual ? r.freq : (store[r.name]?.freq || "")}
                      onChange={(e) => r.manual ? patchManual(r.key, { freq: e.target.value as Freq }) : patch(r.name, { freq: e.target.value as Freq | "" })}
                      className="bg-white border border-slate-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-500"
                      title={r.manual ? "" : (store[r.name]?.freq ? "Handmatig ingesteld" : `Auto: ${FREQ_LABEL[r.autoFreq]}`)}
                    >
                      {!r.manual && <option value="">Auto ({FREQ_LABEL[r.autoFreq]})</option>}
                      <option value="monthly">Maandelijks</option>
                      <option value="quarterly">Per kwartaal</option>
                      <option value="yearly">Jaarlijks</option>
                      <option value="irregular">Onregelmatig</option>
                    </select>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {r.manual ? (
                      <input type="number" step="0.01" value={r.amount || ""} onChange={(e) => patchManual(r.key, { amount: parseFloat(e.target.value) || 0 })}
                        className="bg-white border border-slate-200 rounded px-1.5 py-1 text-xs w-24 text-right focus:outline-none focus:ring-1 focus:ring-teal-500" />
                    ) : (
                      <span className="text-slate-700" title={r.variable ? "Bedrag wisselt sterk per factuur" : ""}>
                        {fmtEur(r.amount)}{r.variable && <span className="ml-1 text-[10px] uppercase text-amber-500">wisselend</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-800 whitespace-nowrap" title={r.monthly == null && r.variable ? "Geen vaste maandlast — projectfacturatie" : ""}>
                    {r.monthly == null ? (r.variable ? "wisselend" : "—") : fmtEur(r.monthly)}
                  </td>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.lastDate || "—"}</td>
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" checked={r.cancelled} onChange={(e) => setCancelled(e.target.checked)} className="cursor-pointer accent-teal-600 w-4 h-4" />
                  </td>
                  <td className="px-3 py-2">
                    <input type="date" value={r.cancelDate} onChange={(e) => setField({ cancelDate: e.target.value })}
                      className="bg-white border border-slate-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-500" />
                  </td>
                  <td className="px-3 py-2">
                    <input type="date" value={r.endDate} onChange={(e) => setField({ endDate: e.target.value })}
                      title="Datum waarop het contract daadwerkelijk eindigt"
                      className="bg-white border border-slate-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-teal-500" />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    {r.manual ? (
                      <button onClick={() => saveManual(manual.filter((m) => m.id !== r.key))} className="text-slate-400 hover:text-red-500" title="Handmatig abonnement verwijderen">
                        <Trash2 size={14} />
                      </button>
                    ) : (
                      <>
                        {(r.cancelled || store[r.name]?.freq || r.cancelDate || r.endDate) && (
                          <button onClick={() => patch(r.name, EMPTY)} className="text-slate-400 hover:text-slate-600 mr-2" title="Wis de opzeg-administratie van deze regel">
                            <RotateCcw size={13} />
                          </button>
                        )}
                        <a href={supplierLink(r.supplier)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-teal-600 hover:underline text-xs">
                          <ExternalLink size={12} />
                        </a>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        Bedrag/frequentie/laatste factuur komen uit de inkoopfacturen in ERPNext (laatste 2 jaar).
        Handmatige abonnementen en de opzeg-administratie (opgezegd, datums, frequentie) worden
        lokaal in deze browser bewaard — nog niet gedeeld tussen apparaten.
      </p>
    </div>
  );
}
