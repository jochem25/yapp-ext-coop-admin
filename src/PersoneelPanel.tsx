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

export default function PersoneelPanel({ year, erpAppUrl }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null); // key = `${month}-${company}`

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const list = await yapp.fetchList<Employee>("Employee", {
        fields: [
          "name", "employee_name", "company", "status",
          "date_of_joining", "relieving_date", "designation", "department",
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

  // Kolommen: alle companies met minstens één employee in dit jaar
  const columns = useMemo(() => {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const active = new Set<string>();
    for (const e of employees) {
      if (inEmployment(e, yearStart, yearEnd)) active.add(e.company);
    }
    return Array.from(active).sort();
  }, [employees, year]);

  // matrix[monthIdx][company] = Employee[]
  const matrix = useMemo(() => {
    const out: Record<number, Record<string, Employee[]>> = {};
    for (let m = 0; m < 12; m++) {
      const monthStart = ymd(year, m, 1);
      const monthEnd = ymd(year, m, lastDay(year, m));
      out[m] = {};
      for (const c of columns) out[m][c] = [];
      for (const e of employees) {
        if (!columns.includes(e.company)) continue;
        if (inEmployment(e, monthStart, monthEnd)) {
          out[m][e.company].push(e);
        }
      }
    }
    return out;
  }, [employees, columns, year]);

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
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 bg-teal-600 text-white text-sm rounded-lg hover:bg-teal-700 disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          Vernieuwen
        </button>
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
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-2 font-semibold text-slate-600 w-24">Maand</th>
                {columns.map((c) => (
                  <th key={c} className="text-right px-4 py-2 font-semibold text-slate-600">
                    {c}
                  </th>
                ))}
                <th className="text-right px-4 py-2 font-semibold text-slate-600 w-16">Totaal</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 12 }, (_, m) => {
                const rowTotal = columns.reduce((s, c) => s + matrix[m][c].length, 0);
                return (
                  <Fragment key={m}>
                    <tr className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-2 text-slate-500 font-medium">{MONTH_LABELS[m]}</td>
                      {columns.map((c) => {
                        const count = matrix[m][c].length;
                        const key = `${m}-${c}`;
                        const isOpen = expanded === key;
                        return (
                          <td key={c} className="px-4 py-2 text-right">
                            {count > 0 ? (
                              <button
                                onClick={() => setExpanded(isOpen ? null : key)}
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded hover:bg-teal-50 cursor-pointer ${
                                  isOpen ? "bg-teal-100 text-teal-800 font-semibold" : "text-slate-700"
                                }`}
                                title="Klik om namen te tonen"
                              >
                                {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                {count}
                              </button>
                            ) : (
                              <span className="text-slate-300">–</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-4 py-2 text-right font-semibold text-slate-700">{rowTotal}</td>
                    </tr>
                    {expanded?.startsWith(`${m}-`) && (() => {
                      const cName = expanded.slice(`${m}-`.length);
                      const emps = matrix[m][cName] || [];
                      return (
                        <tr className="border-b border-slate-100 bg-teal-50/40">
                          <td colSpan={columns.length + 2} className="px-4 py-3">
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
                <td className="px-4 py-2 text-slate-600 text-xs uppercase tracking-wide">Piek</td>
                {columns.map((c) => (
                  <td key={c} className="px-4 py-2 text-right text-slate-700">{peakPerColumn[c]}</td>
                ))}
                <td className="px-4 py-2 text-right text-teal-700">
                  {Math.max(...Array.from({ length: 12 }, (_, m) =>
                    columns.reduce((s, c) => s + matrix[m][c].length, 0)
                  ))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
