// One loader per search. Keep a failed page pending until an explicit retry so
// progressive pagination cannot skip it or append it twice.
export function createSearchLoader({
  onStatus,
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = 45000,
}) {
  const lifetime = new AbortController();
  const abortError = () => new DOMException("Search superseded", "AbortError");

  async function request(url, params = {}) {
    const target = new URL(
      url,
      globalThis.location?.href ?? "http://localhost",
    );
    for (const [key, value] of Object.entries(params)) {
      target.searchParams.set(key, String(value));
    }
    const page = Number(params.page ?? 1);
    while (!lifetime.signal.aborted) {
      const attempt = new AbortController();
      const cancel = () => attempt.abort();
      lifetime.signal.addEventListener("abort", cancel, { once: true });
      let timedOut = false;
      let timer;
      let failure;
      try {
        onStatus({ phase: "loading", page });
        timer = setTimeout(() => {
          timedOut = true;
          attempt.abort();
        }, timeoutMs);
        const response = await fetchImpl(target.href, {
          signal: attempt.signal,
          headers: { Accept: "application/json" },
          credentials: "same-origin",
        });
        let body;
        try {
          body = await response.json();
        } catch (error) {
          if (attempt.signal.aborted) throw error;
          if (response.ok) throw new SearchError("invalid-response");
        }
        if (!response.ok) {
          const timeout = response.status === 504 ||
            (response.status === 503 &&
              /タイムアウト|timeout|timed out/i.test(body?.error ?? ""));
          throw new SearchError(
            timeout
              ? "timeout"
              : response.status === 400
              ? "invalid-query"
              : "server",
            response.status,
          );
        }
        if (
          !body || !Array.isArray(body.data) ||
          !Number.isFinite(body.last_page) || body.last_page < 0
        ) {
          throw new SearchError("invalid-response");
        }
        if (lifetime.signal.aborted) throw abortError();
        onStatus({ phase: "received", page });
        return body;
      } catch (error) {
        if (lifetime.signal.aborted) throw abortError();
        failure = timedOut
          ? new SearchError("timeout")
          : error instanceof SearchError
          ? error
          : new SearchError("connection");
      } finally {
        clearTimeout(timer);
        lifetime.signal.removeEventListener("abort", cancel);
      }
      await new Promise((resolve, reject) => {
        const abort = () => {
          lifetime.signal.removeEventListener("abort", abort);
          reject(abortError());
        };
        lifetime.signal.addEventListener("abort", abort, { once: true });
        if (lifetime.signal.aborted) return abort();
        let retried = false;
        onStatus({
          phase: "error",
          page,
          error: failure,
          retry: () => {
            if (retried || lifetime.signal.aborted) return;
            retried = true;
            lifetime.signal.removeEventListener("abort", abort);
            resolve();
          },
        });
      });
    }
    throw abortError();
  }
  return { request, cancel: () => lifetime.abort() };
}

class SearchError extends Error {
  constructor(kind, status) {
    super(kind);
    this.kind = kind;
    this.status = status;
  }
}

export function searchErrorLabel(error) {
  switch (error.kind) {
    case "timeout":
      return "Timed out";
    case "connection":
      return "Connection failed";
    case "invalid-query":
      return "Invalid search";
    case "invalid-response":
      return "Invalid response";
    default:
      return `Server error${error.status ? ` (${error.status})` : ""}`;
  }
}

export function searchErrorMessage(error) {
  switch (error.kind) {
    case "timeout":
      return "The search timed out. Try narrowing the search or retry.";
    case "connection":
      return "Could not connect to the server. Check your connection and retry.";
    case "invalid-query":
      return "The server could not accept this search. Check the search conditions.";
    case "invalid-response":
      return "The server returned an unexpected response. Please retry.";
    default:
      return `The server could not complete the search${
        error.status ? ` (HTTP ${error.status})` : ""
      }. Please retry.`;
  }
}
