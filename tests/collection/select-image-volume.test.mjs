import test from 'node:test';
import assert from 'node:assert/strict';
import { selectImageVolume } from '../../scripts/collection/select-image-volume.mjs';
const version = { ProductVersion: '15.8.1', ProductBuildVersion: '24H32' };
const system = { device: '/dev/disk6s1', internalVersion: version };
const preboot = { device: '/dev/disk6s2', internalVersion: null };
test('volume selection ignores attach order', () => {
  assert.equal(selectImageVolume([preboot, system], version), system);
  assert.equal(selectImageVolume([system, preboot], version), system);
});
test('missing, wrong-build and ambiguous volumes fail closed', () => {
  assert.throws(() => selectImageVolume([], version));
  assert.throws(() => selectImageVolume([preboot], version));
  assert.throws(() => selectImageVolume([system], { ...version, ProductBuildVersion: 'wrong' }));
  assert.throws(() => selectImageVolume([system, { ...system }], version));
  assert.throws(() => selectImageVolume([system], {}));
});
test('unversioned images require a single volume', () => {
  assert.equal(selectImageVolume([preboot], null), preboot);
  assert.throws(() => selectImageVolume([preboot, system], null));
});
