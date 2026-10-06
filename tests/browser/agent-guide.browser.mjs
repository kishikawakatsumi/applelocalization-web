import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { localBrowser } from "../helpers/local-browser.mjs";

test("agent guide navigation, layout and clipboard failure", {
  skip: process.env.ALLOW_AGENT_GUIDE_TEST !== "1",
  timeout: 60000,
}, async (t) => {
  const server = spawn("deno", ["run", "--node-modules-dir=none", "--frozen",
    "--allow-read", "--allow-net=127.0.0.1", "tests/helpers/search-history-server.ts"],
  { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => server.kill());
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Fixture startup timeout")), 15000);
    let output = "";
    server.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/FIXTURE_PORT=(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
    server.once("exit", (code) => { clearTimeout(timer); reject(Error("Fixture exited " + code)); });
    server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  });
  const origin = `http://127.0.0.1:${port}`;
  const browser = await localBrowser(t);
  await browser.viewport(1440, 960);
  await browser.rawNavigate(origin + "/macos/26?q=tab");
  await browser.until("document.querySelector('#table.tabulator') && document.getElementById('total-count').textContent !== ''");
  assert.deepEqual(await browser.evaluate("Array.from(document.querySelectorAll('nav a')).map(a => a.textContent.trim())"),
    ["Feedback", "Source Code", "AI / API", "Maintainer", "Donate"]);
  assert.equal(await browser.evaluate("document.querySelector('nav .bi-terminal').getBoundingClientRect().width > 0"), true);
  console.log("search", await browser.screenshot("agent-link"));
  await browser.mouseClick('nav a[href="/ai"]');
  await browser.until("location.pathname === '/ai' && document.querySelector('nav a[aria-current=page]')");
  assert.equal(await browser.evaluate("Boolean(document.getElementById('search-field'))"), false);
  assert.equal(await browser.evaluate("Array.from(document.scripts).some(s => s.src.includes('/index.'))"), false);
  for (const width of [1440, 1024, 390]) {
    await browser.viewport(width, 960);
    assert.equal(await browser.evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `overflow at ${width}`);
  }
  await browser.viewport(1440, 960);
  console.log("guide", await browser.screenshot("agent-guide"));
  await browser.evaluate("Object.defineProperty(navigator, 'clipboard', {value: {writeText: async value => {window.copiedText = value;}}})");
  await browser.mouseClick("#copy-mcp-url");
  await browser.until("window.copiedText === 'https://applelocalization.com/mcp'");
  assert.equal(await browser.evaluate("document.getElementById('copy-error').hidden"), true);
  await browser.evaluate("navigator.clipboard.writeText = async () => {throw Error('Denied')}");
  await browser.mouseClick("#copy-mcp-url");
  await browser.until("!document.getElementById('copy-error').hidden");
  await browser.evaluate("history.back()");
  await browser.until("location.pathname === '/macos/26' && document.getElementById('search-field')?.value === 'tab'");
});
