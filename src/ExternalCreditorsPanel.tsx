import { useEffect, useMemo, useState } from "react";
import { RefreshCw, ExternalLink, Info } from "lucide-react";
import { yapp } from "./yapp-bridge";
import { SortHeader, FilterBar, sortRows, type SortState } from "./table-helpers";

/**
 * Crediteuren — open Purchase Invoices van de Coöperatie aan externe leveranciers
 * (alles BUITEN de 3BM-entiteiten). Cumulatief, alle jaren.
 *
 * Voor de intercompany 80%-doorbelasting: zie tab "Te betalen" (IntercompanyPanel).
 */

const COOP_COMPANY = "3BM Coöperatie U.A.";

const INTERCO_SUPPLIERS = [
  "3BM bouwtechniek",          // legacy ERPNext-id van vóór de V.O.F.-rename
  "3BM Bouwtechniek V.O.F.",
  "3BM Engineering",
  "3BM Bouwkunde",
];

interface PurchaseInvoice {
  name: string;
  posting_date: string;
  due_date: string;
  supplier: string;
  supplier_name: string;
  bill_no: string;
  net_total: number;
  grand_total: number;
  outstanding_amount: number;
  status: string;
}

interface Row extends PurchaseInvoice {
  daysOverdue: number;          // positief = overdue, negatief = nog niet vervallen
  bucketOrder: number;          // 0 = >60d, 1 = 31-60d, 2 = 1-30d, 3 = niet vervallen
  amount: number;               // outstanding_amount (= cashflow waarde)
  searchBlob: string;
}

type FilterMode = "all" | "overdue" | "not_due" | "very_late";

