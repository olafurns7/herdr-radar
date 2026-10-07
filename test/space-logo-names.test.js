'use strict';

// space_logo_names = false: a Spaces row's vendor cells carry the logo alone.
// A vendor with no logo keeps its name, or its cell would go blank.

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../lib/config');
const palette = require('../lib/palette');
const state = require('../lib/state');
const { logoFor } = require('../lib/logos');

const brand = palette.brandVendors[0];
const agents = [{ name: brand }, { name: 'no-such-vendor' }];

function names(t, value) {
  const before = config.spaceLogoNames;
  config.spaceLogoNames = value;
  t.after(() => {
    config.spaceLogoNames = before;
  });
}

// The unset default is checked against a scratch config in tools/check.js.
test('true keeps logo and name', (t) => {
  names(t, true);
  const tokens = state.spaceLogoTokens(agents);
  assert.equal(tokens[`space_logo_${brand}`], `${logoFor(brand)} ${brand}`);
  assert.equal(tokens.space_logo_other, 'no-such-vendor');
});

test('false keeps only the logo, and a vendor without one keeps its name', (t) => {
  names(t, false);
  const tokens = state.spaceLogoTokens(agents);
  assert.equal(tokens[`space_logo_${brand}`], logoFor(brand));
  assert.equal(tokens.space_logo_other, 'no-such-vendor');
});

test('false packs logos alone into the shared cell', (t) => {
  names(t, false);
  const packed = Object.keys(require('../lib/logos').PUA).filter(
    (name) => !palette.brandVendors.includes(name) && logoFor(name),
  );
  if (packed.length === 0) return t.skip('every vendor with a logo has its own cell');
  const tokens = state.spaceLogoTokens([{ name: packed[0] }, { name: 'no-such-vendor' }]);
  assert.equal(tokens.space_logo_other, `${logoFor(packed[0])} no-such-vendor`);
});
