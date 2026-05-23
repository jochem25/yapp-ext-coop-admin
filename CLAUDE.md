# Coöp Penningmeester — Y-app extensie

Iframe-extensie voor [Y-app](https://github.com/OpenAEC-Foundation/Y-app): een
penningmeester-dashboard voor 3BM Coöperatie U.A.

**Taal:** Nederlands

## Wat het is

Geen losse app — een iframe-extensie die binnen Y-app draait en met ERPNext praat
via Y-app's postMessage RPC-bridge (`src/yapp-bridge.ts`). De extensie heeft
**zelf geen ERPNext-credentials**; elke RPC draait in de geauthenticeerde Y-app
parent-sessie.

Drie tabs: **Overzicht** (`App.tsx`, klikbare statkaarten + drill-down),
**Grootboek mutaties** (`LedgerChart.tsx`), **Uitgaven** (`ExpensesTable.tsx`).

## Tech stack

React 19 · TypeScript 6 · Vite 8 · TailwindCSS 4 · lucide-react. Geen backend,
geen tests. Build: `npm run build` (`tsc -b && vite build` → `dist/`).

## Harde constraints

- **Geen eigen ERPNext-credentials** — alles via de RPC-bridge, niet omzeilen.
- **Alleen reads** — geen `updateDocument`/`createDocument` zonder expliciet
  akkoord. Dit is een overzichtstool, geen invoertool.
- **`base: "./"` in `vite.config.ts` behouden** — anders breekt de Pages-deploy.
- Nieuwe RPC-methods moeten in Y-app's `ExtensionHost.tsx` DISPATCH-map staan.

## Lokaal draaien

```
npm install
npm run dev      # Vite op http://localhost:5173
```

Testen in Y-app: Settings → Extensions → Advanced → plak de dev-URL.

## Deploy

Push naar `main` triggert `.github/workflows/deploy.yml` → GitHub Pages
(~1 min). Live: https://jochem25.github.io/yapp-ext-coop-admin/. Push naar
`main` is bewust direct toegestaan (deploy is het doel).

## Agent Broker

Deze extensie maakt deel uit van de 3BM Bouwkunde Claude Code orchestrator.
Registreer bij sessie-start bij de message broker.

- **project_id:** `yapp-ext-coop-admin`
- **display_name:** `Coöp Penningmeester`
- **capabilities:** `["y-app-extensie", "erpnext-readonly", "typescript", "react", "dashboard"]`
- **subscriptions:** `["erpnext/*", "shared/*", "y-app/*"]`

## Orchestrator

Sessie-conventies voor de 3BM Bouwkunde orchestrator:

- **Sessie START** → lees `X:\10_3BM_bouwkunde\50_Claude-Code-Projects\lessons_learned_global.md`
  en `~/.claude/orchestrator/sessions/yapp-ext-coop-admin_latest.md`,
  dan `broker_register()` met de Agent Broker-waarden hierboven en `broker_poll()`.
- **Sessie EINDE** → append een samenvatting aan
  `~/.claude/orchestrator/sessions/yapp-ext-coop-admin_latest.md`, en draai daarna
  `& "Z:\50_projecten\7_3BM_bouwkunde\_claude_sessions\sync-session.ps1"` zodat
  recap + CC-transcript naar de share gaan (cross-PC zichtbaar).
- **Registry:** `~/.claude/orchestrator/project-registry.json` (entry `yapp-ext-coop-admin`).
- **Cross-project context:** `~/.claude/orchestrator/context/yapp-ext-coop-admin.md`.
- **Multi-PC let op:** `~` resolvt per machine (LT01 = `C:\Users\Joche\`, werk-PC = `C:\Users\JochemK\`); gebruik géén hardcoded user-paden.
- **Host-project:** zie `context/y-app.md` — bridge-protocol moet synchroon blijven
  met Y-app's `ExtensionHost.tsx`.
