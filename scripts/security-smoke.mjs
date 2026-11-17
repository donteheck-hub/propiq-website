// Offline tests; does not make network requests, create payments, or use odds credits.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const input = readFileSync('lib/entitlements.ts', 'utf8');
const js = ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
vm.runInNewContext(js, { exports });
const { entitlementFromSubscription } = exports;
const now = Date.parse('2026-11-17T00:00:00Z');
const future = '2026-12-17T00:00:00Z';
const past = '2026-10-17T00:00:00Z';
const sample = (plan, status, date) => ({plan,status,current_period_end:date});
for (const [description, row, expected] of [
  ['missing record', undefined, 'free'],
  ['active Pro', sample('pro','active',future), 'pro'],
  ['active Elite', sample('elite','active',future), 'elite'],
  ['trialing Pro', sample('pro','trialing',future), 'pro'],
  ['expired Pro', sample('pro','active',past), 'free'],
  ['canceled Pro', sample('pro','canceled',future), 'free'],
  ['unpaid Elite', sample('elite','unpaid',future), 'free'],
  ['unsupported plan', sample('admin','active',future), 'free'],
  ['missing expiration', sample('pro','active',undefined), 'free'],
  ['invalid expiration', sample('elite','active','nonsense'), 'free'],
]) {
  assert.equal(entitlementFromSubscription(row, now), expected, description);
  console.log('PASS',description);
}
console.log('All offline entitlement checks passed. Live auth, webhook and RLS testing still required.');
