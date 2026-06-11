import { useCallback, useEffect, useState } from "react";
import {
  RefreshCw,
  ExternalLink,
  Banknote,
  Landmark,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  Paperclip,
  Link2,
  ChevronRight,
} from "lucide-react";
import { yapp } from "./yapp-bridge";
import { SortHeader, FilterBar, sortRows, filterRows, sumField, type SortState } from "./table-helpers";

// ---------------------------------------------------------------------------
// Keten-model: Purchase Invoice → Payment Entry → banktransactie (reconciled).
// Elke stap kleurt groen zodra hij afgerond is:
//   PI  groen = submitted          (oranje = draft)
//   PE  groen = submitted          (oranje = draft, grijs = nog geen betaling)
//   Bank groen = clearance_date    (gezet door de Bank Reconciliation Tool)

interface PiDoc {
  name: string;
  posting_date: string;
  supplier_name: string;
  bill_no: string;
  grand_total: number;
  net_total: number;
  outstanding_amount: number;
  docstatus: number;
  status: string;
}

interface PeDoc {
  name: string;
  posting_date: string;
  payment_type: string;
  party_name: string;
  party: string;
  paid_amount: number;
  docstatus: number;
  clearance_date: string | null;
  unallocated_amount: number;
}

interface PeRef {
  parent: string;          // Payment Entry naam
  reference_name: string;  // Purchase Invoice naam
}

type StepState = "ok" | "draft" | "open" | "none";

interface ChainRow {
  name: string;
  posting_date: string;
  supplier_name: string;
  bill_no: string;
  grand_total: number;
  net_total: number;
  outstanding_amount: number;
  docstatus: number;
  status: string;
  hasPdf: boolean;
  pes: PeDoc[];
  pi_state: StepState;
  pe_state: StepState;
  bank_state: StepState;
  done: boolean;
}

interface ReconBT {
  name: string;
  date: string;
  bank_account: string;
  deposit: number;
  withdrawal: number;
  unallocated_amount: number;
  party: string;
  bank_party_name: string;
}

interface Props {
  company: string;
  year: number;
  erpAppUrl: string;
  inclBTW: boolean;
}

