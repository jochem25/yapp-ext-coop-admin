import { Fragment, useEffect, useMemo, useState } from "react";
import { RefreshCw, ChevronDown, ChevronRight, ExternalLink, Info } from "lucide-react";
import { yapp } from "./yapp-bridge";

/**
 * Projecten-overzicht — controle of alle uren doorberekend zijn.
 *
 * Per project (vanuit Coop-perspectief):
 *   - sum(SI.net_total) waar customer NIET intercompany = wat Coop bij externe klant factureerde
 *   - sum(PI.net_total) waar supplier IN INTERCO_SUPPLIERS = 80%-doorbelasting van entiteiten
 *   - 100% basis = PI-som / 0.80
 *   - delta = SI-som - 100% basis
 *
 * Bedoeld om snel te zien of er werkuren wel zijn doorberekend naar klant.
 */

const COOP_COMPANY = "3BM Coöperatie U.A.";

const INTERCO_SUPPLIERS = [
  "3BM bouwtechniek",
  "3BM Bouwtechniek V.O.F.",
  "3BM Engineering",
  "3BM Bouwkunde",
];

const INTERCO_CUSTOMERS = [
  "3BM Bouwtechniek V.O.F.",
  "3BM Engineering",
  "3BM Bouwkunde",
];

const MATCH_THRESHOLD_EUR = 100;

interface SI {
  name: string;
  posting_date: string;
  customer: string;
  customer_name: string;
  project: string;
  net_total: number;
  grand_total: number;
  outstanding_amount: number;
  status: string;
}

interface PI {
  name: string;
  posting_date: string;
  supplier: string;
  supplier_name: string;
  project: string;
  net_total: number;
  grand_total: number;
  outstanding_amount: number;
  status: string;
}

interface PIItem {
  project?: string | null;
  description?: string | null;
  net_amount?: number;
}

interface PIFullDoc {
  name: string;
  items: PIItem[];
}

/**
 * Voor PI's waar header.project leeg is: parse items[].description voor
 * een project-nummer. ERPNext schrijft op intercompany-PI's vaak
 * "project 2459 Gouda_Harderwijkweg" in de item-omschrijving.
 */
function extractProjectFromDescription(desc: string | null | undefined): string | null {
  if (!desc) return null;
  const m = desc.match(/project\s+([0-9]{3,})/i);
  return m ? m[1] : null;
}

interface PiAllocation {
  piName: string;
  project: string;
  netAmount: number;
  source: "header" | "item.project" | "item.description";
}

type Status = "match" | "onderbelast" | "overbelast" | "alleen-coop" | "alleen-entiteiten";

interface ProjectRow {
  project: string;
  siTotal: number;
  siCount: number;
  pi80: number;
  piCount: number;
  pi100: number;
  delta: number;
  status: Status;
}

