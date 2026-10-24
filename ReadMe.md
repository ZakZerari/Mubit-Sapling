# Redline

Line-by-line compliance verification on [Banyan Sapling](https://huggingface.co/MubitLabs/banyan-sapling).

Paste an internal memo on one side and the contract clauses it cites on the
other. Redline pairs each memo line that references a clause (`CL-1`, `CL-2`, …)
with the matching clause text, sends `(policy, evidence, claim)` to Sapling, and
ranks every checked line by a single **directional score** — how strongly it
leans toward *violating* its clause versus being *supported* by it.

That design choice is deliberate. On this kind of input, Sapling's calibrated
status is usually `unsure` — meaning `insufficient_information` stays on the
table alongside the real answer, exactly as its model card warns can happen
outside clean in-distribution data. But the `violation` vs. `supported`
contrast underneath still separates cleanly: in the prefilled example, the one
clause actually breached scores ~80% toward violation, while the three clauses
actually followed score 68–84% toward supported. The lean score — computed as
`violation ÷ (violation + supported)` — isolates exactly that contrast and
shows it plainly, with the full calibrated output always one click away, never
hidden.

## Why a local server

A browser calling the Sapling endpoint directly from a hosted static page
(e.g. a Claude Artifact) gets silently blocked — those sandboxes only allow
outbound requests to a small CDN allowlist, nothing else. `server.py` is a
~100-line, dependency-free Python proxy: the page only ever talks to its own
origin (`/api/verify`), and the server makes the real call to Sapling.

## Run it

```bash
python3 server.py
```

Then open <http://localhost:8787>. No dependencies beyond the Python 3 standard
library.

## Files

- `server.py` — static file server + `/api/verify` proxy to the Sapling endpoint.
- `web/index.html`, `web/style.css`, `web/app.js` — the front end (vanilla JS,
  no build step, no framework).

## The example

The prefilled memo is a Q3 vendor-engagement review citing four NDA clauses.
One line (`CL-1`) describes sharing a spec with a contractor without the
consent the clause requires — a real breach. The other three describe
compliant behavior. Click "Verify memo" (or just load the page — it runs once
automatically) to watch Sapling check each cited line live and rank the breach
to the top of the findings list.