function fmtEur(n: number): string {
  return `€ ${n.toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function docLink(erpAppUrl: string, doctype: string, name: string): string {
  if (!erpAppUrl) return "#";
  const slug = doctype.toLowerCase().replace(/\s+/g, "-");
  return `${erpAppUrl}/app/${slug}/${encodeURIComponent(name)}`;
}

// Submit via frappe.client.submit (core-whitelisted) — de DISPATCH map van
// Y-app's ExtensionHost kent geen submitDocument, wel callMethod. Het volledige
// doc (incl. modified-timestamp) is vereist voor de concurrency-check.
async function submitDoc(doctype: string, name: string): Promise<void> {
  const doc = await yapp.fetchDocument(doctype, name);
  await yapp.callMethod("frappe.client.submit", { doc });
}

// Sommige hosts geven het frappe-response object door i.p.v. alleen message.
function unwrapList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  const msg = (raw as { message?: unknown } | null)?.message;
  return Array.isArray(msg) ? (msg as T[]) : [];
}

export default function BoekingenPanel({ company, year, erpAppUrl, inclBTW }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chains, setChains] = useState<ChainRow[]>([]);
  const [loosePes, setLoosePes] = useState<PeDoc[]>([]);
  const [btUnrec, setBtUnrec] = useState<ReconBT[]>([]);
  const [showDone, setShowDone] = useState(false);

  // Generieke submit-state: keys zijn "<doctype>:<name>" of "bulk:<doctype>"
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    const companyFilter: unknown[][] = company ? [["company", "=", company]] : [];
    const allYears = year === 0;

    const piFilters = [...companyFilter, ["docstatus", "!=", 2]];
    if (!allYears) {
      piFilters.push(["posting_date", ">=", `${year}-01-01`], ["posting_date", "<=", `${year}-12-31`]);
    }
    const btFilters = [...companyFilter, ["docstatus", "=", 1]];
    if (!allYears) {
      btFilters.push(["date", ">=", `${year}-01-01`], ["date", "<=", `${year}-12-31`]);
    }

    try {
      const [piList, fileList, peDraftList, btList] = await Promise.all([
        yapp.fetchList<PiDoc>("Purchase Invoice", {
          fields: [
            "name", "posting_date", "supplier_name", "bill_no", "grand_total",
            "net_total", "outstanding_amount", "docstatus", "status",
          ],
          filters: piFilters,
          limit_page_length: 1000,
          order_by: "posting_date asc",
        }),
        yapp.fetchList<{ attached_to_name: string }>("File", {
          fields: ["attached_to_name"],
          filters: [["attached_to_doctype", "=", "Purchase Invoice"]],
          limit_page_length: 5000,
        }),
        // Draft betalingen zijn werkvoorraad — bewust géén jaarfilter.
        yapp.fetchList<PeDoc>("Payment Entry", {
          fields: [
            "name", "posting_date", "payment_type", "party_name", "party",
            "paid_amount", "docstatus", "clearance_date", "unallocated_amount",
          ],
          filters: [...companyFilter, ["docstatus", "=", 0]],
          limit_page_length: 500,
          order_by: "posting_date asc",
        }),
        yapp.fetchList<ReconBT>("Bank Transaction", {
          fields: ["name", "date", "bank_account", "deposit", "withdrawal", "unallocated_amount", "party", "bank_party_name"],
          filters: btFilters,
          limit_page_length: 2000,
          order_by: "date asc",
        }),
      ]);

      // PI ↔ PE koppeling zit in de child-table Payment Entry Reference.
      // fetchList kan geen child doctypes aan (REST vereist parent-param),
      // frappe.client.get_list wel.
      const piNames = piList.map((p) => p.name);
      let refs: PeRef[] = [];
      if (piNames.length > 0) {
        const rawRefs = await yapp.callMethod("frappe.client.get_list", {
          doctype: "Payment Entry Reference",
          parent: "Payment Entry",
          filters: [
            ["reference_doctype", "=", "Purchase Invoice"],
            ["reference_name", "in", piNames],
          ],
          fields: ["parent", "reference_name"],
          limit_page_length: 0,
        });
        refs = unwrapList<PeRef>(rawRefs);
      }

      const peNames = Array.from(new Set(refs.map((r) => r.parent)));
      let linkedPes: PeDoc[] = [];
      if (peNames.length > 0) {
        linkedPes = await yapp.fetchList<PeDoc>("Payment Entry", {
          fields: [
            "name", "posting_date", "payment_type", "party_name", "party",
            "paid_amount", "docstatus", "clearance_date", "unallocated_amount",
          ],
          filters: [["name", "in", peNames], ["docstatus", "!=", 2]],
          limit_page_length: 1000,
        });
      }
      const peByName = new Map(linkedPes.map((p) => [p.name, p]));
      const pesPerPi = new Map<string, PeDoc[]>();
      for (const r of refs) {
        const pe = peByName.get(r.parent);
        if (!pe) continue;
        const arr = pesPerPi.get(r.reference_name) ?? [];
        if (!arr.some((x) => x.name === pe.name)) arr.push(pe);
        pesPerPi.set(r.reference_name, arr);
      }

      const withPdf = new Set(fileList.map((f) => f.attached_to_name));
      const rows: ChainRow[] = piList.map((p) => {
        const pes = pesPerPi.get(p.name) ?? [];
        const pi_state: StepState = p.docstatus === 1 ? "ok" : "draft";
        const pe_state: StepState =
          pes.length === 0 ? "none" : pes.some((x) => x.docstatus === 0) ? "draft" : "ok";
        const bank_state: StepState =
          pe_state !== "ok" ? "none" : pes.every((x) => !!x.clearance_date) ? "ok" : "open";
        return {
          ...p,
          hasPdf: withPdf.has(p.name),
          pes,
          pi_state,
          pe_state,
          bank_state,
          done: pi_state === "ok" && pe_state === "ok" && bank_state === "ok",
        };
      });
      setChains(rows);

      // Draft PE's zonder factuurkoppeling apart tonen (vallen buiten de keten).
      const linkedDraftNames = new Set(refs.map((r) => r.parent));
      setLoosePes(peDraftList.filter((p) => !linkedDraftNames.has(p.name)));
      setBtUnrec(btList.filter((x) => x.unallocated_amount > 0.01));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout");
    } finally {
      setLoading(false);
    }
  }, [company, year]);

  useEffect(() => { loadAll(); }, [loadAll]);

  async function submitOne(doctype: "Purchase Invoice" | "Payment Entry", name: string): Promise<void> {
    const key = `${doctype}:${name}`;
    if (confirmKey !== key) {
      setConfirmKey(key);
      return;
    }
    setConfirmKey(null);
    setBusyKey(key);
    setErrors([]);
    try {
      await submitDoc(doctype, name);
      await loadAll();
    } catch (e) {
      setErrors([`${name}: ${e instanceof Error ? e.message : "Onbekende fout"}`]);
    } finally {
      setBusyKey(null);
    }
  }

  async function submitBulk(doctype: "Purchase Invoice" | "Payment Entry", names: string[]): Promise<void> {
    if (names.length === 0) return;
    const key = `bulk:${doctype}`;
    if (confirmKey !== key) {
      setConfirmKey(key);
      return;
    }
    setConfirmKey(null);
    setBusyKey(key);
    setErrors([]);
    const errs: string[] = [];
    // Sequentieel — parallelle submits geven document-lock conflicten in Frappe.
    for (let i = 0; i < names.length; i++) {
      setBulkProgress(`${i + 1}/${names.length}`);
      try {
        await submitDoc(doctype, names[i]);
      } catch (e) {
        errs.push(`${names[i]}: ${e instanceof Error ? e.message : "Onbekende fout"}`);
      }
    }
    setBulkProgress(null);
    setBusyKey(null);
    setErrors(errs);
    await loadAll();
  }

  const draftPiNames = chains.filter((c) => c.pi_state === "draft").map((c) => c.name);
  const draftLinkedPeNames = Array.from(new Set(
    chains.flatMap((c) => c.pes.filter((p) => p.docstatus === 0).map((p) => p.name))
  ));
  const draftPeNames = Array.from(new Set([...draftLinkedPeNames, ...loosePes.map((p) => p.name)]));

  const submitCtl: SubmitCtl = { busyKey, confirmKey, bulkProgress, submitOne, cancel: () => setConfirmKey(null) };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-4 flex-wrap text-sm text-slate-500">
          <span className="inline-flex items-center gap-1">
            <StatePill state="ok" label="afgerond" />
            <StatePill state="draft" label="draft" />
            <StatePill state="open" label="open" />
          </span>
          <label className="inline-flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showDone}
              onChange={(e) => setShowDone(e.target.checked)}
              className="cursor-pointer accent-teal-600"
            />
            Toon afgeronde facturen
          </label>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <BulkButton
            label={`Submit alle draft facturen (${draftPiNames.length})`}
            bulkKey="bulk:Purchase Invoice"
            disabled={draftPiNames.length === 0}
            ctl={submitCtl}
            onRun={() => submitBulk("Purchase Invoice", draftPiNames)}
          />
          <BulkButton
            label={`Submit alle draft betalingen (${draftPeNames.length})`}
            bulkKey="bulk:Payment Entry"
            disabled={draftPeNames.length === 0}
            ctl={submitCtl}
            onRun={() => submitBulk("Payment Entry", draftPeNames)}
          />
          <button
            onClick={loadAll}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Vernieuwen
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>
      )}
      {errors.length > 0 && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 space-y-1">
          {errors.map((e) => (
            <div key={e} className="flex items-start gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0" /> {e}</div>
          ))}
        </div>
      )}

      <ChainTable
        rows={chains}
        showDone={showDone}
        erpAppUrl={erpAppUrl}
        inclBTW={inclBTW}
        ctl={submitCtl}
      />

      <LoosePeSection items={loosePes} erpAppUrl={erpAppUrl} ctl={submitCtl} />
      <BtSection rows={btUnrec} erpAppUrl={erpAppUrl} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gedeelde submit-besturing

interface SubmitCtl {
  busyKey: string | null;
  confirmKey: string | null;
  bulkProgress: string | null;
  submitOne: (doctype: "Purchase Invoice" | "Payment Entry", name: string) => void;
  cancel: () => void;
}

function BulkButton({ label, bulkKey, disabled, ctl, onRun }: {
  label: string;
  bulkKey: string;
  disabled: boolean;
  ctl: SubmitCtl;
  onRun: () => void;
}) {
  if (ctl.busyKey === bulkKey) {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-teal-700 px-3 py-2">
        <Loader2 size={14} className="animate-spin" /> Submitten {ctl.bulkProgress}...
      </span>
    );
  }
  const confirming = ctl.confirmKey === bulkKey;
  return (
    <span className="inline-flex items-center gap-1">
      {confirming && (
        <button onClick={ctl.cancel} className="text-xs px-2 py-2 border border-slate-300 rounded hover:bg-white">
          Annuleer
        </button>
      )}
      <button
        onClick={onRun}
        disabled={disabled || ctl.busyKey !== null}
        className={`flex items-center gap-2 text-sm px-3 py-2 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed ${
          confirming ? "bg-red-600 hover:bg-red-700" : "bg-teal-600 hover:bg-teal-700"
        }`}
      >
        <CheckCircle2 size={14} />
        {confirming ? "Bevestig" : label}
      </button>
    </span>
  );
}

function RowSubmitButton({ doctype, name, ctl }: {
  doctype: "Purchase Invoice" | "Payment Entry";
  name: string;
  ctl: SubmitCtl;
}) {
  const key = `${doctype}:${name}`;
  if (ctl.busyKey === key) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-teal-700">
        <Loader2 size={12} className="animate-spin" /> bezig
      </span>
    );
  }
  if (ctl.confirmKey === key) {
    return (
      <span className="inline-flex items-center gap-1">
        <button
          onClick={() => ctl.submitOne(doctype, name)}
          className="text-xs px-2 py-0.5 rounded bg-red-600 text-white hover:bg-red-700"
        >
          Bevestig
        </button>
        <button onClick={ctl.cancel} className="text-xs px-1.5 py-0.5 rounded border border-slate-300 hover:bg-slate-100">
          ×
        </button>
      </span>
    );
  }
  return (
    <button
      onClick={() => ctl.submitOne(doctype, name)}
      disabled={ctl.busyKey !== null}
      className="text-xs px-2 py-0.5 rounded bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-40"
    >
      Submit
    </button>
  );
}

// ---------------------------------------------------------------------------
// Status-pills

const PILL_STYLES: Record<StepState, string> = {
  ok: "bg-emerald-100 text-emerald-700",
  draft: "bg-amber-100 text-amber-700",
  open: "bg-amber-100 text-amber-700",
  none: "bg-slate-100 text-slate-400",
};

function StatePill({ state, label }: { state: StepState; label: string }) {
  return (
    <span className={`inline-block px-2 py-0.5 text-xs rounded-full whitespace-nowrap ${PILL_STYLES[state]}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Keten-tabel: factuur → betaling → bank

function ChainTable({ rows, showDone, erpAppUrl, inclBTW, ctl }: {
  rows: ChainRow[];
  showDone: boolean;
  erpAppUrl: string;
  inclBTW: boolean;
  ctl: SubmitCtl;
}) {
  const [sort, setSort] = useState<SortState | null>(null);
  const [search, setSearch] = useState("");
  const totalField = inclBTW ? "grand_total" : "net_total";

  const base = showDone ? rows : rows.filter((r) => !r.done);
  const visible = sortRows(filterRows(base, search), sort);
  const doneCount = rows.filter((r) => r.done).length;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between flex-wrap gap-3">
        <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide inline-flex items-center gap-2">
          <Link2 size={16} className="text-teal-600" /> Inkoopfacturen — keten ({base.length})
          <span className="normal-case font-normal text-slate-500">
            · {fmtEur(sumField(base, totalField))}{!showDone && doneCount > 0 ? ` · ${doneCount} afgerond verborgen` : ""}
          </span>
        </h3>
        <div className="text-xs text-slate-500 inline-flex items-center gap-1">
          Factuur <ChevronRight size={12} /> Betaling <ChevronRight size={12} /> Bank
        </div>
      </div>
      {base.length === 0 ? (
        <div className="px-5 py-8 text-center text-slate-400">
          {rows.length > 0 ? "Alles afgerond 🎉 — zet 'Toon afgeronde facturen' aan voor de historie" : "Geen inkoopfacturen in deze periode"}
        </div>
      ) : (
        <>
          <FilterBar search={search} setSearch={setSearch} hasSort={sort !== null} resetSort={() => setSort(null)} totalCount={base.length} visibleCount={visible.length} placeholder="Filter (leverancier, factuurnr, status...)" />
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <SortHeader field="posting_date" label="Datum" sort={sort} onSort={setSort} />
                <SortHeader field="supplier_name" label="Leverancier" sort={sort} onSort={setSort} />
                <SortHeader field="name" label="Factuur" sort={sort} onSort={setSort} />
                <SortHeader field={totalField} label={inclBTW ? "Totaal incl" : "Totaal excl"} align="right" sort={sort} onSort={setSort} />
                <SortHeader field="pi_state" label="① Factuur" sort={sort} onSort={setSort} />
                <SortHeader field="pe_state" label="② Betaling" sort={sort} onSort={setSort} />
                <SortHeader field="bank_state" label="③ Bank" sort={sort} onSort={setSort} />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-400">Geen rijen matchen het filter</td></tr>
              ) : visible.map((r) => (
                <tr key={r.name} className={`border-b border-slate-100 hover:bg-slate-50 ${r.done ? "bg-emerald-50/40" : ""}`}>
                  <td className="px-4 py-2 text-slate-500 whitespace-nowrap">{r.posting_date}</td>
                  <td className="px-4 py-2">{r.supplier_name}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    <a href={docLink(erpAppUrl, "Purchase Invoice", r.name)} target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline inline-flex items-center gap-1">
                      {r.name} <ExternalLink size={10} />
                    </a>
                    <span title={r.hasPdf ? "PDF aanwezig" : "Geen PDF-bijlage"} className="ml-1.5 inline-block align-middle">
                      <Paperclip size={12} className={r.hasPdf ? "text-emerald-600" : "text-slate-300"} />
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-slate-700 whitespace-nowrap">
                    {fmtEur(inclBTW ? r.grand_total : r.net_total)}
                  </td>
                  <td className="px-4 py-2">
                    {r.pi_state === "ok" ? (
                      <StatePill state="ok" label="Submitted ✓" />
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <StatePill state="draft" label="Draft" />
                        <RowSubmitButton doctype="Purchase Invoice" name={r.name} ctl={ctl} />
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {r.pes.length === 0 ? (
                      <StatePill state="none" label="Geen betaling" />
                    ) : (
                      <span className="inline-flex items-center gap-2 flex-wrap">
                        {r.pes.map((pe) => (
                          <span key={pe.name} className="inline-flex items-center gap-1.5">
                            {pe.docstatus === 1 ? (
                              <StatePill state="ok" label="Submitted ✓" />
                            ) : (
                              <>
                                <StatePill state="draft" label="Draft" />
                                <RowSubmitButton doctype="Payment Entry" name={pe.name} ctl={ctl} />
                              </>
                            )}
                            <a href={docLink(erpAppUrl, "Payment Entry", pe.name)} target="_blank" rel="noopener noreferrer" className="text-xs text-teal-600 hover:underline inline-flex items-center gap-0.5" title={`${pe.name} · ${fmtEur(pe.paid_amount)}`}>
                              <ExternalLink size={10} />
                            </a>
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {r.bank_state === "ok" ? (
                      <StatePill state="ok" label="Reconciled ✓" />
                    ) : r.bank_state === "open" ? (
                      <StatePill state="open" label="Te reconciliëren" />
                    ) : (
                      <StatePill state="none" label="—" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            {visible.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                  <td colSpan={3} className="px-4 py-2 text-xs uppercase tracking-wide text-slate-600">
                    Totaal · {visible.length} {visible.length === 1 ? "rij" : "rijen"}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-700">{fmtEur(sumField(visible, totalField))}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            )}
          </table>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Losse draft betalingen (zonder factuurkoppeling)

function LoosePeSection({ items, erpAppUrl, ctl }: {
  items: PeDoc[];
  erpAppUrl: string;
  ctl: SubmitCtl;
}) {
  const [sort, setSort] = useState<SortState | null>(null);
  const [search, setSearch] = useState("");
  const visible = sortRows(filterRows(items, search), sort);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-5 py-3 bg-slate-50 border-b border-slate-200">
        <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide inline-flex items-center gap-2">
          <Banknote size={16} className="text-purple-600" /> Losse draft betalingen ({items.length})
          <span className="normal-case font-normal text-slate-500">· {fmtEur(sumField(items, "paid_amount"))} · zonder factuurkoppeling</span>
        </h3>
      </div>
      {items.length === 0 ? (
        <div className="px-5 py-8 text-center text-slate-400">Geen losse draft betalingen</div>
      ) : (
        <>
          <FilterBar search={search} setSearch={setSearch} hasSort={sort !== null} resetSort={() => setSort(null)} totalCount={items.length} visibleCount={visible.length} placeholder="Filter (partij, type...)" />
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <SortHeader field="posting_date" label="Datum" sort={sort} onSort={setSort} />
                <SortHeader field="party_name" label="Partij" sort={sort} onSort={setSort} />
                <SortHeader field="payment_type" label="Type" sort={sort} onSort={setSort} />
                <SortHeader field="name" label="Betaling" sort={sort} onSort={setSort} />
                <SortHeader field="paid_amount" label="Bedrag" align="right" sort={sort} onSort={setSort} />
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Actie</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.name} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 text-slate-500">{r.posting_date}</td>
                  <td className="px-4 py-2">{r.party_name || r.party || "-"}</td>
                  <td className="px-4 py-2">{r.payment_type}</td>
                  <td className="px-4 py-2">
                    <a href={docLink(erpAppUrl, "Payment Entry", r.name)} target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline inline-flex items-center gap-1">
                      {r.name} <ExternalLink size={10} />
                    </a>
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-slate-700">{fmtEur(r.paid_amount)}</td>
                  <td className="px-4 py-2">
                    <RowSubmitButton doctype="Payment Entry" name={r.name} ctl={ctl} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Niet-gekoppelde banktransacties

function BtSection({ rows, erpAppUrl }: { rows: ReconBT[]; erpAppUrl: string }) {
  const [sort, setSort] = useState<SortState | null>(null);
  const [search, setSearch] = useState("");
  const all = rows.map((r) => ({ ...r, signed: r.deposit - r.withdrawal }));
  const visible = sortRows(filterRows(all, search), sort);

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between flex-wrap gap-3">
        <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide inline-flex items-center gap-2">
          <Landmark size={16} className="text-indigo-600" /> Banktransacties niet gekoppeld ({rows.length})
          <span className="normal-case font-normal text-slate-500">· {fmtEur(sumField(rows, "unallocated_amount"))}</span>
        </h3>
        {erpAppUrl && (
          <a
            href={`${erpAppUrl}/app/bank-reconciliation-tool`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm px-3 py-1.5 border border-slate-300 rounded hover:bg-white text-slate-700"
          >
            Bank Reconciliation Tool <ExternalLink size={12} />
          </a>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="px-5 py-8 text-center text-slate-400">Niets te reconciliëren</div>
      ) : (
        <>
          <FilterBar search={search} setSearch={setSearch} hasSort={sort !== null} resetSort={() => setSort(null)} totalCount={rows.length} visibleCount={visible.length} placeholder="Filter (tegenpartij, rekening, datum...)" />
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <SortHeader field="date" label="Datum" sort={sort} onSort={setSort} />
                <SortHeader field="bank_account" label="Bankrekening" sort={sort} onSort={setSort} />
                <SortHeader field="bank_party_name" label="Tegenpartij" sort={sort} onSort={setSort} />
                <SortHeader field="signed" label="Bedrag" align="right" sort={sort} onSort={setSort} />
                <SortHeader field="unallocated_amount" label="Niet gekoppeld" align="right" sort={sort} onSort={setSort} />
                <SortHeader field="name" label="Document" sort={sort} onSort={setSort} />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.name} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 text-slate-500">{r.date}</td>
                  <td className="px-4 py-2 text-slate-600">{r.bank_account}</td>
                  <td className="px-4 py-2">{r.bank_party_name || r.party || "-"}</td>
                  <td className={`px-4 py-2 text-right ${r.signed < 0 ? "text-red-600" : "text-emerald-600"}`}>
                    {r.signed < 0 ? "− " : "+ "}{fmtEur(Math.abs(r.signed))}
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-indigo-700">{fmtEur(r.unallocated_amount)}</td>
                  <td className="px-4 py-2">
                    <a href={docLink(erpAppUrl, "Bank Transaction", r.name)} target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline inline-flex items-center gap-1">
                      {r.name} <ExternalLink size={10} />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
            {visible.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                  <td colSpan={4} className="px-4 py-2 text-xs uppercase tracking-wide text-slate-600">
                    Totaal · {visible.length} {visible.length === 1 ? "rij" : "rijen"}
                  </td>
                  <td className="px-4 py-2 text-right text-indigo-700">{fmtEur(sumField(visible, "unallocated_amount"))}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </>
      )}
    </div>
  );
}
