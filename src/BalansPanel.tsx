import { useEffect, useMemo, useState } from "react";
import { RefreshCw, ExternalLink, ArrowDownCircle, ArrowUpCircle, Landmark, Scale, RefreshCcw } from "lucide-react";
import { yapp } from "./yapp-bridge";
import { SortHeader, FilterBar, sortRows, filterRows, sumField, type SortState } from "./table-helpers";
import { estimateMonthlyRecurring, type PurchaseInvoiceLite } from "./recurring";

/**
 * Balans — liquiditeitspositie van de coöp: te ontvangen (debiteuren) +
 * banksaldo − te betalen (crediteuren) = netto overschot/tekort. Het banksaldo
 * is een handmatig invulveld (localStorage): ERPNext's boeksaldo is onbetrouwbaar
 * zolang de bankfeed niet bijboekt. Crediteuren worden gesplitst in intercompany
 * (onderling binnen 3BM) en extern.
 */

interface Props {
  company: string;
  erpAppUrl: string;
}

interface Invoice {
  name: string;
  party: string;
  posting_date: string;
  due_date: string;
  outstanding_amount: number;
  status: string;
  docstatus: number;
}

const INTERCOMPANY = new Set(
  [
    "3bm bouwtechniek v.o.f.", "3bm bouwtechniek", "3bm bouwkunde", "3bm engineering",
    "3bm bongers constructies", "3bm architectuur", "3bm architect m. otte", "3bm coöperatie u.a.",
  ].map((s) => s.toLowerCase()),
);

const isIntern = (party: string) => INTERCOMPANY.has((party || "").toLowerCase());

