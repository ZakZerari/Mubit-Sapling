(function () {
  "use strict";

  var POLICY_DEFAULT =
    "Determine whether the evidence supports, contradicts, or does not provide enough information about the claim.";

  var DOCUMENT_DEFAULT = [
    "To: Legal & Compliance",
    "Re: Q3 vendor engagement review",
    "Per CL-1, the engineering team shared the integration specification with an external contractor without obtaining the Disclosing Party's prior written consent.",
    "Per CL-2, the team notified the Disclosing Party in writing promptly after discovering the unauthorized disclosure.",
    "Per CL-3, Confidential Information was used only to evaluate the potential partnership, consistent with the agreement.",
    "Per CL-4, our records show that confidentiality obligations survive termination of the Agreement for a period of five years.",
    "Finance will circulate the vendor's final invoice separately."
  ].join("\n");

  var EVIDENCE_DEFAULT = [
    "CL-1 — Receiving Party shall not disclose Confidential Information to any third party without the Disclosing Party's prior written consent, except as required by law.",
    "CL-2 — Receiving Party shall notify Disclosing Party promptly in writing upon discovering any unauthorized use or disclosure of Confidential Information.",
    "CL-3 — Receiving Party may use Confidential Information solely to evaluate a potential business relationship with Disclosing Party, and for no other purpose.",
    "CL-4 — All obligations of confidentiality under this Agreement survive termination of this Agreement for a period of five years."
  ].join("\n");

  var ID_PATTERN = /\bCL-\d+\b/;

  var PROB_ORDER = ["supported", "violation", "insufficient_information", "inconsistent_context"];
  var PROB_LABEL = {
    supported: "Supported",
    violation: "Violation",
    insufficient_information: "Insufficient info",
    inconsistent_context: "Inconsistent context"
  };
  var STATUS_META = {
    supported: { key: "supported", label: "Supported" },
    violation: { key: "violation", label: "Violation" },
    insufficient_information: { key: "insufficient", label: "Insufficient information" },
    inconsistent_context: { key: "inconsistent", label: "Inconsistent context" },
    unsure: { key: "unsure", label: "Unsure (calibration kept more than one label open)" }
  };

  // Sapling's own calibrated status is "unsure" on most of these — exactly what
  // its model card predicts outside synthetic/ContractNLI data. The violation vs.
  // supported split underneath still separates cleanly, so that's what drives
  // the headline score: lean = violation / (violation + supported).
  function computeLean(probabilities) {
    var v = probabilities.violation || 0;
    var s = probabilities.supported || 0;
    if (v + s <= 0) return null;
    return v / (v + s);
  }

  function leanTier(lean) {
    if (lean == null) return "mid";
    if (lean >= 0.6) return "violation";
    if (lean <= 0.4) return "supported";
    return "mid";
  }

  function leanLabel(lean) {
    var tier = leanTier(lean);
    if (tier === "violation") return (lean * 100).toFixed(0) + "% VIOLATION";
    if (tier === "supported") return ((1 - lean) * 100).toFixed(0) + "% SUPPORTED";
    return "inconclusive";
  }

  // ---- DOM refs ----
  var composeEl = document.getElementById("compose");
  var reviewEl = document.getElementById("review");
  var documentInput = document.getElementById("document-input");
  var evidenceInput = document.getElementById("evidence-input");
  var policyInput = document.getElementById("policy-input");
  var verifyBtn = document.getElementById("verify-btn");
  var editBtn = document.getElementById("edit-btn");
  var documentLinesEl = document.getElementById("document-lines");
  var riskListEl = document.getElementById("risk-list");
  var detailEl = document.getElementById("detail");
  var summaryChipsEl = document.getElementById("summary-chips");

  documentInput.value = DOCUMENT_DEFAULT;
  evidenceInput.value = EVIDENCE_DEFAULT;
  policyInput.value = POLICY_DEFAULT;

  var lines = [];       // { text, id, isClaim, evidence, noRecordFor }
  var results = [];     // parallel array; { result, error } | null
  var selectedIndex = null;

  function parseEvidence(text) {
    var map = {};
    text.split("\n").forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      var m = line.match(ID_PATTERN);
      if (m) map[m[0]] = line;
    });
    return map;
  }

  function buildLines(docText, evidenceMap) {
    return docText.split("\n").map(function (raw) {
      var text = raw.trim();
      var m = text.match(ID_PATTERN);
      var id = m ? m[0] : null;
      var hasEvidence = id && evidenceMap.hasOwnProperty(id);
      return {
        text: text,
        id: id,
        isClaim: Boolean(hasEvidence),
        evidence: hasEvidence ? evidenceMap[id] : null,
        noRecordFor: id && !hasEvidence ? id : null
      };
    }).filter(function (l) { return l.text.length > 0; });
  }

  function renderSkeleton() {
    documentLinesEl.innerHTML = "";
    lines.forEach(function (line, i) {
      var row = document.createElement("div");
      row.className = "line" + (line.isClaim ? " is-claim" : " is-boilerplate");
      row.dataset.index = String(i);

      var gutter = document.createElement("div");
      gutter.className = "line-gutter" + (line.isClaim ? " is-checking" : "");

      var textWrap = document.createElement("div");
      textWrap.className = "line-text-wrap";

      var textEl = document.createElement("span");
      textEl.className = "line-text";
      textEl.textContent = line.text;
      textWrap.appendChild(textEl);

      if (line.isClaim) {
        var badge = document.createElement("span");
        badge.className = "line-badge is-pending";
        badge.textContent = "checking…";
        textWrap.appendChild(badge);
      }

      row.appendChild(gutter);
      row.appendChild(textWrap);
      if (line.isClaim) {
        row.addEventListener("click", function () { selectLine(i); });
      }
      documentLinesEl.appendChild(row);
    });
  }

  function lineRowEl(i) { return documentLinesEl.children[i]; }

  function setLineResult(i, result, error) {
    results[i] = { result: result, error: error || null };
    var row = lineRowEl(i);
    var gutter = row.querySelector(".line-gutter");
    var badge = row.querySelector(".line-badge");
    gutter.classList.remove("is-checking");
    badge.classList.remove("is-pending");

    if (error) {
      gutter.classList.add("tier-violation");
      badge.classList.add("tier-violation");
      badge.textContent = "request failed";
      return;
    }
    var lean = computeLean(result.probabilities);
    var tier = leanTier(lean);
    gutter.classList.add("tier-" + tier);
    badge.classList.add("tier-" + tier);
    badge.textContent = leanLabel(lean);
  }

  async function callSapling(policy, evidence, claim) {
    var started = performance.now();
    var res = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: { policy: policy, evidence: evidence, claim: claim } })
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data && data.error ? data.error : ("Request failed (" + res.status + ")"));
    data._roundTripMs = Math.round(performance.now() - started);
    data._request = { policy: policy, evidence: evidence, claim: claim };
    return data;
  }

  async function runVerification() {
    var evidenceMap = parseEvidence(evidenceInput.value);
    lines = buildLines(documentInput.value, evidenceMap);
    results = lines.map(function () { return null; });
    selectedIndex = null;

    composeEl.hidden = true;
    reviewEl.hidden = false;
    summaryChipsEl.innerHTML = '<span class="chip">Checking…</span>';
    detailEl.innerHTML = '<p class="detail-empty">Verifying lines against the contract…</p>';
    riskListEl.innerHTML = "";
    renderSkeleton();

    var policy = policyInput.value.trim() || POLICY_DEFAULT;

    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].isClaim) continue;
      try {
        var data = await callSapling(policy, lines[i].evidence, lines[i].text);
        setLineResult(i, data, null);
      } catch (err) {
        setLineResult(i, null, err.message);
      }
    }

    renderFindings();
    renderSummary();

    var topIndex = topFindingIndex();
    if (topIndex != null) selectLine(topIndex);
  }

  function leanOf(i) {
    if (!results[i] || results[i].error) return null;
    return computeLean(results[i].result.probabilities);
  }

  function topFindingIndex() {
    var best = null;
    lines.forEach(function (line, i) {
      if (!line.isClaim) return;
      var lean = leanOf(i);
      if (lean == null) return;
      if (best == null || lean > leanOf(best)) best = i;
    });
    return best;
  }

  function renderFindings() {
    var items = [];
    lines.forEach(function (line, i) {
      var lean = leanOf(i);
      if (lean == null) return;
      items.push({ index: i, lean: lean, line: line });
    });
    items.sort(function (a, b) { return b.lean - a.lean; });

    riskListEl.innerHTML = "";
    items.forEach(function (item, rank) {
      var li = document.createElement("li");
      li.dataset.index = String(item.index);
      var tier = leanTier(item.lean);
      li.innerHTML =
        '<span class="risk-rank">' + (rank + 1) + "</span>" +
        '<span class="risk-snippet">' + escapeHtml(item.line.id || item.line.text) + "</span>" +
        '<span class="risk-pct tier-' + tier + '">' + leanLabel(item.lean) + "</span>";
      li.addEventListener("click", function () { selectLine(item.index); });
      riskListEl.appendChild(li);
    });
  }

  function renderSummary() {
    var claimCount = lines.filter(function (l) { return l.isClaim; }).length;
    var errorCount = results.filter(function (r) { return r && r.error; }).length;
    var violationCount = 0;
    lines.forEach(function (line, i) {
      if (line.isClaim && leanTier(leanOf(i)) === "violation") violationCount++;
    });
    var chips = [];
    chips.push('<span class="chip"><b>' + lines.length + '</b>&nbsp;lines &middot; <b>' + claimCount + '</b>&nbsp;checked against the contract</span>');
    if (violationCount > 0) {
      chips.push('<span class="chip"><span class="chip-dot" style="background:var(--status-violation)"></span><b>' + violationCount + '</b>&nbsp;likely ' + (violationCount > 1 ? "violations" : "violation") + "</span>");
    } else {
      chips.push('<span class="chip"><span class="chip-dot" style="background:var(--status-supported)"></span>nothing flagged</span>');
    }
    if (errorCount > 0) {
      chips.push('<span class="chip">' + errorCount + ' request' + (errorCount > 1 ? "s" : "") + ' failed</span>');
    }
    summaryChipsEl.innerHTML = chips.join("");
  }

  function selectLine(i) {
    selectedIndex = i;
    Array.prototype.forEach.call(documentLinesEl.children, function (el, idx) {
      el.classList.toggle("is-selected", idx === i);
    });
    Array.prototype.forEach.call(riskListEl.children, function (el) {
      el.classList.toggle("is-active", Number(el.dataset.index) === i);
    });
    lineRowEl(i).scrollIntoView({ block: "nearest", behavior: "smooth" });
    renderDetail(i);
  }

  function renderDetail(i) {
    var line = lines[i];
    if (!line.isClaim) {
      detailEl.innerHTML =
        '<p class="detail-claim">“' + escapeHtml(line.text) + '”</p>' +
        '<p class="detail-empty">' + (line.noRecordFor
          ? "References " + escapeHtml(line.noRecordFor) + ", but no matching clause was found in the evidence — not sent to Sapling."
          : "No clause reference in this line, so it was treated as prose and not sent to Sapling.") + "</p>";
      return;
    }

    var entry = results[i];
    if (!entry) {
      detailEl.innerHTML = '<p class="detail-empty">Still checking this line…</p>';
      return;
    }
    if (entry.error) {
      detailEl.innerHTML =
        '<p class="detail-claim">“' + escapeHtml(line.text) + '”</p>' +
        '<p class="detail-empty" style="color:var(--status-violation)">Request failed: ' + escapeHtml(entry.error) + "</p>";
      return;
    }

    var data = entry.result;
    var lean = computeLean(data.probabilities);
    var tier = leanTier(lean);
    var meta = STATUS_META[data.status] || STATUS_META.unsure;

    var html = "";
    html += '<p class="detail-claim">“' + escapeHtml(line.text) + '”</p>';
    html += '<div class="detail-label">Matched clause</div>';
    html += '<div class="detail-evidence">' + escapeHtml(line.evidence) + "</div>";

    html += '<div class="detail-label">Directional score</div>';
    html += '<div class="gauge">' +
      '<div class="gauge-track">' +
      '<div class="gauge-marker tier-' + tier + '" style="left:' + (lean * 100).toFixed(1) + '%"></div>' +
      "</div>" +
      '<div class="gauge-ends"><span>Supported</span><span>Violation</span></div>' +
      "</div>";
    html += '<p class="gauge-readout tier-' + tier + '">' + leanLabel(lean) + "</p>";
    html += '<p class="gauge-note">Computed from Sapling\'s own probabilities as violation &divide; (violation + supported) &mdash; isolating the one contrast a reviewer needs to act on.</p>';

    html += '<span class="status-badge" style="background:var(--status-' + meta.key + '-bg); color:var(--status-' + meta.key + ')">Calibrated status: ' + meta.label + "</span>";

    html += '<div class="detail-label" style="margin-top:14px">Full probability breakdown</div>';
    html += '<div class="bars">';
    PROB_ORDER.forEach(function (key) {
      var pct = data.probabilities && data.probabilities[key] != null ? data.probabilities[key] * 100 : 0;
      var barKey = key === "insufficient_information" ? "insufficient" : key === "inconsistent_context" ? "inconsistent" : key;
      html +=
        '<div class="bar-row">' +
        '<div class="bar-row-label">' + PROB_LABEL[key] + "</div>" +
        '<div class="bar-track"><div class="bar-fill" data-width="' + pct + '" style="background:var(--status-' + barKey + ')"></div></div>' +
        '<div class="bar-row-value">' + pct.toFixed(1) + "%</div>" +
        "</div>";
    });
    html += "</div>";

    var modelMs = data.timing_ms && data.timing_ms.model ? Math.round(data.timing_ms.model) : null;
    var set = (data.conformal_prediction_set || []).map(function (l) { return PROB_LABEL[l] || l; }).join(", ");
    html += '<div class="meta-list">';
    html += "<span>Raw argmax: <b>" + (PROB_LABEL[data.raw_label] || data.raw_label) + "</b></span>";
    html += "<span>Plausible set: <b>" + (set || "—") + "</b></span>";
    html += "<span>Model time: <b>" + (modelMs != null ? modelMs + " ms" : "—") + "</b> &middot; round trip <b>" + data._roundTripMs + " ms</b></span>";
    html += "</div>";

    html += '<details class="raw"><summary>View request &amp; response</summary><pre>' +
      escapeHtml("Request\n" + JSON.stringify(data._request, null, 2) + "\n\nResponse\n" + JSON.stringify(stripInternal(data), null, 2)) +
      "</pre></details>";

    detailEl.innerHTML = html;

    requestAnimationFrame(function () {
      detailEl.querySelectorAll(".bar-fill").forEach(function (el) {
        el.style.width = el.dataset.width + "%";
      });
    });
  }

  function stripInternal(data) {
    var copy = {};
    Object.keys(data).forEach(function (k) {
      if (k !== "_roundTripMs" && k !== "_request") copy[k] = data[k];
    });
    return copy;
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str == null ? "" : str;
    return div.innerHTML;
  }

  verifyBtn.addEventListener("click", runVerification);
  editBtn.addEventListener("click", function () {
    reviewEl.hidden = true;
    composeEl.hidden = false;
  });

  runVerification();
})();
