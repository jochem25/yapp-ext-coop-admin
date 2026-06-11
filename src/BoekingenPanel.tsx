import { useCallback, useEffect, useState } from "react";
import {
  RefreshCw,
  ExternalLink,
  ShoppingCart,
  Banknote,
  Landmark,
  CheckCircle2,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { yapp } from "./yapp-bridge";
import { SortHeader, FilterBar, sortRows, filterRows, sumField, type SortState } from "./table-helpers";

interface DraftPI {
  name: string;
  posting_date: string;
  supplier_name: string;
  bill_no: string;
  grand_total: number;
  net_total: number;
}

interface DraftPE {
  name: string;
  posting_date: string;
  payment_type: string;
  party_name: string;
  party: string;
  paid_amount: number;
  mode_of_payment: string;
}

interface ReconPE {
  name: string;
  posting_date: string;
  payment_type: string;
  party_name: string;
  party: string;
  unallocated_amount: number;
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

interface ReconRow {
  key: string;
  doctype: "Payment Entry" | "Bank Transaction";
  date: string;
  party: string;
  detail: string;
  amount: number;
  unallocated: number;
  name: string;
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

// Submit via frappe.client.submit (core-whitelisted) — de DISPATCH map van
// Y-app's ExtensionHost kent geen submitDocument, wel callMethod. Het volledige
// doc (incl. modified-timestamp) is vereist voor de concurrency-check.
async function submitDoc(doctype: string, name: string): Promise<void> {
  const doc = await yapp.fetchDocument(doctype, name);
  await yapp.callMethod("frappe.client.submit", { doc });
}

export default function BoekingenPanel({ company, year, erpAppUrl, inclBTW }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [piDrafts, setPiDrafts] = useState<DraftPI[]>([]);
  const [peDrafts, setPeDrafts] = useState<DraftPE[]>([]);
  const [reconRows, setReconRows] = useState<ReconRow[]>([]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    const companyFilter: unknown[][] = company ? [["company", "=", company]] : [];
    const allYears = year === 0;

    // Drafts zijn werkvoorraad — bewust géén jaarfilter, anders verdwijnen
    // oude drafts uit beeld terwijl ze juist actie nodig hebben.
    const draftFilters = [...companyFilter, ["docstatus", "=", 0]];

    const pePostedFilters = [...companyFilter, ["docstatus", "=", 1]];
    const btFilters = [...companyFilter, ["docstatus", "=", 1]];
    if (!allYears) {
      pePostedFilters.push(["posting_date", ">=", `${year}-01-01`], ["posting_date", "<=", `${year}-12-31`]);
      btFilters.push(["date", ">=", `${year}-01-01`], ["date", "<=", `${year}-12-31`]);
    }

    try {
      const [piList, peList, peRecList, btList] = await Promise.all([
        yapp.fetchList<DraftPI>("Purchase Invoice", {
          fields: ["name", "posting_date", "supplier_name", "bill_no", "grand_total", "net_total"],
          filters: draftFilters,
          limit_page_length: 500,
          order_by: "posting_date asc",
        }),
        yapp.fetchList<DraftPE>("Payment Entry", {
          fields: ["name", "posting_date", "payment_type", "party_name", "party", "paid_amount", "mode_of_payment"],
          filters: draftFilters,
          limit_page_length: 500,
          order_by: "posting_date asc",
        }),
        yapp.fetchList<ReconPE>("Payment Entry", {
          fields: ["name", "posting_date", "payment_type", "party_name", "party", "unallocated_amount"],
          filters: pePostedFilters,
          limit_page_length: 1000,
          order_by: "posting_date asc",
        }),
        yapp.fetchList<ReconBT>("Bank Transaction", {
          fields: ["name", "date", "bank_account", "deposit", "withdrawal", "unallocated_amount", "party", "bank_party_name"],
          filters: btFilters,
          limit_page_length: 2000,
          order_by: "date asc",
        }),
      ]);
      setPiDrafts(piList);
      setPeDrafts(peList);
      const peRows: ReconRow[] = peRecList
        .filter((x) => Math.abs(x.unallocated_amount) > 0.01)
        .map((x) => ({
          key: `pe:${x.name}`,
          doctype: "Payment Entry",
          date: x.posting_date,
          party: x.party_name || x.party || "-",
          detail: x.payment_type,
          amount: x.unallocated_amount,
          unallocated: x.unallocated_amount,
          name: x.name,
        }));
      const btRows: ReconRow[] = btList
        .filter((x) => x.unallocated_amount > 0.01)
        .map((x) => ({
          key: `bt:${x.name}`,
          doctype: "Bank Transaction",
          date: x.date,
          party: x.bank_party_name || x.party || "-",
          detail: x.bank_account,
          amount: x.deposit - x.withdrawal,
          unallocated: x.unallocated_amount,
          name: x.name,
        }));
      setReconRows([...peRows, ...btRows].sort((a, b) => a.date.localeCompare(b.date)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout");
    } finally {
      setLoading(false);
    }
  }, [company, year]);

  useEffect(() => { loadAll(); }, [loadAll]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-slate-500">
          Drafts staan los van het jaarfilter; te reconciliëren entries volgen bedrijf- en jaarfilter.
        </p>
        <button
          onClick={loadAll}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          Vernieuwen
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>
      )}

      <DraftPiSection items={piDrafts} erpAppUrl={erpAppUrl} inclBTW={inclBTW} onSubmitted={loadAll} />
      <DraftPeSection items={peDrafts} erpAppUrl={erpAppUrl} onSubmitted={loadAll} />
      <ReconSection rows={reconRows} erpAppUrl={erpAppUrl} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gedeelde submit-machinerie voor beide draft-secties

interface SubmitState {
  selected: Set<string>;
  busyName: string | null;       // naam van het doc dat nu submit (ook tijdens bulk)
  bulkBusy: boolean;
  bulkProgress: string | null;
  confirmName: string | null;    // per-rij two-step confirm
  confirmBulk: boolean;
  errors: string[];
}

const EMPTY_SUBMIT: SubmitState = {
  selected: new Set(),
  busyName: null,
  bulkBusy: false,
  bulkProgress: null,
  confirmName: null,
  confirmBulk: false,
  errors: [],
};

function useSubmitMachine(doctype: "Purchase Invoice" | "Payment Entry", onSubmitted: () => void) {
  const [st, setSt] = useState<SubmitState>(EMPTY_SUBMIT);

  function toggle(name: string): void {
    setSt((p) => {
      const selected = new Set(p.selected);
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
      return { ...p, selected, confirmBulk: false };
    });
  }

  function toggleAll(names: string[]): void {
    setSt((p) => {
      const allSelected = names.length > 0 && names.every((n) => p.selected.has(n));
      return { ...p, selected: allSelected ? new Set() : new Set(names), confirmBulk: false };
    });
  }

  async function submitOne(name: string): Promise<void> {
    if (st.confirmName !== name) {
      setSt((p) => ({ ...p, confirmName: name, confirmBulk: false }));
      return;
    }
    setSt((p) => ({ ...p, busyName: name, confirmName: null, errors: [] }));
    try {
      await submitDoc(doctype, name);
      setSt((p) => {
        const selected = new Set(p.selected);
        selected.delete(name);
        return { ...p, busyName: null, selected };
      });
      onSubmitted();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Onbekende fout";
      setSt((p) => ({ ...p, busyName: null, errors: [`${name}: ${msg}`] }));
    }
  }

  async function submitSelected(): Promise<void> {
    const names = Array.from(st.selected);
    if (names.length === 0) return;
    if (!st.confirmBulk) {
      setSt((p) => ({ ...p, confirmBulk: true, confirmName: null }));
      return;
    }
    setSt((p) => ({ ...p, bulkBusy: true, confirmBulk: false, errors: [] }));
    const errors: string[] = [];
    let done = 0;
    // Sequentieel — parallelle submits geven document-lock conflicten in Frappe.
    for (const name of names) {
      setSt((p) => ({ ...p, busyName: name, bulkProgress: `${done + 1}/${names.length}` }));
      try {
        await submitDoc(doctype, name);
        setSt((p) => {
          const selected = new Set(p.selected);
          selected.delete(name);
          return { ...p, selected };
        });
      } catch (e) {
        errors.push(`${name}: ${e instanceof Error ? e.message : "Onbekende fout"}`);
      }
      done++;
    }
    setSt((p) => ({ ...p, bulkBusy: false, busyName: null, bulkProgress: null, errors }));
    onSubmitted();
  }

  function cancelConfirm(): void {
    setSt((p) => ({ ...p, confirmName: null, confirmBulk: false }));
  }

  return { st, toggle, toggleAll, submitOne, submitSelected, cancelConfirm };
}

interface SectionShellProps {
  icon: React.ReactNode;
  title: string;
  count: number;
  totalLabel: string;
  children: React.ReactNode;
  toolbar?: React.ReactNode;
  errors?: string[];
}

function SectionShell({ icon, title, count, totalLabel, children, toolbar, errors }: SectionShellProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between flex-wrap gap-3">
        <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide inline-flex items-center gap-2">
          {icon} {title} ({count}) <span className="normal-case font-normal text-slate-500">· {totalLabel}</span>
        </h3>
        {toolbar}
      </div>
      {errors && errors.length > 0 && (
        <div className="px-5 py-3 bg-red-50 border-b border-red-100 text-sm text-red-700 space-y-1">
          {errors.map((e) => (
            <div key={e} className="flex items-start gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0" /> {e}</div>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

interface BulkToolbarProps {
  selectedCount: number;
  st: SubmitState;
  onSubmitSelected: () => void;
  onCancel: () => void;
}

function BulkToolbar({ selectedCount, st, onSubmitSelected, onCancel }: BulkToolbarProps) {
  if (st.bulkBusy) {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-teal-700">
        <Loader2 size={14} className="animate-spin" /> Submitten {st.bulkProgress}...
      </span>
    );
  }
  return (
    <div className="flex items-center gap-2">
      {st.confirmBulk && (
        <button onClick={onCancel} className="text-xs px-3 py-1.5 border border-slate-300 rounded hover:bg-white">
          Annuleer
        </button>
      )}
      <button
        onClick={onSubmitSelected}
        disabled={selectedCount === 0}
        className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed ${
          st.confirmBulk ? "bg-red-600 hover:bg-red-700" : "bg-teal-600 hover:bg-teal-700"
        }`}
      >
        <CheckCircle2 size={14} />
        {st.confirmBulk ? `Bevestig submit (${selectedCount})` : `Submit geselecteerde (${selectedCount})`}
      </button>
    </div>
  );
}

interface RowSubmitButtonProps {
  name: string;
  st: SubmitState;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

function RowSubmitButton({ name, st, onSubmit, onCancel }: RowSubmitButtonProps) {
  if (st.busyName === name) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-teal-700">
        <Loader2 size={12} className="animate-spin" /> bezig
      </span>
    );
  }
  if (st.confirmName === name) {
    return (
      <span className="inline-flex items-center gap-1">
        <button
          onClick={() => onSubmit(name)}
          className="text-xs px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700"
        >
          Bevestig
        </button>
        <button onClick={onCancel} className="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-100">
          ×
        </button>
      </span>
    );
  }
  return (
    <button
      onClick={() => onSubmit(name)}
      disabled={st.bulkBusy}
      className="text-xs px-2 py-1 rounded bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-40"
    >
      Submit
    </button>
  );
}

function docLink(erpAppUrl: string, doctype: string, name: string): string {
  if (!erpAppUrl) return "#";
  const slug = doctype.toLowerCase().replace(/\s+/g, "-");
  return `${erpAppUrl}/app/${slug}/${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------------------
// Sectie 1: draft inkoopfacturen

function DraftPiSection({ items, erpAppUrl, inclBTW, onSubmitted }: {
  items: DraftPI[];
  erpAppUrl: string;
  inclBTW: boolean;
  onSubmitted: () => void;
}) {
  const { st, toggle, toggleAll, submitOne, submitSelected, cancelConfirm } = useSubmitMachine("Purchase Invoice", onSubmitted);
  const [sort, setSort] = useState<SortState | null>(null);
  const [search, setSearch] = useState("");
  const totalField = inclBTW ? "grand_total" : "net_total";
  const visible = sortRows(filterRows(items, search), sort);
  const allNames = visible.map((x) => x.name);
  const allSelected = allNames.length > 0 && allNames.every((n) => st.selected.has(n));

  return (
    <SectionShell
      icon={<ShoppingCart size={16} className="text-red-600" />}
      title="Inkoopfacturen draft"
      count={items.length}
      totalLabel={fmtEur(sumField(items, totalField))}
      errors={st.errors}
      toolbar={<BulkToolbar selectedCount={st.selected.size} st={st} onSubmitSelected={submitSelected} onCancel={cancelConfirm} />}
    >
      {items.length === 0 ? (
        <div className="px-5 py-8 text-center text-slate-400">Geen draft inkoopfacturen</div>
      ) : (
        <>
          <FilterBar search={search} setSearch={setSearch} hasSort={sort !== null} resetSort={() => setSort(null)} totalCount={items.length} visibleCount={visible.length} placeholder="Filter (leverancier, factuurnr...)" />
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="w-10 px-3 py-2">
                  <input type="checkbox" checked={allSelected} onChange={() => toggleAll(allNames)} className="cursor-pointer accent-teal-600" />
                </th>
                <SortHeader field="posting_date" label="Datum" sort={sort} onSort={setSort} />
                <SortHeader field="supplier_name" label="Leverancier" sort={sort} onSort={setSort} />
                <SortHeader field="bill_no" label="Factuurnr" sort={sort} onSort={setSort} />
                <SortHeader field="name" label="Factuur" sort={sort} onSort={setSort} />
                <SortHeader field={totalField} label={inclBTW ? "Totaal incl" : "Totaal excl"} align="right" sort={sort} onSort={setSort} />
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Actie</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.name} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" checked={st.selected.has(r.name)} onChange={() => toggle(r.name)} className="cursor-pointer accent-teal-600" />
                  </td>
                  <td className="px-4 py-2 text-slate-500">{r.posting_date}</td>
                  <td className="px-4 py-2">{r.supplier_name}</td>
                  <td className="px-4 py-2 text-slate-600">{r.bill_no || "-"}</td>
                  <td className="px-4 py-2">
                    <a href={docLink(erpAppUrl, "Purchase Invoice", r.name)} target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline inline-flex items-center gap-1">
                      {r.name} <ExternalLink size={10} />
                    </a>
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-slate-700">{fmtEur(inclBTW ? r.grand_total : r.net_total)}</td>
                  <td className="px-4 py-2">
                    <RowSubmitButton name={r.name} st={st} onSubmit={submitOne} onCancel={cancelConfirm} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Sectie 2: draft betalingen

function DraftPeSection({ items, erpAppUrl, onSubmitted }: {
  items: DraftPE[];
  erpAppUrl: string;
  onSubmitted: () => void;
}) {
  const { st, toggle, toggleAll, submitOne, submitSelected, cancelConfirm } = useSubmitMachine("Payment Entry", onSubmitted);
  const [sort, setSort] = useState<SortState | null>(null);
  const [search, setSearch] = useState("");
  const visible = sortRows(filterRows(items, search), sort);
  const allNames = visible.map((x) => x.name);
  const allSelected = allNames.length > 0 && allNames.every((n) => st.selected.has(n));

  return (
    <SectionShell
      icon={<Banknote size={16} className="text-purple-600" />}
      title="Betalingen draft"
      count={items.length}
      totalLabel={fmtEur(sumField(items, "paid_amount"))}
      errors={st.errors}
      toolbar={<BulkToolbar selectedCount={st.selected.size} st={st} onSubmitSelected={submitSelected} onCancel={cancelConfirm} />}
    >
      {items.length === 0 ? (
        <div className="px-5 py-8 text-center text-slate-400">Geen draft betalingen</div>
      ) : (
        <>
          <FilterBar search={search} setSearch={setSearch} hasSort={sort !== null} resetSort={() => setSort(null)} totalCount={items.length} visibleCount={visible.length} placeholder="Filter (partij, type...)" />
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="w-10 px-3 py-2">
                  <input type="checkbox" checked={allSelected} onChange={() => toggleAll(allNames)} className="cursor-pointer accent-teal-600" />
                </th>
                <SortHeader field="posting_date" label="Datum" sort={sort} onSort={setSort} />
                <SortHeader field="party_name" label="Partij" sort={sort} onSort={setSort} />
                <SortHeader field="payment_type" label="Type" sort={sort} onSort={setSort} />
                <SortHeader field="mode_of_payment" label="Wijze" sort={sort} onSort={setSort} />
                <SortHeader field="name" label="Betaling" sort={sort} onSort={setSort} />
                <SortHeader field="paid_amount" label="Bedrag" align="right" sort={sort} onSort={setSort} />
                <th className="px-4 py-2 text-left font-semibold text-slate-600">Actie</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.name} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" checked={st.selected.has(r.name)} onChange={() => toggle(r.name)} className="cursor-pointer accent-teal-600" />
                  </td>
                  <td className="px-4 py-2 text-slate-500">{r.posting_date}</td>
                  <td className="px-4 py-2">{r.party_name || r.party || "-"}</td>
                  <td className="px-4 py-2">{r.payment_type}</td>
                  <td className="px-4 py-2 text-slate-600">{r.mode_of_payment || "-"}</td>
                  <td className="px-4 py-2">
                    <a href={docLink(erpAppUrl, "Payment Entry", r.name)} target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline inline-flex items-center gap-1">
                      {r.name} <ExternalLink size={10} />
                    </a>
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-slate-700">{fmtEur(r.paid_amount)}</td>
                  <td className="px-4 py-2">
                    <RowSubmitButton name={r.name} st={st} onSubmit={submitOne} onCancel={cancelConfirm} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Sectie 3: te reconciliëren (submitted PE's met niet-gekoppeld bedrag + banktransacties)

function ReconSection({ rows, erpAppUrl }: { rows: ReconRow[]; erpAppUrl: string }) {
  const [sort, setSort] = useState<SortState | null>(null);
  const [search, setSearch] = useState("");
  const visible = sortRows(filterRows(rows, search), sort);

  return (
    <SectionShell
      icon={<Landmark size={16} className="text-indigo-600" />}
      title="Te reconciliëren"
      count={rows.length}
      totalLabel={fmtEur(sumField(rows, "unallocated"))}
      toolbar={
        erpAppUrl ? (
          <a
            href={`${erpAppUrl}/app/bank-reconciliation-tool`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm px-3 py-1.5 border border-slate-300 rounded hover:bg-white text-slate-700"
          >
            Bank Reconciliation Tool <ExternalLink size={12} />
          </a>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <div className="px-5 py-8 text-center text-slate-400">Niets te reconciliëren</div>
      ) : (
        <>
          <FilterBar search={search} setSearch={setSearch} hasSort={sort !== null} resetSort={() => setSort(null)} totalCount={rows.length} visibleCount={visible.length} placeholder="Filter (partij, type, datum...)" />
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <SortHeader field="date" label="Datum" sort={sort} onSort={setSort} />
                <SortHeader field="doctype" label="Soort" sort={sort} onSort={setSort} />
                <SortHeader field="party" label="Partij" sort={sort} onSort={setSort} />
                <SortHeader field="detail" label="Detail" sort={sort} onSort={setSort} />
                <SortHeader field="amount" label="Bedrag" align="right" sort={sort} onSort={setSort} />
                <SortHeader field="unallocated" label="Niet gekoppeld" align="right" sort={sort} onSort={setSort} />
                <SortHeader field="name" label="Document" sort={sort} onSort={setSort} />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.key} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 text-slate-500">{r.date}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-block px-2 py-0.5 text-xs rounded-full ${
                      r.doctype === "Payment Entry" ? "bg-purple-100 text-purple-700" : "bg-indigo-100 text-indigo-700"
                    }`}>
                      {r.doctype === "Payment Entry" ? "Betaling" : "Bank"}
                    </span>
                  </td>
                  <td className="px-4 py-2">{r.party}</td>
                  <td className="px-4 py-2 text-slate-600">{r.detail}</td>
                  <td className={`px-4 py-2 text-right ${r.amount < 0 ? "text-red-600" : "text-emerald-600"}`}>
                    {r.amount < 0 ? "− " : "+ "}{fmtEur(Math.abs(r.amount))}
                  </td>
                  <td className="px-4 py-2 text-right font-semibold text-indigo-700">{fmtEur(r.unallocated)}</td>
                  <td className="px-4 py-2">
                    <a href={docLink(erpAppUrl, r.doctype, r.name)} target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline inline-flex items-center gap-1">
                      {r.name} <ExternalLink size={10} />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
            {visible.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                  <td colSpan={5} className="px-4 py-2 text-xs uppercase tracking-wide text-slate-600">
                    Totaal · {visible.length} {visible.length === 1 ? "rij" : "rijen"}
                  </td>
                  <td className="px-4 py-2 text-right text-indigo-700">{fmtEur(sumField(visible, "unallocated"))}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </>
      )}
    </SectionShell>
  );
}
