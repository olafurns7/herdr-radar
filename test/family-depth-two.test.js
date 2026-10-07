'use strict';

// Families two levels deep: the hub (the repo's main checkout) holds each
// token root cut from it, and each root holds the workspaces whose
// parent_token names it.
//
//   hub
//   ├─ ox        <- linked worktree of hub, named by xa's and xb's parent_token
//   │  ├─ xa
//   │  └─ xb
//   └─ oy
//      └─ ya

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../lib/config');
const herdr = require('../lib/herdr');
const state = require('../lib/state');
const { Frame } = require('../lib/frame');
const { desiredOrder } = require('../lib/workspace-order');

const I = '​  ';

function settings(t, values) {
  const before = {};
  for (const key of Object.keys(values)) before[key] = config[key];
  Object.assign(config, values);
  t.after(() => Object.assign(config, before));
}

const ws = (id, parent, linked) => ({
  workspace_id: id,
  label: id,
  tokens: parent ? { taskr_parent: parent } : {},
  ...(linked === undefined
    ? {}
    : { worktree: { repo_key: '/trip/.git', repo_name: 'trip', is_linked_worktree: linked } }),
});

const hubList = () => [
  ws('hub', null, false),
  ws('ox', null, true),
  ws('oy', null, true),
  ws('xa', 'ox', true),
  ws('xb', 'ox', true),
  ws('ya', 'oy', true),
];

const sorted = (map) => [...map].sort(([a], [b]) => (a < b ? -1 : 1));

test('a token root keeps its checkout, its children stay under it', (t) => {
  settings(t, { parentToken: 'taskr_parent', parentLabelToken: '' });
  const { parents, worktrees } = state.worktreeParents(hubList());
  assert.deepEqual(sorted(parents), [
    ['ox', 'hub'],
    ['oy', 'hub'],
    ['xa', 'ox'],
    ['xb', 'ox'],
    ['ya', 'oy'],
  ]);
  assert.deepEqual(sorted(worktrees), [
    ['ox', 'trip'],
    ['oy', 'trip'],
  ]);
});

test('a checkout that is a token child itself holds no root', (t) => {
  settings(t, { parentToken: 'taskr_parent', parentLabelToken: '' });
  const list = [...hubList(), ws('boss')];
  list[0].tokens.taskr_parent = 'boss';
  const { parents } = state.worktreeParents(list);
  assert.deepEqual(sorted(parents), [
    ['hub', 'boss'],
    ['xa', 'ox'],
    ['xb', 'ox'],
    ['ya', 'oy'],
  ]);
});

test('a token chain or cycle stays depth one', (t) => {
  settings(t, { parentToken: 'taskr_parent', parentLabelToken: '' });
  const depth = (parents, id) => {
    let n = 0;
    for (let at = id; parents.has(at) && n < 10; at = parents.get(at)) n += 1;
    return n;
  };
  const cycle = state.worktreeParents([ws('hub', null, false), ws('a', 'b', true), ws('b', 'a', true)]);
  assert.deepEqual(sorted(cycle.parents), []);
  // p is a root with a link of its own: it floats, as before. q, the root at
  // the end of the chain, has none and keeps its checkout.
  const chain = state.worktreeParents([
    ws('hub', null, false),
    ws('c', 'p', true),
    ws('p', 'q', true),
    ws('q', null, true),
  ]);
  assert.deepEqual(sorted(chain.parents), [
    ['c', 'p'],
    ['q', 'hub'],
  ]);
  for (const id of ['c', 'p', 'q']) assert(depth(chain.parents, id) <= 1, id);
});

test('without parent_token the git tree is untouched', (t) => {
  settings(t, { parentToken: '', parentLabelToken: '' });
  const { parents, worktrees } = state.worktreeParents(hubList());
  assert.deepEqual(sorted(parents), [
    ['ox', 'hub'],
    ['oy', 'hub'],
    ['xa', 'hub'],
    ['xb', 'hub'],
    ['ya', 'hub'],
  ]);
  assert.equal(worktrees.size, 5);
});

async function draw(t, entries, tree) {
  settings(t, { worktreeMark: '*', groupGap: true });
  const sent = new Map();
  t.mock.method(herdr, 'reportMetadataAsync', async (pane, _source, tokens) => {
    sent.set(pane, tokens);
    return true;
  });
  const labels = new Map(entries.map((entry) => [entry.workspace, entry.workspace]));
  await state.writeGroups('test', entries, labels, new Set(), tree);
  return sent;
}

