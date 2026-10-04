import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('icons and clean Docker builds need no private registry credentials', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.ok(Object.keys(pkg.dependencies).every(name => !name.startsWith('@fortawesome/pro-')));
  for (const path of ['package-lock.json', 'Dockerfile', '.github/workflows/test.yml', 'frontend/js/icon.js']) {
    assert.doesNotMatch(await readFile(path, 'utf8'), /npm\.fontawesome\.com|FONTAWESOME_TOKEN|@fortawesome\/pro-/);
  }
  const html = await readFile('frontend/index.html', 'utf8');
  assert.doesNotMatch(html, /fa-light|fa-duotone|fa-message-smile|fa-regular fa-at/);
  for (const name of ['globe', 'sliders']) {
    assert.ok(html.includes(`icon-${name}.html`));
    assert.match(await readFile(`frontend/templates/icon-${name}.html`, 'utf8'), new RegExp(`bi-${name}`));
  }
  assert.match(await readFile('frontend/static/bootstrap-icons-LICENSE.txt', 'utf8'), /The Bootstrap Authors/);
});
