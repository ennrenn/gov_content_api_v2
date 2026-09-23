/* =========================================================================
   GOV.UK Content Monitor — app.js
   -------------------------------------------------------------------------
   Two phases each time you press "Run":
     1. Rebuild the taxonomy live from the Content API (20 top-level branch
        calls, each recursively expanded by GOV.UK into its full subtree via
        links.child_taxons). This replaces the old bundled taxonomy.json
        snapshot so topic names are always current.
     2. Resolve the 27 watch-list branch names against that fresh taxonomy,
        then run ONE unrestricted Search API call across all of them
        (no format filter — filtering happens here in the browser).

   Date range: the Search API's own date filter (filter_public_timestamp)
   was found to be unreliable during earlier testing on this project, so it
   is never used here. Instead the full unfiltered result set is pulled
   (count=1500, newest first) and any date range you pick is applied
   client-side, in the same place as the other filters — so exports always
   match whatever is on screen.
   ========================================================================= */

const SEARCH_BASE = "https://www.gov.uk/api/search.json";
const CONTENT_BASE = "https://www.gov.uk/api/content";

// The 20 top-level taxonomy branches. GOV.UK's Content API expands each of
// these into its entire descendant tree in a single call.
const TOP_LEVEL_BRANCHES = [
  "health-and-social-care",
  "money",
  "crime-justice-and-law",
  "defence-and-armed-forces",
  "work",
  "life-circumstances",
  "welfare",
  "housing-local-and-community",
  "society-and-culture",
  "international",
  "regional-and-local-government",
  "government/all",
  "environment",
  "business-and-industry",
  "transport",
  "education",
  "going-and-being-abroad",
  "entering-staying-uk",
  "childcare-parenting",
  "corporate-information",
];

// The 27-branch watch list, by exact taxon title. Resolved against the
// freshly-rebuilt taxonomy each run, rather than hardcoded content_ids, so
// this file never goes stale even if a taxon's ID were ever to change.
// Edit this list to change what the tool watches.
const WATCH_LIST_TITLES = [
  "Education",
  "Government",
  "Work",
  "Childcare and early years",
  "Devolution",
  "Financial services",
  "Government graduate schemes",
  "Industrial strategy",
  "Labour market reform",
  "Local government",
  "Manufacturing",
  "National Health Service",
  "Public health",
  "Research and innovation in health and social care",
  "Technology in health and social care",
  "UK economy",
  "Visas and entry clearance",
  "Visas and immigration corporate",
  "Young people",
  "Youth employment and social issues",
  "Artificial intelligence",
  "Employing people",
  "Mental health of children and young people",
  "Pharmacy",
  "Regulation reform",
  "Research and development",
  "Further/higher education and vocational training during COVID-19",
];

const RESULT_FIELDS = [
  "title",
  "description",
  "link",
  "public_timestamp",
  "format",
  "organisations",
  "taxons",
  "content_id",
  "content_store_document_type",
];

// ---- state ----------------------------------------------------------------
let taxonomyById = new Map();     // content_id -> { title, basePath }
let taxonomyByTitle = new Map();  // exact title -> [content_id, ...]
let rawResults = [];              // everything the sweep call returned
let filteredResults = [];         // rawResults after current filters applied
let taxonomyBuildFailed = false;

const el = (id) => document.getElementById(id);

function setStatus(msg, isError) {
  const box = el("status");
  box.textContent = msg;
  box.className = isError ? "status error" : "status";
}

function appendStatus(msg) {
  const box = el("status");
  box.textContent = box.textContent ? box.textContent + "\n" + msg : msg;
}

// ---- phase 1: live taxonomy rebuild ---------------------------------------

function walkTaxonTree(node, sink) {
  if (!node || !node.content_id) return;
  sink.set(node.content_id, {
    title: node.title || "(untitled)",
    basePath: node.base_path || "",
  });
  const children = (node.links && node.links.child_taxons) || [];
  for (const child of children) walkTaxonTree(child, sink);
}

