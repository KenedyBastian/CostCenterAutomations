# Cost Center Automations

Automates GitHub Enterprise cost-center setup: one cost center per organization, populated with that organization's members.

## Files

| File | Purpose |
|---|---|
| `org-cost-centers.mjs` | The script (single file, no dependencies) |
| `orgs.example.txt` | Example organization list; copy to `orgs.txt` |
| `org-cost-centers.test.mjs` | Offline tests (`node --test`); no GitHub access needed |

## Quick start

```bash
cp orgs.example.txt orgs.txt          # edit with your organization logins
export GITHUB_TOKEN=<token> GHE_ENTERPRISE=<enterprise-slug>
node org-cost-centers.mjs --orgs-file orgs.txt           # preview
node org-cost-centers.mjs --orgs-file orgs.txt --apply   # apply
```

---

## About `org-cost-centers.mjs`

`org-cost-centers.mjs` is a single, dependency-free script. It creates one GitHub Enterprise **cost center for each organization** and adds that organization's **members to it as users**.

## What it does

For each organization you list, the script:

1. **Finds or creates a cost center** named after the organization (for example, `my-org`). If an active cost center with that exact name already exists, the script reuses it. `--name-prefix "CC - "` changes the name to `CC - my-org`.
2. **Reads every member** of the organization, across all pages of results.
3. **Checks each member's current cost-center assignment.**
4. **Sorts each member into one of these groups:**

   | Situation | What the script does |
   |---|---|
   | Not in any cost center | **Adds** them to their organization's cost center |
   | Already in the correct cost center | Leaves them as they are (`alreadyAssigned`) |
   | In a different cost center | **Skips** them and reports a conflict; they are never moved |
   | Member of more than one listed organization | **Skips** them and reports a conflict for you to assign manually |

5. **Prints a JSON report** of the cost centers, additions, skips and any errors.

## Safety rules

- **By default it only previews.** Nothing changes unless you add `--apply`.
- **It never removes users** from a cost center.
- **It never reassigns users** who are already in another cost center.
- **It adds users one at a time and stops at the first error** or at the first reassignment GitHub reports.
- **Running it again is safe.** It creates nothing twice and adds only new members.
- It exits with code `1` if anything failed, so scheduled runs can detect problems.

## Requirements

- **Node.js 20 or later.** No `npm install` is needed.
- A **classic personal access token** from an **enterprise owner or billing manager** with these scopes:
  - `manage_billing:enterprise` (or `admin:enterprise`)
  - `read:org`
- **SAML single sign-on:** if your organizations enforce SAML, go to GitHub **Settings → Developer settings → Personal access tokens (classic)**, open the token, choose **Configure SSO**, and **Authorize** it for each organization. Without this, the script fails with `403 Resource protected by organization SAML enforcement`.

## How to run it

```bash
export GITHUB_TOKEN=<token>                 # do not store the token in files
export GHE_ENTERPRISE=<enterprise-slug>     # from https://github.com/enterprises/<slug>
# export GITHUB_API_URL=https://api.<subdomain>.ghe.com   # only for GHE.com

# 1. Preview (makes no changes)
node org-cost-centers.mjs --org org-a --org org-b

# 2. Review the output, then apply
node org-cost-centers.mjs --org org-a --org org-b --apply
```

### Options

| Option | Description |
|---|---|
| `--org ORG` | Organization login. Repeat the option, or separate several names with commas. |
| `--orgs-file FILE` | File with one organization per line (`#` comments allowed), or a JSON array such as `["org-a", "org-b"]` |
| `--name-prefix TEXT` | Optional prefix for cost-center names |
| `--apply` | Make the changes. Without it, the script only previews. |
| `--help` | Show usage |

Example `orgs.txt`:

```text
# Organizations to map
org-a
org-b
```

## Reading the output

| Field | Meaning |
|---|---|
| `mode` | `dry-run` or `apply` |
| `costCenters` | Each cost center's name and ID. Status is `exists`, `to-create` or `created`. |
| `additions` | Users who will be added (in a preview) |
| `added` | Users who were actually added (with `--apply`) |
| `alreadyAssigned` | Users already in the correct cost center |
| `conflicts` | Users who were skipped, and why. Handle these manually. |
| `warnings` / `errors` | Problems found. The script stops at the first one. |

Keep the output from each `--apply` run as an audit record.

## Recommended process

1. Run a preview and review `costCenters`, `additions` and `conflicts`.
2. Resolve any conflicts you want handled differently, either in the GitHub billing settings or by changing the organization list.
3. Run with `--apply`.
4. Check the results in **Enterprise → Billing and licensing → Cost centers**.
5. Optionally, schedule repeat runs to pick up new organization members.

## What it doesn't do

- It doesn't create or change **budgets**; set those for each cost center in the GitHub billing settings.
- It doesn't remove users who have left an organization; clean those up manually.
- It assigns only individual **users**, not teams, organizations or repositories.

## Troubleshooting

| Error | Fix |
|---|---|
| `Set GITHUB_TOKEN and GHE_ENTERPRISE` | Export both environment variables. |
| `403 ... SAML enforcement` | Authorize the token for the organization using **Configure SSO**. |
| `404` on cost-center endpoints | Check the enterprise slug and that the token belongs to an enterprise owner or billing manager with the required scopes. |
| `More than one active cost center is named "..."` | Rename or delete the duplicate cost center, or use `--name-prefix`. |
