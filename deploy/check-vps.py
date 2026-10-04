"""Read-only checks against the candidate's loopback port; no public endpoint."""
import json
import sys
import urllib.request


def check(port):
    base = f"http://127.0.0.1:{int(port)}"

    def get(path):
        with urllib.request.urlopen(base + path, timeout=30) as response:
            if response.status != 200:
                raise RuntimeError(f"HTTP {response.status}: {path}")
            return json.load(response)

    health = get("/healthz")
    if health != {"ready": True, "datasets": 12, "validationOnly": False}:
        raise RuntimeError(f"Unexpected health: {health}")
    for platform, versions in [("ios", [15, 16, 17, 18, 26, 27]), ("macos", [12, 13, 14, 15, 26, 27])]:
        for version in versions:
            dataset = f"{platform}{version}"
            result = get(f"/api/{platform}/{version}/search?q=Open&l=English&l=Japanese")
            if not isinstance(result.get("data"), list) or not result["data"]:
                raise RuntimeError(f"No search results: {dataset}")
            if any(row.get("dataset") != dataset for row in result["data"]):
                raise RuntimeError(f"Cross-platform/version results: {dataset}")
            print(f"Search OK: {dataset}", flush=True)


if __name__ == "__main__":
    check(sys.argv[1])
