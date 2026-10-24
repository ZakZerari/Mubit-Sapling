#!/usr/bin/env python3
"""Redline — local server.

Serves the static front end and proxies /api/verify to the Banyan Sapling
inference endpoint server-side. A browser-side fetch() straight to Sapling
doesn't work from a hosted Artifact (the sandbox blocks cross-origin fetch
to arbitrary hosts), so this tiny proxy is the fix: the page only ever
talks to its own origin, and this process makes the real call.

Run:
    python3 server.py
Then open http://localhost:8787
"""

import json
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB_DIR = (Path(__file__).parent / "web").resolve()
SAPLING_ENDPOINT = "https://6adbee0669a00298cd4774c9.endpoints.huggingface.cloud"
PORT = 8787

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            path = "/index.html"

        candidate = (WEB_DIR / path.lstrip("/")).resolve()
        if WEB_DIR != candidate and WEB_DIR not in candidate.parents:
            self.send_error(404, "Not found")
            return
        if not candidate.is_file():
            self.send_error(404, "Not found")
            return

        data = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(candidate.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path != "/api/verify":
            self.send_error(404, "Not found")
            return

        length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(length) if length else b""

        try:
            payload = json.loads(raw_body)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "Request body must be valid JSON."})
            return

        inputs = payload.get("inputs") if isinstance(payload, dict) else None
        if not isinstance(inputs, dict) or not all(
            isinstance(inputs.get(k), str) and inputs.get(k).strip()
            for k in ("policy", "evidence", "claim")
        ):
            self._send_json(400, {"error": "inputs.policy, inputs.evidence and inputs.claim are all required."})
            return

        upstream_req = urllib.request.Request(
            SAPLING_ENDPOINT,
            data=json.dumps({"inputs": inputs}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(upstream_req, timeout=30) as resp:
                body = resp.read()
                status = resp.status
        except urllib.error.HTTPError as err:
            body = err.read()
            status = err.code
        except urllib.error.URLError as err:
            self._send_json(502, {"error": f"Could not reach Sapling endpoint: {err.reason}"})
            return

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("  " + (fmt % args))


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Redline running at http://localhost:{PORT}")
    print(f"Proxying /api/verify -> {SAPLING_ENDPOINT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