function fmtEur(n: number): string {
  return `€ ${n.toLocaleString("nl-NL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + "T00:00:00");
  const b = new Date(toIso + "T00:00:00");
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function bucketOf(daysOverdue: number): number {
  if (daysOverdue > 60) return 0;
  if (daysOverdue > 30) return 1;
  if (daysOverdue > 0) return 2;
  return 3;
}

interface Props {
  company: string;
  erpAppUrl: string;
  inclBTW: boolean;
}

export default function ExternalCreditorsPanel({ company, erpAppUrl, inclBTW }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pis, setPis] = useState<PurchaseInvoice[]>([]);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [sort, setSort] = useState<SortState | null>({ field: "daysOverdue", dir: "desc" });
  const [search, setSearch] = useState("");

  const wrongCompany = company !== COOP_COMPANY && company !== "";

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const list = await yapp.fetchList<PurchaseInvoice>("Purchase Invoice", {
        fields: [
          "name", "posting_date", "due_date", "supplier", "supplier_name", "bill_no",
          "net_total", "grand_total", "outstanding_amount", "status",
        ],
        filters: [
          ["company", "=", COOP_COMPANY],
          ["supplier", "not in", INTERCO_SUPPLIERS],
          ["docstatus", "=", 1],
          ["outstanding_amount", ">", 0],
        ],
        limit_page_length: 5000,
        order_by: "due_date asc",
      });
      setPis(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const rows = useMemo<Row[]>(() => {
    return pis.map((p) => {
      const daysOverdue = p.due_date ? daysBetween(p.due_date, today) : 0;
      return {
        ...p,
        daysOverdue,
        bucketOrder: bucketOf(daysOverdue),
        amount: p.outstanding_amount,
        searchBlob: `${p.name} ${p.supplier_name} ${p.bill_no ?? ""} ${p.status}`.toLowerCase(),
      };
    });
  }, [pis, today]);

  const counts = useMemo(() => {
    let veryLate = 0, overdue = 0, notDue = 0;
    for (const r of rows) {
      if (r.daysOverdue > 60) veryLate += 1;
      if (r.daysOverdue > 0) overdue += 1;
      else notDue += 1;
    }
    return { veryLate, overdue, notDue };
  }, [rows]);

  const semanticFiltered = useMemo(() => {
    switch (filter) {
      case "very_late":
        return rows.filter((r) => r.daysOverdue > 60);
      case "overdue":
        return rows.filter((r) => r.daysOverdue > 0);
      case "not_due":
        return rows.filter((r) => r.daysOverdue <= 0);
      default:
        return rows;
    }
  }, [rows, filter]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const searched = needle
      ? semanticFiltered.filter((r) => r.searchBlob.includes(needle))
      : semanticFiltered;
    return sortRows(searched, sort);
  }, [semanticFiltered, search, sort]);

  const totals = useMemo(() => filtered.reduce(
    (acc, r) => ({
      outstanding: acc.outstanding + r.outstanding_amount,
      total: acc.total + (inclBTW ? r.grand_total : r.net_total),
    }),
    { outstanding: 0, total: 0 },
  ), [filtered, inclBTW]);

  const linkBase = erpAppUrl ? `${erpAppUrl}/app` : "";
  const docLink = (doctype: string, name: string) => {
    const slug = doctype.toLowerCase().replace(/\s+/g, "-");
    return linkBase ? `${linkBase}/${slug}/${encodeURIComponent(name)}` : "#";
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-800">Crediteuren — open PI's aan derden</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Onbetaalde inkoopfacturen van de Coöperatie aan externe leveranciers (excl. 3BM-entiteiten). Cumulatief, alle jaren.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 cursor-pointer text-sm"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          Vernieuwen
        </button>
      </div>

      {wrongCompany && (
        <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800 flex items-start gap-2">
          <Info size={16} className="shrink-0 mt-0.5" />
          <div>Dit overzicht is altijd voor <strong>{COOP_COMPANY}</strong> — bedrijfsfilter wordt genegeerd.</div>
        </div>
      )}

      {error && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>
      )}

      <div className="mb-3 flex items-center gap-2 flex-wrap text-xs">
        {([
          ["all", `Alle (${rows.length})`],
          ["overdue", `Vervallen (${counts.overdue})`],
          ["very_late", `> 60 dagen (${counts.veryLate})`],
          ["not_due", `Nog niet vervallen (${counts.notDue})`],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={`px-3 py-1.5 rounded-full border transition ${
              filter === k
                ? "bg-teal-600 text-white border-teal-600"
                : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-auto">
        <FilterBar
          search={search}
          setSearch={setSearch}
          hasSort={sort !== null}
          resetSort={() => setSort(null)}
          totalCount={semanticFiltered.length}
          visibleCount={filtered.length}
          placeholder="Filter op factuur, leverancier of bill_no..."
        />
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
            <tr>
              <SortHeader field="name" label="Factuur" sort={sort} onSort={setSort} className="px-3" />
              <SortHeader field="supplier_name" label="Leverancier" sort={sort} onSort={setSort} className="px-3" />
              <SortHeader field="bill_no" label="Bill no." sort={sort} onSort={setSort} className="px-3" />
              <SortHeader field="posting_date" label="Datum" sort={sort} onSort={setSort} className="px-3" />
              <SortHeader field="due_date" label="Vervaldatum" sort={sort} onSort={setSort} className="px-3" />
              <SortHeader field="daysOverdue" label="Dagen" align="right" sort={sort} onSort={setSort} className="px-3" />
              <SortHeader field={inclBTW ? "grand_total" : "net_total"} label={inclBTW ? "Totaal incl" : "Totaal excl"} align="right" sort={sort} onSort={setSort} className="px-3" />
              <SortHeader field="amount" label="Openstaand" align="right" sort={sort} onSort={setSort} className="px-3 text-slate-700" />
              <SortHeader field="status" label="Status" sort={sort} onSort={setSort} className="px-3" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const lateColor =
                r.daysOverdue > 60 ? "text-red-700 font-semibold" :
                r.daysOverdue > 30 ? "text-red-600" :
                r.daysOverdue > 0 ? "text-amber-700" : "text-slate-400";
              return (
                <tr key={r.name} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-1.5">
                    <a
                      href={docLink("Purchase Invoice", r.name)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-teal-600 hover:underline inline-flex items-center gap-1"
                    >
                      {r.name} <ExternalLink size={10} />
                    </a>
                  </td>
                  <td className="px-3 py-1.5 truncate max-w-[200px]" title={r.supplier_name}>
                    <a
                      href={docLink("Supplier", r.supplier)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-slate-700 hover:text-teal-600 hover:underline"
                    >
                      {r.supplier_name}
                    </a>
                  </td>
                  <td className="px-3 py-1.5 text-slate-500 text-xs truncate max-w-[160px]" title={r.bill_no}>{r.bill_no || <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-1.5 text-slate-600">{r.posting_date}</td>
                  <td className="px-3 py-1.5 text-slate-600">{r.due_date || <span className="text-slate-300">—</span>}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${lateColor}`}>
                    {r.due_date ? (r.daysOverdue > 0 ? `+${r.daysOverdue}` : r.daysOverdue) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{fmtEur(inclBTW ? r.grand_total : r.net_total)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-slate-800">{fmtEur(r.outstanding_amount)}</td>
                  <td className="px-3 py-1.5 text-slate-500 text-xs">{r.status}</td>
                </tr>
              );
            })}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-slate-400">
                  Geen open inkoopfacturen aan derden.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot className="bg-slate-50 border-t border-slate-200 font-semibold">
            <tr>
              <td className="px-3 py-2 text-slate-700" colSpan={6}>Totaal ({filtered.length})</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtEur(totals.total)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-800">{fmtEur(totals.outstanding)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded text-xs text-slate-600 space-y-1">
        <div>
          <strong className="text-slate-700">Bron:</strong> Purchase Invoice waar company = {COOP_COMPANY}, supplier NIET in 3BM-entiteiten, docstatus = 1, outstanding_amount {`>`} 0.
          Cumulatief, alle jaren. Intercompany PI's: zie tab "Te betalen".
        </div>
        <div>
          <strong className="text-slate-700">Kolommen:</strong> "Totaal" volgt BTW-toggle ({inclBTW ? "incl" : "excl"} BTW). "Openstaand" is altijd bruto (cashflow). "Dagen" = vandaag − vervaldatum (positief = overdue).
        </div>
      </div>
    </div>
  );
}
