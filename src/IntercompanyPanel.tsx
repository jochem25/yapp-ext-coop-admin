import { Fragment, useEffect, useMemo, useState } from "react";
import { RefreshCw, ChevronDown, ChevronRight, ExternalLink, Info } from "lucide-react";
import { yapp } from "./yapp-bridge";

/**
 * Winstuitkering-overzicht.
 *
 * 3BM Coöperatie U.A. ontvangt 80%-facturen van de werkmaatschappijen
 * (3BM Bouwkunde, 3BM Engineering, 3BM bouwtechniek). 20% blijft bij
 * de Coöperatie als liquiditeit, wordt het jaar erop uitgekeerd als
 * winstuitkering.
 *
 * Bron: Purchase Invoice waar company = Coöp + supplier in werkmij's.
 * Berekening op net_total (exclusief BTW), want BTW is doorlopende post.
 */

const COOP_COMPANY = "3BM Coöperatie U.A.";

const INTERCO_SUPPLIERS = [
  "3BM bouwtechniek",
  "3BM Engineering",
  "3BM Bouwkunde",
];

interface PurchaseInvoiceForInterco {
  name: string;
  posting_date: string;
  supplier: string;
  supplier_name: string;
  bill_no: string;
  net_total: number;
  grand_total: number;
  outstanding_amount: number;
  status: string;
  docstatus: number;
}