function fmtEur(n: number): string {
  return `€ ${n.toLocaleString("nl-NL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

interface Props {
  company: string;
  erpAppUrl: string;
}

const STATUS_LABELS: Record<Status, { label: string; chip: string }> = {
  "match": { label: "Match", chip: "bg-emerald-100 text-emerald-700" },
  "overbelast": { label: "Coop > entiteiten", chip: "bg-sky-100 text-sky-700" },
  "onderbelast": { label: "Entiteiten > Coop", chip: "bg-red-100 text-red-700" },
  "alleen-coop": { label: "Alleen Coop-facturen", chip: "bg-amber-100 text-amber-700" },
  "alleen-entiteiten": { label: "Alleen entiteiten", chip: "bg-orange-100 text-orange-700" },
};

export default function ProjectsPanel({ company, erpAppUrl }: Props) {
  const [loading, setLoading] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sis, setSis] = useState<SI[]>([]);
  const [pis, setPis] = useState<PI[]>([]);
  const [allocations, setAllocations] = useState<PiAllocation[]>([]);
  const [unlinkedCount, setUnlinkedCount] = useState({ total: 0, mapped: 0 });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filterStatus, setFilterStatus] = useState<"all" | Status>("all");

  const wrongCompany = company !== COOP_COMPANY && company !== "";

  async function load() {
    setLoading(true);
    setError(null);
    setAllocations([]);
    setUnlinkedCount({ total: 0, mapped: 0 });
    try {
      const [siList, piList] = await Promise.all([
        yapp.fetchList<SI>("Sales Invoice", {
          fields: [
            "name", "posting_date", "customer", "customer_name", "project",
            "net_total", "grand_total", "outstanding_amount", "status",
          ],
          filters: [
            ["company", "=", COOP_COMPANY],
            ["docstatus", "=", 1],
            ["project", "!=", ""],
          ],
          limit_page_length: 5000,
          order_by: "posting_date asc",
        }),
        // Belangrijk: GEEN project!="" filter — we hebben ook PI's zonder header.project nodig
        yapp.fetchList<PI>("Purchase Invoice", {
          fields: [
            "name", "posting_date", "supplier", "supplier_name", "project",
            "net_total", "grand_total", "outstanding_amount", "status",
          ],
          filters: [
            ["company", "=", COOP_COMPANY],
            ["supplier", "in", INTERCO_SUPPLIERS],
            ["docstatus", "=", 1],
          ],
          limit_page_length: 5000,
          order_by: "posting_date asc",
        }),
      ]);
      setSis(siList);
      setPis(piList);

      // Bouw initiële allocations: PI met header.project gevuld
      const baseAlloc: PiAllocation[] = [];
      const unlinked: PI[] = [];
      for (const p of piList) {
        if (p.project) {
          baseAlloc.push({
            piName: p.name,
            project: p.project,
            netAmount: p.net_total,
            source: "header",
          });
        } else {
          unlinked.push(p);
        }
      }
      setAllocations(baseAlloc);
      setUnlinkedCount({ total: unlinked.length, mapped: 0 });

      // Fase 2 (async, niet blocking): per unlinked PI items ophalen en project parsen
      if (unlinked.length > 0) {
        setEnriching(true);
        const enriched: PiAllocation[] = [];
        let mapped = 0;
        const results = await Promise.all(
          unlinked.map((p) =>
            yapp.fetchDocument<PIFullDoc>("Purchase Invoice", p.name).catch(() => null),
          ),
        );
        for (let i = 0; i < unlinked.length; i++) {
          const p = unlinked[i];
          const doc = results[i];
          if (!doc || !doc.items) continue;
          // Per item: detecteer project (item.project of regex op description)
          const perProject = new Map<string, { amount: number; source: PiAllocation["source"] }>();
          for (const it of doc.items) {
            const projFromField = it.project ?? null;
            const projFromDesc = projFromField ? null : extractProjectFromDescription(it.description);
            const proj = projFromField || projFromDesc;
            if (!proj) continue;
            const src: PiAllocation["source"] = projFromField ? "item.project" : "item.description";
            const cur = perProject.get(proj);
            const amt = it.net_amount ?? 0;
            if (cur) {
              cur.amount += amt;
            } else {
              perProject.set(proj, { amount: amt, source: src });
            }
          }
          if (perProject.size > 0) mapped += 1;
          for (const [proj, info] of perProject.entries()) {
            enriched.push({
              piName: p.name,
              project: proj,
              netAmount: info.amount,
              source: info.source,
            });
          }
        }
        setAllocations([...baseAlloc, ...enriched]);
        setUnlinkedCount({ total: unlinked.length, mapped });
        setEnriching(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout");
      setEnriching(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // External SI's only (exclude intercompany customers — die zijn een andere geldstroom)
  const externalSis = useMemo(
    () => sis.filter((s) => !INTERCO_CUSTOMERS.includes(s.customer)),
    [sis],
  );

  const projectRows = useMemo<ProjectRow[]>(() => {
    const map = new Map<string, ProjectRow>();
    const ensure = (project: string): ProjectRow => {
      let r = map.get(project);
      if (!r) {
        r = {
          project, siTotal: 0, siCount: 0, pi80: 0, piCount: 0,
          pi100: 0, delta: 0, status: "match",
        };
        map.set(project, r);
      }
      return r;
    };
    for (const s of externalSis) {
      const r = ensure(s.project);
      r.siTotal += s.net_total;
      r.siCount += 1;
    }
    // Allocations: één entry per (PI, project). Bij multi-project-PI's tel je per project.
    const piCountedPerProject = new Set<string>();
    for (const a of allocations) {
      const r = ensure(a.project);
      r.pi80 += a.netAmount;
      const key = `${a.piName}|${a.project}`;
      if (!piCountedPerProject.has(key)) {
        r.piCount += 1;
        piCountedPerProject.add(key);
      }
    }
    for (const r of map.values()) {
      r.pi100 = r.pi80 / 0.80;
      r.delta = r.siTotal - r.pi100;
      if (r.siTotal === 0 && r.pi80 > 0) r.status = "alleen-entiteiten";
      else if (r.pi80 === 0 && r.siTotal > 0) r.status = "alleen-coop";
      else if (Math.abs(r.delta) <= MATCH_THRESHOLD_EUR) r.status = "match";
      else if (r.delta < 0) r.status = "onderbelast";
      else r.status = "overbelast";
    }
    return Array.from(map.values()).sort((a, b) => {
      // Mismatches eerst (groot verschil bovenaan); matches onderaan
      const mismatchPriority = (s: Status) =>
        s === "onderbelast" ? 0 :
        s === "alleen-entiteiten" ? 1 :
        s === "overbelast" ? 2 :
        s === "alleen-coop" ? 3 : 4;
      const pa = mismatchPriority(a.status);
      const pb = mismatchPriority(b.status);
      if (pa !== pb) return pa - pb;
      return Math.abs(b.delta) - Math.abs(a.delta);
    });
  }, [externalSis, allocations]);

  const visibleRows = useMemo(
    () => filterStatus === "all" ? projectRows : projectRows.filter((r) => r.status === filterStatus),
    [projectRows, filterStatus],
  );

  const totals = useMemo(() => {
    return visibleRows.reduce(
      (acc, r) => ({
        siTotal: acc.siTotal + r.siTotal,
        pi80: acc.pi80 + r.pi80,
        pi100: acc.pi100 + r.pi100,
        delta: acc.delta + r.delta,
      }),
      { siTotal: 0, pi80: 0, pi100: 0, delta: 0 },
    );
  }, [visibleRows]);

  const sisByProject = useMemo(() => {
    const m = new Map<string, SI[]>();
    for (const s of externalSis) {
      const arr = m.get(s.project) ?? [];
      arr.push(s);
      m.set(s.project, arr);
    }
    return m;
  }, [externalSis]);

  /** Voor de detail-expand: per project de PI's plus de toegekende bedragen + source. */
  const pisByProject = useMemo(() => {
    const piMap = new Map<string, PI>();
    for (const p of pis) piMap.set(p.name, p);
    const m = new Map<string, Array<PI & { allocAmount: number; allocSource: PiAllocation["source"] }>>();
    for (const a of allocations) {
      const pi = piMap.get(a.piName);
      if (!pi) continue;
      const arr = m.get(a.project) ?? [];
      arr.push({ ...pi, allocAmount: a.netAmount, allocSource: a.source });
      m.set(a.project, arr);
    }
    return m;
  }, [pis, allocations]);

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

  const statusCounts = useMemo(() => {
    const c: Record<Status | "all", number> = {
      all: projectRows.length,
      "match": 0, "overbelast": 0, "onderbelast": 0,
      "alleen-coop": 0, "alleen-entiteiten": 0,
    };
    for (const r of projectRows) c[r.status] += 1;
    return c;
  }, [projectRows]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-800">Projecten — uren-doorbelasting check</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Per project: externe verkoopfacturen vs intercompany 80%-PI's (omgerekend naar 100%).
            Alle jaren, alle bedragen exclusief BTW.
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
          <div>
            Dit overzicht is altijd voor <strong>{COOP_COMPANY}</strong> — bedrijfsfilter wordt genegeerd.
          </div>
        </div>
      )}

      {error && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>
      )}

      {(enriching || unlinkedCount.total > 0) && (
        <div className="mb-3 p-3 bg-sky-50 border border-sky-200 rounded text-xs text-sky-800 flex items-start gap-2">
          <Info size={14} className="shrink-0 mt-0.5" />
          <div>
            {enriching ? (
              <>Items van {unlinkedCount.total} PI's zonder header-project worden geanalyseerd…</>
            ) : (
              <>
                <strong>{unlinkedCount.mapped}</strong> van <strong>{unlinkedCount.total}</strong> PI's
                zonder header-project zijn via item-omschrijving (regex op "project NNNN") gekoppeld.
                {unlinkedCount.total - unlinkedCount.mapped > 0 && (
                  <> {unlinkedCount.total - unlinkedCount.mapped} PI's blijven losgekoppeld — vul header.project in ERPNext voor schone data.</>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <div className="mb-3 flex items-center gap-1 flex-wrap text-xs">
        {(["all", "onderbelast", "alleen-entiteiten", "overbelast", "alleen-coop", "match"] as const).map((s) => {
          const active = filterStatus === s;
          const label = s === "all" ? "Alle" : STATUS_LABELS[s].label;
          return (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={`px-3 py-1.5 rounded-full border transition ${
                active
                  ? "bg-teal-600 text-white border-teal-600"
                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
              }`}
            >
              {label} <span className={active ? "text-teal-100" : "text-slate-400"}>{statusCounts[s]}</span>
            </button>
          );
        })}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
            <tr>
              <th className="w-6 px-1 py-2"></th>
              <th className="text-left px-3 py-2 font-semibold text-slate-600 min-w-[200px]">Project</th>
              <th className="text-right px-3 py-2 font-semibold text-slate-600">Coop → klant</th>
              <th className="text-right px-3 py-2 font-semibold text-slate-500">Entiteiten 80%</th>
              <th className="text-right px-3 py-2 font-semibold text-slate-600">Entiteiten 100%</th>
              <th className="text-right px-3 py-2 font-semibold text-slate-700">Verschil</th>
              <th className="text-left px-3 py-2 font-semibold text-slate-600">Status</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => {
              const isOpen = expanded.has(r.project);
              const projSis = sisByProject.get(r.project) ?? [];
              const projPis = pisByProject.get(r.project) ?? [];
              return (
                <Fragment key={r.project}>
                  <tr
                    className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                    onClick={() => toggle(r.project)}
                  >
                    <td className="px-1 py-1.5 text-center text-slate-400">
                      {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </td>
                    <td className="px-3 py-1.5">
                      <a
                        href={docLink("Project", r.project)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-teal-600 hover:underline inline-flex items-center gap-1"
                      >
                        {r.project} <ExternalLink size={10} />
                      </a>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">
                      {r.siTotal === 0 ? <span className="text-slate-300">—</span> : fmtEur(r.siTotal)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">
                      {r.pi80 === 0 ? <span className="text-slate-300">—</span> : fmtEur(r.pi80)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">
                      {r.pi100 === 0 ? <span className="text-slate-300">—</span> : fmtEur(r.pi100)}
                    </td>
                    <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${
                      r.status === "onderbelast" ? "text-red-700" :
                      r.status === "overbelast" ? "text-sky-700" :
                      r.status === "match" ? "text-emerald-700" : "text-slate-500"
                    }`}>
                      {fmtEur(r.delta)}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={`inline-block px-2 py-0.5 text-[10px] rounded-full ${STATUS_LABELS[r.status].chip}`}>
                        {STATUS_LABELS[r.status].label}
                      </span>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-slate-100 bg-slate-50/60">
                      <td></td>
                      <td colSpan={6} className="px-3 py-2">
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                          <div>
                            <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
                              Coop → externe klant ({projSis.length})
                            </div>
                            {projSis.length === 0 ? (
                              <div className="text-xs text-slate-400 italic">Geen externe verkoopfacturen</div>
                            ) : (
                              <table className="w-full text-xs">
                                <thead className="text-slate-500">
                                  <tr>
                                    <th className="text-left py-1">Datum</th>
                                    <th className="text-left py-1">Klant</th>
                                    <th className="text-left py-1">SI</th>
                                    <th className="text-right py-1">Excl BTW</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {projSis.map((s) => (
                                    <tr key={s.name} className="text-slate-700">
                                      <td className="py-1">{s.posting_date}</td>
                                      <td className="py-1 truncate max-w-[140px]">{s.customer_name}</td>
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
                                      </td>
                                      <td className="py-1 text-right tabular-nums">{fmtEur(s.net_total)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                          <div>
                            <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
                              Entiteiten → Coop, 80% ({projPis.length})
                            </div>
                            {projPis.length === 0 ? (
                              <div className="text-xs text-slate-400 italic">Geen intercompany inkoopfacturen</div>
                            ) : (
                              <table className="w-full text-xs">
                                <thead className="text-slate-500">
                                  <tr>
                                    <th className="text-left py-1">Datum</th>
                                    <th className="text-left py-1">Entiteit</th>
                                    <th className="text-left py-1">PI</th>
                                    <th className="text-left py-1">Bron</th>
                                    <th className="text-right py-1">80% excl BTW</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {projPis.map((p) => (
                                    <tr key={`${p.name}-${p.allocSource}`} className="text-slate-700">
                                      <td className="py-1">{p.posting_date}</td>
                                      <td className="py-1 truncate max-w-[140px]">{p.supplier_name}</td>
                                      <td className="py-1">
                                        <a
                                          href={docLink("Purchase Invoice", p.name)}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          onClick={(e) => e.stopPropagation()}
                                          className="text-teal-600 hover:underline"
                                        >
                                          {p.name}
                                        </a>
                                      </td>
                                      <td className="py-1">
                                        <span className={`inline-block px-1.5 py-0.5 text-[9px] rounded ${
                                          p.allocSource === "header" ? "bg-emerald-50 text-emerald-700" :
                                          p.allocSource === "item.project" ? "bg-sky-50 text-sky-700" :
                                          "bg-amber-50 text-amber-700"
                                        }`}>
                                          {p.allocSource === "header" ? "header" :
                                           p.allocSource === "item.project" ? "item-veld" : "uit tekst"}
                                        </span>
                                      </td>
                                      <td className="py-1 text-right tabular-nums">{fmtEur(p.allocAmount)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {visibleRows.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-slate-400">
                  Geen projecten met facturen voor deze filter.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot className="bg-slate-50 border-t border-slate-200 font-semibold">
            <tr>
              <td></td>
              <td className="px-3 py-2 text-slate-700">Totaal ({visibleRows.length})</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-800">{fmtEur(totals.siTotal)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtEur(totals.pi80)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtEur(totals.pi100)}</td>
              <td className={`px-3 py-2 text-right tabular-nums ${totals.delta < 0 ? "text-red-700" : totals.delta > 0 ? "text-sky-700" : "text-emerald-700"}`}>
                {fmtEur(totals.delta)}
              </td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded text-xs text-slate-600">
        <strong className="text-slate-700">Berekening per project:</strong> 100% basis = som entiteiten-PI (net_total) ÷ 0,80.
        Verschil = Coop-SI som − 100% basis. Negatief = entiteiten hebben meer doorbelast dan Coop heeft gefactureerd
        (mogelijk gemiste klantfactuur). Positief = Coop heeft meer gefactureerd dan entiteiten (eigen marge of nog te doorbelasten uren).
        Drempel voor "Match": ± {fmtEur(MATCH_THRESHOLD_EUR)}.
      </div>
    </div>
  );
}
