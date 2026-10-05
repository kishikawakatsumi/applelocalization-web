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
  for (const name of ['globe', 'sliders', 'phone', 'display']) {
    assert.ok(html.includes(`icon-${name}.html`));
    assert.match(await readFile(`frontend/templates/icon-${name}.html`, 'utf8'), new RegExp(`bi-${name}`));
  }
  assert.match(await readFile('frontend/static/bootstrap-icons-LICENSE.txt', 'utf8'), /The Bootstrap Authors/);
});

test('both platform selectors use decorative Bootstrap device icons', async () => {
  const html = await readFile('frontend/index.html', 'utf8');
  assert.equal(html.split('include(dataset.platformId === "ios" ? "icon-phone.html" : "icon-display.html")').length - 1, 2);
  assert.doesNotMatch(html, /fa-mobile|fa-desktop/);
  assert.doesNotMatch(await readFile('frontend/js/icon.js', 'utf8'), /faMobile|faDesktop/);
  for (const name of ['phone', 'display']) {
    const svg = await readFile(`frontend/templates/icon-${name}.html`, 'utf8');
    assert.match(svg, /fill="currentColor"/);
    assert.match(svg, /width="1em" height="1em"/);
    assert.match(svg, /aria-hidden="true" focusable="false"/);
  }
});
