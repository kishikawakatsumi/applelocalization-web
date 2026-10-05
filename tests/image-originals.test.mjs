import test from 'node:test';
import { execFileSync } from 'node:child_process';

test('independent original-value audit: Python fixtures and mutation rejection', () => {
  execFileSync('python3', ['-B', 'tests/audit_image_originals.py'], { timeout: 30000 });
});
