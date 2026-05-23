import { useEffect, useMemo, useState } from "react";
import { Download, X, AlertTriangle, CheckCircle2 } from "lucide-react";
import { yapp } from "./yapp-bridge";
import {
  generateSepaXml,
  isValidIban,
  stripIban,
  buildMessageId,
  buildPaymentInfoId,
  nowIsoSeconds,
  type SepaTransaction,
} from "./sepa";

export interface BatchInvoice {
  name: string;            // PI naam (ERPNext id)
  bill_no: string;         // crediteur-factuurnummer
  supplier: string;        // supplier id (link)
  supplier_name: string;   // display
  outstanding_amount: number;
}

interface BankAccount {
  name: string;
  account_name: string;
  iban: string | null;
  bank_account_no: string | null;
  branch_code: string | null;
  swift_number: string | null;
  is_default: number;
  is_company_account: number;
  party_type: string | null;
  party: string | null;
  company: string | null;
}

interface BatchLine {
  invoiceName: string;
  billNo: string;
  supplier: string;
  creditorName: string;
  creditorIban: string;
  amount: number;
  remittance: string;
}

function fmtEur(n: number): string {
  return `€ ${n.toLocaleString("nl-NL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function pickIban(b: BankAccount): string {
  return (b.iban || b.bank_account_no || "").trim();
}

function pickBic(b: BankAccount): string {
  return (b.swift_number || b.branch_code || "").trim();
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
}

interface Props {
  invoices: BatchInvoice[];
  company: string;
  onClose: () => void;
  onPaid: (invoiceNames: string[]) => void;
}

export default function PaymentBatch({ invoices, company, onClose, onPaid }: Props) {
  const [companyAccounts, setCompanyAccounts] = useState<BankAccount[]>([]);
  const [supplierIbans, setSupplierIbans] = useState<Map<string, BankAccount>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [dbtrAccountName, setDbtrAccountName] = useState<string>("");
  const [execDate, setExecDate] = useState<string>(todayIso());
  const [lines, setLines] = useState<BatchLine[]>([]);
  const [downloaded, setDownloaded] = useState(false);

  // Load company + supplier bank accounts
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const supplierIds = Array.from(new Set(invoices.map((i) => i.supplier)));
        const fields = [
          "name", "account_name", "iban", "bank_account_no",
          "branch_code", "swift_number", "is_default", "is_company_account",
          "party_type", "party", "company",
        ];
        const [coAcc, supAcc] = await Promise.all([
          yapp.fetchList<BankAccount>("Bank Account", {
            fields,
            filters: [
              ["company", "=", company],
              ["is_company_account", "=", 1],
              ["disabled", "=", 0],
            ],
            limit_page_length: 50,
          }),
          supplierIds.length > 0
            ? yapp.fetchList<BankAccount>("Bank Account", {
                fields,
                filters: [
                  ["party_type", "=", "Supplier"],
                  ["party", "in", supplierIds],
                  ["disabled", "=", 0],
                ],
                limit_page_length: 500,
              })
            : Promise.resolve([] as BankAccount[]),
        ]);
        if (cancelled) return;
        setCompanyAccounts(coAcc);
        const map = new Map<string, BankAccount>();
        for (const b of supAcc) {
          if (b.party && !map.has(b.party)) map.set(b.party, b);
        }
        setSupplierIbans(map);
        const def = coAcc.find((b) => b.is_default === 1) ?? coAcc[0];
        if (def) setDbtrAccountName(def.name);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Onbekende fout");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [company, invoices]);

  // Initialise lines once bank accounts are in
  useEffect(() => {
    if (loading) return;
    setLines(
      invoices.map((inv) => {
        const supBank = supplierIbans.get(inv.supplier);
        return {
          invoiceName: inv.name,
          billNo: inv.bill_no,
          supplier: inv.supplier,
          creditorName: inv.supplier_name,
          creditorIban: supBank ? pickIban(supBank) : "",
          amount: Number(inv.outstanding_amount.toFixed(2)),
          remittance: `Factuur: ${inv.bill_no || inv.name}`,
        };
      }),
    );
    setDownloaded(false);
  }, [loading, invoices, supplierIbans]);

  const dbtr = useMemo(
    () => companyAccounts.find((b) => b.name === dbtrAccountName) ?? null,
    [companyAccounts, dbtrAccountName],
  );

  const totalAmount = useMemo(
    () => lines.reduce((s, l) => s + (Number.isFinite(l.amount) ? l.amount : 0), 0),
    [lines],
  );

  const rowErrors = useMemo(() => {
    return lines.map((l) => {
      const errs: string[] = [];
      if (!l.creditorName.trim()) errs.push("Naam crediteur ontbreekt");
      if (!l.creditorIban || !isValidIban(l.creditorIban)) errs.push("IBAN ongeldig of leeg");
      if (!(l.amount > 0)) errs.push("Bedrag moet > 0");
      if (!l.remittance.trim()) errs.push("Mededeling leeg");
      return errs;
    });
  }, [lines]);

  const formErrors = useMemo(() => {
    const errs: string[] = [];
    if (!company) errs.push("Kies eerst een bedrijf in het hoofdoverzicht");
    if (!dbtr) errs.push("Kies een eigen bankrekening");
    else if (!isValidIban(pickIban(dbtr))) errs.push("Eigen IBAN ongeldig in ERPNext");
    if (!execDate) errs.push("Uitvoerdatum leeg");
    if (lines.length === 0) errs.push("Geen regels");
    return errs;
  }, [company, dbtr, execDate, lines]);

  const canGenerate =
    formErrors.length === 0 && rowErrors.every((e) => e.length === 0);

  function updateLine(idx: number, patch: Partial<BatchLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  function handleDownload() {
    if (!canGenerate || !dbtr) return;
    const transactions: SepaTransaction[] = lines.map((l, i) => ({
      endToEndId: `EBTR${i + 1}`,
      amountEur: l.amount,
      creditorName: l.creditorName,
      creditorIban: l.creditorIban,
      remittanceInfo: l.remittance,
    }));
    const xml = generateSepaXml({
      initiatingPartyName: company,
      messageId: buildMessageId(slug(company).toUpperCase().slice(0, 5) || "BATCH"),
      creationDateTime: nowIsoSeconds(),
      requestedExecutionDate: execDate,
      paymentInfoId: buildPaymentInfoId(),
      debtorName: company,
      debtorIban: pickIban(dbtr),
      debtorBic: pickBic(dbtr) || undefined,
      transactions,
    });

    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = execDate.replace(/-/g, "");
    a.href = url;
    a.download = `BATCH-${slug(company)}-${d}-${new Date().getHours().toString().padStart(2,"0")}${new Date().getMinutes().toString().padStart(2,"0")}.xml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloaded(true);
  }

  function handleMarkPaid() {
    onPaid(lines.map((l) => l.invoiceName));
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-800">SEPA betaalbatch genereren</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={20} />
          </button>
        </div>

        <div className="px-5 py-4 overflow-auto flex-1">
          {loading && <div className="text-sm text-slate-500">Bankrekeningen laden…</div>}
          {loadError && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
              {loadError}
            </div>
          )}

          {!loading && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
                <div>
                  <label className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
                    Eigen rekening (Dbtr)
                  </label>
                  <select
                    value={dbtrAccountName}
                    onChange={(e) => setDbtrAccountName(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                  >
                    <option value="">— kies rekening —</option>
                    {companyAccounts.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.account_name} · {pickIban(b) || "geen IBAN"}
                      </option>
                    ))}
                  </select>
                  {dbtr && (
                    <p className="text-xs text-slate-500 mt-1">
                      {pickIban(dbtr)}
                      {pickBic(dbtr) ? ` · ${pickBic(dbtr)}` : " · BIC ontbreekt"}
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
                    Uitvoerdatum
                  </label>
                  <input
                    type="date"
                    value={execDate}
                    onChange={(e) => setExecDate(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </div>
              </div>

              <div className="border border-slate-200 rounded overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold text-slate-600">Crediteur</th>
                      <th className="text-left px-3 py-2 font-semibold text-slate-600">IBAN</th>
                      <th className="text-left px-3 py-2 font-semibold text-slate-600">Mededeling</th>
                      <th className="text-right px-3 py-2 font-semibold text-slate-600">Bedrag</th>
                      <th className="w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => {
                      const errs = rowErrors[i] ?? [];
                      const hasErr = errs.length > 0;
                      return (
                        <tr key={l.invoiceName} className={`border-b border-slate-100 ${hasErr ? "bg-red-50/40" : ""}`}>
                          <td className="px-3 py-2 align-top">
                            <input
                              value={l.creditorName}
                              onChange={(e) => updateLine(i, { creditorName: e.target.value })}
                              className="w-full px-2 py-1 border border-slate-200 rounded text-sm"
                            />
                            <div className="text-[11px] text-slate-400 mt-0.5">{l.invoiceName}</div>
                          </td>
                          <td className="px-3 py-2 align-top">
                            <input
                              value={l.creditorIban}
                              onChange={(e) => updateLine(i, { creditorIban: stripIban(e.target.value) })}
                              placeholder="NL.."
                              className={`w-full px-2 py-1 border rounded text-sm font-mono ${
                                l.creditorIban && !isValidIban(l.creditorIban)
                                  ? "border-red-400"
                                  : "border-slate-200"
                              }`}
                            />
                          </td>
                          <td className="px-3 py-2 align-top">
                            <input
                              value={l.remittance}
                              onChange={(e) => updateLine(i, { remittance: e.target.value })}
                              className="w-full px-2 py-1 border border-slate-200 rounded text-sm"
                            />
                          </td>
                          <td className="px-3 py-2 align-top text-right">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={l.amount}
                              onChange={(e) => updateLine(i, { amount: parseFloat(e.target.value) || 0 })}
                              className="w-28 px-2 py-1 border border-slate-200 rounded text-sm text-right"
                            />
                            {hasErr && (
                              <div className="text-[11px] text-red-600 mt-1 flex items-center justify-end gap-1">
                                <AlertTriangle size={11} /> {errs[0]}
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-2 align-top">
                            <button
                              onClick={() => removeLine(i)}
                              className="text-slate-400 hover:text-red-600"
                              title="Verwijder regel"
                            >
                              <X size={14} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-slate-50 border-t border-slate-200">
                    <tr>
                      <td colSpan={3} className="px-3 py-2 text-right font-semibold text-slate-600">
                        Totaal ({lines.length} regels)
                      </td>
                      <td className="px-3 py-2 text-right font-bold text-slate-800">{fmtEur(totalAmount)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {formErrors.length > 0 && (
                <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800">
                  <ul className="list-disc list-inside">
                    {formErrors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between gap-3">
          <div className="text-xs text-slate-500">
            {downloaded
              ? "XML gedownload. Markeer als verstuurd om deze regels grijs te maken."
              : "Geen ERPNext-write — XML wordt alleen lokaal gedownload."}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-50"
            >
              Annuleren
            </button>
            {!downloaded ? (
              <button
                onClick={handleDownload}
                disabled={!canGenerate}
                className="flex items-center gap-2 px-4 py-1.5 text-sm bg-teal-600 text-white rounded hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Download size={14} /> Genereer XML
              </button>
            ) : (
              <button
                onClick={handleMarkPaid}
                className="flex items-center gap-2 px-4 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700"
              >
                <CheckCircle2 size={14} /> Markeer als verstuurd
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
