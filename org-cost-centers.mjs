#!/usr/bin/env node
/**
 * Standalone tool: creates one GitHub Enterprise cost center per organization
 * (named after the organization) and adds each organization's members to it.
 *
 * No dependencies; requires Node.js 20+. Runs as a dry run unless --apply is given.
 *
 * Environment:
 *   GITHUB_TOKEN        Enterprise owner or billing manager classic PAT with
 *                       manage_billing:enterprise and read:org scopes.
 *   GHE_ENTERPRISE      Enterprise slug.
 *   GITHUB_API_URL      Optional; e.g. https://api.SUBDOMAIN.ghe.com for GHE.com.
 *   GITHUB_API_VERSION  Optional; defaults to 2026-03-10.
 *
 * Usage:
 *   node org-cost-centers.mjs --org org-a --org org-b            # preview
 *   node org-cost-centers.mjs --orgs-file orgs.txt --apply       # create + add
 *   node org-cost-centers.mjs --org org-a --name-prefix "CC - "  # name "CC - org-a"
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const enc = encodeURIComponent;

export class GitHubApiError extends Error {
  constructor(status, message, apiPath) {
    super(message);
    this.status = status;
    this.path = apiPath;
  }
}

export class Client {
  constructor({ token, enterprise, apiUrl = 'https://api.github.com', apiVersion = '2026-03-10', fetchImpl = fetch, sleep }) {
    Object.assign(this, { token, enterprise, apiUrl: apiUrl.replace(/\/+$/, ''), apiVersion, fetch: fetchImpl });
    this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get ent() {
    return `/enterprises/${enc(this.enterprise)}/settings/billing/cost-centers`;
  }

  async request(method, apiPath, { query, body } = {}) {
    const url = new URL(this.apiUrl + apiPath);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': this.apiVersion,
          'User-Agent': 'org-cost-centers',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return res.status === 204 ? null : res.json();
      let message = res.statusText;
      try { message = (await res.json()).message || message; } catch { /* non-JSON body */ }
      const rateLimited = res.status === 429
        || (res.status === 403 && (res.headers?.get?.('retry-after') || /rate limit/i.test(message)));
      // Retry only reads so a write is never sent twice.
      if (rateLimited && method === 'GET' && attempt < 3) {
        await this.sleep(Math.min(Number(res.headers?.get?.('retry-after')) || 60, 300) * 1000);
        continue;
      }
      throw new GitHubApiError(res.status, message, apiPath);
    }
  }

  async listOrgMembers(org) {
    const members = [];
    for (let page = 1; ; page++) {
      const data = await this.request('GET', `/orgs/${enc(org)}/members`, { query: { per_page: 100, page } });
      if (!Array.isArray(data)) throw new Error(`Unsupported organization-members response for ${org}`);
      members.push(...data);
      if (data.length < 100) return members;
    }
  }

  async listActiveCostCenters() {
    const data = await this.request('GET', this.ent, { query: { state: 'active' } });
    if (!Array.isArray(data?.costCenters)) throw new Error('Unsupported cost-center response: missing costCenters');
    return data.costCenters;
  }

  createCostCenter(name) {
    return this.request('POST', this.ent, { body: { name } });
  }

  getUserMemberships(login) {
    return this.request('GET', `${this.ent}/memberships`, { query: { resource_type: 'user', name: login } });
  }

  addUser(costCenterId, login) {
    return this.request('POST', `${this.ent}/${enc(costCenterId)}/resource`, { body: { users: [login] } });
  }
}

