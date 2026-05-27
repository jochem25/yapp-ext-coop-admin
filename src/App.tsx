import { useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  Filter,
  AlertTriangle,
  FileText,
  ShoppingCart,
  Banknote,
  Paperclip,
  RotateCcw,
  Edit3,
  ExternalLink,
  LayoutDashboard,
  BarChart3,
  Receipt,
  Landmark,
  Send,
  Coins,
  Truck,
  Table2,
  Briefcase,
  Users,
} from "lucide-react";
import { yapp } from "./yapp-bridge";
import LedgerChart from "./LedgerChart";
import ExpensesTable from "./ExpensesTable";
import PaymentBatch, { type BatchInvoice } from "./PaymentBatch";
import IntercompanyPanel from "./IntercompanyPanel";
import ExternalCreditorsPanel from "./ExternalCreditorsPanel";
import CostMatrix from "./CostMatrix";
import ProjectsPanel from "./ProjectsPanel";
import PersoneelPanel from "./PersoneelPanel";
import { SortHeader, FilterBar, sortRows, filterRows, sumField, type SortState } from "./table-helpers";

const PAID_BATCH_KEY = "coop_admin_paid_in_batch";

function loadPaidSet(): Set<string> {
  try {
    const raw = localStorage.getItem(PAID_BATCH_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function savePaidSet(s: Set<string>): void {
  localStorage.setItem(PAID_BATCH_KEY, JSON.stringify(Array.from(s)));
}

const DEFAULT_COMPANY = "3BM Coöperatie U.A.";

interface SalesInvoice {
  name: string;
  posting_date: string;
  due_date: string;
  customer_name: string;
  grand_total: number;
  net_total: number;
  outstanding_amount: number;
  status: string;
  docstatus: number;
}

interface PurchaseInvoice {
  name: string;
  posting_date: string;
  supplier_name: string;
  supplier: string;
  bill_no: string;
  grand_total: number;
  net_total: number;
  outstanding_amount: number;
  status: string;
  docstatus: number;
}

interface PaymentEntry {
  name: string;
  posting_date: string;
  payment_type: string;
  party: string;
  paid_amount: number;
  unallocated_amount: number;
}

interface BankTransaction {
  name: string;
  date: string;
  status: string;
  bank_account: string;
  deposit: number;
  withdrawal: number;
  unallocated_amount: number;
  party: string;
  bank_party_name: string;
  docstatus: number;
}

interface FileAttachment {
  attached_to_name: string;
}

interface Company {
  name: string;
  company_name: string;
}

type DrillKey =
  | "si_open"
  | "si_draft"
  | "si_returns_open"
  | "pi_open"
  | "pi_no_pdf"
  | "pe_unallocated"
  | "bt_unreconciled";

const INTERCOMPANY_SUPPLIERS = new Set([
  "3BM bouwtechniek",
  "3BM Bouwtechniek V.O.F.",
  "3BM Engineering",
  "3BM Bouwkunde",
]);

function fmtEur(n: number): string {
  return `€ ${n.toLocaleString("nl-NL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function thisYear(): number {
  return new Date().getFullYear();
}

interface CardProps {
  label: string;
  count: number | null;
  amount: number | null;
  icon: React.ReactNode;
  tone: "amber" | "orange" | "red" | "purple" | "slate" | "pink" | "indigo";
  active: boolean;
  onClick: () => void;
}

const TONES: Record<CardProps["tone"], { bg: string; text: string }> = {
  amber: { bg: "bg-amber-100", text: "text-amber-600" },
  orange: { bg: "bg-orange-100", text: "text-orange-600" },
  red: { bg: "bg-red-100", text: "text-red-600" },
  purple: { bg: "bg-purple-100", text: "text-purple-600" },
  slate: { bg: "bg-slate-100", text: "text-slate-600" },
  pink: { bg: "bg-pink-100", text: "text-pink-600" },
  indigo: { bg: "bg-indigo-100", text: "text-indigo-600" },
};

function StatCard({ label, count, amount, icon, tone, active, onClick }: CardProps) {
  const t = TONES[tone];
  return (
    <button
      onClick={onClick}
      className={`text-left bg-white rounded-xl shadow-sm border-2 p-5 hover:shadow-md transition cursor-pointer ${
        active ? "border-teal-500" : "border-slate-200"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`p-3 rounded-lg ${t.bg}`}>
          <div className={t.text}>{icon}</div>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-slate-500 uppercase tracking-wide truncate">{label}</p>
          <p className="text-2xl font-bold text-slate-800">{count == null ? "..." : count}</p>
          {amount != null && (
            <p className="text-sm text-slate-500">{fmtEur(amount)}</p>
          )}
        </div>
      </div>
    </button>
  );
}

export default function App() {
  const storedCompany = localStorage.getItem("coop_admin_company");
  const storedInclBTW = localStorage.getItem("coop_admin_incl_btw");
  const [company, setCompany] = useState<string>(storedCompany ?? DEFAULT_COMPANY);
  const [year, setYear] = useState<number>(thisYear());
  const [inclBTW, setInclBTW] = useState<boolean>(storedInclBTW === "1");
  const [companies, setCompanies] = useState<Company[]>([]);
  const [erpAppUrl, setErpAppUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [si, setSi] = useState<SalesInvoice[]>([]);
  const [pi, setPi] = useState<PurchaseInvoice[]>([]);
  const [pe, setPe] = useState<PaymentEntry[]>([]);
  const [bt, setBt] = useState<BankTransaction[]>([]);
  const [piWithFile, setPiWithFile] = useState<Set<string>>(new Set());

  const [drill, setDrill] = useState<DrillKey | null>(null);
  const [tab, setTab] = useState<"overview" | "ledger" | "expenses" | "tebetalen" | "crediteuren" | "kostenmatrix" | "projecten" | "personeel">("overview");

  const [paidInBatch, setPaidInBatch] = useState<Set<string>>(() => loadPaidSet());
  const [selectedPis, setSelectedPis] = useState<Set<string>>(new Set());
  const [showBatch, setShowBatch] = useState(false);

  function togglePi(name: string): void {
    setSelectedPis((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function markBatchPaid(names: string[]): void {
    setPaidInBatch((prev) => {
      const next = new Set(prev);
      for (const n of names) next.add(n);
      savePaidSet(next);
      return next;
    });
    setSelectedPis(new Set());
  }

  function clearPaidFlag(name: string): void {
    setPaidInBatch((prev) => {
      const next = new Set(prev);
      next.delete(name);
      savePaidSet(next);
      return next;
    });
  }

  useEffect(() => {
    localStorage.setItem("coop_admin_company", company);
  }, [company]);

  useEffect(() => {
    localStorage.setItem("coop_admin_incl_btw", inclBTW ? "1" : "0");
  }, [inclBTW]);

  // Load companies + erpnext url once
  useEffect(() => {
    yapp.getErpNextAppUrl()
      .then((u) => setErpAppUrl(u))
      .catch(() => {});
    yapp.fetchList<Company>("Company", { fields: ["name", "company_name"], limit_page_length: 50 })
      .then(setCompanies)
      .catch(() => {});
  }, []);

  async function loadAll() {
    setLoading(true);
    setError(null);
    const fromDate = `${year}-01-01`;
    const toDate = `${year}-12-31`;
    const baseFilters: unknown[][] = [
      ["posting_date", ">=", fromDate],
      ["posting_date", "<=", toDate],
      ["docstatus", "!=", 2],
    ];
    if (company) baseFilters.unshift(["company", "=", company]);

    // Bank Transaction uses the "date" field instead of "posting_date".
    const btFilters: unknown[][] = [
      ["date", ">=", fromDate],
      ["date", "<=", toDate],
      ["docstatus", "!=", 2],
    ];
    if (company) btFilters.unshift(["company", "=", company]);

    try {
      const [siList, piList, peList, btList, fileList] = await Promise.all([
        yapp.fetchList<SalesInvoice>("Sales Invoice", {
          fields: [
            "name", "posting_date", "due_date", "customer_name",
            "grand_total", "net_total", "outstanding_amount", "status", "docstatus",
          ],
          filters: baseFilters,
          limit_page_length: 1000,
          order_by: "posting_date asc",
        }),
        yapp.fetchList<PurchaseInvoice>("Purchase Invoice", {
          fields: [
            "name", "posting_date", "supplier_name", "supplier", "bill_no",
            "grand_total", "net_total", "outstanding_amount", "status", "docstatus",
          ],
          filters: baseFilters,
          limit_page_length: 1000,
          order_by: "posting_date asc",
        }),
        yapp.fetchList<PaymentEntry>("Payment Entry", {
          fields: [
            "name", "posting_date", "payment_type", "party",
            "paid_amount", "unallocated_amount",
          ],
          filters: baseFilters,
          limit_page_length: 1000,
          order_by: "posting_date asc",
        }),
        yapp.fetchList<BankTransaction>("Bank Transaction", {
          fields: [
            "name", "date", "status", "bank_account", "deposit", "withdrawal",
            "unallocated_amount", "party", "bank_party_name", "docstatus",
          ],
          filters: btFilters,
          limit_page_length: 2000,
          order_by: "date asc",
        }),
        yapp.fetchList<FileAttachment>("File", {
          fields: ["attached_to_name"],
          filters: [["attached_to_doctype", "=", "Purchase Invoice"]],
          limit_page_length: 5000,
        }),
      ]);
      setSi(siList);
      setPi(piList);
      setPe(peList);
      setBt(btList);
      setPiWithFile(new Set(fileList.map((f) => f.attached_to_name)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAll(); }, [company, year]);

  const stats = useMemo(() => {
    const totalField = inclBTW ? "grand_total" : "net_total";
    const siOpen = si.filter((x) => x.docstatus === 1 && x.outstanding_amount > 0);
    const siDraft = si.filter((x) => x.docstatus === 0);
    const siReturnsOpen = si.filter((x) => x.outstanding_amount < 0);
    const piOpen = pi.filter((x) => x.docstatus === 1 && x.outstanding_amount > 0);
    const piNoPdf = pi.filter(
      (x) => x.docstatus === 1 && !piWithFile.has(x.name) && !INTERCOMPANY_SUPPLIERS.has(x.supplier)
    );
    const peUnalloc = pe.filter((x) => Math.abs(x.unallocated_amount) > 0.01);
    const btUnrec = bt.filter((x) => x.docstatus === 1 && x.unallocated_amount > 0.01);
    const sumTotal = <T extends SalesInvoice | PurchaseInvoice>(arr: T[]) =>
      arr.reduce((s, x) => s + ((x as unknown as Record<string, number>)[totalField] ?? 0), 0);
    return {
      si_open: { items: siOpen, count: siOpen.length, amount: siOpen.reduce((s, x) => s + x.outstanding_amount, 0) },
      si_draft: { items: siDraft, count: siDraft.length, amount: sumTotal(siDraft) },
      si_returns_open: { items: siReturnsOpen, count: siReturnsOpen.length, amount: siReturnsOpen.reduce((s, x) => s + x.outstanding_amount, 0) },
      pi_open: { items: piOpen, count: piOpen.length, amount: piOpen.reduce((s, x) => s + x.outstanding_amount, 0) },
      pi_no_pdf: { items: piNoPdf, count: piNoPdf.length, amount: sumTotal(piNoPdf) },
      pe_unallocated: { items: peUnalloc, count: peUnalloc.length, amount: peUnalloc.reduce((s, x) => s + x.unallocated_amount, 0) },
      bt_unreconciled: { items: btUnrec, count: btUnrec.length, amount: btUnrec.reduce((s, x) => s + x.unallocated_amount, 0) },
    };
  }, [si, pi, pe, bt, piWithFile, inclBTW]);

  const drillData = drill ? stats[drill] : null;

  const labels: Record<DrillKey, string> = {
    si_open: "Verkoopfacturen openstaand",
    si_draft: "Verkoopfacturen drafts",
    si_returns_open: "Creditnota's niet verrekend",
    pi_open: "Inkoopfacturen openstaand",
    pi_no_pdf: "Inkoopfacturen zonder PDF",
    pe_unallocated: "Losse betalingen niet gekoppeld",
    bt_unreconciled: "Banktransacties niet gekoppeld",
  };

  return (
    <div className="p-3 sm:p-6 min-h-full bg-slate-100">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Penningmeester</h2>
          <p className="text-sm text-slate-500 mt-1">Overzicht openstaand, ontbrekende PDFs, losse betalingen en banktransacties</p>
        </div>
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
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>
      )}

      <div className="mb-6 flex items-center gap-3 flex-wrap">
        <Filter size={16} className="text-slate-400" />
        <select
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
        >
          <option value="">Alle bedrijven</option>
          {companies.map((c) => (
            <option key={c.name} value={c.name}>
              {c.company_name || c.name}
            </option>
          ))}
        </select>
        <select
          value={year}
          onChange={(e) => setYear(parseInt(e.target.value, 10))}
          className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
        >
          {Array.from({ length: 5 }, (_, i) => thisYear() - i).map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        <label
          className="inline-flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none ml-2"
          title="Schakel tussen netto bedragen (excl. BTW) en bruto (incl. BTW)"
        >
          <span className="relative inline-flex items-center">
            <input
              type="checkbox"
              checked={inclBTW}
              onChange={(e) => setInclBTW(e.target.checked)}
              className="sr-only peer"
            />
            <span className="w-9 h-5 bg-slate-200 rounded-full peer-checked:bg-teal-600 transition-colors"></span>
            <span className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4"></span>
          </span>
          <span className="font-medium">{inclBTW ? "Incl. BTW" : "Excl. BTW"}</span>
        </label>
      </div>

      <div className="mb-4 flex items-center gap-1 bg-white border border-slate-200 rounded-lg p-1 w-fit">
        <button
          onClick={() => setTab("overview")}
          className={`flex items-center gap-2 px-4 py-1.5 text-sm rounded-md transition ${
            tab === "overview" ? "bg-teal-600 text-white" : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          <LayoutDashboard size={14} /> Overzicht
        </button>
        <button
          onClick={() => setTab("ledger")}
          className={`flex items-center gap-2 px-4 py-1.5 text-sm rounded-md transition ${
            tab === "ledger" ? "bg-teal-600 text-white" : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          <BarChart3 size={14} /> Grootboek mutaties
        </button>
        <button
          onClick={() => setTab("expenses")}
          className={`flex items-center gap-2 px-4 py-1.5 text-sm rounded-md transition ${
            tab === "expenses" ? "bg-teal-600 text-white" : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          <Receipt size={14} /> Uitgaven
        </button>
        <button
          onClick={() => setTab("tebetalen")}
          className={`flex items-center gap-2 px-4 py-1.5 text-sm rounded-md transition ${
            tab === "tebetalen" ? "bg-teal-600 text-white" : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          <Coins size={14} /> Te betalen
        </button>
        <button
          onClick={() => setTab("crediteuren")}
          className={`flex items-center gap-2 px-4 py-1.5 text-sm rounded-md transition ${
            tab === "crediteuren" ? "bg-teal-600 text-white" : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          <Truck size={14} /> Crediteuren
        </button>
        <button
          onClick={() => setTab("kostenmatrix")}
          className={`flex items-center gap-2 px-4 py-1.5 text-sm rounded-md transition ${
            tab === "kostenmatrix" ? "bg-teal-600 text-white" : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          <Table2 size={14} /> Kostenmatrix
        </button>
        <button
          onClick={() => setTab("projecten")}
          className={`flex items-center gap-2 px-4 py-1.5 text-sm rounded-md transition ${
            tab === "projecten" ? "bg-teal-600 text-white" : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          <Briefcase size={14} /> Projecten
        </button>
        <button
          onClick={() => setTab("personeel")}
          className={`flex items-center gap-2 px-4 py-1.5 text-sm rounded-md transition ${
            tab === "personeel" ? "bg-teal-600 text-white" : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          <Users size={14} /> Personeel
        </button>
      </div>

      {tab === "ledger" ? (
        <LedgerChart company={company} year={year} />
      ) : tab === "expenses" ? (
        <ExpensesTable company={company} year={year} erpAppUrl={erpAppUrl} />
      ) : tab === "tebetalen" ? (
        <IntercompanyPanel company={company} year={year} erpAppUrl={erpAppUrl} inclBTW={inclBTW} />
      ) : tab === "crediteuren" ? (
        <ExternalCreditorsPanel company={company} erpAppUrl={erpAppUrl} inclBTW={inclBTW} />
      ) : tab === "kostenmatrix" ? (
        <CostMatrix company={company} year={year} erpAppUrl={erpAppUrl} />
      ) : tab === "projecten" ? (
        <ProjectsPanel company={company} erpAppUrl={erpAppUrl} inclBTW={inclBTW} />
      ) : tab === "personeel" ? (
        <PersoneelPanel year={year} erpAppUrl={erpAppUrl} />
      ) : (
      <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <StatCard label={labels.si_open}  count={stats.si_open.count}  amount={stats.si_open.amount}  icon={<FileText size={22} />}    tone="amber"  active={drill === "si_open"}  onClick={() => setDrill(drill === "si_open" ? null : "si_open")} />
        <StatCard label={labels.si_draft} count={stats.si_draft.count} amount={stats.si_draft.amount} icon={<Edit3 size={22} />}       tone="orange" active={drill === "si_draft"} onClick={() => setDrill(drill === "si_draft" ? null : "si_draft")} />
        <StatCard label={labels.si_returns_open} count={stats.si_returns_open.count} amount={stats.si_returns_open.amount} icon={<RotateCcw size={22} />} tone="pink" active={drill === "si_returns_open"} onClick={() => setDrill(drill === "si_returns_open" ? null : "si_returns_open")} />
        <StatCard label={labels.pi_open}  count={stats.pi_open.count}  amount={stats.pi_open.amount}  icon={<ShoppingCart size={22} />} tone="red"   active={drill === "pi_open"}  onClick={() => setDrill(drill === "pi_open" ? null : "pi_open")} />
        <StatCard label={labels.pi_no_pdf} count={stats.pi_no_pdf.count} amount={stats.pi_no_pdf.amount} icon={<Paperclip size={22} />} tone="slate" active={drill === "pi_no_pdf"} onClick={() => setDrill(drill === "pi_no_pdf" ? null : "pi_no_pdf")} />
        <StatCard label={labels.pe_unallocated} count={stats.pe_unallocated.count} amount={stats.pe_unallocated.amount} icon={<Banknote size={22} />} tone="purple" active={drill === "pe_unallocated"} onClick={() => setDrill(drill === "pe_unallocated" ? null : "pe_unallocated")} />
        <StatCard label={labels.bt_unreconciled} count={stats.bt_unreconciled.count} amount={stats.bt_unreconciled.amount} icon={<Landmark size={22} />} tone="indigo" active={drill === "bt_unreconciled"} onClick={() => setDrill(drill === "bt_unreconciled" ? null : "bt_unreconciled")} />
      </div>

      {drill && drillData && (() => {
        const isPiOpen = drill === "pi_open";
        const piItems = isPiOpen ? (drillData.items as PurchaseInvoice[]) : [];
        const selectableItems = piItems.filter((x) => !paidInBatch.has(x.name));
        const selectedItems = piItems.filter((x) => selectedPis.has(x.name) && !paidInBatch.has(x.name));
        const selectedTotal = selectedItems.reduce((s, x) => s + x.outstanding_amount, 0);
        const allSelected = selectableItems.length > 0 && selectableItems.every((x) => selectedPis.has(x.name));

        return (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between flex-wrap gap-3">
              <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
                {labels[drill]} ({drillData.count})
              </h3>
              <button onClick={() => setDrill(null)} className="text-xs text-slate-500 hover:text-slate-700">Sluiten</button>
            </div>
            {isPiOpen && (
              <div className="px-5 py-3 bg-teal-50/50 border-b border-teal-100 flex items-center justify-between flex-wrap gap-3">
                <div className="text-sm">
                  <span className="font-semibold text-slate-700">{selectedItems.length}</span>
                  <span className="text-slate-500"> van {selectableItems.length} geselecteerd · totaal </span>
                  <span className="font-semibold text-teal-700">{fmtEur(selectedTotal)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      if (allSelected) {
                        const next = new Set(selectedPis);
                        for (const x of selectableItems) next.delete(x.name);
                        setSelectedPis(next);
                      } else {
                        const next = new Set(selectedPis);
                        for (const x of selectableItems) next.add(x.name);
                        setSelectedPis(next);
                      }
                    }}
                    className="text-xs px-3 py-1.5 border border-slate-300 rounded hover:bg-white"
                  >
                    {allSelected ? "Wis selectie" : "Selecteer alles"}
                  </button>
                  <button
                    onClick={() => setShowBatch(true)}
                    disabled={selectedItems.length === 0 || !company}
                    className="flex items-center gap-2 text-sm px-3 py-1.5 bg-teal-600 text-white rounded hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed"
                    title={!company ? "Kies eerst een bedrijf in het filter" : ""}
                  >
                    <Send size={14} /> Batch genereren
                  </button>
                </div>
              </div>
            )}
            <DrillTable
              kind={drill}
              items={drillData.items as Array<SalesInvoice | PurchaseInvoice | PaymentEntry | BankTransaction>}
              erpAppUrl={erpAppUrl}
              inclBTW={inclBTW}
              selectedPis={selectedPis}
              paidInBatch={paidInBatch}
              onTogglePi={togglePi}
              onClearPaid={clearPaidFlag}
            />
          </div>
        );
      })()}

      {showBatch && (() => {
        const batchInvoices: BatchInvoice[] = pi
          .filter((x) => selectedPis.has(x.name) && !paidInBatch.has(x.name))
          .map((x) => ({
            name: x.name,
            bill_no: x.bill_no,
            supplier: x.supplier,
            supplier_name: x.supplier_name,
            outstanding_amount: x.outstanding_amount,
          }));
        return (
          <PaymentBatch
            invoices={batchInvoices}
            company={company}
            onClose={() => setShowBatch(false)}
            onPaid={markBatchPaid}
          />
        );
      })()}

      {!drill && !loading && (
        <div className="text-center text-sm text-slate-400 mt-8">Klik een kaart om de details te zien</div>
      )}
      </>
      )}
    </div>
  );
}

interface DrillTableProps {
  kind: DrillKey;
  items: Array<SalesInvoice | PurchaseInvoice | PaymentEntry | BankTransaction>;
  erpAppUrl: string;
  inclBTW: boolean;
  selectedPis?: Set<string>;
  paidInBatch?: Set<string>;
  onTogglePi?: (name: string) => void;
  onClearPaid?: (name: string) => void;
}

function DrillTable({ kind, items, erpAppUrl, inclBTW, selectedPis, paidInBatch, onTogglePi, onClearPaid }: DrillTableProps) {
  const totalField = inclBTW ? "grand_total" : "net_total";
  const totalLabel = inclBTW ? "Totaal incl" : "Totaal excl";
  const [sort, setSort] = useState<SortState | null>(null);
  const [search, setSearch] = useState("");

  // Reset sort/filter wanneer de drill-categorie wijzigt
  useEffect(() => { setSort(null); setSearch(""); }, [kind]);

  const linkBase = erpAppUrl ? `${erpAppUrl}/app` : "";
  const docLink = (doctype: string, name: string) => {
    const slug = doctype.toLowerCase().replace(/\s+/g, "-");
    return linkBase ? `${linkBase}/${slug}/${encodeURIComponent(name)}` : "#";
  };

  if (items.length === 0) {
    return <div className="px-5 py-8 text-center text-slate-400">Geen items in deze categorie</div>;
  }

  const filterBar = (visibleCount: number) => (
    <FilterBar
      search={search}
      setSearch={setSearch}
      hasSort={sort !== null}
      resetSort={() => setSort(null)}
      totalCount={items.length}
      visibleCount={visibleCount}
      placeholder="Filter (datum, naam, factuurnr, status...)"
    />
  );

  const noMatchRow = (colSpan: number) => (
    <tr><td colSpan={colSpan} className="px-4 py-6 text-center text-slate-400">Geen rijen matchen het filter</td></tr>
  );

  if (kind === "pe_unallocated") {
    const all = items as PaymentEntry[];
    const visible = sortRows(filterRows(all, search), sort);
    return (
      <>
        {filterBar(visible.length)}
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <SortHeader field="posting_date" label="Datum" sort={sort} onSort={setSort} />
              <SortHeader field="party" label="Partij" sort={sort} onSort={setSort} />
              <SortHeader field="payment_type" label="Type" sort={sort} onSort={setSort} />
              <SortHeader field="unallocated_amount" label="Niet gekoppeld" align="right" sort={sort} onSort={setSort} />
              <SortHeader field="name" label="Actie" sort={sort} onSort={setSort} />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? noMatchRow(5) : visible.map((r) => (
              <tr key={r.name} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2 text-slate-500">{r.posting_date}</td>
                <td className="px-4 py-2">{r.party}</td>
                <td className="px-4 py-2">{r.payment_type}</td>
                <td className="px-4 py-2 text-right font-semibold text-purple-700">{fmtEur(r.unallocated_amount)}</td>
                <td className="px-4 py-2">
                  <a href={docLink("Payment Entry", r.name)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-teal-600 hover:underline">
                    {r.name} <ExternalLink size={12} />
                  </a>
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
                <td className="px-4 py-2 text-right text-purple-700">{fmtEur(sumField(visible, "unallocated_amount"))}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </>
    );
  }

  if (kind === "bt_unreconciled") {
    const all = (items as BankTransaction[]).map((r) => ({ ...r, signed: r.deposit - r.withdrawal }));
    const visible = sortRows(filterRows(all, search), sort);
    return (
      <>
        {filterBar(visible.length)}
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <SortHeader field="date" label="Datum" sort={sort} onSort={setSort} />
              <SortHeader field="bank_account" label="Bankrekening" sort={sort} onSort={setSort} />
              <SortHeader field="bank_party_name" label="Tegenpartij" sort={sort} onSort={setSort} />
              <SortHeader field="signed" label="Bedrag" align="right" sort={sort} onSort={setSort} />
              <SortHeader field="unallocated_amount" label="Niet gekoppeld" align="right" sort={sort} onSort={setSort} />
              <SortHeader field="name" label="Actie" sort={sort} onSort={setSort} />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? noMatchRow(6) : visible.map((r) => (
              <tr key={r.name} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2 text-slate-500">{r.date}</td>
                <td className="px-4 py-2 text-slate-600">{r.bank_account}</td>
                <td className="px-4 py-2">{r.bank_party_name || r.party || "-"}</td>
                <td className={`px-4 py-2 text-right ${r.signed < 0 ? "text-red-600" : "text-emerald-600"}`}>
                  {r.signed < 0 ? "− " : "+ "}{fmtEur(Math.abs(r.signed))}
                </td>
                <td className="px-4 py-2 text-right font-semibold text-indigo-700">{fmtEur(r.unallocated_amount)}</td>
                <td className="px-4 py-2">
                  <a href={docLink("Bank Transaction", r.name)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-teal-600 hover:underline">
                    {r.name} <ExternalLink size={12} />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
          {visible.length > 0 && (() => {
            const totalSigned = sumField(visible, "signed");
            return (
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                  <td colSpan={3} className="px-4 py-2 text-xs uppercase tracking-wide text-slate-600">
                    Totaal · {visible.length} {visible.length === 1 ? "rij" : "rijen"}
                  </td>
                  <td className={`px-4 py-2 text-right ${totalSigned < 0 ? "text-red-600" : "text-emerald-600"}`}>
                    {totalSigned < 0 ? "− " : "+ "}{fmtEur(Math.abs(totalSigned))}
                  </td>
                  <td className="px-4 py-2 text-right text-indigo-700">{fmtEur(sumField(visible, "unallocated_amount"))}</td>
                  <td />
                </tr>
              </tfoot>
            );
          })()}
        </table>
      </>
    );
  }

  const isSI = kind === "si_open" || kind === "si_draft" || kind === "si_returns_open";
  if (isSI) {
    const all = items as SalesInvoice[];
    const visible = sortRows(filterRows(all, search), sort);
    return (
      <>
        {filterBar(visible.length)}
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <SortHeader field="posting_date" label="Datum" sort={sort} onSort={setSort} />
              <SortHeader field="customer_name" label="Klant" sort={sort} onSort={setSort} />
              <SortHeader field="name" label="Factuur" sort={sort} onSort={setSort} />
              <SortHeader field={totalField} label={totalLabel} align="right" sort={sort} onSort={setSort} />
              <SortHeader field="outstanding_amount" label="Openstaand" align="right" sort={sort} onSort={setSort} />
              <SortHeader field="status" label="Status" sort={sort} onSort={setSort} />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? noMatchRow(6) : visible.map((r) => (
              <tr key={r.name} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2 text-slate-500">{r.posting_date}</td>
                <td className="px-4 py-2">{r.customer_name}</td>
                <td className="px-4 py-2">
                  <a href={docLink("Sales Invoice", r.name)} target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline inline-flex items-center gap-1">
                    {r.name} <ExternalLink size={10} />
                  </a>
                </td>
                <td className="px-4 py-2 text-right text-slate-700">{fmtEur(inclBTW ? r.grand_total : r.net_total)}</td>
                <td className={`px-4 py-2 text-right font-semibold ${r.outstanding_amount < 0 ? "text-pink-600" : "text-amber-700"}`}>{fmtEur(r.outstanding_amount)}</td>
                <td className="px-4 py-2">
                  <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-slate-100 text-slate-700">{r.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
          {visible.length > 0 && (() => {
            const totalOutstanding = sumField(visible, "outstanding_amount");
            return (
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                  <td colSpan={3} className="px-4 py-2 text-xs uppercase tracking-wide text-slate-600">
                    Totaal · {visible.length} {visible.length === 1 ? "rij" : "rijen"}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-700">{fmtEur(sumField(visible, totalField))}</td>
                  <td className={`px-4 py-2 text-right ${totalOutstanding < 0 ? "text-pink-600" : "text-amber-700"}`}>{fmtEur(totalOutstanding)}</td>
                  <td />
                </tr>
              </tfoot>
            );
          })()}
        </table>
      </>
    );
  }

  // PurchaseInvoice (pi_open + pi_no_pdf)
  const all = items as PurchaseInvoice[];
  const visible = sortRows(filterRows(all, search), sort);
  const showSelect = kind === "pi_open" && !!onTogglePi;
  const colCount = (showSelect ? 1 : 0) + (kind === "pi_open" ? 7 : 6);
  return (
    <>
      {filterBar(visible.length)}
      <table className="w-full text-sm">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr>
            {showSelect && <th className="w-10 px-3 py-2"></th>}
            <SortHeader field="posting_date" label="Datum" sort={sort} onSort={setSort} />
            <SortHeader field="supplier_name" label="Leverancier" sort={sort} onSort={setSort} />
            <SortHeader field="bill_no" label="Factuurnr" sort={sort} onSort={setSort} />
            <SortHeader field="name" label="Factuur" sort={sort} onSort={setSort} />
            <SortHeader field={totalField} label={totalLabel} align="right" sort={sort} onSort={setSort} />
            {kind === "pi_open" && (
              <SortHeader field="outstanding_amount" label="Openstaand" align="right" sort={sort} onSort={setSort} />
            )}
            <SortHeader field="status" label="Status" sort={sort} onSort={setSort} />
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 ? noMatchRow(colCount) : visible.map((r) => {
            const isPaid = !!paidInBatch?.has(r.name);
            const isSelected = !!selectedPis?.has(r.name);
            return (
              <tr key={r.name} className={`border-b border-slate-100 hover:bg-slate-50 ${isPaid ? "bg-slate-50 text-slate-400" : ""}`}>
                {showSelect && (
                  <td className="px-3 py-2 text-center">
                    {isPaid ? (
                      <span className="text-[10px] text-slate-400">batch</span>
                    ) : (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => onTogglePi?.(r.name)}
                        className="cursor-pointer accent-teal-600"
                      />
                    )}
                  </td>
                )}
                <td className="px-4 py-2 text-slate-500">{r.posting_date}</td>
                <td className="px-4 py-2">{r.supplier_name}</td>
                <td className="px-4 py-2 text-slate-600">{r.bill_no || "-"}</td>
                <td className="px-4 py-2">
                  <a href={docLink("Purchase Invoice", r.name)} target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline inline-flex items-center gap-1">
                    {r.name} <ExternalLink size={10} />
                  </a>
                </td>
                <td className="px-4 py-2 text-right text-slate-700">{fmtEur(inclBTW ? r.grand_total : r.net_total)}</td>
                {kind === "pi_open" && (
                  <td className="px-4 py-2 text-right font-semibold text-red-700">{fmtEur(r.outstanding_amount)}</td>
                )}
                <td className="px-4 py-2">
                  {kind === "pi_no_pdf" ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-slate-100 text-slate-700">
                      <AlertTriangle size={12} /> Geen PDF
                    </span>
                  ) : isPaid ? (
                    <button
                      onClick={() => onClearPaid?.(r.name)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                      title="Klik om de batch-markering te verwijderen"
                    >
                      In batch verstuurd
                    </button>
                  ) : (
                    <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-slate-100 text-slate-700">{r.status}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        {visible.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
              {showSelect && <td />}
              <td colSpan={4} className="px-4 py-2 text-xs uppercase tracking-wide text-slate-600">
                Totaal · {visible.length} {visible.length === 1 ? "rij" : "rijen"}
              </td>
              <td className="px-4 py-2 text-right text-slate-700">{fmtEur(sumField(visible, totalField))}</td>
              {kind === "pi_open" && (
                <td className="px-4 py-2 text-right text-red-700">{fmtEur(sumField(visible, "outstanding_amount"))}</td>
              )}
              <td />
            </tr>
          </tfoot>
        )}
      </table>
    </>
  );
}
