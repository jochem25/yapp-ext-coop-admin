import { Fragment, useEffect, useMemo, useState } from "react";
import { RefreshCw, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { yapp } from "./yapp-bridge";

/**
 * Personeel-in-dienst per entiteit per maand.
 *
 * Iemand telt mee voor maand M wanneer:
 *   date_of_joining  ≤ laatste dag van M
 *   AND (relieving_date is null OR relieving_date ≥ eerste dag van M)
 *
 * Status (Active/Inactive/Left/Suspended) is current-snapshot — alleen voor
 * badge bij namen, niet gebruikt in tel-logica.
 */

interface Employee {
  name: string;
  employee_name: string;
  company: string;
  status: string;
  date_of_joining: string | null;
  relieving_date: string | null;
  designation: string | null;
  department: string | null;
  employment_type: string | null;
}

interface SIRevenue {
  company: string;
  net_total: number;
  is_internal_customer: number;
}

const ZERO_HOURS_TYPE = "Nuluren contract";
const COOP_COMPANY = "3BM Coöperatie U.A.";

const COST_BASE_KEY = "coop_admin_personeel_cost_base";
const COST_MARGINAL_KEY = "coop_admin_personeel_cost_marginal";
const DEFAULT_BASE = 670;
const DEFAULT_MARGINAL = 375;

function loadCost(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function fmtEur(n: number): string {
  return `€ ${n.toLocaleString("nl-NL", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

interface Props {
  year: number;
  erpAppUrl: string;
}

const MONTH_LABELS = [
  "jan", "feb", "mrt", "apr", "mei", "jun",
  "jul", "aug", "sep", "okt", "nov", "dec",
];

const STATUS_TONE: Record<string, string> = {
  Active: "bg-emerald-100 text-emerald-700",
  Suspended: "bg-amber-100 text-amber-700",
  Inactive: "bg-slate-100 text-slate-600",
  Left: "bg-slate-200 text-slate-500",
};

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function lastDay(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate();
}

function inEmployment(emp: Employee, monthStart: string, monthEnd: string): boolean {
  if (!emp.date_of_joining) return false;
  if (emp.date_of_joining > monthEnd) return false;
  if (emp.relieving_date && emp.relieving_date < monthStart) return false;
  return true;
}

export default function PersoneelPanel({ year: rawYear, erpAppUrl }: Props) {
  // Matrix toont maand × entiteit: bij "Alle jaren" globaal (0) valt deze tab
  // terug op het huidige jaar — een matrix kan per definitie maar één jaar
  // tegelijk weergeven.
  const year = rawYear > 0 ? rawYear : new Date().getFullYear();
  const allYearsFallback = rawYear === 0;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [siRevenue, setSiRevenue] = useState<SIRevenue[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null); // key = `${month}-${company}`
  const [onlyActive, setOnlyActive] = useState(true);
  const [hideZeroHours, setHideZeroHours] = useState(true);
  const [costBase, setCostBase] = useState<number>(() => loadCost(COST_BASE_KEY, DEFAULT_BASE));
  const [costMarginal, setCostMarginal] = useState<number>(() => loadCost(COST_MARGINAL_KEY, DEFAULT_MARGINAL));

  useEffect(() => { localStorage.setItem(COST_BASE_KEY, String(costBase)); }, [costBase]);
  useEffect(() => { localStorage.setItem(COST_MARGINAL_KEY, String(costMarginal)); }, [costMarginal]);

  // Per-maand zichtbaarheid wordt al correct afgehandeld via inEmployment()
  // op basis van date_of_joining + relieving_date. Een werknemer die in maart
  // is uitgestapt blijft dus zichtbaar in jan/feb/mrt — alleen vanaf april niet.
  //
  // `onlyActive` filtert nog WEL globaal de "ghosts": records met status ≠
  // Active maar zonder relieving_date — daar kan geen einddatum bepaald worden,
  // dus zouden ze tot in den treure blijven verschijnen.
  const visibleEmployees = useMemo(
    () => employees.filter((e) => {
      if (hideZeroHours && e.employment_type === ZERO_HOURS_TYPE) return false;
      if (onlyActive && e.status !== "Active" && !e.relieving_date) return false;
      return true;
    }),
    [employees, onlyActive, hideZeroHours],
  );

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const list = await yapp.fetchList<Employee>("Employee", {
        fields: [
          "name", "employee_name", "company", "status",
          "date_of_joining", "relieving_date", "designation", "department",
          "employment_type",
        ],
        filters: [],
        limit_page_length: 1000,
        order_by: "date_of_joining asc",
      });
      setEmployees(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // Externe omzet per company voor het geselecteerde jaar (her-fetched bij year-wijziging).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sis = await yapp.fetchList<SIRevenue>("Sales Invoice", {
          fields: ["company", "net_total", "is_internal_customer"],
          filters: [
            ["docstatus", "=", 1],
            ["posting_date", ">=", `${year}-01-01`],
            ["posting_date", "<=", `${year}-12-31`],
          ],
          limit_page_length: 5000,
        });
        if (!cancelled) setSiRevenue(sis);
      } catch {
        if (!cancelled) setSiRevenue([]);
      }
    })();
    return () => { cancelled = true; };
  }, [year]);

  // Omzet per company op 100%-basis:
  //  - Externe SI's (is_internal_customer=0): tellen 1-op-1
  //  - Entiteit-SI's aan Coöp (is_internal_customer=1, company ≠ Coöp):
  //    dit is het 80%-deel van de doorbelasting, dus omzet = net_total / 0.80
  //  - Coöp's eigen intercompany-SI's (zeldzaam): genegeerd om dubbeltelling te voorkomen
  const revenueByCompany = useMemo(() => {
    const m = new Map<string, number>();
    for (const si of siRevenue) {
      const isInter = !!si.is_internal_customer;
      const isCoop = si.company === COOP_COMPANY;
      const net = si.net_total ?? 0;
      if (isInter && !isCoop) {
        m.set(si.company, (m.get(si.company) ?? 0) + net / 0.80);
      } else if (!isInter) {
        m.set(si.company, (m.get(si.company) ?? 0) + net);
      }
    }
    return m;
  }, [siRevenue]);

  const revenueTotal = useMemo(
    () => Array.from(revenueByCompany.values()).reduce((s, v) => s + v, 0),
    [revenueByCompany],
  );

  // Kolommen: alle companies met minstens één employee in dit jaar
  const columns = useMemo(() => {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const active = new Set<string>();
    for (const e of visibleEmployees) {
      if (inEmployment(e, yearStart, yearEnd)) active.add(e.company);
    }
    return Array.from(active).sort();
  }, [visibleEmployees, year]);

  // matrix[monthIdx][company] = Employee[]
  const matrix = useMemo(() => {
    const out: Record<number, Record<string, Employee[]>> = {};
    for (let m = 0; m < 12; m++) {
      const monthStart = ymd(year, m, 1);
      const monthEnd = ymd(year, m, lastDay(year, m));
      out[m] = {};
      for (const c of columns) out[m][c] = [];
      for (const e of visibleEmployees) {
        if (!columns.includes(e.company)) continue;
        if (inEmployment(e, monthStart, monthEnd)) {
          out[m][e.company].push(e);
        }
      }
    }
    return out;
  }, [visibleEmployees, columns, year]);

  // Totaal per kolom = piek over de 12 maanden (max werknemers in een maand binnen jaar)
  const peakPerColumn = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of columns) {
      let max = 0;
      for (let m = 0; m < 12; m++) max = Math.max(max, matrix[m][c].length);
      out[c] = max;
    }
    return out;
  }, [matrix, columns]);

  // Coöperatie-kosten per maand per entiteit op basis van die-maand-headcount.
  // De input-bedragen zijn PER MAAND. Coöp betaalt zelf nooit (0).
  // Regel: 1 OF 2 leden = solo-tarief (costBase). Vanaf de 3e medewerker
  // komt er costMarginal per extra hoofd bovenop. Jaartotal = som van 12 maanden.
  function monthlyCostForCount(n: number): number {
    if (n === 0) return 0;
    if (n <= 2) return costBase;
    return costBase + (n - 2) * costMarginal;
  }

  const monthlyCostMatrix = useMemo(() => {
    const out: Record<number, Record<string, number>> = {};
    for (let m = 0; m < 12; m++) {
      out[m] = {};
      for (const c of columns) {
        out[m][c] = c === COOP_COMPANY ? 0 : monthlyCostForCount(matrix[m][c].length);
      }
    }
    return out;
  }, [matrix, columns, costBase, costMarginal]);

  const costPerColumn = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of columns) {
      let sum = 0;
      for (let m = 0; m < 12; m++) sum += monthlyCostMatrix[m][c];
      out[c] = sum;
    }
    return out;
  }, [monthlyCostMatrix, columns]);

  const costTotal = useMemo(
    () => Object.values(costPerColumn).reduce((s, v) => s + v, 0),
    [costPerColumn],
  );

  const erpLink = (empName: string) =>
    erpAppUrl ? `${erpAppUrl}/app/employee/${encodeURIComponent(empName)}` : "#";

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
            Personeel in dienst — {year}
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Klik op een aantal om de namen uit te klappen
            {allYearsFallback && ` · "Alle jaren" niet ondersteund — toont ${year}.`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
            <span className="relative inline-flex items-center">
              <input
                type="checkbox"
                checked={hideZeroHours}
                onChange={(e) => setHideZeroHours(e.target.checked)}
                className="sr-only peer"
              />
              <span className="w-9 h-5 bg-slate-200 rounded-full peer-checked:bg-teal-600 transition-colors"></span>
              <span className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4"></span>
            </span>
            Verberg 0-uren
          </label>
          <label
            className="inline-flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none"
            title="Verberg records met status ≠ Active maar zonder einddatum (data-glitch). Werknemers met een geldige relieving_date blijven zichtbaar in de maanden vóór hun vertrek."
          >
            <span className="relative inline-flex items-center">
              <input
                type="checkbox"
                checked={onlyActive}
                onChange={(e) => setOnlyActive(e.target.checked)}
                className="sr-only peer"
              />
              <span className="w-9 h-5 bg-slate-200 rounded-full peer-checked:bg-teal-600 transition-colors"></span>
              <span className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4"></span>
            </span>
            Verberg ghosts
          </label>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 bg-teal-600 text-white text-sm rounded-lg hover:bg-teal-700 disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Vernieuwen
          </button>
        </div>
      </div>

      <div className="px-5 py-2 bg-white border-b border-slate-100 flex items-center gap-4 flex-wrap text-sm">
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Kosten/jaar per entiteit</span>
        <label className="inline-flex items-center gap-2 text-slate-600">
          Solo (1-2 leden) /mnd
          <span className="text-slate-400">€</span>
          <input
            type="number"
            min={0}
            step={1}
            value={costBase}
            onChange={(e) => setCostBase(Number(e.target.value) || 0)}
            className="w-20 px-2 py-1 border border-slate-200 rounded text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
        </label>
        <label className="inline-flex items-center gap-2 text-slate-600">
          Per extra medewerker (3+) /mnd
          <span className="text-slate-400">€</span>
          <input
            type="number"
            min={0}
            step={1}
            value={costMarginal}
            onChange={(e) => setCostMarginal(Number(e.target.value) || 0)}
            className="w-20 px-2 py-1 border border-slate-200 rounded text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
        </label>
        <span className="text-xs text-slate-400">
          Tarieven per maand. 1 of 2 leden = solo-tarief; vanaf 3 leden = solo + (aantal − 2) × extra-tarief.
          Jaartotaal = som van 12 maanden. Coöperatie betaalt niks.
        </span>
      </div>

      {error && (
        <div className="m-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {columns.length === 0 && !loading && (
        <div className="px-5 py-8 text-center text-slate-400 text-sm">
          Geen personeel gevonden voor {year}.
        </div>
      )}

      {columns.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-2 py-1.5 font-semibold text-slate-600 w-20">Maand</th>
                {columns.map((c) => (
                  <th key={c} className="text-right px-2 py-1.5 font-semibold text-slate-600">
                    {c}
                  </th>
                ))}
                <th className="text-right px-2 py-1.5 font-semibold text-slate-600 w-20">Totaal</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 12 }, (_, m) => {
                const rowTotal = columns.reduce((s, c) => s + matrix[m][c].length, 0);
                const rowCost = columns.reduce((s, c) => s + monthlyCostMatrix[m][c], 0);
                return (
                  <Fragment key={m}>
                    <tr className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-2 py-1 text-slate-500 font-medium">{MONTH_LABELS[m]}</td>
                      {columns.map((c) => {
                        const count = matrix[m][c].length;
                        const cost = monthlyCostMatrix[m][c];
                        const key = `${m}-${c}`;
                        const isOpen = expanded === key;
                        return (
                          <td key={c} className="px-2 py-1 text-right">
                            {count > 0 ? (
                              <div className="inline-flex flex-col items-end leading-tight">
                                <button
                                  onClick={() => setExpanded(isOpen ? null : key)}
                                  className={`inline-flex items-center gap-1 px-1.5 py-0 rounded hover:bg-teal-50 cursor-pointer ${
                                    isOpen ? "bg-teal-100 text-teal-800 font-semibold" : "text-slate-700"
                                  }`}
                                  title="Klik om namen te tonen"
                                >
                                  {isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                                  {count}
                                </button>
                                {cost > 0 && (
                                  <span className="text-[10px] text-slate-400 tabular-nums mt-0.5">
                                    {fmtEur(cost)}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-slate-300">–</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-2 py-1 text-right text-slate-700">
                        <div className="inline-flex flex-col items-end leading-tight">
                          <span className="font-semibold">{rowTotal}</span>
                          {rowCost > 0 && (
                            <span className="text-[10px] text-slate-400 tabular-nums mt-0.5">{fmtEur(rowCost)}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expanded?.startsWith(`${m}-`) && (() => {
                      const cName = expanded.slice(`${m}-`.length);
                      const emps = matrix[m][cName] || [];
                      return (
                        <tr className="border-b border-slate-100 bg-teal-50/40">
                          <td colSpan={columns.length + 2} className="px-2 py-2">
                            <div className="text-xs text-slate-500 uppercase tracking-wide mb-2">
                              {MONTH_LABELS[m]} {year} · {cName} · {emps.length} {emps.length === 1 ? "persoon" : "personen"}
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                              {emps
                                .slice()
                                .sort((a, b) => a.employee_name.localeCompare(b.employee_name))
                                .map((e) => {
                                  const tone = STATUS_TONE[e.status] ?? "bg-slate-100 text-slate-600";
                                  return (
                                    <div
                                      key={e.name}
                                      className="flex items-center justify-between gap-2 px-3 py-1.5 bg-white border border-slate-200 rounded"
                                    >
                                      <div className="min-w-0 flex-1">
                                        <a
                                          href={erpLink(e.name)}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-slate-800 hover:text-teal-700 hover:underline inline-flex items-center gap-1 text-sm truncate"
                                        >
                                          {e.employee_name}
                                          <ExternalLink size={10} className="shrink-0" />
                                        </a>
                                        {e.designation && (
                                          <div className="text-[11px] text-slate-400 truncate">{e.designation}</div>
                                        )}
                                      </div>
                                      <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full ${tone}`}>
                                        {e.status}
                                      </span>
                                    </div>
                                  );
                                })}
                            </div>
                          </td>
                        </tr>
                      );
                    })()}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                <td className="px-2 py-1.5 text-slate-600 text-[10px] uppercase tracking-wide">Piek</td>
                {columns.map((c) => (
                  <td key={c} className="px-2 py-1.5 text-right text-slate-700">{peakPerColumn[c]}</td>
                ))}
                <td className="px-2 py-1.5 text-right text-teal-700">
                  {Math.max(...Array.from({ length: 12 }, (_, m) =>
                    columns.reduce((s, c) => s + matrix[m][c].length, 0)
                  ))}
                </td>
              </tr>
              <tr className="bg-slate-50 font-semibold">
                <td className="px-2 py-1.5 text-slate-600 text-[10px] uppercase tracking-wide">Kosten/jaar</td>
                {columns.map((c) => (
                  <td key={c} className="px-2 py-1.5 text-right tabular-nums text-slate-700">
                    {c === COOP_COMPANY ? <span className="text-slate-300">—</span> : fmtEur(costPerColumn[c])}
                  </td>
                ))}
                <td className="px-2 py-1.5 text-right tabular-nums text-teal-700">{fmtEur(costTotal)}</td>
              </tr>
              <tr className="bg-slate-50/60">
                <td
                  className="px-2 py-1.5 text-slate-500 text-[10px] uppercase tracking-wide"
                  title="Externe Sales Invoices (1:1) plus entiteit-SI's aan Coöp / 0,80 (= 100%-basis volgens 80/20-regel)"
                >
                  Omzet (100%)
                </td>
                {columns.map((c) => (
                  <td key={c} className="px-2 py-1.5 text-right tabular-nums text-slate-500">
                    {fmtEur(revenueByCompany.get(c) ?? 0)}
                  </td>
                ))}
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">{fmtEur(revenueTotal)}</td>
              </tr>
              <tr className="bg-slate-50/60">
                <td
                  className="px-2 py-1.5 text-slate-500 text-[10px] uppercase tracking-wide"
                  title="Coöp-bijdrage als % van externe omzet"
                >
                  Coöp-kosten % omzet
                </td>
                {columns.map((c) => {
                  const rev = revenueByCompany.get(c) ?? 0;
                  const cost = costPerColumn[c] ?? 0;
                  if (c === COOP_COMPANY || rev <= 0 || cost <= 0) {
                    return <td key={c} className="px-2 py-1.5 text-right text-slate-300">—</td>;
                  }
                  const pct = (cost / rev) * 100;
                  const tone = pct >= 10 ? "text-rose-600" : pct >= 5 ? "text-amber-600" : "text-emerald-600";
                  return (
                    <td key={c} className={`px-2 py-1.5 text-right tabular-nums ${tone}`}>
                      {pct.toFixed(1)}%
                    </td>
                  );
                })}
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                  {revenueTotal > 0 && costTotal > 0 ? `${((costTotal / revenueTotal) * 100).toFixed(1)}%` : "—"}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
