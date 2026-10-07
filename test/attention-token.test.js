'use strict';

// attention_token: another plugin flags a pane whose agent waits on its owner
// (taskr publishes `taskr_owner_ask=<n>`), and the row reads as Herdr's own
// blocked state while Herdr itself reports the agent idle or done.

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../lib/config');
const herdr = require('../lib/herdr');
const state = require('../lib/state');
const { Frame } = require('../lib/frame');

const NOW = 10 * 60 * 60000;

function attention(t, name) {
  const before = config.attentionToken;
  config.attentionToken = name;
  t.after(() => {
    config.attentionToken = before;
  });
}

const agent = (pane, status, tokens) => ({
  pane_id: pane,
  agent_status: status,
  agent: 'claude',
  workspace_id: 'w',
  tab_id: 't',
  title: pane,
  tokens,
});

const listing = () => [
  agent('ask', 'idle', { taskr_owner_ask: '2' }),
  agent('object', 'done', { taskr_owner_ask: { value: '1' } }),
  agent('zero', 'idle', { taskr_owner_ask: '0' }),
  agent('empty', 'idle', { taskr_owner_ask: '' }),
  agent('none', 'idle', {}),
];

async function flags(t) {
  t.mock.method(herdr, 'agentsAsync', async () => listing());
  return Object.fromEntries((await state.snapshot()).map((entry) => [entry.pane, entry.attention]));
}

test('the token flags a pane only for a count above zero', async (t) => {
  attention(t, 'taskr_owner_ask');
  assert.deepEqual(await flags(t), { ask: true, object: true, zero: false, empty: false, none: false });
});

test('without attention_token no pane is flagged', async (t) => {
  attention(t, '');
  assert.deepEqual(await flags(t), { ask: false, object: false, zero: false, empty: false, none: false });
});

// A frame that already knows the pane, so nothing is recovered from disk.
function frameFor(pane) {
  const frame = new Frame('test');
  frame.lastWorkingAt.set(pane, NOW - 60000);
  frame.recovered.add(pane);
  return frame;
}

const entry = (status, flagged) => ({
  pane: 'p',
  workspace: 'w',
  tab: 't',
  name: 'claude',
  status,
  attention: flagged,
});

test('an owner ask shows blocked while Herdr says idle or done', () => {
  for (const status of ['idle', 'done']) {
    assert.equal(frameFor('p').displayFor(entry(status, true), NOW, []), 'blocked', status);
  }
});

test('a cleared ask returns the pane to what Herdr says', () => {
  const frame = frameFor('p');
  const plain = frameFor('p').displayFor(entry('idle', false), NOW, []);
  assert.notEqual(plain, 'blocked');
  assert.equal(frame.displayFor(entry('idle', true), NOW, []), 'blocked');
  assert.equal(frame.displayFor(entry('idle', false), NOW + 1000, []), plain);
});

test('a flagged pane draws the blocked title and pulse', async (t) => {
  const sent = {};
  t.mock.method(herdr, 'reportMetadataAsync', async (_pane, _source, tokens) => {
    Object.assign(sent, tokens);
    return true;
  });
  const frame = frameFor('p');
  const flagged = { ...entry('idle', true), title: 'waiting' };
  const deadlines = [];
  const display = frame.displayFor(flagged, NOW, deadlines);
  const keys = { minuteKey: () => null, wsKeys: new Map(), tabKeys: new Map() };
  const jobs = [];
  frame.paneJobs(flagged, display, { tabs: new Map(), keys, indent: '', spinStep: 0 }, NOW, deadlines, jobs);
  await Promise.all(jobs);
  assert(sent.title_blocked, 'no blocked title');
  assert.equal(sent.title_idle ?? null, null);
  assert(
    deadlines.some((at) => at > NOW),
    'no pulse deadline',
  );
});

