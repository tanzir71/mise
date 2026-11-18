# Prompt 4 — Deploy your own copy of Mise to Vercel (for the shop owner's AI agent)

Shop owners paste this into Claude Code, Codex or any agent that can run commands on their computer. It's also linked from the setup page (`/setup/#vercel`).

---

You are deploying the Mise web app (landing page + app) from the owner's GitHub fork to **their own Vercel account**. Work carefully, explain each step in one line, and **ask before anything that costs money or deletes something**.

**Inputs to ask for if missing:**
- the fork URL, e.g. `https://github.com/<owner>/mise`
- the project name (default `mise-<shopname>`)
- whether they want a custom domain

1. **Check tools.** `git`, Node 22.12+ and `pnpm` are needed. If `pnpm` is missing: `corepack enable && corepack prepare pnpm@latest --activate`.
2. **Get the code.** `git clone <fork> && cd mise`.
3. **Build locally first.** Run `pnpm install --frozen-lockfile`, then `BASE_PATH=/ PUBLIC_APP_URL=/app/ pnpm build`. Confirm `site/index.html` and `site/app/index.html` exist. If the build fails, stop and show the error.
4. **Vercel CLI.**
   - `npm i -g vercel` (or use `npx vercel`).
   - `vercel login`: the owner approves in their browser. Never ask for or handle their password.
5. **Link the project.** Run `vercel link --yes --project <project-name>`. This creates the project if it doesn't exist (free Hobby plan unless the owner chooses otherwise). The repo's `vercel.json` already sets the install command, the build command (with `BASE_PATH=/`), the output folder `site` and the app routing.
6. **Environment variables.** Add only what exists for the current version, using `vercel env add <NAME> production`:
   - `PUBLIC_WHATSAPP_URL` (optional, the shop's `wa.me` link) or `PUBLIC_DEMO_URL`
   - `PUBLIC_GEO_URL` (optional country lookup for the landing page)
   - from v0.4 (sync): `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` from the owner's own Supabase project. Help them create it if they ask. Never put a `service_role` key in Vercel public env vars.
7. **Deploy.** Run `vercel deploy --prod`. Open the URL and check `/`, `/app/` and `/setup/`. From M10, the local app includes shop setup, settings and navigation. Complete setup, then reload `/app/` offline to confirm its shell cache. Counter, orders and stock follow in their milestones; installation and storage-persistence polish is M18.
8. **Connect Git for automatic updates** (recommended): `vercel git connect`, or in the Vercel dashboard → Project → Git. Every push to the fork's `main` then redeploys.
9. **Custom domain** (optional): `vercel domains add <domain>`, then show the DNS records the owner must add at their registrar.
10. **Hand back:**
    - the production URL
    - how to update: on GitHub, "Sync fork" with the upstream Mise repo; Vercel redeploys automatically
    - how to roll back: Vercel dashboard → Deployments → Promote a previous one
    - which env vars were set (names only)

**Rules:**
- Don't change application code to make the deploy pass. If the build fails, report it and suggest opening an issue on the upstream repo.
- Don't create paid resources, teams or domains without an explicit yes.
- Don't print secrets back in chat.
