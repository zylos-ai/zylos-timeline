# Dev Plan: Migrate from Vercel to GitHub Pages (#308)

## Summary

Migrate zylos-timeline hosting from Vercel to GitHub Pages. Convert Next.js to static export, replace server-side search with client-side search, and set up GitHub Actions for automated deployment.

## Scope

**In scope:**
- Next.js static export configuration (resolving all build blockers)
- Search: server-side API route → client-side static search index
- Sitemap/robots: dynamic metadata routes → static export compatible
- Root layout i18n fix (remove `getLocale()` headers() dependency)
- GitHub Actions CI/CD workflow for GitHub Pages
- Custom domain configuration
- Vercel config cleanup

**Out of scope:**
- Content changes, design/UI changes
- i18n locale additions (en/zh already defined)

## Development Checklist

### Phase 1: Static Export (resolve build blockers)

- [ ] Add `output: 'export'` and `images: { unoptimized: true }` to `next.config.mjs`
- [ ] **Fix root layout i18n blocker**: `app/layout.tsx` imports `getLocale` from `next-intl/server` and calls `await getLocale()` — this triggers `headers()` which blocks static export. Remove `getLocale()` from root layout; locale is already handled by `[locale]/layout.tsx` via `setRequestLocale()` + `generateStaticParams()`. Root `<html lang>` can use a hardcoded default or be moved into `[locale]/layout.tsx`.
- [ ] **Fix sitemap blocker**: `app/sitemap.ts` is a dynamic metadata route. Either add `export const dynamic = 'force-static'` and verify `out/sitemap.xml` is generated, or convert to a build script that generates `public/sitemap.xml`. Sitemap should include both default and zh locale URLs.
- [ ] **Fix robots blocker**: `app/robots.ts` same issue. Add `export const dynamic = 'force-static'` or convert to static `public/robots.txt`.
- [ ] Remove `app/api/search/route.ts` (incompatible with static export)
- [ ] Verify `npm run build` succeeds and produces `out/` directory

### Phase 2: Client-Side Search

- [ ] Choose static search provider: fumadocs supports `flexsearchStaticClient` or `oramaStaticClient`
- [ ] Generate static search index at build time: configure fumadocs to output search index file (e.g. `public/search.json` or per-locale `public/search/{locale}.json`). May need a build script or fumadocs config.
- [ ] Wire `<RootProvider>` with static search client: pass `search` config using the static client pointing to the generated index file (not `/api/search`)
- [ ] Verify search works: open browser, type query, check Network tab — requests should hit the static JSON index, NOT `/api/search`
- [ ] Verify both en and zh content are searchable

### Phase 3: GitHub Actions + GitHub Pages

- [ ] Create `.github/workflows/deploy.yml`:
  - Trigger: push to main
  - Steps: checkout → setup Node → install deps → `npm run build` → upload `out/` artifact → deploy to GitHub Pages
- [ ] Enable GitHub Pages in repo settings (source: GitHub Actions)
- [ ] Add `CNAME` file in `public/` with the custom domain
- [ ] Configure custom domain DNS (CNAME or A records pointing to GitHub Pages)
- [ ] Verify deployment: push to main → Actions runs → site updates

### Phase 4: Cleanup

- [ ] Remove `vercel.json` if present
- [ ] Remove any Vercel-specific env vars or config references
- [ ] Update README with new deployment instructions

## Test Checklist

- [ ] `npm run build` produces `out/` with no errors
- [ ] File-level locale coverage checks:
  - `test -f out/index.html`
  - `test -f out/zh/index.html`
  - `test -f out/research/index.html`
  - `test -f out/zh/research/index.html`
  - Spot-check a research article: `test -f out/research/<slug>/index.html` and `out/zh/research/<slug>/index.html`
- [ ] `out/sitemap.xml` exists and contains both default and zh locale URLs
- [ ] `out/robots.txt` exists
- [ ] Client-side search: browser Network tab shows requests to static JSON index (not `/api/search`); results appear for both en and zh queries
- [ ] Google Analytics script still present in page source
- [ ] GitHub Actions workflow completes successfully

## Acceptance Checklist

- [ ] `npm run build` succeeds with `output: 'export'`
- [ ] `out/` contains both locale trees (default + zh), verified by file checks above
- [ ] `out/sitemap.xml` includes both locale URLs (or documented decision to use canonical only)
- [ ] Search works client-side (no `/api/search` requests in Network tab)
- [ ] GitHub Actions deploys on push to main
- [ ] Custom domain with HTTPS works
- [ ] Vercel deployment can be deactivated