async function fetchBranch(path) {
  const url = `${CONTENT_BASE}/${path}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
  return resp.json();
}

async function buildTaxonomy() {
  const byId = new Map();
  let ok = 0;
  let failed = [];

  setStatus(`Rebuilding taxonomy: 0 / ${TOP_LEVEL_BRANCHES.length} branches loaded...`);

  const settled = await Promise.allSettled(TOP_LEVEL_BRANCHES.map(fetchBranch));

  settled.forEach((result, i) => {
    const branch = TOP_LEVEL_BRANCHES[i];
    if (result.status === "fulfilled") {
      walkTaxonTree(result.value, byId);
      ok++;
    } else {
      failed.push(branch);
    }
  });

  appendStatus(
    `Taxonomy rebuild: ${ok}/${TOP_LEVEL_BRANCHES.length} branches loaded (${byId.size} taxons total).`
  );
  if (failed.length) {
    appendStatus(
      `Warning: could not load ${failed.length} branch(es) — ${failed.join(", ")}. ` +
      `Topic names for content under these branches may be missing, and any watch-list ` +
      `taxon that lives only under them will not be included in this run.`
    );
  }

  const byTitle = new Map();
  for (const [id, info] of byId.entries()) {
    if (!byTitle.has(info.title)) byTitle.set(info.title, []);
    byTitle.get(info.title).push(id);
  }

  taxonomyById = byId;
  taxonomyByTitle = byTitle;
  taxonomyBuildFailed = ok === 0;
  return { ok, failed };
}

function resolveWatchListIds() {
  const ids = [];
  const missing = [];
  for (const title of WATCH_LIST_TITLES) {
    const matches = taxonomyByTitle.get(title);
    if (matches && matches.length) {
      ids.push(...matches);
    } else {
      missing.push(title);
    }
  }
  if (missing.length) {
    appendStatus(
      `Warning: ${missing.length} watch-list taxon(s) not found in the rebuilt taxonomy — ` +
      `${missing.join(", ")}. These are skipped for this run (the taxon may have been ` +
      `renamed, or its branch failed to load above).`
    );
  }
  return ids;
}

// ---- phase 2: the single 27-branch sweep call ------------------------------

function buildSweepUrl(branchIds) {
  const url = new URL(SEARCH_BASE);
  for (const id of branchIds) url.searchParams.append("filter_part_of_taxonomy_tree[]", id);
  url.searchParams.set("order", "-public_timestamp");
  url.searchParams.set("count", "1500");
  for (const f of RESULT_FIELDS) url.searchParams.append("fields", f);
  return url.toString();
}

function resolveTaxonNames(taxons) {
  if (!Array.isArray(taxons) || !taxons.length) return "";
  return taxons
    .map((t) => {
      if (t && typeof t === "object") {
        if (t.title) return t.title;
        if (t.content_id && taxonomyById.has(t.content_id)) {
          return taxonomyById.get(t.content_id).title;
        }
        return t.content_id || "";
      }
      // plain string content_id
      if (taxonomyById.has(t)) return taxonomyById.get(t).title;
      return t;
    })
    .filter(Boolean)
    .join("; ");
}

function resolveOrgNames(organisations) {
  if (!Array.isArray(organisations) || !organisations.length) return "";
  return organisations
    .map((o) => (o && typeof o === "object" ? o.title : o))
    .filter(Boolean)
    .join("; ");
}

function enrichResult(item) {
  return {
    title: item.title || "",
    description: item.description || "",
    link: item.link ? `https://www.gov.uk${item.link}` : "",
    published: item.public_timestamp || "",
    format: item.format || item.content_store_document_type || "",
    department: resolveOrgNames(item.organisations),
    topics: resolveTaxonNames(item.taxons),
    contentId: item.content_id || "",
  };
}

async function runSweep() {
  el("runBtn").disabled = true;
  el("results").innerHTML = "";
  el("resultCount").textContent = "";
  setStatus("Starting...");

  try {
    await buildTaxonomy();

    if (taxonomyBuildFailed) {
      appendStatus(
        "Could not load any part of the taxonomy — topic names will show as raw IDs. " +
        "This usually means the Content API is unreachable from here right now " +
        "(unlike the Search API, cross-browser access to the Content API has not " +
        "been separately confirmed for this tool)."
      );
    }

    const branchIds = resolveWatchListIds();
    if (!branchIds.length) {
      setStatus(
        "Could not resolve any of the 27 watch-list topics against the rebuilt taxonomy — " +
        "stopping before the content call. Check your network connection and try again.",
        true
      );
      el("runBtn").disabled = false;
      return;
    }

    appendStatus(`Fetching content across ${branchIds.length} resolved topic branch(es)...`);
    const sweepUrl = buildSweepUrl(branchIds);
    const resp = await fetch(sweepUrl);
    if (!resp.ok) throw new Error(`Search API returned HTTP ${resp.status}`);
    const data = await resp.json();

    rawResults = (data.results || []).map(enrichResult);
    appendStatus(`Done — ${rawResults.length} results loaded (newest first, count=1500).`);

    populateFilterOptions();
    applyFilters();
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  } finally {
    el("runBtn").disabled = false;
  }
}