export function parseOrgList(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : parsed.organizations;
    if (!Array.isArray(list)) throw new Error('JSON org file must be an array or contain an organizations array');
    return list.map((entry) => (typeof entry === 'string' ? entry : entry?.org));
  }
  return trimmed.split(/[\r\n,]+/).map((line) => line.replace(/#.*/, '').trim()).filter(Boolean);
}

function normalizeOrgs(orgs) {
  const seen = new Map();
  for (const raw of orgs) {
    const org = String(raw || '').trim();
    if (!ORG_RE.test(org)) throw new Error(`Invalid organization name: ${JSON.stringify(raw)}`);
    if (seen.has(org.toLowerCase())) throw new Error(`Organization listed more than once: ${org}`);
    seen.set(org.toLowerCase(), org);
  }
  if (!seen.size) throw new Error('At least one organization is required');
  return [...seen.values()];
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

function errorText(error) {
  return error.status ? `GitHub API ${error.status} at ${error.path || 'unknown endpoint'}: ${error.message}` : error.message;
}

export async function run(client, orgList, { apply = false, namePrefix = '' } = {}) {
  const orgs = normalizeOrgs(orgList);
  const result = {
    mode: apply ? 'apply' : 'dry-run',
    costCenters: [],
    additions: [],
    alreadyAssigned: [],
    conflicts: [],
    added: [],
    warnings: [],
    errors: [],
  };

  const byName = new Map();
  for (const center of await client.listActiveCostCenters()) {
    const key = String(center?.name || '').toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(center);
  }

  const targets = [];
  for (const org of orgs) {
    const name = `${namePrefix}${org}`;
    if (name.length > 255) throw new Error(`Cost-center name exceeds 255 characters: ${name}`);
    const matches = byName.get(name.toLowerCase()) || [];
    if (matches.length > 1) throw new Error(`More than one active cost center is named "${name}"; resolve this before running`);
    const target = { org, name, id: matches[0]?.id || null, status: matches.length ? 'exists' : 'to-create' };
    targets.push(target);
    result.costCenters.push({ ...target });
  }

  const desired = new Map();
  for (const target of targets) {
    for (const member of await client.listOrgMembers(target.org)) {
      if (typeof member?.login !== 'string' || !member.login) throw new Error(`Incomplete member list for ${target.org}`);
      const key = member.login.toLowerCase();
      const entry = desired.get(key) || { login: member.login, targets: [] };
      entry.targets.push(target);
      desired.set(key, entry);
    }
  }

  const additions = new Map(targets.map((t) => [t, []]));
  const eligible = [];
  for (const entry of desired.values()) {
    if (entry.targets.length > 1) {
      result.conflicts.push({
        login: entry.login,
        organizations: entry.targets.map((t) => t.org),
        reason: 'Member of more than one listed organization; assign manually',
      });
    } else {
      eligible.push(entry);
    }
  }
  const memberships = await mapLimit(eligible, 8, async (entry) => {
    const data = await client.getUserMemberships(entry.login);
    if (!Array.isArray(data?.memberships) || data.memberships.some((m) => typeof m?.cost_center?.id !== 'string')) {
      throw new Error(`Unsupported cost-center membership response for ${entry.login}`);
    }
    return { entry, centers: data.memberships.map((m) => m.cost_center) };
  });
  for (const { entry, centers } of memberships) {
    const [target] = entry.targets;
    const others = centers.filter((c) => c.id !== target.id);
    if (others.length) {
      result.conflicts.push({
        login: entry.login,
        organizations: [target.org],
        desiredCostCenter: target.name,
        existingCostCenters: centers.map((c) => c.name || c.id),
        reason: 'Already assigned to a different cost center; not changed',
      });
    } else if (centers.length) {
      result.alreadyAssigned.push({ login: entry.login, costCenter: target.name });
    } else {
      additions.get(target).push(entry.login);
    }
  }
  for (const [target, users] of additions) {
    if (users.length) result.additions.push({ org: target.org, costCenter: target.name, users: users.sort((a, b) => a.localeCompare(b)) });
  }
  const byLogin = (a, b) => a.login.localeCompare(b.login);
  result.alreadyAssigned.sort(byLogin);
  result.conflicts.sort(byLogin);
  if (!apply) return result;

  for (const target of targets) {
    if (target.id) continue;
    try {
      const created = await client.createCostCenter(target.name);
      if (typeof created?.id !== 'string') throw new Error(`Unsupported create response for cost center ${target.name}`);
      target.id = created.id;
      Object.assign(result.costCenters.find((c) => c.org === target.org), { id: created.id, status: 'created' });
    } catch (error) {
      result.errors.push({ costCenter: target.name, message: errorText(error) });
      return result;
    }
  }

  for (const [target, users] of additions) {
    for (const login of users) {
      try {
        const response = await client.addUser(target.id, login);
        result.added.push({ login, costCenter: target.name, costCenterId: target.id });
        if (response?.reassigned_resources?.length) {
          result.warnings.push({
            login,
            costCenter: target.name,
            reassignedResources: response.reassigned_resources,
            message: 'GitHub reported a reassignment from another cost center; review before re-running',
          });
          return result;
        }
      } catch (error) {
        result.errors.push({ login, costCenter: target.name, message: errorText(error) });
        return result;
      }
    }
  }
  return result;
}

function parseArgs(args) {
  const opts = { orgs: [], apply: false, namePrefix: '', help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--org' && args[i + 1]) opts.orgs.push(...parseOrgList(args[++i]));
    else if (arg === '--orgs-file' && args[i + 1]) opts.orgs.push(...parseOrgList(fs.readFileSync(args[++i], 'utf8')));
    else if (arg === '--name-prefix' && args[i + 1] !== undefined) opts.namePrefix = args[++i];
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  return opts;
}

const HELP = `Usage: node org-cost-centers.mjs (--org ORG ... | --orgs-file FILE) [--name-prefix TEXT] [--apply]

Creates an active cost center named after each organization (if one does not
already exist) and adds the organization's members to it as users.

  --org ORG            Organization login; repeat or comma-separate for several.
  --orgs-file FILE     One org per line (# comments allowed), or JSON:
                       ["org-a", "org-b"] or {"organizations":[{"org":"org-a"}]}
  --name-prefix TEXT   Optional prefix for cost-center names (default: none).
  --apply              Make changes. Without it the script only previews.

Users already in another cost center, or in more than one listed org, are
reported as conflicts and skipped. The script never removes users.
Requires GITHUB_TOKEN and GHE_ENTERPRISE (and GITHUB_API_URL for GHE.com).`;

export async function main(args = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(args);
  if (opts.help) return console.log(HELP);
  if (!opts.orgs.length) throw new Error('Provide --org or --orgs-file (see --help)');
  if (!env.GITHUB_TOKEN || !env.GHE_ENTERPRISE) throw new Error('Set GITHUB_TOKEN and GHE_ENTERPRISE in the environment');
  const client = new Client({
    token: env.GITHUB_TOKEN,
    enterprise: env.GHE_ENTERPRISE,
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    apiVersion: env.GITHUB_API_VERSION || '2026-03-10',
  });
  const result = await run(client, opts.orgs, opts);
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length || result.warnings.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(errorText(error));
    process.exitCode = 1;
  });
}
