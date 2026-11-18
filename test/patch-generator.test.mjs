import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePatch, exportPatchManifest } from '../packages/core/src/patch-generator.mjs';

test('generatePatch returns CSS patch for overflow rules', () => {
  const p = generatePatch({ ruleId: 'overflow-container', selector: '#box' });
  assert.ok(p);
  assert.equal(p.type, 'css');
  assert.ok(p.css.includes('max-width: 100%'));
  assert.ok(p.css.includes('box-sizing: border-box'));
  assert.ok(p.css.includes('overflow-x: clip'));
});

test('generatePatch returns tap-target patch for mobile controls', () => {
  const p = generatePatch({ ruleId: 'tap-target-undersized', selector: 'button.icon' });
  assert.ok(p);
  assert.equal(p.type, 'css');
  assert.ok(p.css.includes('min-width: 44px'));
  assert.ok(p.css.includes('min-height: 44px'));
});

test('generatePatch returns attr patch with inferred aria-label', () => {
  const cartPatch = generatePatch({ ruleId: 'a11y-missing-label', selector: 'header button.cart' });
  assert.ok(cartPatch);
  assert.equal(cartPatch.type, 'attr');
  assert.equal(cartPatch.attr.name, 'aria-label');
  assert.equal(cartPatch.attr.value, 'Ver carrito de compras');

  const nextPatch = generatePatch({ ruleId: 'a11y-missing-label', selector: 'button.next-slide' });
  assert.equal(nextPatch.attr.value, 'Siguiente diapositiva');
});

test('exportPatchManifest compiles valid manifest', () => {
  const p1 = generatePatch({ ruleId: 'overflow-container', selector: '#a' });
  const p2 = generatePatch({ ruleId: 'a11y-missing-label', selector: '#b' });
  const manifest = exportPatchManifest([p1, p2]);

  assert.equal(manifest.totalPatches, 2);
  assert.ok(manifest.timestamp);
  assert.equal(manifest.patches[0].selector, '#a');
  assert.equal(manifest.patches[1].selector, '#b');
});
