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
} from "lucide-react";
import { yapp } from "./yapp-bridge";

const DEFAULT_COMPANY = "3BM Coöperatie U.A.";

interface SalesInvoice {
  name: string;
  posting_date: string;
  due_date: string;
  customer_name: string;
  grand_total: number;
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
  | "pe_unallocated";

const INTERCOMPANY_SUPPLIERS = new Set([
  "3BM bouwtechniek",
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
  tone: "amber" | "orange" | "red" | "purple" | "slate" | "pink";
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
  const [company, setCompany] = useState<string>(storedCompany ?? DEFAULT_COMPANY);
  const [year, setYear] = useState<number>(thisYear());
  const [companies, setCompanies] = useState<Company[]>([]);
  const [erpAppUrl, setErpAppUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [si, setSi] = useState<SalesInvoice[]>([]);
  const [pi, setPi] = useState<PurchaseInvoice[]>([]);
  const [pe, setPe] = useState<PaymentEntry[]>([]);
  const [piWithFile, setPiWithFile] = useState<Set<string>>(new Set());

  const [drill, setDrill] = useState<DrillKey | null>(null);

  useEffect(() => {
    localStorage.setItem("coop_admin_company", company);
  }, [company]);

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

    try {
      const [siList, piList, peList, fileList] = await Promise.all([
        yapp.fetchList<SalesInvoice>("Sales Invoice", {
          fields: [
            "name", "posting_date", "due_date", "customer_name",
            "grand_total", "outstanding_amount", "status", "docstatus",
          ],
          filters: baseFilters,
          limit_page_length: 1000,
          order_by: "posting_date asc",
        }),
        yapp.fetchList<PurchaseInvoice>("Purchase Invoice", {
          fields: [
            "name", "posting_date", "supplier_name", "supplier", "bill_no",
            "grand_total", "outstanding_amount", "status", "docstatus",
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
        yapp.fetchList<FileAttachment>("File", {
          fields: ["attached_to_name"],
          filters: [["attached_to_doctype", "=", "Purchase Invoice"]],
          limit_page_length: 5000,
        }),
      ]);
      setSi(siList);
      setPi(piList);
      setPe(peList);
      setPiWithFile(new Set(fileList.map((f) => f.attached_to_name)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAll(); }, [company, year]);

  const stats = useMemo(() => {
    const siOpen = si.filter((x) => x.docstatus === 1 && x.outstanding_amount > 0);
    const siDraft = si.filter((x) => x.docstatus === 0);
    const siReturnsOpen = si.filter((x) => x.outstanding_amount < 0);
    const piOpen = pi.filter((x) => x.docstatus === 1 && x.outstanding_amount > 0);
    const piNoPdf = pi.filter(
      (x) => x.docstatus === 1 && !piWithFile.has(x.name) && !INTERCOMPANY_SUPPLIERS.has(x.supplier)
    );
    const peUnalloc = pe.filter((x) => Math.abs(x.unallocated_amount) > 0.01);
    return {
      si_open: { items: siOpen, count: siOpen.length, amount: siOpen.reduce((s, x) => s + x.outstanding_amount, 0) },
      si_draft: { items: siDraft, count: siDraft.length, amount: siDraft.reduce((s, x) => s + x.grand_total, 0) },
      si_returns_open: { items: siReturnsOpen, count: siReturnsOpen.length, amount: siReturnsOpen.reduce((s, x) => s + x.outstanding_amount, 0) },
      pi_open: { items: piOpen, count: piOpen.length, amount: piOpen.reduce((s, x) => s + x.outstanding_amount, 0) },
      pi_no_pdf: { items: piNoPdf, count: piNoPdf.length, amount: piNoPdf.reduce((s, x) => s + x.grand_total, 0) },
      pe_unallocated: { items: peUnalloc, count: peUnalloc.length, amount: peUnalloc.reduce((s, x) => s + x.unallocated_amount, 0) },
    };
  }, [si, pi, pe, piWithFile]);

  const drillData = drill ? stats[drill] : null;

  const labels: Record<DrillKey, string> = {
    si_open: "Verkoopfacturen openstaand",
    si_draft: "Verkoopfacturen drafts",
    si_returns_open: "Creditnota's niet verrekend",
    pi_open: "Inkoopfacturen openstaand",
    pi_no_pdf: "Inkoopfacturen zonder PDF",
    pe_unallocated: "Losse betalingen niet gekoppeld",
  };

  return (
    <div className="p-3 sm:p-6 min-h-full bg-slate-100">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Coöp Penningmeester Dashboard</h2>
          <p className="text-sm text-slate-500 mt-1">Overzicht openstaand, ontbrekende PDFs en losse betalingen</p>
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
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <StatCard label={labels.si_open}  count={stats.si_open.count}  amount={stats.si_open.amount}  icon={<FileText size={22} />}    tone="amber"  active={drill === "si_open"}  onClick={() => setDrill(drill === "si_open" ? null : "si_open")} />
        <StatCard label={labels.si_draft} count={stats.si_draft.count} amount={stats.si_draft.amount} icon={<Edit3 size={22} />}       tone="orange" active={drill === "si_draft"} onClick={() => setDrill(drill === "si_draft" ? null : "si_draft")} />
        <StatCard label={labels.si_returns_open} count={stats.si_returns_open.count} amount={stats.si_returns_open.amount} icon={<RotateCcw size={22} />} tone="pink" active={drill === "si_returns_open"} onClick={() => setDrill(drill === "si_returns_open" ? null : "si_returns_open")} />
        <StatCard label={labels.pi_open}  count={stats.pi_open.count}  amount={stats.pi_open.amount}  icon={<ShoppingCart size={22} />} tone="red"   active={drill === "pi_open"}  onClick={() => setDrill(drill === "pi_open" ? null : "pi_open")} />
        <StatCard label={labels.pi_no_pdf} count={stats.pi_no_pdf.count} amount={stats.pi_no_pdf.amount} icon={<Paperclip size={22} />} tone="slate" active={drill === "pi_no_pdf"} onClick={() => setDrill(drill === "pi_no_pdf" ? null : "pi_no_pdf")} />
        <StatCard label={labels.pe_unallocated} count={stats.pe_unallocated.count} amount={stats.pe_unallocated.amount} icon={<Banknote size={22} />} tone="purple" active={drill === "pe_unallocated"} onClick={() => setDrill(drill === "pe_unallocated" ? null : "pe_unallocated")} />
      </div>

      {drill && drillData && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
              {labels[drill]} ({drillData.count})
            </h3>
            <button onClick={() => setDrill(null)} className="text-xs text-slate-500 hover:text-slate-700">Sluiten</button>
          </div>
          <DrillTable kind={drill} items={drillData.items as Array<SalesInvoice | PurchaseInvoice | PaymentEntry>} erpAppUrl={erpAppUrl} />
        </div>
      )}

      {!drill && !loading && (
        <div className="text-center text-sm text-slate-400 mt-8">Klik een kaart om de details te zien</div>
      )}
    </div>
  );
}

interface DrillTableProps {
  kind: DrillKey;
  items: Array<SalesInvoice | PurchaseInvoice | PaymentEntry>;
  erpAppUrl: string;
}

function DrillTable({ kind, items, erpAppUrl }: DrillTableProps) {
  if (items.length === 0) {
    return <div className="px-5 py-8 text-center text-slate-400">Geen items in deze categorie</div>;
  }

  const linkBase = erpAppUrl ? `${erpAppUrl}/app` : "";
  const docLink = (doctype: string, name: string) => {
    const slug = doctype.toLowerCase().replace(/\s+/g, "-");
    return linkBase ? `${linkBase}/${slug}/${encodeURIComponent(name)}` : "#";
  };

  if (kind === "pe_unallocated") {
    const rows = items as PaymentEntry[];
    return (
      <table className="w-full text-sm">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr>
            <th className="text-left px-4 py-2 font-semibold text-slate-600">Datum</th>
            <th className="text-left px-4 py-2 font-semibold text-slate-600">Partij</th>
            <th className="text-left px-4 py-2 font-semibold text-slate-600">Type</th>
            <th className="text-right px-4 py-2 font-semibold text-slate-600">Niet gekoppeld</th>
            <th className="text-left px-4 py-2 font-semibold text-slate-600">Actie</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
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
      </table>
    );
  }

  const isSI = kind === "si_open" || kind === "si_draft" || kind === "si_returns_open";
  if (isSI) {
    const rows = items as SalesInvoice[];
    return (
      <table className="w-full text-sm">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr>
            <th className="text-left px-4 py-2 font-semibold text-slate-600">Datum</th>
            <th className="text-left px-4 py-2 font-semibold text-slate-600">Klant</th>
            <th className="text-left px-4 py-2 font-semibold text-slate-600">Factuur</th>
            <th className="text-right px-4 py-2 font-semibold text-slate-600">Totaal</th>
            <th className="text-right px-4 py-2 font-semibold text-slate-600">Openstaand</th>
            <th className="text-left px-4 py-2 font-semibold text-slate-600">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-4 py-2 text-slate-500">{r.posting_date}</td>
              <td className="px-4 py-2">{r.customer_name}</td>
              <td className="px-4 py-2">
                <a href={docLink("Sales Invoice", r.name)} target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline inline-flex items-center gap-1">
                  {r.name} <ExternalLink size={10} />
                </a>
              </td>
              <td className="px-4 py-2 text-right text-slate-700">{fmtEur(r.grand_total)}</td>
              <td className={`px-4 py-2 text-right font-semibold ${r.outstanding_amount < 0 ? "text-pink-600" : "text-amber-700"}`}>{fmtEur(r.outstanding_amount)}</td>
              <td className="px-4 py-2">
                <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-slate-100 text-slate-700">{r.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  const rows = items as PurchaseInvoice[];
  return (
    <table className="w-full text-sm">
      <thead className="bg-slate-50 border-b border-slate-200">
        <tr>
          <th className="text-left px-4 py-2 font-semibold text-slate-600">Datum</th>
          <th className="text-left px-4 py-2 font-semibold text-slate-600">Leverancier</th>
          <th className="text-left px-4 py-2 font-semibold text-slate-600">Factuurnr</th>
          <th className="text-left px-4 py-2 font-semibold text-slate-600">Factuur</th>
          <th className="text-right px-4 py-2 font-semibold text-slate-600">Totaal</th>
          {kind === "pi_open" && (
            <th className="text-right px-4 py-2 font-semibold text-slate-600">Openstaand</th>
          )}
          <th className="text-left px-4 py-2 font-semibold text-slate-600">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} className="border-b border-slate-100 hover:bg-slate-50">
            <td className="px-4 py-2 text-slate-500">{r.posting_date}</td>
            <td className="px-4 py-2">{r.supplier_name}</td>
            <td className="px-4 py-2 text-slate-600">{r.bill_no || "-"}</td>
            <td className="px-4 py-2">
              <a href={docLink("Purchase Invoice", r.name)} target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline inline-flex items-center gap-1">
                {r.name} <ExternalLink size={10} />
              </a>
            </td>
            <td className="px-4 py-2 text-right text-slate-700">{fmtEur(r.grand_total)}</td>
            {kind === "pi_open" && (
              <td className="px-4 py-2 text-right font-semibold text-red-700">{fmtEur(r.outstanding_amount)}</td>
            )}
            <td className="px-4 py-2">
              {kind === "pi_no_pdf" ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-slate-100 text-slate-700">
                  <AlertTriangle size={12} /> Geen PDF
                </span>
              ) : (
                <span className="inline-block px-2 py-0.5 text-xs rounded-full bg-slate-100 text-slate-700">{r.status}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
