import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PATCHABLE_RULES, exportPatchManifest, generatePatch } from '../packages/core/src/patch-generator.mjs';

test('every patch recipe is keyed by a rule id the DOM auditor really emits', async () => {
  const { readFileSync } = await import('node:fs');
  const auditor = readFileSync(new URL('../packages/overlay/src/dom-auditor.js', import.meta.url), 'utf8');
  for (const ruleId of PATCHABLE_RULES) assert.ok(auditor.includes(`'${ruleId}'`), `auditor never emits "${ruleId}"`);
});

test('generatePatch returns validated CSS declarations for overflow and tap-target findings', () => {
  const overflow = generatePatch({ ruleId: 'overflow-container', selector: '#box' });
  assert.equal(overflow.type, 'css');
  assert.deepEqual(overflow.declarations, { 'max-width': '100%', 'box-sizing': 'border-box', 'overflow-x': 'auto' });
  assert.equal(overflow.css, '#box { max-width: 100%; box-sizing: border-box; overflow-x: auto; }');
  assert.match(overflow.id, /^patch-[0-9a-f]{8}$/);

  assert.equal(
    generatePatch({ ruleId: 'overflow-container', selector: '#grid > article:nth-of-type(3) > div' }).selector,
    '#grid > article:nth-of-type(3) > div'
  );

  const tap = generatePatch({ ruleId: 'tap-target-size', selector: 'button.icon' });
  assert.equal(tap.declarations['min-width'], '44px');
  assert.equal(tap.declarations['min-height'], '44px');
  assert.equal(generatePatch({ ruleId: 'tap-target-undersized', selector: 'button.icon' }).ruleId, 'tap-target-size');
});

test('generatePatch infers accessible names and field labels', () => {
  const cart = generatePatch({ ruleId: 'a11y-accessible-name', selector: 'header button.cart' });
  assert.deepEqual(cart.attr, { name: 'aria-label', value: 'Ver carrito' });
  assert.equal(generatePatch({ ruleId: 'a11y-missing-label', selector: 'button.next-slide' }).attr.value, 'Siguiente');
  assert.equal(generatePatch({ ruleId: 'a11y-accessible-name', selector: '#theme-toggle' }).attr.value, 'Cambiar tema');
  const email = generatePatch({ ruleId: 'a11y-form-label', selector: '#email', actual: 'unlabeled input (type=email)' });
  assert.equal(email.attr.value, 'Correo electrónico');
});

test('generatePatch refuses unknown rules, document-level targets and selectors that could inject CSS', () => {
  assert.equal(generatePatch({ ruleId: 'overlap-elements', selector: '#a' }), null);
  assert.equal(generatePatch({ ruleId: 'overflow-container', selector: 'html' }), null);
  assert.equal(generatePatch({ ruleId: 'overflow-container', selector: 'a{} body{display:none} x' }), null);
  assert.equal(generatePatch({ ruleId: 'overflow-container', selector: '' }), null);
  assert.equal(generatePatch(null), null);
});

test('exportPatchManifest compiles a serializable manifest', () => {
  const manifest = exportPatchManifest([
    generatePatch({ ruleId: 'overflow-container', selector: '#a' }),
    generatePatch({ ruleId: 'a11y-accessible-name', selector: '#b' })
  ]);
  assert.equal(manifest.totalPatches, 2);
  assert.ok(manifest.timestamp);
  assert.equal(manifest.patches[0].selector, '#a');
  assert.equal(manifest.patches[1].attr.name, 'aria-label');
});
