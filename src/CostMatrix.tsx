import { Fragment, useEffect, useMemo, useState } from "react";
import { RefreshCw, ChevronDown, ChevronRight, ExternalLink, Calendar } from "lucide-react";
import { yapp } from "./yapp-bridge";

/**
 * Kosten-matrix: maand × (grootboek of leverancier).
 *
 * Vervangt het handmatige "Overzicht algemene kosten" Excel-overzicht
 * met live data uit ERPNext GL Entry waar account.root_type='Expense'.
 */

interface Account {
  name: string;
  account_name: string;
  account_number: string | null;
  custom_account_nl: string | null;
}

interface GLEntry {
  name: string;
  posting_date: string;       // YYYY-MM-DD
  account: string;
  debit: number;
  credit: number;
  voucher_type: string;
  voucher_no: string;
  party_type: string | null;
  party: string | null;
  remarks: string | null;
}

type GroupMode = "account" | "supplier";

const MONTHS_NL_SHORT = [
  "Jan", "Feb", "Mrt", "Apr", "Mei", "Jun",
  "Jul", "Aug", "Sep", "Okt", "Nov", "Dec",
];

function fmtEur(n: number): string {
  if (n === 0) return "—";
  return n.toLocaleString("nl-NL", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function fmtEurFull(n: number): string {
  return `€ ${n.toLocaleString("nl-NL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function thisYear(): number {
  return new Date().getFullYear();
}

function monthIndex(isoDate: string): number {
  // "2025-03-14" → 2 (March)
  return parseInt(isoDate.slice(5, 7), 10) - 1;
}

interface Props {
  company: string;
  erpAppUrl: string;
}

export default function CostMatrix({ company, erpAppUrl }: Props) {
  const [year, setYear] = useState<number>(thisYear());
  const [groupMode, setGroupMode] = useState<GroupMode>("account");
  const [hideEmpty, setHideEmpty] = useState<boolean>(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expenseAccounts, setExpenseAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<GLEntry[]>([]);
  const [voucherSupplier, setVoucherSupplier] = useState<Map<string, string>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Load expense accounts
  useEffect(() => {
    const filters: unknown[][] = [
      ["is_group", "=", 0],
      ["root_type", "=", "Expense"],
    ];
    if (company) filters.push(["company", "=", company]);
    yapp.fetchList<Account>("Account", {
      fields: ["name", "account_name", "account_number", "custom_account_nl"],
      filters,
      limit_page_length: 500,
    })
      .then(setExpenseAccounts)
      .catch(() => setExpenseAccounts([]));
  }, [company]);

  async function load() {
    setLoading(true);
    setError(null);
    if (expenseAccounts.length === 0) {
      setEntries([]);
      setLoading(false);
      return;
    }
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const filters: unknown[][] = [
      ["posting_date", ">=", from],
      ["posting_date", "<=", to],
      ["is_cancelled", "=", 0],
      ["account", "in", expenseAccounts.map((a) => a.name)],
      ["debit", ">", 0],
    ];
    if (company) filters.unshift(["company", "=", company]);
    try {
      const piFilters: unknown[][] = [
        ["posting_date", ">=", from],
        ["posting_date", "<=", to],
        ["docstatus", "=", 1],
      ];
      if (company) piFilters.unshift(["company", "=", company]);
      const [data, piList] = await Promise.all([
        yapp.fetchList<GLEntry>("GL Entry", {
          fields: [
            "name", "posting_date", "account", "debit", "credit",
            "voucher_type", "voucher_no", "party_type", "party", "remarks",
          ],
          filters,
          limit_page_length: 10000,
          order_by: "posting_date asc",
        }),
        yapp.fetchList<{ name: string; supplier_name: string }>("Purchase Invoice", {
          fields: ["name", "supplier_name"],
          filters: piFilters,
          limit_page_length: 5000,
        }),
      ]);
      setEntries(data);
      const map = new Map<string, string>();
      for (const pi of piList) map.set(pi.name, pi.supplier_name);
      setVoucherSupplier(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout");
    } finally {
      setLoading(false);
    }
  }

  function resolveSupplier(e: GLEntry): string {
    if (e.party && e.party_type === "Supplier") return e.party;
    if (e.voucher_type === "Purchase Invoice") {
      const s = voucherSupplier.get(e.voucher_no);
      if (s) return s;
    }
    return "(zonder leverancier)";
  }

  useEffect(() => { load(); }, [year, company, expenseAccounts.length]);

  const accountMeta = useMemo(() => {
    const m = new Map<string, { nl: string; number: string; name: string }>();
    for (const a of expenseAccounts) {
      m.set(a.name, {
        nl: a.custom_account_nl ?? "",
        number: a.account_number ?? "",
        name: a.account_name,
      });
    }
    return m;
  }, [expenseAccounts]);

  function accountLabel(account: string): string {
    const meta = accountMeta.get(account);
    if (!meta) return account;
    if (meta.nl) return meta.nl;
    return meta.number ? `${meta.number} ${meta.name}` : meta.name;
  }

  function groupKey(e: GLEntry): string {
    if (groupMode === "account") return e.account;
    return resolveSupplier(e);
  }

  function groupLabel(key: string): string {
    if (groupMode === "account") return accountLabel(key);
    return key;
  }

  // Build matrix: groupKey -> [12 months] of amount, and overall row total
  const { rows, monthTotals, grandTotal, entriesByGroup } = useMemo(() => {
    const monthMap = new Map<string, number[]>();
    const entryMap = new Map<string, GLEntry[]>();
    for (const e of entries) {
      const key = groupKey(e);
      let arr = monthMap.get(key);
      if (!arr) {
        arr = Array.from({ length: 12 }, () => 0);
        monthMap.set(key, arr);
      }
      const idx = monthIndex(e.posting_date);
      arr[idx] += e.debit;

      let list = entryMap.get(key);
      if (!list) {
        list = [];
        entryMap.set(key, list);
      }
      list.push(e);
    }
    const arr = Array.from(monthMap.entries()).map(([key, months]) => ({
      key,
      months,
      total: months.reduce((s, v) => s + v, 0),
    }));
    arr.sort((a, b) => b.total - a.total);
    const monthTotals = Array.from({ length: 12 }, (_, i) =>
      arr.reduce((s, r) => s + r.months[i], 0),
    );
    const grandTotal = monthTotals.reduce((s, v) => s + v, 0);
    return { rows: arr, monthTotals, grandTotal, entriesByGroup: entryMap };
  }, [entries, groupMode, voucherSupplier]);

  const visibleRows = hideEmpty ? rows.filter((r) => r.total > 0) : rows;

  function toggle(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const linkBase = erpAppUrl ? `${erpAppUrl}/app` : "";
  function voucherLink(e: GLEntry): string {
    if (!linkBase) return "#";
    const slug = e.voucher_type.toLowerCase().replace(/\s+/g, "-");
    return `${linkBase}/${slug}/${encodeURIComponent(e.voucher_no)}`;
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-800">Algemene kosten — matrix per maand</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            GL Entries waar grootboek root_type = Expense, gegroepeerd per {groupMode === "account" ? "grootboek" : "leverancier"}.
            {!company && " · Geen bedrijf gekozen: toont alle entiteiten."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-slate-400" />
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

      <div className="mb-3 flex items-center gap-3 text-sm flex-wrap">
        <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-md p-0.5">
          <button
            onClick={() => setGroupMode("account")}
            className={`px-3 py-1 text-xs rounded ${groupMode === "account" ? "bg-teal-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}
          >
            Per grootboek
          </button>
          <button
            onClick={() => setGroupMode("supplier")}
            className={`px-3 py-1 text-xs rounded ${groupMode === "supplier" ? "bg-teal-600 text-white" : "text-slate-600 hover:bg-slate-100"}`}
          >
            Per leverancier
          </button>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
          <input
            type="checkbox"
            checked={hideEmpty}
            onChange={(e) => setHideEmpty(e.target.checked)}
            className="accent-teal-600"
          />
          Verberg lege rijen
        </label>
        <div className="ml-auto text-xs text-slate-500">
          {visibleRows.length} rijen · {entries.length} GL-regels
        </div>
      </div>

      {error && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
            <tr>
              <th className="w-6 px-1 py-2"></th>
              <th className="text-left px-3 py-2 font-semibold text-slate-600 min-w-[200px]">
                {groupMode === "account" ? "Grootboek" : "Leverancier"}
              </th>
              {MONTHS_NL_SHORT.map((m, i) => (
                <th key={i} className="text-right px-2 py-2 font-semibold text-slate-600 whitespace-nowrap">{m}</th>
              ))}
              <th className="text-right px-3 py-2 font-semibold text-slate-700 whitespace-nowrap">Totaal</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => {
              const isOpen = expanded.has(r.key);
              const items = entriesByGroup.get(r.key) ?? [];
              return (
                <Fragment key={r.key}>
                  <tr
                    className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                    onClick={() => toggle(r.key)}
                  >
                    <td className="px-1 py-1.5 text-center text-slate-400">
                      {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </td>
                    <td className="px-3 py-1.5 text-slate-700 truncate max-w-[280px]" title={groupLabel(r.key)}>
                      {groupLabel(r.key)}
                    </td>
                    {r.months.map((v, i) => (
                      <td key={i} className={`px-2 py-1.5 text-right tabular-nums ${v > 0 ? "text-slate-700" : "text-slate-300"}`}>
                        {fmtEur(v)}
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-right font-semibold text-slate-800 tabular-nums">{fmtEur(r.total)}</td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-slate-100 bg-slate-50/60">
                      <td></td>
                      <td colSpan={14} className="px-3 py-2">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-slate-500">
                              <th className="text-left py-1">Datum</th>
                              <th className="text-left py-1">{groupMode === "account" ? "Leverancier" : "Grootboek"}</th>
                              <th className="text-left py-1">Voucher</th>
                              <th className="text-left py-1">Toelichting</th>
                              <th className="text-right py-1">Bedrag</th>
                            </tr>
                          </thead>
                          <tbody>
                            {items.map((it) => (
                              <tr key={it.name} className="text-slate-700">
                                <td className="py-1 text-slate-500">{it.posting_date}</td>
                                <td className="py-1 text-slate-600">
                                  {groupMode === "account"
                                    ? (resolveSupplier(it) === "(zonder leverancier)" ? "-" : resolveSupplier(it))
                                    : accountLabel(it.account)}
                                </td>
                                <td className="py-1">
                                  <a
                                    href={voucherLink(it)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-teal-600 hover:underline inline-flex items-center gap-1"
                                  >
                                    {it.voucher_no} <ExternalLink size={9} />
                                  </a>
                                </td>
                                <td className="py-1 text-slate-500 truncate max-w-[300px]" title={it.remarks ?? ""}>
                                  {it.remarks ?? "-"}
                                </td>
                                <td className="py-1 text-right tabular-nums">{fmtEurFull(it.debit)}</td>
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
            {visibleRows.length === 0 && !loading && (
              <tr>
                <td colSpan={15} className="px-3 py-8 text-center text-slate-400">
                  Geen kostenregels gevonden voor {year}.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot className="bg-slate-50 border-t border-slate-200 font-semibold sticky bottom-0">
            <tr>
              <td></td>
              <td className="px-3 py-2 text-slate-700">Totaal per maand</td>
              {monthTotals.map((v, i) => (
                <td key={i} className="px-2 py-2 text-right text-slate-700 tabular-nums">{fmtEur(v)}</td>
              ))}
              <td className="px-3 py-2 text-right text-slate-900 tabular-nums">{fmtEurFull(grandTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-3 text-[11px] text-slate-500">
        Bedragen exclusief BTW. Klik een rij voor losse regels.
        Bron: GL Entry · {expenseAccounts.length} expense-accounts voor {company || "alle entiteiten"}.
      </div>
    </div>
  );
}
