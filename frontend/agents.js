import "bulma/css/bulma.min.css";
import "./css/index.css";
import "./css/agents.css";
import "./js/icon.js";

document.querySelector('nav a[href="/ai"]').setAttribute("aria-current", "page");
document.getElementById("copy-mcp-url").addEventListener("click", async () => {
  const error = document.getElementById("copy-error");
  error.hidden = true;
  try {
    await navigator.clipboard.writeText(document.getElementById("mcp-url").textContent);
  } catch {
    error.hidden = false;
  }
});