function fmtEur(n: number): string {
  return `€ ${n.toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const BANK_KEY = "coop_admin_bank_balance";

function loadBank(company: string): string {
  try {
    const raw = localStorage.getItem(BANK_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return map[company] ?? "";
  } catch {
    return "";
  }
}
function saveBank(company: string, value: string): void {
  let map: Record<string, string> = {};
  try {
    const raw = localStorage.getItem(BANK_KEY);
    map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    map = {};
  }
  map[company] = value;
  localStorage.setItem(BANK_KEY, JSON.stringify(map));
}

export default function BalansPanel({ company, erpAppUrl }: Props) {
  const [si, setSi] = useState<Invoice[]>([]);
  const [pi, setPi] = useState<Invoice[]>([]);
  const [recurPi, setRecurPi] = useState<PurchaseInvoiceLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bankText, setBankText] = useState<string>(() => loadBank(company));

  useEffect(() => { setBankText(loadBank(company)); }, [company]);

  async function load() {
    setLoading(true);
    setError(null);
    // Concept (docstatus 0) meenemen zodat net-geboekte inkoopfacturen die nog
    // niet gesubmit zijn al meetellen; ze krijgen een "concept"-badge.
    const filters: unknown[][] = [["docstatus", "!=", 2], ["outstanding_amount", "!=", 0]];
    if (company) filters.unshift(["company", "=", company]);
    // Aparte set voor de terugkerende-kosten-schatting: alle inkoopfacturen van
    // de laatste 2 jaar (voor het ritme), niet alleen de openstaande.
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 2);
    const recurFilters: unknown[][] = [["docstatus", "=", 1], ["posting_date", ">=", cutoff.toISOString().slice(0, 10)]];
    if (company) recurFilters.unshift(["company", "=", company]);
    try {
      const [siList, piList, recurList] = await Promise.all([
        yapp.fetchList<Record<string, unknown>>("Sales Invoice", {
          fields: ["name", "customer_name", "posting_date", "due_date", "outstanding_amount", "status", "docstatus"],
          filters,
          limit_page_length: 1000,
          order_by: "due_date asc",
        }),
        yapp.fetchList<Record<string, unknown>>("Purchase Invoice", {
          fields: ["name", "supplier_name", "posting_date", "due_date", "outstanding_amount", "status", "docstatus"],
          filters,
          limit_page_length: 1000,
          order_by: "due_date asc",
        }),
        yapp.fetchList<PurchaseInvoiceLite>("Purchase Invoice", {
          fields: ["name", "supplier", "supplier_name", "posting_date", "grand_total", "net_total", "docstatus"],
          filters: recurFilters,
          limit_page_length: 5000,
          order_by: "posting_date asc",
        }),
      ]);
      setSi(siList.map((r) => ({ ...(r as unknown as Invoice), party: String(r.customer_name ?? "") })));
      setPi(piList.map((r) => ({ ...(r as unknown as Invoice), party: String(r.supplier_name ?? "") })));
      setRecurPi(recurList);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [company]);

  const bank = parseFloat(bankText.replace(",", ".")) || 0;
  const receivable = useMemo(() => si.reduce((s, x) => s + x.outstanding_amount, 0), [si]);
  const payable = useMemo(() => pi.reduce((s, x) => s + x.outstanding_amount, 0), [pi]);
  const payableIntern = useMemo(() => pi.filter((x) => isIntern(x.party)).reduce((s, x) => s + x.outstanding_amount, 0), [pi]);
  const payableExtern = payable - payableIntern;

  const netAll = bank + receivable - payable;
  const netExtern = bank + receivable - payableExtern;

  // Terugkerende kosten die er nog aankomen (abonnementen/hosting/…).
  const recurring = useMemo(() => estimateMonthlyRecurring(recurPi, true), [recurPi]);
  const now = new Date();
  const monthsLeft = 12 - now.getMonth(); // incl. lopende maand (jul → 6)
  const recurToYearEnd = recurring.monthly * monthsLeft;
  const netAfterCosts = netAll - recurToYearEnd;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500">Liquiditeitspositie: bank + te ontvangen − te betalen.</p>
        <button onClick={load} disabled={loading} className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 cursor-pointer">
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} /> Vernieuwen
        </button>
      </div>

      {error && <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>}

      {/* Samenvatting */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <div className="flex items-center gap-2 text-emerald-600 mb-1"><ArrowDownCircle size={18} /><span className="text-xs uppercase tracking-wide text-slate-500">Te ontvangen</span></div>
          <p className="text-2xl font-bold text-slate-800">{fmtEur(receivable)}</p>
          <p className="text-xs text-slate-400">{si.length} debiteuren</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <div className="flex items-center gap-2 text-red-600 mb-1"><ArrowUpCircle size={18} /><span className="text-xs uppercase tracking-wide text-slate-500">Te betalen</span></div>
          <p className="text-2xl font-bold text-slate-800">{fmtEur(payable)}</p>
          <p className="text-xs text-slate-400">
            {fmtEur(payableIntern)} intern · {fmtEur(payableExtern)} extern
          </p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <div className="flex items-center gap-2 text-slate-600 mb-1"><Landmark size={18} /><span className="text-xs uppercase tracking-wide text-slate-500">Banksaldo (invullen)</span></div>
          <div className="flex items-center gap-1">
            <span className="text-slate-400 text-lg">€</span>
            <input
              type="number" step="0.01" inputMode="decimal" placeholder="0,00"
              value={bankText}
              onChange={(e) => { setBankText(e.target.value); saveBank(company, e.target.value); }}
              className="w-full text-2xl font-bold text-slate-800 bg-transparent border-b border-slate-200 focus:border-teal-500 focus:outline-none"
            />
          </div>
          <p className="text-xs text-slate-400">handmatig — boeksaldo is onbetrouwbaar</p>
        </div>
        <div className={`rounded-xl shadow-sm border-2 p-5 ${netAll >= 0 ? "bg-emerald-50 border-emerald-200" : "bg-red-50 border-red-200"}`}>
          <div className={`flex items-center gap-2 mb-1 ${netAll >= 0 ? "text-emerald-700" : "text-red-700"}`}><Scale size={18} /><span className="text-xs uppercase tracking-wide">{netAll >= 0 ? "Overschot" : "Tekort"}</span></div>
          <p className={`text-2xl font-bold ${netAll >= 0 ? "text-emerald-700" : "text-red-700"}`}>{fmtEur(netAll)}</p>
          <p className="text-xs text-slate-500">excl. intercompany: {fmtEur(netExtern)}</p>
        </div>
      </div>

      {/* Rekenregel */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 mb-4 text-sm text-slate-600 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{fmtEur(bank)} bank</span><span className="text-slate-300">+</span>
        <span className="text-emerald-600">{fmtEur(receivable)} te ontvangen</span><span className="text-slate-300">−</span>
        <span className="text-red-600">{fmtEur(payable)} te betalen</span><span className="text-slate-300">=</span>
        <span className={`font-bold ${netAll >= 0 ? "text-emerald-700" : "text-red-700"}`}>{fmtEur(netAll)}</span>
      </div>

      {/* Verwachte terugkerende kosten */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <RefreshCcw size={16} className="text-orange-500" />
          <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">Nog te verwachten kosten</h3>
          <span className="text-xs text-slate-400">abonnementen · hosting · vaste lasten</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Verwachte maandlast</p>
            <p className="text-2xl font-bold text-slate-800">{fmtEur(recurring.monthly)}<span className="text-sm font-normal text-slate-400"> / mnd</span></p>
            <p className="text-xs text-slate-400">{recurring.items.length} terugkerende posten</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Rest dit jaar</p>
            <p className="text-2xl font-bold text-orange-600">{fmtEur(recurToYearEnd)}</p>
            <p className="text-xs text-slate-400">{monthsLeft} maanden × {fmtEur(recurring.monthly)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Netto na deze kosten</p>
            <p className={`text-2xl font-bold ${netAfterCosts >= 0 ? "text-emerald-700" : "text-red-700"}`}>{fmtEur(netAfterCosts)}</p>
            <p className="text-xs text-slate-400">overschot − rest dit jaar</p>
          </div>
        </div>
        {recurring.items.length > 0 && (
          <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            {recurring.items.slice(0, 10).map((it) => (
              <span key={it.name}>{it.name} <span className="text-slate-400">{fmtEur(it.monthly)}/mnd</span></span>
            ))}
            {recurring.items.length > 10 && <span className="text-slate-400">+{recurring.items.length - 10} meer</span>}
          </div>
        )}
        <p className="mt-3 text-xs text-slate-400">
          Geschat uit de terugkerende inkoopfacturen (incl. handmatige abonnementen uit de Abonnementen-tab,
          exclusief opgezegde). Alleen posten met een vaste maandlast; wisselende kosten (projectfacturen) tellen niet mee.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <InvoiceTable title="Te ontvangen facturen" tone="emerald" rows={si} doctype="Sales Invoice" erpAppUrl={erpAppUrl} loading={loading} />
        <InvoiceTable title="Te betalen facturen" tone="red" rows={pi} doctype="Purchase Invoice" erpAppUrl={erpAppUrl} loading={loading} showIntern />
      </div>
    </div>
  );
}

function InvoiceTable({ title, tone, rows, doctype, erpAppUrl, loading, showIntern }: {
  title: string; tone: "emerald" | "red"; rows: Invoice[]; doctype: string; erpAppUrl: string; loading: boolean; showIntern?: boolean;
}) {
  const [sort, setSort] = useState<SortState | null>({ field: "due_date", dir: "asc" });
  const [search, setSearch] = useState("");
  const linkBase = erpAppUrl ? `${erpAppUrl}/app` : "";
  const slug = doctype.toLowerCase().replace(/\s+/g, "-");
  const visible = sortRows(filterRows(rows, search), sort);
  const amountColor = tone === "emerald" ? "text-emerald-700" : "text-red-700";

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">
      <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">{title}</h3>
        <span className={`text-sm font-bold ${amountColor}`}>{fmtEur(sumField(visible, "outstanding_amount"))}</span>
      </div>
      <FilterBar search={search} setSearch={setSearch} hasSort={sort !== null} resetSort={() => setSort(null)} totalCount={rows.length} visibleCount={visible.length} placeholder="Filter (naam, factuurnr, datum...)" />
      <div className="overflow-auto max-h-[60vh]">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
            <tr>
              <SortHeader field="party" label={tone === "emerald" ? "Klant" : "Leverancier"} sort={sort} onSort={setSort} />
              <SortHeader field="name" label="Factuur" sort={sort} onSort={setSort} />
              <SortHeader field="due_date" label="Vervalt" sort={sort} onSort={setSort} />
              <SortHeader field="outstanding_amount" label="Openstaand" align="right" sort={sort} onSort={setSort} />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-400">{loading ? "Laden…" : "Niets openstaand"}</td></tr>
            ) : visible.map((r) => {
              const intern = showIntern && isIntern(r.party);
              const draft = r.docstatus === 0;
              const overdue = r.status === "Overdue";
              return (
                <tr key={r.name} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 text-slate-700">
                    {r.party || "—"}
                    {intern && <span className="ml-2 text-[10px] uppercase tracking-wide text-purple-500">intern</span>}
                  </td>
                  <td className="px-4 py-2">
                    <a href={linkBase ? `${linkBase}/${slug}/${encodeURIComponent(r.name)}` : "#"} target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline inline-flex items-center gap-1">
                      {r.name} <ExternalLink size={10} />
                    </a>
                    {draft && <span className="ml-2 text-[10px] uppercase tracking-wide rounded bg-amber-100 text-amber-700 px-1">concept</span>}
                  </td>
                  <td className={`px-4 py-2 text-xs ${overdue ? "text-red-600 font-medium" : "text-slate-500"}`}>{r.due_date || "—"}</td>
                  <td className={`px-4 py-2 text-right font-semibold ${amountColor}`}>{fmtEur(r.outstanding_amount)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