// ---- filtering (text / department / topic / format / date range) ---------

function populateFilterOptions() {
  const formats = new Set();
  const depts = new Set();
  rawResults.forEach((r) => {
    if (r.format) formats.add(r.format);
    r.department.split("; ").forEach((d) => d && depts.add(d));
  });

  fillSelect(el("formatFilter"), formats);
  fillSelect(el("deptFilter"), depts);
}

function fillSelect(select, values) {
  const current = select.value;
  select.innerHTML = '<option value="">All</option>';
  [...values].sort().forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  });
  if ([...values].includes(current)) select.value = current;
}

function applyFilters() {
  const text = el("textFilter").value.trim().toLowerCase();
  const dept = el("deptFilter").value;
  const format = el("formatFilter").value;
  const topic = el("topicFilter").value.trim().toLowerCase();
  const dateFrom = el("dateFrom").value; // "YYYY-MM-DD" or ""
  const dateTo = el("dateTo").value;

  filteredResults = rawResults.filter((r) => {
    if (text && !(r.title.toLowerCase().includes(text) || r.description.toLowerCase().includes(text))) {
      return false;
    }
    if (dept && !r.department.includes(dept)) return false;
    if (format && r.format !== format) return false;
    if (topic && !r.topics.toLowerCase().includes(topic)) return false;

    if (dateFrom || dateTo) {
      if (!r.published) return false;
      const publishedDate = r.published.slice(0, 10); // "YYYY-MM-DD"
      if (dateFrom && publishedDate < dateFrom) return false;
      if (dateTo && publishedDate > dateTo) return false;
    }
    return true;
  });

  renderTable(filteredResults);
}

function renderTable(rows) {
  const tbody = el("results");
  tbody.innerHTML = "";
  const frag = document.createDocumentFragment();

  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(formatDate(r.published))}</td>
      <td>${escapeHtml(r.format)}</td>
      <td><a href="${escapeHtml(r.link)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a><div class="desc">${escapeHtml(r.description)}</div></td>
      <td>${escapeHtml(r.department)}</td>
      <td>${escapeHtml(r.topics)}</td>
    `;
    frag.appendChild(tr);
  });

  tbody.appendChild(frag);
  el("resultCount").textContent = `${rows.length} of ${rawResults.length} result(s) shown`;
}

function formatDate(iso) {
  if (!iso) return "";
  return iso.slice(0, 10);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- export (respects whatever filters, including date range, are active) -

function exportCsv() {
  if (!filteredResults.length) return;
  const headers = ["Published", "Format", "Title", "Description", "Department(s)", "Topic(s)", "Content ID", "Link"];
  const rows = filteredResults.map((r) => [
    r.published, r.format, r.title, r.description, r.department, r.topics, r.contentId, r.link,
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\r\n");
  downloadBlob(csv, "govuk-content-pull.csv", "text/csv;charset=utf-8;");
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exportJson() {
  if (!filteredResults.length) return;
  const json = JSON.stringify(filteredResults, null, 2);
  downloadBlob(json, "govuk-content-pull.json", "application/json");
}

function exportXlsx() {
  if (!filteredResults.length) return;
  const headers = ["Published", "Format", "Title", "Description", "Department(s)", "Topic(s)", "Content ID", "Link"];
  const rows = filteredResults.map((r) => [
    r.published, r.format, r.title, r.description, r.department, r.topics, r.contentId, r.link,
  ]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Results");
  XLSX.writeFile(wb, "govuk-content-pull.xlsx");
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---- wire up ----------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  el("runBtn").addEventListener("click", runSweep);
  el("textFilter").addEventListener("input", applyFilters);
  el("deptFilter").addEventListener("change", applyFilters);
  el("formatFilter").addEventListener("change", applyFilters);
  el("topicFilter").addEventListener("input", applyFilters);
  el("dateFrom").addEventListener("change", applyFilters);
  el("dateTo").addEventListener("change", applyFilters);
  el("clearDates").addEventListener("click", () => {
    el("dateFrom").value = "";
    el("dateTo").value = "";
    applyFilters();
  });
  el("exportCsv").addEventListener("click", exportCsv);
  el("exportJson").addEventListener("click", exportJson);
  el("exportXlsx").addEventListener("click", exportXlsx);
});
