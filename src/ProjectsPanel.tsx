import { Fragment, useEffect, useMemo, useState } from "react";
import { RefreshCw, ChevronDown, ChevronRight, ExternalLink, Info } from "lucide-react";
import { yapp } from "./yapp-bridge";
import { SortHeader, FilterBar, sortRows, type SortState } from "./table-helpers";

/**
 * Projecten-overzicht: Coöp output (naar eindklant) vs entiteiten input (naar Coöp).
 *
 * Aanpak per spec:
 * - Query 1: Coöp SI's (company=Coöp) naar EXTERNE klanten (customer NOT IN entiteiten + Coöp zelf)
 * - Query 2: Entiteit SI's (company in entiteiten) naar Coöp (customer=Coöp)
 *   Hier staat het project-veld doorgaans wel correct gevuld, in tegenstelling tot Coöp's PI's.
 *
 * Bedragen: grand_total (incl BTW) — apples-to-apples vergelijking.
 * 80% norm = coop_output × 0,80. Verschil = total_input − norm.
 * Cumulatief, alle jaren.
 */

const COOP_COMPANY = "3BM Coöperatie U.A.";
const E_BOUWKUNDE = "3BM Bouwkunde";
const E_BOUWTECHNIEK = "3BM Bouwtechniek V.O.F.";
const E_ENGINEERING = "3BM Engineering";

const ENTITIES = [E_BOUWKUNDE, E_BOUWTECHNIEK, E_ENGINEERING];
const EXCLUDE_AS_CUSTOMER = [COOP_COMPANY, ...ENTITIES];

const OVERHEAD_PROJECT = "0000";
const NO_PROJECT_KEY = "(geen project)";

interface SI {
  name: string;
  company: string;
  posting_date: string;
  customer: string;
  customer_name: string;
  project: string | null;
  grand_total: number;
  net_total: number;
  is_return: number;
  status: string;
}

type Sluit = "JA" | "BIJNA" | "NEE" | "NVT";

interface ProjectRow {
  project: string;             // sleutel: "2459" / "0000" / NO_PROJECT_KEY
  coopOutput: number;
  bouwkundeInput: number;
  bouwtechniekInput: number;
  engineeringInput: number;
  totalInput: number;
  norm80: number;
  delta: number;               // totalInput − norm80
  absDelta: number;            // |delta| voor sorteren op "verschil grootte"
  sluit: Sluit;
  sluitOrder: number;          // 0=NEE, 1=BIJNA, 2=NVT, 3=JA voor sorteren
  isOverhead: boolean;
  searchBlob: string;          // pre-computed lowercase search-target (project + alle customer_names)
}

