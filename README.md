# Y-app Extension: Coöp Penningmeester Dashboard

Dashboard voor 3BM Coöperatie U.A. administratie:
- Openstaande verkoopfacturen + drafts + niet-verrekende creditnota's
- Openstaande inkoopfacturen
- Inkoopfacturen zonder PDF-bijlage
- Niet-gekoppelde Payment Entries

Bedrijf en jaar zijn instelbaar; default = 3BM Coöperatie U.A. + huidig jaar.

## Architectuur

Iframe-extensie voor [Y-app](https://github.com/OpenAEC-Foundation/Y-app). Praat met
ERPNext via de postMessage RPC-bridge in `packages/frontend/src/components/ExtensionHost.tsx`
— de extensie heeft zelf geen ERPNext-credentials. Elke RPC-aanroep wordt
in de Y-app parent-context uitgevoerd via de geauthenticeerde sessie.

## Lokaal draaien

```
cd extensions/coop-admin
npm install
npm run dev      # vite dev op http://localhost:5173
```

Voor lokaal testen in Y-app: open `Settings → Extensions → Advanced` en plak
`http://localhost:5173/` als extensie-URL. De Y-app iframe laadt 'm dan via
de RPC-bridge.

## Build

```
npm run build    # output: dist/
```

`vite.config.ts` gebruikt `base: "./"` zodat de bundle onder elke gehoste
URL werkt (GitHub Pages `/repo-name/`, root, file://, etc).

## Deploy via GitHub Pages

1. Maak een repo (bijv. `3BM/yapp-ext-coop-admin`) en push de inhoud
2. Enable GitHub Pages: Settings → Pages → Source = `GitHub Actions`
3. Push naar `main` triggert `.github/workflows/deploy.yml` (zie hieronder)
4. Live op `https://<owner>.github.io/<repo>/`
5. Voeg URL toe in Y-app: Settings → Extensions → Advanced

## Catalog-entry (optioneel)

Om de extensie 1-klik installeerbaar te maken in Y-app, voeg toe aan
`packages/frontend/src/extensions/catalog.ts`:

```ts
{
  id: "coop-admin",
  name: "Coöp Penningmeester",
  description: "Dashboard voor 3BM Coöperatie U.A. administratie.",
  url: "https://<owner>.github.io/yapp-ext-coop-admin/",
  sidebarSection: "Boekhouding",
  visibility: "employer",
  author: "3BM",
}
```

## Permissies

ERPNext-rol vereist: `Accounts User` of hoger (voor Sales/Purchase Invoice/
Payment Entry/File doctypes). Geen schrijfacties — alleen reads.
