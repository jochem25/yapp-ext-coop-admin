import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Calendar, Search, ExternalLink } from "lucide-react";
import { yapp } from "./yapp-bridge";

interface Account {
  name: string;
  account_name: string;
  account_number: string | null;
  root_type: string;
}

interface GLEntry {
  name: string;
  posting_date: string;
  account: string;
  debit: number;
  credit: number;
  voucher_type: string;
  voucher_no: string;
  party_type: string | null;
  party: string | null;
  remarks: string | null;
}

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

interface Props {
  company: string;
  year: number;
  erpAppUrl: string;
}

type SortKey = "date" | "amount" | "account" | "party";

export default function ExpensesTable({ company, year: defaultYear, erpAppUrl }: Props) {
  const [year, setYear] = useState(defaultYear);
  const [month, setMonth] = useState(new Date().getMonth());
  const [accountFilter, setAccountFilter] = useState<string>(""); // optional ledger filter
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<GLEntry[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<Account[]>([]);

  useEffect(() => { setYear(defaultYear); }, [defaultYear]);

  // Load expense accounts for the company
  useEffect(() => {
    const filters: unknown[][] = [
      ["is_group", "=", 0],
      ["root_type", "=", "Expense"],
    ];
    if (company) filters.push(["company", "=", company]);
    yapp.fetchList<Account>("Account", {
      fields: ["name", "account_name", "account_number", "root_type"],
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
    const m = String(month + 1).padStart(2, "0");
    const last = new Date(year, month + 1, 0).getDate();
    const from = `${year}-${m}-01`;
    const to = `${year}-${m}-${String(last).padStart(2, "0")}`;
    const accountList = accountFilter
      ? [accountFilter]
      : expenseAccounts.map((a) => a.name);
    const filters: unknown[][] = [
      ["posting_date", ">=", from],
      ["posting_date", "<=", to],
      ["is_cancelled", "=", 0],
      ["account", "in", accountList],
      ["debit", ">", 0],
    ];
    if (company) filters.unshift(["company", "=", company]);
    try {
      const data = await yapp.fetchList<GLEntry>("GL Entry", {
        fields: [
          "name", "posting_date", "account", "debit", "credit",
          "voucher_type", "voucher_no", "party_type", "party", "remarks",
        ],
        filters,
        limit_page_length: 5000,
        order_by: "posting_date asc",
      });
      setEntries(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onbekende fout bij ophalen");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [company, year, month, accountFilter, expenseAccounts.length]);

  const accountMeta = useMemo(() => {
    const m = new Map<string, { number: string; name: string }>();
    for (const a of expenseAccounts) {
      m.set(a.name, { number: a.account_number ?? "", name: a.account_name });
    }
    return m;
  }, [expenseAccounts]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    let arr = entries;
    if (q) {
      arr = arr.filter((e) =>
        (e.party ?? "").toLowerCase().includes(q) ||
        (e.remarks ?? "").toLowerCase().includes(q) ||
        e.voucher_no.toLowerCase().includes(q) ||
        e.account.toLowerCase().includes(q),
      );
    }
    arr = [...arr].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "amount": cmp = a.debit - b.debit; break;
        case "account": cmp = a.account.localeCompare(b.account); break;
        case "party": cmp = (a.party ?? "").localeCompare(b.party ?? ""); break;
        case "date":
        default: cmp = a.posting_date.localeCompare(b.posting_date); break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [entries, search, sortKey, sortDir]);

  const total = useMemo(() => filtered.reduce((s, e) => s + e.debit, 0), [filtered]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "date" ? "desc" : "desc");
    }
  }

  function voucherLink(e: GLEntry): string {
    if (!erpAppUrl) return "#";
    const slug = e.voucher_type.toLowerCase().replace(/\s+/g, "-");
    return `${erpAppUrl}/app/${slug}/${encodeURIComponent(e.voucher_no)}`;
  }

  function accountLabel(account: string): string {
    const meta = accountMeta.get(account);
    if (!meta) return account;
    return meta.number ? `${meta.number} ${meta.name}` : meta.name;
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide flex-1 min-w-0">
          Uitgaven — {MONTHS_NL[month]} {year}
        </h3>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-teal-600 text-white rounded-md hover:bg-teal-700 disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Vernieuwen
        </button>
      </div>

      <div className="px-5 py-3 border-b border-slate-200 flex flex-wrap items-center gap-3 text-sm">
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
          <select
            value={month}
            onChange={(e) => setMonth(parseInt(e.target.value, 10))}
            className="px-2 py-1 bg-white border border-slate-200 rounded text-xs"
          >
            {MONTHS_NL.map((m, i) => (
              <option key={m} value={i}>{m}</option>
            ))}
          </select>
        </div>

        <select
          value={accountFilter}
          onChange={(e) => setAccountFilter(e.target.value)}
          className="px-2 py-1 bg-white border border-slate-200 rounded text-xs max-w-[280px]"
        >
          <option value="">Alle uitgave-grootboeken</option>
          {expenseAccounts
            .slice()
            .sort((a, b) => {
              const an = parseInt(a.account_number ?? "999999", 10);
              const bn = parseInt(b.account_number ?? "999999", 10);
              return an - bn;
            })
            .map((a) => (
              <option key={a.name} value={a.name}>
                {a.account_number ? `${a.account_number} ${a.account_name}` : a.account_name}
              </option>
            ))}
        </select>

        <div className="flex items-center gap-1.5 ml-auto">
          <Search size={14} className="text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Zoek leverancier, omschrijving, voucher…"
            className="px-2 py-1 bg-white border border-slate-200 rounded text-xs w-64"
          />
        </div>
      </div>

      <div className="px-5 py-2 bg-slate-50 border-b border-slate-200 text-xs text-slate-600 flex flex-wrap gap-4">
        <span><b>{filtered.length}</b> regels</span>
        <span>Totaal: <b className="text-blue-700">{fmtEur(total)}</b></span>
        {expenseAccounts.length === 0 && !loading && (
          <span className="text-amber-600">Geen uitgave-grootboeken gevonden voor deze company</span>
        )}
      </div>

      {error && (
        <div className="m-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">{error}</div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
            <tr>
              <Th onClick={() => toggleSort("date")} active={sortKey === "date"} dir={sortDir}>Datum</Th>
              <Th onClick={() => toggleSort("party")} active={sortKey === "party"} dir={sortDir}>Partij</Th>
              <Th onClick={() => toggleSort("account")} active={sortKey === "account"} dir={sortDir}>Grootboek</Th>
              <th className="text-left px-3 py-2 font-semibold">Voucher</th>
              <th className="text-left px-3 py-2 font-semibold">Omschrijving</th>
              <Th onClick={() => toggleSort("amount")} active={sortKey === "amount"} dir={sortDir} align="right">Bedrag</Th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Laden...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Geen uitgaven in deze periode</td></tr>
            ) : (
              filtered.map((e) => (
                <tr key={e.name} className="border-b border-slate-100 hover:bg-slate-50 align-top">
                  <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{e.posting_date}</td>
                  <td className="px-3 py-1.5">{e.party ?? <span className="text-slate-400">—</span>}</td>
                  <td className="px-3 py-1.5 text-slate-700">{accountLabel(e.account)}</td>
                  <td className="px-3 py-1.5">
                    <a
                      href={voucherLink(e)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 text-teal-600 hover:underline"
                      title={e.voucher_type}
                    >
                      {e.voucher_no} <ExternalLink size={9} />
                    </a>
                  </td>
                  <td className="px-3 py-1.5 text-slate-600 max-w-md">
                    <span className="line-clamp-2" title={e.remarks ?? ""}>{e.remarks ?? ""}</span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-semibold text-blue-700 whitespace-nowrap">{fmtEur(e.debit)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface ThProps {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  dir: "asc" | "desc";
  align?: "left" | "right";
}

function Th({ children, onClick, active, dir, align = "left" }: ThProps) {
  return (
    <th
      onClick={onClick}
      className={`px-3 py-2 font-semibold cursor-pointer select-none ${align === "right" ? "text-right" : "text-left"} ${active ? "text-slate-800" : ""}`}
    >
      <span className="inline-flex items-center gap-0.5">
        {children}
        {active && <span className="text-[9px]">{dir === "asc" ? "▲" : "▼"}</span>}
      </span>
    </th>
  );
}