function fmtEur(n: number): string {
  return `€ ${n.toLocaleString("nl-NL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const SLUIT_CHIP: Record<Sluit, { label: string; chip: string }> = {
  JA: { label: "🟢 JA", chip: "bg-emerald-100 text-emerald-700" },
  BIJNA: { label: "🟡 BIJNA", chip: "bg-amber-100 text-amber-700" },
  NEE: { label: "🔴 NEE", chip: "bg-red-100 text-red-700" },
  NVT: { label: "—", chip: "bg-slate-100 text-slate-500" },
};

function projectKey(s: SI): string {
  if (!s.project || s.project.trim() === "") return NO_PROJECT_KEY;
  return s.project;
}

function classify(coopOut: number, totalInput: number, isOverhead: boolean): Sluit {
  if (isOverhead) return "NVT";
  const delta = totalInput - coopOut * 0.8;
  const a = Math.abs(delta);
  if (a <= 1.0) return "JA";
  const denom = Math.max(coopOut, totalInput);
  if (a <= 1000 && denom > 0 && a / denom < 0.10) return "BIJNA";
  return "NEE";
}

interface Props {
  company: string;
  erpAppUrl: string;
  inclBTW: boolean;
}

type FilterMode = "all" | "niet_sluitend" | "input_hoger" | "input_lager" | "alleen_overhead";

const SLUIT_ORDER: Record<Sluit, number> = { NEE: 0, BIJNA: 1, NVT: 2, JA: 3 };

export default function ProjectsPanel({ company, erpAppUrl, inclBTW }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coopSis, setCoopSis] = useState<SI[]>([]);
  const [entitySis, setEntitySis] = useState<SI[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<FilterMode>("all");
  const [sort, setSort] = useState<SortState | null>({ field: "coopOutput", dir: "desc" });
  const [search, setSearch] = useState("");

  const wrongCompany = company !== COOP_COMPANY && company !== "";

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const fields = [
        "name", "company", "posting_date", "customer", "customer_name",
        "project", "grand_total", "net_total", "is_return", "status",
      ];
      const [coop, entity] = await Promise.all([
        yapp.fetchList<SI>("Sales Invoice", {
          fields,
          filters: [
            ["company", "=", COOP_COMPANY],
            ["docstatus", "=", 1],
            ["customer", "not in", EXCLUDE_AS_CUSTOMER],
          ],
          limit_page_length: 10000,
          order_by: "posting_date asc",
        }),
        yapp.fetchList<SI>("Sales Invoice", {
          fields,
          filters: [
            ["company", "in", ENTITIES],
            ["customer", "=", COOP_COMPANY],
            ["docstatus", "=", 1],
          ],
          limit_page_length: 10000,
          order_by: "posting_date asc",
        }),
      ]);
      setCoopSis(coop);
      setEntitySis(entity);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const projectRows = useMemo<ProjectRow[]>(() => {
    const map = new Map<string, ProjectRow>();
    const customerNames = new Map<string, Set<string>>();  // project → set(customer_name)
    const ensure = (key: string): ProjectRow => {
      let r = map.get(key);
      if (!r) {
        r = {
          project: key,
          coopOutput: 0,
          bouwkundeInput: 0,
          bouwtechniekInput: 0,
          engineeringInput: 0,
          totalInput: 0,
          norm80: 0,
          delta: 0,
          absDelta: 0,
          sluit: "JA",
          sluitOrder: SLUIT_ORDER.JA,
          isOverhead: key === OVERHEAD_PROJECT,
          searchBlob: "",
        };
        map.set(key, r);
        customerNames.set(key, new Set());
      }
      return r;
    };
    const amt = (s: SI): number => inclBTW ? s.grand_total : s.net_total;
    for (const s of coopSis) {
      const k = projectKey(s);
      const r = ensure(k);
      r.coopOutput += amt(s);
      if (s.customer_name) customerNames.get(k)!.add(s.customer_name);
    }
    for (const s of entitySis) {
      const k = projectKey(s);
      const r = ensure(k);
      switch (s.company) {
        case E_BOUWKUNDE: r.bouwkundeInput += amt(s); break;
        case E_BOUWTECHNIEK: r.bouwtechniekInput += amt(s); break;
        case E_ENGINEERING: r.engineeringInput += amt(s); break;
      }
    }
    for (const r of map.values()) {
      r.totalInput = r.bouwkundeInput + r.bouwtechniekInput + r.engineeringInput;
      r.norm80 = r.coopOutput * 0.80;
      r.delta = r.totalInput - r.norm80;
      r.absDelta = Math.abs(r.delta);
      r.sluit = classify(r.coopOutput, r.totalInput, r.isOverhead);
      r.sluitOrder = SLUIT_ORDER[r.sluit];
      const customers = Array.from(customerNames.get(r.project) ?? []).join(" ");
      r.searchBlob = `${r.project} ${customers} ${r.sluit}`.toLowerCase();
    }
    return Array.from(map.values());
  }, [coopSis, entitySis, inclBTW]);

  const semanticFiltered = useMemo(() => {
    switch (filter) {
      case "niet_sluitend":
        return projectRows.filter((r) => r.sluit === "NEE" || r.sluit === "BIJNA");
      case "input_hoger":
        return projectRows.filter((r) => !r.isOverhead && r.delta > 1);
      case "input_lager":
        return projectRows.filter((r) => !r.isOverhead && r.delta < -1);
      case "alleen_overhead":
        return projectRows.filter((r) => r.isOverhead || r.project === NO_PROJECT_KEY);
      default:
        return projectRows;
    }
  }, [projectRows, filter]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const searched = needle
      ? semanticFiltered.filter((r) => r.searchBlob.includes(needle))
      : semanticFiltered;
    return sortRows(searched, sort);
  }, [semanticFiltered, search, sort]);

  const totals = useMemo(() => filtered.reduce(
    (acc, r) => ({
      coopOutput: acc.coopOutput + r.coopOutput,
      bouwkundeInput: acc.bouwkundeInput + r.bouwkundeInput,
      bouwtechniekInput: acc.bouwtechniekInput + r.bouwtechniekInput,
      engineeringInput: acc.engineeringInput + r.engineeringInput,
      totalInput: acc.totalInput + r.totalInput,
      norm80: acc.norm80 + r.norm80,
      delta: acc.delta + r.delta,
    }),
    { coopOutput: 0, bouwkundeInput: 0, bouwtechniekInput: 0, engineeringInput: 0, totalInput: 0, norm80: 0, delta: 0 },
  ), [filtered]);

  const sisByProject = useMemo(() => {
    const m = new Map<string, SI[]>();
    for (const s of coopSis) {
      const k = projectKey(s);
      const arr = m.get(k) ?? [];
      arr.push(s);
      m.set(k, arr);
    }
    for (const s of entitySis) {
      const k = projectKey(s);
      const arr = m.get(k) ?? [];
      arr.push(s);
      m.set(k, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => a.posting_date.localeCompare(b.posting_date));
    }
    return m;
  }, [coopSis, entitySis]);

  const counts = useMemo(() => {
    let nee = 0, bijna = 0, ja = 0, nvt = 0;
    for (const r of projectRows) {
      if (r.sluit === "NEE") nee += 1;
      else if (r.sluit === "BIJNA") bijna += 1;
      else if (r.sluit === "NVT") nvt += 1;
      else ja += 1;
    }
    return { nee, bijna, ja, nvt };
  }, [projectRows]);

  function toggle(project: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
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
          <h3 className="text-lg font-semibold text-slate-800">Projecten — 80%-doorbelasting check</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Coöp output (klant) versus entiteit input (Coöp): controleert of entiteiten 80% van klantfactuur hebben doorbelast.
            Cumulatief, {inclBTW ? "incl BTW (grand_total)" : "excl BTW (net_total)"}, alle jaren.
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
          ["all", `Alle (${projectRows.length})`],
          ["niet_sluitend", `🔴/🟡 niet sluitend (${counts.nee + counts.bijna})`],
          ["input_hoger", "Input > 80% norm"],
          ["input_lager", "Input < 80% norm"],
          ["alleen_overhead", `Overhead / geen (${counts.nvt})`],
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
          placeholder="Filter op project, klant of status..."
        />
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
            <tr>
              <th className="w-6 px-1 py-2"></th>
              <SortHeader field="project" label="Project" sort={sort} onSort={setSort} className="px-3" />
              <SortHeader field="coopOutput" label="Coöp output" align="right" sort={sort} onSort={setSort} className="px-3 text-slate-700" />
              <SortHeader field="bouwkundeInput" label="Bouwkunde" align="right" sort={sort} onSort={setSort} className="px-3" />
              <SortHeader field="bouwtechniekInput" label="Bouwtechniek" align="right" sort={sort} onSort={setSort} className="px-3" />
              <SortHeader field="engineeringInput" label="Engineering" align="right" sort={sort} onSort={setSort} className="px-3" />
              <SortHeader field="totalInput" label="Som input" align="right" sort={sort} onSort={setSort} className="px-3 text-slate-700" />
              <SortHeader field="norm80" label="80% norm" align="right" sort={sort} onSort={setSort} className="px-3" />
              <SortHeader field="absDelta" label="|Verschil|" align="right" sort={sort} onSort={setSort} className="px-3 text-slate-700" />
              <SortHeader field="sluitOrder" label="Status" sort={sort} onSort={setSort} className="px-3" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const isOpen = expanded.has(r.project);
              const projSis = sisByProject.get(r.project) ?? [];
              const isSpecial = r.isOverhead || r.project === NO_PROJECT_KEY;
              return (
                <Fragment key={r.project}>
                  <tr
                    className={`border-b border-slate-100 hover:bg-slate-50 cursor-pointer ${isSpecial ? "bg-slate-50/40" : ""}`}
                    onClick={() => toggle(r.project)}
                  >
                    <td className="px-1 py-1.5 text-center text-slate-400">
                      {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </td>
                    <td className="px-3 py-1.5">
                      {r.project === NO_PROJECT_KEY ? (
                        <span className="text-slate-500 italic">(geen project)</span>
                      ) : (
                        <a
                          href={docLink("Project", r.project)}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-teal-600 hover:underline inline-flex items-center gap-1"
                        >
                          {r.project}{r.isOverhead && <span className="text-[10px] text-slate-500">(overhead)</span>} <ExternalLink size={10} />
                        </a>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-800">{r.coopOutput === 0 ? <span className="text-slate-300">—</span> : fmtEur(r.coopOutput)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{r.bouwkundeInput === 0 ? <span className="text-slate-300">—</span> : fmtEur(r.bouwkundeInput)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{r.bouwtechniekInput === 0 ? <span className="text-slate-300">—</span> : fmtEur(r.bouwtechniekInput)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{r.engineeringInput === 0 ? <span className="text-slate-300">—</span> : fmtEur(r.engineeringInput)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-slate-700">{r.totalInput === 0 ? <span className="text-slate-300">—</span> : fmtEur(r.totalInput)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{r.norm80 === 0 ? <span className="text-slate-300">—</span> : fmtEur(r.norm80)}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${
                      r.sluit === "JA" ? "text-emerald-700" :
                      r.sluit === "BIJNA" ? "text-amber-700" :
                      r.sluit === "NEE" ? "text-red-700" : "text-slate-400"
                    }`}>
                      {r.isOverhead ? <span className="text-slate-300">—</span> : fmtEur(r.delta)}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={`inline-block px-2 py-0.5 text-[10px] rounded-full whitespace-nowrap ${SLUIT_CHIP[r.sluit].chip}`}>
                        {SLUIT_CHIP[r.sluit].label}
                      </span>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-slate-100 bg-slate-50/60">
                      <td></td>
                      <td colSpan={9} className="px-3 py-2">
                        <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
                          Tijdlijn ({projSis.length} facturen, chronologisch)
                        </div>
                        <table className="w-full text-xs">
                          <thead className="text-slate-500">
                            <tr>
                              <th className="text-left py-1">Datum</th>
                              <th className="text-left py-1">Company</th>
                              <th className="text-left py-1">→ Klant</th>
                              <th className="text-left py-1">SI</th>
                              <th className="text-right py-1">{inclBTW ? "Incl BTW" : "Excl BTW"}</th>
                              <th className="text-left py-1">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {projSis.map((s) => {
                              const isCoopSi = s.company === COOP_COMPANY;
                              return (
                                <tr key={s.name} className={`text-slate-700 ${isCoopSi ? "bg-teal-50/40" : ""}`}>
                                  <td className="py-1">{s.posting_date}</td>
                                  <td className="py-1 truncate max-w-[140px]">{s.company}</td>
                                  <td className="py-1 truncate max-w-[160px]">{s.customer_name}</td>
                                  <td className="py-1">
                                    <a
                                      href={docLink("Sales Invoice", s.name)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="text-teal-600 hover:underline"
                                    >
                                      {s.name}
                                    </a>
                                    {s.is_return ? <span className="ml-1 px-1 text-[9px] bg-red-100 text-red-700 rounded">retour</span> : null}
                                  </td>
                                  <td className={`py-1 text-right tabular-nums ${(inclBTW ? s.grand_total : s.net_total) < 0 ? "text-red-700" : ""}`}>{fmtEur(inclBTW ? s.grand_total : s.net_total)}</td>
                                  <td className="py-1 text-slate-500 text-[10px]">{s.status}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={10} className="px-3 py-8 text-center text-slate-400">
                  Geen projecten voor deze filter.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot className="bg-slate-50 border-t border-slate-200 font-semibold">
            <tr>
              <td></td>
              <td className="px-3 py-2 text-slate-700">Totaal ({filtered.length})</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-800">{fmtEur(totals.coopOutput)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtEur(totals.bouwkundeInput)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtEur(totals.bouwtechniekInput)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtEur(totals.engineeringInput)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtEur(totals.totalInput)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtEur(totals.norm80)}</td>
              <td className={`px-3 py-2 text-right tabular-nums ${totals.delta < -1 ? "text-red-700" : totals.delta > 1 ? "text-sky-700" : "text-emerald-700"}`}>
                {fmtEur(totals.delta)}
              </td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded text-xs text-slate-600 space-y-1">
        <div>
          <strong className="text-slate-700">Berekening:</strong> 80% norm = Coöp output × 0,80. Verschil = Som input − 80% norm.
          Status: 🟢 JA als |verschil| ≤ €1 · 🟡 BIJNA als |verschil| ≤ €1000 én {`<`} 10% van max(output, input) · 🔴 NEE overig.
        </div>
        <div>
          <strong className="text-slate-700">Bron:</strong> Coöp SI's naar externe klanten + entiteit SI's naar Coöp.
          Bedragen {inclBTW ? "incl BTW (grand_total)" : "excl BTW (net_total)"}. Cumulatief, alle jaren. Project "0000" = overhead (geen 80%-check).
          Retouren (is_return) tellen mee als negatief.
        </div>
      </div>
    </div>
  );
}