test("the workspace's Spaces mark becomes blocked", async (t) => {
  const sent = {};
  t.mock.method(herdr, 'reportWorkspaceMetadataAsync', async (_ws, _source, tokens) => {
    Object.assign(sent, tokens);
    return true;
  });
  const frame = frameFor('p');
  const display = frame.displayFor(entry('idle', true), NOW, []);
  const jobs = [];
  const agents = new Map([
    [
      'w',
      [
        { display, name: 'claude' },
        { display: 'idle', name: 'codex' },
      ],
    ],
  ]);
  frame.spaceJobs(agents, new Map([['w', 'w']]), NOW, jobs);
  await Promise.all(jobs);
  assert(sent.space_blocked, 'workspace mark is not blocked');
});

// The real loop: what one frame publishes is what the next snapshot reads
// back, and a daemon restart is a new Frame reading the same tokens.
function pane(t, status) {
  const published = {};
  const live = { status, ask: null };
  t.mock.method(herdr, 'reportMetadataAsync', async (_pane, _source, tokens) => {
    for (const [name, value] of Object.entries(tokens)) {
      if (value === null) delete published[name];
      else published[name] = value;
    }
    return true;
  });
  t.mock.method(herdr, 'agentsAsync', async () => [
    agent('loop', live.status, { ...published, ...(live.ask === null ? {} : { taskr_owner_ask: live.ask }) }),
  ]);
  const keys = { minuteKey: () => null, wsKeys: new Map(), tabKeys: new Map() };
  const step = async (frame, at) => {
    const [seen] = await state.snapshot();
    const display = frame.displayFor(seen, at, []);
    const jobs = [];
    frame.paneJobs(seen, display, { tabs: new Map(), keys, indent: '', spinStep: 0 }, at, [], jobs);
    await Promise.all(jobs);
    return display;
  };
  return { live, published, step, frame: () => frameFor('loop') };
}

function holds(t) {
  attention(t, 'taskr_owner_ask');
  const before = config.blockedHoldUntilAnswered;
  config.blockedHoldUntilAnswered = true;
  t.after(() => {
    config.blockedHoldUntilAnswered = before;
  });
}

test('an owner ask fed back through the snapshot is never held', async (t) => {
  holds(t);
  const { live, step, frame: make } = pane(t, 'idle');
  const frame = make();
  live.ask = '1';
  assert.equal(await step(frame, NOW), 'blocked');
  assert.equal(await step(frame, NOW + 1000), 'blocked');
  assert(!frame.blockedSince.has('loop'), 'the ask was adopted as a held question');
  live.ask = '0';
  assert.notEqual(await step(frame, NOW + 2000), 'blocked');
  assert.notEqual(await step(frame, NOW + 3000), 'blocked');
});

test('a restart does not hold an ask that was cleared meanwhile', async (t) => {
  holds(t);
  const { live, published, step, frame: make } = pane(t, 'idle');
  live.ask = '2';
  assert.equal(await step(make(), NOW), 'blocked');
  assert(published.state_blocked, 'no blocked badge was published');
  live.ask = null;
  const restarted = make();
  assert.notEqual(await step(restarted, NOW + 1000), 'blocked');
  assert(!published.state_blocked, 'the stale badge stayed up');
});

test('a restart keeps showing an open ask, then lets it clear', async (t) => {
  holds(t);
  const { live, step, frame: make } = pane(t, 'done');
  live.ask = '1';
  await step(make(), NOW);
  const restarted = make();
  assert.equal(await step(restarted, NOW + 1000), 'blocked');
  live.ask = '0';
  assert.notEqual(await step(restarted, NOW + 2000), 'blocked');
});

test("Herdr's own question is still held across a restart", async (t) => {
  holds(t);
  const { live, published, step, frame: make } = pane(t, 'blocked');
  assert.equal(await step(make(), NOW), 'blocked');
  assert.equal(published.name_blocked, undefined, 'a native question was marked as an ask');
  live.status = 'idle';
  assert.equal(await step(make(), NOW + 1000), 'blocked');
});
