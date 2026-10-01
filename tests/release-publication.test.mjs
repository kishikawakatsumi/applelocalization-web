import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReleaseForPublication } from '../scripts/publish-intermediate-release.mjs';

test('draft and resume checks bind release identity, original commit and every uploaded asset digest', () => {
  const expected = { tag: 'fixed-tag', commit: 'a'.repeat(40), assets: [{ name: 'artifact.json', size: 10, digest: 'sha256:' + 'b'.repeat(64) }] };
  const release = { id: 123, draft: true, prerelease: true, tag_name: expected.tag, target_commitish: expected.commit, assets: expected.assets };
  validateReleaseForPublication(release, expected);
  for (const change of [r => r.id = 0, r => r.tag_name = 'another', r => r.target_commitish = 'other', r => r.prerelease = false,
    r => r.assets[0].digest = 'changed', r => r.assets[0].size++, r => r.assets.push({ name: 'original.strings' })]) {
    const value = structuredClone(release); change(value); assert.throws(() => validateReleaseForPublication(value, expected));
  }
});
