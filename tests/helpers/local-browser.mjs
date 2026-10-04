import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export async function localBrowser(t) {
  const profile = await mkdtemp(join(tmpdir(), "candidate-browser-"));
  const chrome = spawn(
    process.env.CHROME_BIN ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  t.after(() => chrome.kill());
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Browser startup timeout")),
      15000,
    );
    let log = "";
    chrome.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    chrome.stderr.on("data", (chunk) => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const socket = new WebSocket(endpoint);
  await once(socket, "open");
  t.after(() => socket.close());
  const pending = new Map();
  let id = 0;
  socket.addEventListener("message", (event) => {
    const m = JSON.parse(event.data), p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error
        ? p.reject(new Error(JSON.stringify(m.error)))
        : p.resolve(m.result);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const next = ++id;
      pending.set(next, { resolve, reject });
      socket.send(JSON.stringify({ id: next, method, params, sessionId }));
    });
  const { targetId } = await send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 300; i++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Timed out: " + expression);
  };
  const ready =
    "document.getElementById('candidate-results')?.getAttribute('aria-busy') === 'false'";
  const navigate = async (url) => {
    await send("Page.navigate", { url }, sessionId);
    await until(`location.href === ${JSON.stringify(url)} && (${ready})`);
  };
  const click = async (selector) => {
    // Resolve the actual generated link, then navigate explicitly to avoid observing the outgoing page as ready.
    const href = await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).href`,
    );
    await navigate(href);
  };
  const screenshot = async (name) => {
    const result = await send(
      "Page.captureScreenshot",
      { format: "png" },
      sessionId,
    );
    const path = join(profile, name + ".png");
    await writeFile(path, Buffer.from(result.data, "base64"));
    return path;
  };
  return {
    evaluate,
    until,
    navigate,
    click,
    mouseClick: async (selector) => {
      const point = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error('Click target not found');
        element.scrollIntoView({block:'nearest'});
        const r = element.getBoundingClientRect();
        return {x:r.x+r.width/2,y:r.y+r.height/2};
      })()`);
      await send(
        "Input.dispatchMouseEvent",
        { type: "mouseMoved", ...point },
        sessionId,
      );
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        ...point,
      }, sessionId);
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        clickCount: 1,
        ...point,
      }, sessionId);
    },
    keyPress: async (key, code = key, windowsVirtualKeyCode, modifiers = 0) => {
      const params = { key, code, windowsVirtualKeyCode, modifiers };
      await send(
        "Input.dispatchKeyEvent",
        { type: "rawKeyDown", ...params },
        sessionId,
      );
      await send(
        "Input.dispatchKeyEvent",
        { type: "keyUp", ...params },
        sessionId,
      );
    },
    screenshot,
    downloads: (path) =>
      send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: path,
      }),
    rawNavigate: (url) => send("Page.navigate", { url }, sessionId),
    viewport: (width, height) =>
      send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width < 600,
      }, sessionId),
  };
}
