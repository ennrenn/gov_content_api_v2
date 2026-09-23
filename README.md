# GOV.UK Content Monitor

A static, no-backend page (works on GitHub Pages) that pulls the latest GOV.UK content
across a 27-branch topic watch list, lets you filter and date-range it, and exports the
result to CSV, JSON or Excel. Everything runs in the visitor's own browser — nothing is
sent to or stored on a server.

## What changed in this version

Four things, all requested together:

1. **Taxonomy is rebuilt live, every run.** Earlier versions of this tool shipped a
   static `taxonomy.json` snapshot of GOV.UK's topic tree, built once and bundled with
   the site. That snapshot could go stale. This version instead calls the Content API's
   20 top-level branches fresh every time you press "Run pull", and rebuilds the full
   topic lookup from that response. `taxonomy.json` and `taxonomy-loader.js` are no
   longer used and have been removed — everything now lives in `app.js`.
2. **Runs the current 27-branch watch list**, with "Work" included and "Working, jobs
   and pensions" removed (redundant — it sits under "Work"), and "Employing people"
   correctly retained (its real parent is "Running a business", not "Work", despite the
   name — this was checked against the taxonomy directly, not assumed from the name).
3. **Date range picker**, filtering the already-loaded results in the browser.
4. **Exports respect the date range** (and every other active filter), because they
   read from the same filtered array the table is built from.

## How a run works

Press "Run pull" and two things happen in sequence:

**Phase 1 — rebuild the taxonomy.** The tool fetches all 20 top-level taxonomy branches
from the Content API (`https://www.gov.uk/api/content/<branch>`), and walks each one's
`links.child_taxons` recursively — GOV.UK returns a branch's entire subtree in one call,
so this is 20 requests total, not one per taxon. It builds a title → content_id lookup
from the result and uses that to resolve the 27 watch-list names (see `WATCH_LIST_TITLES`
at the top of `app.js`) to their actual taxon IDs for this run. Titles are used rather
than hardcoded IDs so the list stays readable and editable without needing to know any
UUIDs — if you need to change the watch list, edit that array.

**Phase 2 — the content pull.** One Search API call, across every resolved branch ID,
with no format filter — same design as before:

```
https://www.gov.uk/api/search.json
  ?filter_part_of_taxonomy_tree[]=<id 1>
  &filter_part_of_taxonomy_tree[]=<id 2>
  ... (one per resolved branch)
  &order=-public_timestamp
  &count=1500
  &fields=title&fields=description&fields=link&fields=public_timestamp
  &fields=format&fields=organisations&fields=taxons&fields=content_id
  &fields=content_store_document_type
```

This is deliberately the simple, unrestricted single-call design (Government branch
included, no format restriction) chosen for this interactive tool — all filtering,
including by format, happens here in the browser afterwards. This is not the most
precise option (a split call that restricts Government to a handful of "agreed"
formats would waste less of the 1,500-result budget on noise and reach further back
in time); it was chosen for simplicity. See the separate decision note from the
original exploration work if you want the fuller comparison.

## Date range — why it's not sent to the API

GOV.UK's Search API does have a native date filter (`filter_public_timestamp`), but
testing during this project found it unreliable — a known, correctly-dated item was
sometimes missing from date-filtered results. So this tool never sends a date filter
to the API. Instead it always pulls the full 1,500-result set (newest first) and
applies whatever date range you pick to that already-loaded data, in the same place
as the text/department/format/topic filters. Exports are built from that same
filtered set, so a CSV, JSON or Excel download always matches what's on screen,
including the date range.

One consequence worth knowing: if you pick a date range older than the oldest item
the 1,500-result pull actually reached, you won't see anything from before that —
the date filter can only narrow what was pulled, not extend it. At `count=1500`
across all 27 branches (Government included, unrestricted), reach has typically been
several weeks; if you need guaranteed coverage further back than that, run the pull
more frequently and keep your own archive.

## A caveat worth knowing: Content API and CORS

The Search API (`/api/search.json`) has been directly confirmed to allow cross-origin
browser requests — this was tested from DevTools Console during this project and
works without a proxy. The Content API (`/api/content/*`), which Phase 1 now depends
on for the live taxonomy rebuild, has **not** been separately confirmed the same way.
It's expected to behave the same way (same GOV.UK platform, same general CORS policy),
but this is an assumption, not a tested fact.

If it turns out the Content API blocks cross-origin requests from a GitHub Pages
domain, Phase 1 will fail for some or all of the 20 branches. The tool is built to
degrade gracefully if that happens: it reports which branches failed in the status
box, and depending on which watch-list taxons could still be resolved, either runs
a partial pull or stops and tells you plainly rather than silently returning less
than you'd expect. If you hit this in practice, the fix would be reintroducing a
small bundled fallback taxonomy snapshot as a backup path — not something built in
yet, since it wasn't needed before this tool depended on live Content API calls.

## Editing the watch list

Change the `WATCH_LIST_TITLES` array near the top of `app.js`. Use the taxon's exact
title as it appears on GOV.UK (case-sensitive). If a title doesn't resolve against the
rebuilt taxonomy — typo, or the taxon's been renamed — the tool will say so in the
status box and just skip it for that run, rather than failing the whole pull.

This did happen on first real-world run: two entries were stale. "Education" is
actually titled "Education, training and skills" on GOV.UK, and the taxon originally
called "Further/higher education and vocational training during COVID-19" has since
been renamed (the COVID framing retired) to "Further and higher education, skills and
vocational training" — confirmed directly against the live API and corrected in
`app.js`. Worth knowing: matching by title means a future GOV.UK rename will silently
drop that branch from a run until the status box is checked and the title updated
here — matching by content_id wouldn't have this problem, but titles are what's
readable and editable without needing to look up a UUID. If this becomes a recurring
issue, the fix would be storing both the title and its last-known content_id, so a
rename can be flagged as "title changed but ID matched" rather than "not found" —
not built yet, since it wasn't needed until this first run surfaced it.

## Files

- `index.html` — page structure and controls
- `style.css` — styling
- `app.js` — all logic: taxonomy rebuild, the sweep call, filtering (including
  date range), and CSV/JSON/Excel export
- No `taxonomy.json` / `taxonomy-loader.js` — removed, replaced by the live rebuild
