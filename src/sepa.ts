/**
 * SEPA Credit Transfer (pain.001.001.09) generator + IBAN validation.
 *
 * Reference XML structure based on a real Bunq batch:
 *   InitgPty + GrpHdr (1x), PmtInf (1x per uitvoerdatum),
 *   CdtTrfTxInf (1x per crediteur-transactie).
 *
 * Geen externe XML-lib: simpele template + escape, scheelt 30kb in de bundle.
 */

const SEPA_NS = "urn:iso:std:iso:20022:tech:xsd:pain.001.001.09";

export interface SepaTransaction {
  endToEndId: string;       // bijv. "EBTR1"
  amountEur: number;        // 1216.05 — wordt op .00 afgerond met `.` als decimaal
  creditorName: string;     // wordt ASCII-genormalized
  creditorIban: string;     // spaties + lowercase worden gestript
  creditorBic?: string;     // optioneel (modern SEPA hoeft binnen EU geen BIC)
  remittanceInfo: string;   // bijv. "Factuur: 267-00169"
}

export interface SepaPayload {
  initiatingPartyName: string;
  messageId: string;             // unieke ID, max 35 chars
  creationDateTime: string;      // ISO "2026-05-23T10:47:00"
  requestedExecutionDate: string; // "YYYY-MM-DD"
  paymentInfoId: string;         // bijv. "BATCH20983"
  debtorName: string;
  debtorIban: string;
  debtorBic?: string;
  transactions: SepaTransaction[];
}

// ----- IBAN -----

export function stripIban(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/**
 * IBAN validatie via mod-97 = 1. Lengte 15-34.
 * Zie ISO 13616.
 */
export function isValidIban(raw: string): boolean {
  const iban = stripIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  return modulo97FromAlphaNumeric(rearranged) === 1;
}

function modulo97FromAlphaNumeric(input: string): number {
  let remainder = "";
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    remainder += code >= 65 ? String(code - 55) : ch;
    if (remainder.length >= 9) {
      remainder = String(parseInt(remainder, 10) % 97);
    }
  }
  return parseInt(remainder, 10) % 97;
}

// ----- ASCII normalize -----

/**
 * SEPA Nm/Ustrd velden accepteren ASCII + beperkte interpunctie.
 * Diacrieten worden ge-NFKD'd, combining marks gestript, overige rommel vervangen door spatie.
 * Resultaat wordt ook getrimd en gecapt op `maxLen`.
 */
export function asciiNormalize(input: string, maxLen = 140): string {
  const decomposed = input.normalize("NFKD");
  const stripped = decomposed.replace(/[̀-ͯ]/g, "");
  const replaced = stripped.replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, " ");
  return replaced.replace(/\s+/g, " ").trim().slice(0, maxLen);
}

// ----- XML helpers -----

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function fmtAmount(n: number): string {
  // SEPA wil punt als decimaalseparator, max 2 decimalen
  return n.toFixed(2);
}

// ----- generate -----

export function generateSepaXml(p: SepaPayload): string {
  const totalAmount = p.transactions.reduce((s, t) => s + t.amountEur, 0);
  const nbTx = p.transactions.length;

  const dbtrAgt = p.debtorBic
    ? `      <DbtrAgt>
        <FinInstnId>
          <BICFI>${escapeXml(p.debtorBic)}</BICFI>
        </FinInstnId>
      </DbtrAgt>
`
    : "";

  const txBlocks = p.transactions
    .map((t) => {
      const cdtrAgt = t.creditorBic
        ? `        <CdtrAgt>
          <FinInstnId>
            <BICFI>${escapeXml(t.creditorBic)}</BICFI>
          </FinInstnId>
        </CdtrAgt>
`
        : "";
      return `      <CdtTrfTxInf>
        <PmtId>
          <EndToEndId>${escapeXml(t.endToEndId)}</EndToEndId>
        </PmtId>
        <Amt>
          <InstdAmt Ccy="EUR">${fmtAmount(t.amountEur)}</InstdAmt>
        </Amt>
${cdtrAgt}        <Cdtr>
          <Nm>${escapeXml(asciiNormalize(t.creditorName, 70))}</Nm>
        </Cdtr>
        <CdtrAcct>
          <Id>
            <IBAN>${escapeXml(stripIban(t.creditorIban))}</IBAN>
          </Id>
        </CdtrAcct>
        <RmtInf>
          <Ustrd>${escapeXml(asciiNormalize(t.remittanceInfo, 140))}</Ustrd>
        </RmtInf>
      </CdtTrfTxInf>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="${SEPA_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${escapeXml(p.messageId)}</MsgId>
      <CreDtTm>${escapeXml(p.creationDateTime)}</CreDtTm>
      <NbOfTxs>${nbTx}</NbOfTxs>
      <CtrlSum>${fmtAmount(totalAmount)}</CtrlSum>
      <InitgPty>
        <Nm>${escapeXml(asciiNormalize(p.initiatingPartyName, 70))}</Nm>
      </InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${escapeXml(p.paymentInfoId)}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <BtchBookg>true</BtchBookg>
      <NbOfTxs>${nbTx}</NbOfTxs>
      <CtrlSum>${fmtAmount(totalAmount)}</CtrlSum>
      <PmtTpInf>
        <SvcLvl>
          <Cd>SEPA</Cd>
        </SvcLvl>
      </PmtTpInf>
      <ReqdExctnDt>
        <Dt>${escapeXml(p.requestedExecutionDate)}</Dt>
      </ReqdExctnDt>
      <Dbtr>
        <Nm>${escapeXml(asciiNormalize(p.debtorName, 70))}</Nm>
      </Dbtr>
      <DbtrAcct>
        <Id>
          <IBAN>${escapeXml(stripIban(p.debtorIban))}</IBAN>
        </Id>
      </DbtrAcct>
${dbtrAgt}      <ChrgBr>SLEV</ChrgBr>
${txBlocks}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>`;
}

// ----- id helpers -----

export function buildMessageId(prefix: string): string {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
  return `${prefix}-${dd}${mm}${yyyy}-${hh}:${mi}:${ss}-${rand}`.slice(0, 35);
}

export function buildPaymentInfoId(): string {
  return `BATCH${Math.floor(Math.random() * 90000) + 10000}`;
}

export function nowIsoSeconds(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
