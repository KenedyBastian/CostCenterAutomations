import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, parseOrgList, run } from './org-cost-centers.mjs';

function fakeApi({ centers = [], members = {}, memberships = {} }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, pathname, body });
    const json = (data) => ({ ok: true, status: 200, json: async () => data });
    if (init.method === 'GET' && pathname.endsWith('/cost-centers')) return json({ costCenters: centers });
    if (init.method === 'POST' && pathname.endsWith('/cost-centers')) return json({ id: `id-${body.name}`, name: body.name });
    if (pathname.endsWith('/memberships')) {
      return json({ memberships: (memberships[searchParams.get('name')] || []).map((c) => ({ cost_center: c })) });
    }
    if (pathname.endsWith('/resource')) return json({ message: 'ok' });
    const org = pathname.match(/^\/orgs\/([^/]+)\/members$/)?.[1];
    if (org) return json(searchParams.get('page') === '1' ? (members[org] || []).map((login) => ({ login })) : []);
    throw new Error(`Unexpected ${init.method} ${pathname}`);
  };
  return { calls, client: new Client({ token: 't', enterprise: 'ent', fetchImpl }) };
}

const scenario = {
  centers: [{ id: 'cc-a', name: 'org-a' }, { id: 'cc-x', name: 'other' }],
  members: { 'org-a': ['alice', 'shared', 'done'], 'org-b': ['bob', 'shared', 'taken'] },
  memberships: { done: [{ id: 'cc-a', name: 'org-a' }], taken: [{ id: 'cc-x', name: 'other' }] },
};

test('dry run plans cost-center creation and additions without writing', async () => {
  const { client, calls } = fakeApi(scenario);
  const result = await run(client, ['org-a', 'org-b']);
  assert.deepEqual(result.costCenters.map((c) => [c.name, c.status]), [['org-a', 'exists'], ['org-b', 'to-create']]);
  assert.deepEqual(result.additions, [
    { org: 'org-a', costCenter: 'org-a', users: ['alice'] },
    { org: 'org-b', costCenter: 'org-b', users: ['bob'] },
  ]);
  assert.deepEqual(result.alreadyAssigned, [{ login: 'done', costCenter: 'org-a' }]);
  assert.deepEqual(result.conflicts.map((c) => c.login), ['shared', 'taken']);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('apply creates only missing cost centers, then adds users one at a time', async () => {
  const { client, calls } = fakeApi(scenario);
  const result = await run(client, ['org-a', 'org-b'], { apply: true, namePrefix: '' });
  const posts = calls.filter((c) => c.method === 'POST');
  assert.deepEqual(posts.map((c) => c.body), [{ name: 'org-b' }, { users: ['alice'] }, { users: ['bob'] }]);
  assert.equal(posts[2].pathname, '/enterprises/ent/settings/billing/cost-centers/id-org-b/resource');
  assert.equal(result.costCenters[1].status, 'created');
  assert.deepEqual(result.added.map((a) => a.login), ['alice', 'bob']);
  assert.deepEqual(result.errors, []);
});

test('name prefix is applied and duplicate active names are rejected', async () => {
  const { client } = fakeApi({ centers: [{ id: '1', name: 'CC org-a' }, { id: '2', name: 'cc ORG-A' }] });
  await assert.rejects(run(client, ['org-a'], { namePrefix: 'CC ' }), /More than one active cost center/);
});

test('org lists accept lines, comments, commas, and JSON', () => {
  assert.deepEqual(parseOrgList('org-a # main\n\norg-b,org-c\n'), ['org-a', 'org-b', 'org-c']);
  assert.deepEqual(parseOrgList('{"organizations":[{"org":"org-a","costCenterId":"x"}]}'), ['org-a']);
});