function fmtEur(n: number): string {
  return `€ ${n.toLocaleString("nl-NL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function thisYear(): number {
  return new Date().getFullYear();
}

interface Props {
  company: string;
  erpAppUrl: string;
}

interface EntityStats {
  supplier: string;
  count: number;
  sumNet: number;     // som 80% (excl BTW)
  sumGross: number;   // som grand_total (incl BTW)
  basis100: number;   // 100% basis = sumNet / 0.80
  reserve20: number;  // 20% restant = sumNet * 0.25
}

export default function IntercompanyPanel({ company, erpAppUrl }: Props) {
  const [year, setYear] = useState<number>(thisYear());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pis, setPis] = useState<PurchaseInvoiceForInterco[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const wrongCompany = company !== COOP_COMPANY && company !== "";

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const fromDate = `${year}-01-01`;
      const toDate = `${year}-12-31`;
      const list = await yapp.fetchList<PurchaseInvoiceForInterco>("Purchase Invoice", {
        fields: [
          "name", "posting_date", "supplier", "supplier_name", "bill_no",
          "net_total", "grand_total", "outstanding_amount", "status", "docstatus",
        ],
        filters: [
          ["company", "=", COOP_COMPANY],
          ["supplier", "in", INTERCO_SUPPLIERS],
          ["posting_date", ">=", fromDate],
          ["posting_date", "<=", toDate],
          ["docstatus", "=", 1],
        ],
        limit_page_length: 2000,
        order_by: "posting_date asc",
      });
      setPis(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [year]);

  const statsBySupplier = useMemo<EntityStats[]>(() => {
    const map = new Map<string, EntityStats>();
    for (const supplier of INTERCO_SUPPLIERS) {
      map.set(supplier, { supplier, count: 0, sumNet: 0, sumGross: 0, basis100: 0, reserve20: 0 });
    }
    for (const pi of pis) {
      const e = map.get(pi.supplier);
      if (!e) continue;
      e.count += 1;
      e.sumNet += pi.net_total;
      e.sumGross += pi.grand_total;
    }
    for (const e of map.values()) {
      e.basis100 = e.sumNet / 0.80;
      e.reserve20 = e.sumNet * 0.25;
    }
    return Array.from(map.values()).sort((a, b) => b.sumNet - a.sumNet);
  }, [pis]);

  const totals = useMemo(() => {
    return statsBySupplier.reduce(
      (acc, e) => ({
        count: acc.count + e.count,
        sumNet: acc.sumNet + e.sumNet,
        sumGross: acc.sumGross + e.sumGross,
        basis100: acc.basis100 + e.basis100,
        reserve20: acc.reserve20 + e.reserve20,
      }),
      { count: 0, sumNet: 0, sumGross: 0, basis100: 0, reserve20: 0 },
    );
  }, [statsBySupplier]);

  const piBySupplier = useMemo(() => {
    const map = new Map<string, PurchaseInvoiceForInterco[]>();
    for (const pi of pis) {
      const arr = map.get(pi.supplier) ?? [];
      arr.push(pi);
      map.set(pi.supplier, arr);
    }
    return map;
  }, [pis]);

  function toggle(supplier: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(supplier)) next.delete(supplier);
      else next.add(supplier);
      return next;
    });
  }

  const linkBase = erpAppUrl ? `${erpAppUrl}/app` : "";
  const docLink = (doctype: string, name: string) => {
    const slug = doctype.toLowerCase().replace(/\s+/g, "-");
    return linkBase ? `${linkBase}/${slug}/${encodeURIComponent(name)}` : "#";
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-800">Winstuitkering — 20% restant per entiteit</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            80%-facturen van werkmijen aan {COOP_COMPANY}. 20% blijft als liquiditeit, wordt het jaar erop uitgekeerd.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={year}
            onChange={(e) => setYear(parseInt(e.target.value, 10))}
            className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
          >
            {Array.from({ length: 5 }, (_, i) => thisYear() - i).map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 cursor-pointer text-sm"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Vernieuwen
          </button>
        </div>
      </div>

      {wrongCompany && (
        <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800 flex items-start gap-2">
          <Info size={16} className="shrink-0 mt-0.5" />
          <div>
            Dit overzicht toont altijd <strong>{COOP_COMPANY}</strong> ongeacht het bedrijfsfilter, want winstuitkering is per definitie een Coöp-zaak.
          </div>
        </div>
      )}

      {error && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="w-8 px-2 py-2"></th>
              <th className="text-left px-4 py-2 font-semibold text-slate-600">Entiteit</th>
              <th className="text-right px-4 py-2 font-semibold text-slate-600">#</th>
              <th className="text-right px-4 py-2 font-semibold text-slate-600">80% gefactureerd (excl BTW)</th>
              <th className="text-right px-4 py-2 font-semibold text-slate-600">Incl BTW</th>
              <th className="text-right px-4 py-2 font-semibold text-slate-600">100% basis</th>
              <th className="text-right px-4 py-2 font-semibold text-emerald-700">20% restant ({year + 1})</th>
            </tr>
          </thead>
          <tbody>
            {statsBySupplier.map((s) => {
              const isOpen = expanded.has(s.supplier);
              const rows = piBySupplier.get(s.supplier) ?? [];
              const empty = s.count === 0;
              return (
                <Fragment key={s.supplier}>
                  <tr
                    className={`border-b border-slate-100 hover:bg-slate-50 cursor-pointer ${empty ? "text-slate-400" : ""}`}
                    onClick={() => !empty && toggle(s.supplier)}
                  >
                    <td className="px-2 py-2 text-center">
                      {!empty && (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
                    </td>
                    <td className="px-4 py-2 font-medium">{s.supplier}</td>
                    <td className="px-4 py-2 text-right">{s.count}</td>
                    <td className="px-4 py-2 text-right font-semibold text-slate-800">{fmtEur(s.sumNet)}</td>
                    <td className="px-4 py-2 text-right text-slate-500">{fmtEur(s.sumGross)}</td>
                    <td className="px-4 py-2 text-right text-slate-500">{fmtEur(s.basis100)}</td>
                    <td className="px-4 py-2 text-right font-bold text-emerald-700">{fmtEur(s.reserve20)}</td>
                  </tr>
                  {isOpen && !empty && (
                    <tr className="border-b border-slate-100 bg-slate-50/60">
                      <td></td>
                      <td colSpan={6} className="px-4 py-2">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-slate-500">
                              <th className="text-left py-1">Datum</th>
                              <th className="text-left py-1">Factuurnr</th>
                              <th className="text-left py-1">PI</th>
                              <th className="text-right py-1">Excl BTW</th>
                              <th className="text-right py-1">Incl BTW</th>
                              <th className="text-right py-1">Openstaand</th>
                              <th className="text-right py-1">20% restant</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((r) => (
                              <tr key={r.name} className="text-slate-700">
                                <td className="py-1">{r.posting_date}</td>
                                <td className="py-1 text-slate-500">{r.bill_no || "-"}</td>
                                <td className="py-1">
                                  <a
                                    href={docLink("Purchase Invoice", r.name)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-teal-600 hover:underline inline-flex items-center gap-1"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {r.name} <ExternalLink size={10} />
                                  </a>
                                </td>
                                <td className="py-1 text-right">{fmtEur(r.net_total)}</td>
                                <td className="py-1 text-right text-slate-500">{fmtEur(r.grand_total)}</td>
                                <td className="py-1 text-right text-amber-700">
                                  {r.outstanding_amount > 0 ? fmtEur(r.outstanding_amount) : "-"}
                                </td>
                                <td className="py-1 text-right text-emerald-700">{fmtEur(r.net_total * 0.25)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot className="bg-slate-50 border-t border-slate-200 font-semibold">
            <tr>
              <td></td>
              <td className="px-4 py-2 text-slate-700">Totaal</td>
              <td className="px-4 py-2 text-right text-slate-700">{totals.count}</td>
              <td className="px-4 py-2 text-right text-slate-800">{fmtEur(totals.sumNet)}</td>
              <td className="px-4 py-2 text-right text-slate-500">{fmtEur(totals.sumGross)}</td>
              <td className="px-4 py-2 text-right text-slate-500">{fmtEur(totals.basis100)}</td>
              <td className="px-4 py-2 text-right text-emerald-700">{fmtEur(totals.reserve20)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {!loading && pis.length === 0 && (
        <div className="text-center text-sm text-slate-400 mt-6">
          Geen 80%-facturen gevonden voor {year} bij {COOP_COMPANY}.
        </div>
      )}

      <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded text-xs text-slate-600">
        <strong className="text-slate-700">Berekening:</strong> 80%-bedrag = som van net_total (excl BTW) van Purchase Invoices.
        100% basis = som ÷ 0,80. 20% restant = som × 0,25 (= 20%/80%).
        Uit te keren in {year + 1} als winstuitkering naar de werkmaatschappijen.
      </div>
    </div>
  );
}