const family = new Map([
  ['ox', 'hub'],
  ['oy', 'hub'],
  ['xa', 'ox'],
  ['xb', 'ox'],
  ['ya', 'oy'],
]);
const shown = ['hub', 'ox', 'xa', 'xb', 'oy', 'ya'].map((id) => ({ workspace: id, pane: `${id}:p` }));

test('children of a nested root carry the outer stem, or blank under the last', async (t) => {
  const sent = await draw(t, shown, {
    parentOf: family,
    familyLabels: new Map([
      ['ox', 'ox'],
      ['oy', 'oy'],
    ]),
    indent: I,
  });
  const groups = Object.fromEntries([...sent].map(([pane, tokens]) => [pane.slice(0, -2), tokens.group]));
  assert.deepEqual(groups, {
    hub: 'hub',
    ox: `${I}├─ * ox`,
    xa: `${I}│  ├─ * xa`,
    xb: `${I}│  └─ * xb`,
    oy: `${I}└─ * oy`,
    ya: `${I}   └─ * ya`,
  });
  const gaps = [...sent].filter(([, tokens]) => tokens.gap).map(([pane]) => pane);
  assert.deepEqual(gaps, ['ya:p'], 'a spacer opened inside the family');
});

test('an orphaned root still indents its children past the corner', async (t) => {
  const entries = shown.filter((entry) => entry.workspace === 'ox' || entry.workspace === 'xa');
  const sent = await draw(t, entries, {
    parentOf: new Map([['xa', 'ox']]),
    orphanRepo: new Map([['ox', 'trip']]),
    familyLabels: new Map([['ox', 'ox']]),
    indent: I,
  });
  assert.equal(sent.get('ox:p').group, '└─ * ox');
  assert.equal(sent.get('ox:p').group_parent, 'trip');
  assert.equal(sent.get('xa:p').group, `${I}   └─ * xa`);
});

test('zero indent draws the nested family with marks and no corners', async (t) => {
  const sent = await draw(t, shown, {
    parentOf: family,
    familyLabels: new Map([
      ['ox', 'ox'],
      ['oy', 'oy'],
    ]),
    indent: '',
  });
  for (const id of ['ox', 'xa', 'xb', 'oy', 'ya']) assert.equal(sent.get(`${id}:p`).group, `* ${id}`);
  assert.deepEqual(
    [...sent].filter(([, tokens]) => tokens.gap).map(([pane]) => pane),
    ['ya:p'],
  );
});

test('a three-level family sorts as one block: hub, then each root with its children', (t) => {
  const frame = new Frame('test');
  // Scrambled list order; oy's family is the busiest, xb the busiest task.
  const ids = ['xa', 'oy', 'other', 'hub', 'xb', 'ya', 'ox'];
  const minute = { hub: 1, ox: 2, xa: 3, xb: 6, oy: 4, ya: 7, other: 5 };
  const entries = ids.map((id) => ({ workspace: id, pane: `${id}:p`, tab: `${id}:t` }));
  for (const id of ids) frame.lastWorkingAt.set(`${id}:p`, minute[id] * 60000);
  const keys = frame.sortKeys(entries, family, new Map(), new Map());
  const order = frame.displayOrder(entries, 'grouped', keys).map((entry) => entry.workspace);
  assert.deepEqual(order, ['hub', 'oy', 'ya', 'ox', 'xb', 'xa', 'other']);
  assert.deepEqual(
    ['hub', 'ox', 'xa'].map((id) => keys.nested(id)),
    [0, 1, 2],
  );
});

test('the Spaces reorder keeps each root ahead of its children', (t) => {
  settings(t, { parentToken: 'taskr_parent' });
  const current = ['xa', 'oy', 'other', 'hub', 'xb', 'ya', 'ox'];
  const keys = new Map([
    ['xa', '3'],
    ['other', '1'],
  ]);
  const once = desiredOrder(current, keys, family);
  assert.deepEqual(once, ['hub', 'oy', 'ya', 'ox', 'xa', 'xb', 'other']);
  assert.deepEqual(desiredOrder(once, keys, family), once);
});
