import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Calendar, ArrowUpDown, Filter as FilterIcon } from "lucide-react";
import { yapp } from "./yapp-bridge";

interface GLEntry {
  account: string;
  debit: number;
  credit: number;
  posting_date: string;
}

interface AccountAgg {
  account: string;
  debit: number;
  credit: number;
  net: number;
  gross: number;
}

type Mode = "year" | "month";
type SortKey = "gross" | "net" | "debit" | "credit" | "name";

const MONTHS_NL = [
  "Januari", "Februari", "Maart", "April", "Mei", "Juni",
  "Juli", "Augustus", "September", "Oktober", "November", "December",
];

function fmtEur(n: number): string {
  return `€ ${n.toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function thisYear(): number {
  return new Date().getFullYear();
}

function periodRange(mode: Mode, year: number, month: number): { from: string; to: string; label: string } {
  if (mode === "year") {
    return { from: `${year}-01-01`, to: `${year}-12-31`, label: `Heel ${year}` };
  }
  const m = String(month + 1).padStart(2, "0");
  const last = new Date(year, month + 1, 0).getDate();
  return {
    from: `${year}-${m}-01`,
    to: `${year}-${m}-${String(last).padStart(2, "0")}`,
    label: `${MONTHS_NL[month]} ${year}`,
  };
}

interface Props {
  company: string;
  year: number;
}

export default function LedgerChart({ company, year: defaultYear }: Props) {
  const [mode, setMode] = useState<Mode>("year");
  const [year, setYear] = useState(defaultYear);
  const [month, setMonth] = useState(new Date().getMonth());
  const [sortKey, setSortKey] = useState<SortKey>("gross");
  const [showZero, setShowZero] = useState(false);
  const [maxRows, setMaxRows] = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<GLEntry[]>([]);

  useEffect(() => { setYear(defaultYear); }, [defaultYear]);

  async function load() {
    setLoading(true);
    setError(null);
    const { from, to } = periodRange(mode, year, month);
    const filters: unknown[][] = [
      ["posting_date", ">=", from],
      ["posting_date", "<=", to],
      ["is_cancelled", "=", 0],
    ];
    if (company) filters.unshift(["company", "=", company]);
    try {
      const data = await yapp.fetchList<GLEntry>("GL Entry", {
        fields: ["account", "debit", "credit"],
        filters,
        limit_page_length: 20000,
      });
      setEntries(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout bij ophalen GL Entries");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [company, mode, year, month]);

  const aggregated: AccountAgg[] = useMemo(() => {
    const map = new Map<string, { debit: number; credit: number }>();
    for (const e of entries) {
      const cur = map.get(e.account) ?? { debit: 0, credit: 0 };
      cur.debit += e.debit ?? 0;
      cur.credit += e.credit ?? 0;
      map.set(e.account, cur);
    }
    let arr = Array.from(map.entries()).map(([account, v]) => ({
      account,
      debit: v.debit,
      credit: v.credit,
      net: v.debit - v.credit,
      gross: v.debit + v.credit,
    }));
    if (!showZero) {
      arr = arr.filter((a) => a.gross > 0.01);
    }
    arr.sort((a, b) => {
      switch (sortKey) {
        case "name": return a.account.localeCompare(b.account);
        case "net": return Math.abs(b.net) - Math.abs(a.net);
        case "debit": return b.debit - a.debit;
        case "credit": return b.credit - a.credit;
        case "gross":
        default: return b.gross - a.gross;
      }
    });
    return arr;
  }, [entries, sortKey, showZero]);

  const visible = aggregated.slice(0, maxRows);
  const maxValue = useMemo(() => {
    if (visible.length === 0) return 1;
    return Math.max(...visible.map((a) => Math.max(a.debit, a.credit)));
  }, [visible]);

  const totals = useMemo(() => ({
    accounts: aggregated.length,
    debit: aggregated.reduce((s, a) => s + a.debit, 0),
    credit: aggregated.reduce((s, a) => s + a.credit, 0),
  }), [aggregated]);

  const { label } = periodRange(mode, year, month);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide flex-1 min-w-0">
          Mutaties per grootboek — {label}
        </h3>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-teal-600 text-white rounded-md hover:bg-teal-700 disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Vernieuwen
        </button>
      </div>

      {/* Filter bar */}
      <div className="px-5 py-3 border-b border-slate-200 flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-1 bg-slate-100 rounded-md p-0.5">
          <button
            onClick={() => setMode("year")}
            className={`px-3 py-1 text-xs rounded ${mode === "year" ? "bg-white text-slate-800 shadow-sm" : "text-slate-500"}`}
          >Per jaar</button>
          <button
            onClick={() => setMode("month")}
            className={`px-3 py-1 text-xs rounded ${mode === "month" ? "bg-white text-slate-800 shadow-sm" : "text-slate-500"}`}
          >Per maand</button>
        </div>

        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-slate-400" />
          <select
            value={year}
            onChange={(e) => setYear(parseInt(e.target.value, 10))}
            className="px-2 py-1 bg-white border border-slate-200 rounded text-xs"
          >
            {Array.from({ length: 5 }, (_, i) => thisYear() - i).map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          {mode === "month" && (
            <select
              value={month}
              onChange={(e) => setMonth(parseInt(e.target.value, 10))}
              className="px-2 py-1 bg-white border border-slate-200 rounded text-xs"
            >
              {MONTHS_NL.map((m, i) => (
                <option key={m} value={i}>{m}</option>
              ))}
            </select>
          )}
        </div>

        <div className="flex items-center gap-2">
          <ArrowUpDown size={14} className="text-slate-400" />
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="px-2 py-1 bg-white border border-slate-200 rounded text-xs"
          >
            <option value="gross">Sortering: omzet (debet+credit)</option>
            <option value="net">Sortering: netto (|debet-credit|)</option>
            <option value="debit">Sortering: debet</option>
            <option value="credit">Sortering: credit</option>
            <option value="name">Sortering: naam</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <FilterIcon size={14} className="text-slate-400" />
          <select
            value={maxRows}
            onChange={(e) => setMaxRows(parseInt(e.target.value, 10))}
            className="px-2 py-1 bg-white border border-slate-200 rounded text-xs"
          >
            <option value={15}>Top 15</option>
            <option value={30}>Top 30</option>
            <option value={60}>Top 60</option>
            <option value={9999}>Alle</option>
          </select>
        </div>

        <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer">
          <input type="checkbox" checked={showZero} onChange={(e) => setShowZero(e.target.checked)} />
          Inclusief lege rekeningen
        </label>
      </div>

      {/* Summary line */}
      <div className="px-5 py-2 bg-slate-50 border-b border-slate-200 text-xs text-slate-600 flex flex-wrap gap-4">
        <span><b>{totals.accounts}</b> rekeningen actief</span>
        <span>Totaal debet: <b className="text-blue-700">{fmtEur(totals.debit)}</b></span>
        <span>Totaal credit: <b className="text-orange-700">{fmtEur(totals.credit)}</b></span>
      </div>

      {error && (
        <div className="m-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">{error}</div>
      )}

      {/* Bars */}
      <div className="px-5 py-4">
        {loading ? (
          <div className="text-center py-8 text-slate-400 text-sm">Laden...</div>
        ) : visible.length === 0 ? (
          <div className="text-center py-8 text-slate-400 text-sm">Geen mutaties in deze periode</div>
        ) : (
          <div className="space-y-1.5">
            {visible.map((a) => {
              const debitPct = (a.debit / maxValue) * 100;
              const creditPct = (a.credit / maxValue) * 100;
              return (
                <div key={a.account} className="grid grid-cols-[minmax(180px,260px)_1fr_minmax(140px,auto)] gap-3 items-center text-xs">
                  <div className="truncate text-slate-700" title={a.account}>{a.account}</div>
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1">
                      <div className="h-3 bg-blue-500 rounded-r" style={{ width: `${debitPct}%`, minWidth: a.debit > 0 ? 2 : 0 }} title={`Debet: ${fmtEur(a.debit)}`} />
                      <span className="text-slate-500 text-[10px]">{a.debit > 0 ? fmtEur(a.debit) : ""}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="h-3 bg-orange-500 rounded-r" style={{ width: `${creditPct}%`, minWidth: a.credit > 0 ? 2 : 0 }} title={`Credit: ${fmtEur(a.credit)}`} />
                      <span className="text-slate-500 text-[10px]">{a.credit > 0 ? fmtEur(a.credit) : ""}</span>
                    </div>
                  </div>
                  <div className={`text-right font-semibold ${a.net >= 0 ? "text-blue-700" : "text-orange-700"}`}>
                    Netto {fmtEur(a.net)}
                  </div>
                </div>
              );
            })}
            {aggregated.length > visible.length && (
              <div className="text-center text-xs text-slate-400 mt-3">
                {aggregated.length - visible.length} meer rekeningen verborgen — verhoog Top-filter of selecteer "Alle"
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex items-center gap-4 text-[11px] text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 bg-blue-500 rounded" /> Debet
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 bg-orange-500 rounded" /> Credit
          </span>
        </div>
      </div>
    </div>
  );
}
