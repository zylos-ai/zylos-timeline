# Dev Plan: Migrate from Vercel to GitHub Pages (#308)

## Summary

Migrate zylos-timeline hosting from Vercel to GitHub Pages. Convert Next.js to static export, replace server-side search with client-side search, and set up GitHub Actions for automated deployment.

## Scope

**In scope:**
- Next.js static export configuration
- Search: server-side API route → client-side flexsearch/orama
- Sitemap/robots: dynamic → static generation
- GitHub Actions CI/CD workflow for GitHub Pages
- Custom domain configuration
- Vercel config cleanup

**Out of scope:**
- Content changes
- Design/UI changes
- i18n changes (already SSG-compatible)

## Development Checklist

### Phase 1: Static Export

- [ ] Add `output: 'export'` to `next.config.mjs`
- [ ] Add `images: { unoptimized: true }` to next config (required for static export, even though no next/image is used currently — prevents build errors)
- [ ] Remove `app/api/search/route.ts` (incompatible with static export)
- [ ] Convert `app/sitemap.ts` to generate static `sitemap.xml` at build time (use `generateSitemaps` or move to `public/` as build step)
- [ ] Convert `app/robots.ts` to static `public/robots.txt` or use `generateStaticParams` pattern
- [ ] Verify `next build` succeeds and produces `out/` directory
- [ ] Test locally: `npx serve out` — verify all pages render, both locales work

### Phase 2: Client-Side Search

- [ ] Install fumadocs client-side search dependency (flexsearch or orama)
- [ ] Configure fumadocs to use client-side search provider instead of server API
- [ ] Verify search works: type query → results appear, both en/zh content searchable
- [ ] Remove any remaining server-side search imports/config

### Phase 3: GitHub Actions + GitHub Pages

- [ ] Create `.github/workflows/deploy.yml`:
  - Trigger: push to main
  - Steps: checkout → setup Node → install deps → `next build` → upload artifact → deploy to GitHub Pages
- [ ] Enable GitHub Pages in repo settings (source: GitHub Actions)
- [ ] Configure custom domain in repo settings + CNAME file in `public/`
- [ ] Verify deployment: push to main → Actions runs → site updates

### Phase 4: Cleanup

- [ ] Remove `vercel.json` if present
- [ ] Remove any Vercel-specific env vars or config references
- [ ] Update README with new deployment instructions
- [ ] Verify Vercel can be disconnected/paused

## Test Checklist

- [ ] `next build` produces `out/` with no errors
- [ ] All pages render correctly (spot check: homepage, timeline, research articles, both locales)
- [ ] Client-side search returns results for known content
- [ ] Google Analytics still fires (check network tab)
- [ ] GitHub Actions workflow completes successfully
- [ ] Site accessible via custom domain with HTTPS

## Acceptance Checklist

- [ ] `npm run build` succeeds with static export
- [ ] `out/` directory contains complete site (both locales, all research articles)
- [ ] Search works client-side
- [ ] GitHub Actions deploys on push to main
- [ ] Custom domain with HTTPS works
- [ ] Vercel deployment can be deactivated
