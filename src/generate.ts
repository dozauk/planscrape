import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { getRecentApplications, getScrapeStatus } from './db';

const DISPLAY_DAYS = 14;

function buildHtml(appsJson: string, statusJson: string, generatedAt: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Planning Applications</title>
  <link href="https://unpkg.com/tabulator-tables@6.3.0/dist/css/tabulator.min.css" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 1600px; margin: 0 auto; padding: 16px 20px;
      color: #374151; background: #f9fafb;
    }
    h1 { font-size: 1.2rem; margin: 0 0 4px; color: #111827; }
    .subtitle { font-size: 12px; color: #9ca3af; margin: 0 0 12px; }
    .status-bar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; align-items: center; }
    .status-bar-label { font-size: 12px; color: #6b7280; font-weight: 500; }
    .chip {
      padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600;
      display: inline-flex; align-items: center; gap: 4px;
    }
    .chip-ok  { background: #d1fae5; color: #065f46; }
    .chip-warn{ background: #fef3c7; color: #92400e; }
    .chip-err { background: #fee2e2; color: #991b1b; }
    .controls {
      display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
      margin-bottom: 10px;
    }
    #search {
      padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 6px;
      font-size: 13px; width: 280px; background: #fff;
    }
    #search:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 2px #e0e7ff; }
    .count { font-size: 12px; color: #6b7280; }
    #clear-filters {
      margin-left: auto; padding: 5px 12px; font-size: 12px; font-weight: 500;
      border: 1px solid #d1d5db; border-radius: 6px; background: #fff;
      color: #6b7280; cursor: pointer;
    }
    #clear-filters:hover { background: #f3f4f6; color: #374151; border-color: #9ca3af; }
    #table { background: #fff; border-radius: 8px; overflow: hidden;
             box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .tabulator { border: none !important; font-size: 13px; }
    .tabulator .tabulator-header { background: #f3f4f6; border-bottom: 1px solid #e5e7eb; }
    .tabulator .tabulator-col { background: #f3f4f6; border-right: 1px solid #e5e7eb; }
    .tabulator .tabulator-col-title { font-weight: 600; color: #374151; }
    .tabulator .tabulator-row:nth-child(even) { background: #fafafa; }
    .tabulator .tabulator-row:hover { background: #eff6ff !important; }
    .tabulator-footer { border-top: 1px solid #e5e7eb; background: #f9fafb; }
    .dec-permitted { color: #065f46; font-weight: 500; }
    .dec-refused   { color: #991b1b; font-weight: 500; }
    .dec-withdrawn { color: #92400e; }
    .dec-other     { color: #374151; }
    .council-tw  { color: #1d4ed8; font-weight: 600; }
    .council-sev { color: #6d28d9; font-weight: 600; }
    .council-wea { color: #0369a1; font-weight: 600; }
    .pri-badge { padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; display: inline-block; }
    .pri-high   { background: #d1fae5; color: #065f46; }
    .pri-medium { background: #fef3c7; color: #92400e; }
    .pri-low    { background: #f3f4f6; color: #6b7280; font-weight: 400; }
    .pri-none   { background: #f3f4f6; color: #9ca3af; font-weight: 400; }
  </style>
</head>
<body>
  <h1>Planning Applications</h1>
  <p class="subtitle">Decided or appealed in the last ${DISPLAY_DAYS} days &mdash; generated ${generatedAt}</p>

  <div class="status-bar">
    <span class="status-bar-label">Last scraped:</span>
    <span id="status-chips"></span>
  </div>

  <div class="controls">
    <input id="search" type="text" placeholder="Search reference, address, description…">
    <span class="count" id="count"></span>
    <button id="clear-filters">Clear Filters</button>
  </div>

  <div id="table"></div>

  <script src="https://unpkg.com/tabulator-tables@6.3.0/dist/js/tabulator.min.js"></script>
  <script>
    const STATUS = ${statusJson};
    const DATA   = ${appsJson};

    // Status chips
    const chipsEl = document.getElementById('status-chips');
    const councils = ['TW', 'Sevenoaks', 'Wealden'];
    councils.forEach(council => {
      const s = STATUS.find(x => x.council === council);
      let cls = 'chip-err', label = council + ' — never scraped';
      if (s && s.last_success) {
        const ageH = (Date.now() - new Date(s.last_success).getTime()) / 3600000;
        cls = ageH < 25 ? 'chip-ok' : ageH < 49 ? 'chip-warn' : 'chip-err';
        const ageLabel = ageH < 1 ? '<1h ago'
          : ageH < 24 ? Math.round(ageH) + 'h ago'
          : Math.round(ageH / 24) + 'd ago';
        label = council + ' \u2014 ' + ageLabel;
      }
      chipsEl.innerHTML += '<span class="chip ' + cls + '">' + label + '</span> ';
    });

    // Decision colour helper
    function decisionClass(val) {
      if (!val) return 'dec-other';
      const v = val.toLowerCase();
      if (v.includes('permit') || v.includes('grant') || v.includes('approv') || v.includes('allow')) return 'dec-permitted';
      if (v.includes('refus') || v.includes('dismiss')) return 'dec-refused';
      if (v.includes('withdraw')) return 'dec-withdrawn';
      return 'dec-other';
    }

    // Council colour helper
    function councilClass(val) {
      if (val === 'TW') return 'council-tw';
      if (val === 'Sevenoaks') return 'council-sev';
      return 'council-wea';
    }

    // Priority badge helper
    function priorityBadge(val) {
      if (!val) return '<span style="color:#d1d5db;">—</span>';
      const label = val.charAt(0).toUpperCase() + val.slice(1);
      return '<span class="pri-badge pri-' + val + '">' + label + '</span>';
    }

    /**
     * Custom checkbox-dropdown header filter.
     * entries:       [{value, label}, ...]
     * initialValues: string[] of values to pre-check (optional)
     * Attaches dropdown to document.body (fixed positioning) to escape
     * Tabulator's overflow:hidden header cells.
     */
    const filterResets = [];

    function makeMultiCheckFilter(entries, initialValues) {
      initialValues = initialValues || [];
      return function(cell, onRendered, success) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative;width:100%;';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.style.cssText = 'width:100%;text-align:left;padding:2px 6px;font-size:11px;' +
          'border:1px solid #d1d5db;border-radius:4px;background:#fff;cursor:pointer;' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#374151;';
        wrap.appendChild(btn);

        const drop = document.createElement('div');
        drop.style.cssText = 'display:none;position:fixed;z-index:9999;background:#fff;' +
          'border:1px solid #d1d5db;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.15);' +
          'min-width:140px;padding:4px 0;';
        document.body.appendChild(drop);

        const checkboxes = [];
        entries.forEach(function(e) {
          const row = document.createElement('label');
          row.style.cssText = 'display:flex;align-items:center;gap:7px;padding:5px 10px;' +
            'cursor:pointer;font-size:12px;user-select:none;white-space:nowrap;';

          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = e.value;
          cb.checked = initialValues.includes(e.value);
          cb.style.cssText = 'width:13px;height:13px;cursor:pointer;accent-color:#6366f1;flex-shrink:0;';

          function updateBtn() {
            const checked = checkboxes.filter(function(c){ return c.checked; }).map(function(c){ return c.value; });
            btn.textContent = checked.length
              ? entries.filter(function(en){ return checked.includes(en.value); }).map(function(en){ return en.label; }).join(', ')
              : 'All';
            return checked;
          }

          cb.addEventListener('change', function() { success(updateBtn()); });

          row.addEventListener('mouseenter', function(){ row.style.background = '#f5f3ff'; });
          row.addEventListener('mouseleave', function(){ row.style.background = ''; });
          row.appendChild(cb);
          row.appendChild(document.createTextNode(e.label));
          drop.appendChild(row);
          checkboxes.push(cb);
        });

        // Set initial button text and activate initial filter once rendered
        onRendered(function() {
          const checked = checkboxes.filter(function(c){ return c.checked; }).map(function(c){ return c.value; });
          btn.textContent = checked.length
            ? entries.filter(function(en){ return checked.includes(en.value); }).map(function(en){ return en.label; }).join(', ')
            : 'All';
          if (checked.length) success(checked);
        });

        // Register a reset function for the Clear Filters button
        filterResets.push(function() {
          checkboxes.forEach(function(c){ c.checked = false; });
          btn.textContent = 'All';
          success([]);
        });

        let open = false;
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          open = !open;
          if (open) {
            const rect = btn.getBoundingClientRect();
            drop.style.top  = (rect.bottom + 2) + 'px';
            drop.style.left = rect.left + 'px';
            drop.style.display = 'block';
          } else {
            drop.style.display = 'none';
          }
        });

        document.addEventListener('click', function(e) {
          if (open && !wrap.contains(e.target) && !drop.contains(e.target)) {
            open = false;
            drop.style.display = 'none';
          }
        });

        return wrap;
      };
    }

    // Build dynamic entries for Decision / Appeal from the loaded data
    function colEntries(field) {
      return [...new Set(DATA.map(function(d){ return d[field]; }).filter(Boolean))].sort()
        .map(function(v){ return {value: v, label: v}; });
    }

    const PRIORITY_ENTRIES = [
      {value:'high',   label:'High'},
      {value:'medium', label:'Medium'},
      {value:'low',    label:'Low'},
      {value:'none',   label:'None'},
    ];
    const COUNCIL_ENTRIES = [
      {value:'TW',        label:'TW'},
      {value:'Sevenoaks', label:'Sevenoaks'},
      {value:'Wealden',   label:'Wealden'},
    ];
    const DECISION_DEFAULTS = ['Application Permitted', 'Approval', 'Granted'];

    // Shared filter func: empty selection = show all; else must be in selection
    function multiFilterFunc(headerVal, rowVal) {
      return !Array.isArray(headerVal) || headerVal.length === 0 || headerVal.includes(rowVal);
    }

    const table = new Tabulator('#table', {
      data: DATA,
      layout: 'fitColumns',
      pagination: true,
      paginationSize: 50,
      paginationSizeSelector: [25, 50, 100, true],
      movableColumns: true,
      initialSort: [{ column: 'decision_date', dir: 'desc' }],
      columns: [
        {
          title: 'Priority', field: 'priority', widthGrow: 0.6, minWidth: 85,
          headerFilter: makeMultiCheckFilter(PRIORITY_ENTRIES, ['high']),
          headerFilterFunc: multiFilterFunc,
          headerFilterEmptyCheck: (v) => !Array.isArray(v) || v.length === 0,
          formatter: (cell) => priorityBadge(cell.getValue()),
          tooltip: (e, cell) => cell.getData().priority_reason || '',
          sorter: (a, b) => {
            const order = { high: 0, medium: 1, low: 2, none: 3 };
            return (order[a] ?? 4) - (order[b] ?? 4);
          },
        },
        {
          title: 'Council', field: 'council', widthGrow: 0.7, minWidth: 80,
          headerFilter: makeMultiCheckFilter(COUNCIL_ENTRIES),
          headerFilterFunc: multiFilterFunc,
          headerFilterEmptyCheck: (v) => !Array.isArray(v) || v.length === 0,
          formatter: (cell) => '<span class="' + councilClass(cell.getValue()) + '">' + (cell.getValue() || '') + '</span>',
        },
        {
          title: 'Reference', field: 'applreference', widthGrow: 1.2, minWidth: 140,
          formatter: (cell) => {
            const url = cell.getData().detailsurl;
            return '<a href="' + url + '" target="_blank" style="color:#1a56db;text-decoration:none;">' + cell.getValue() + '</a>';
          },
        },
        { title: 'Address',     field: 'address',     widthGrow: 1.6, minWidth: 120, formatter: 'textarea' },
        { title: 'Description', field: 'description', widthGrow: 3.0, minWidth: 160, formatter: 'textarea' },
        { title: 'Validated',   field: 'datevalidated', widthGrow: 0.7, minWidth: 85, sorter: 'date', sorterParams: { format: 'YYYY-MM-DD' } },
        {
          title: 'Decision', field: 'decision', widthGrow: 1.0, minWidth: 100,
          headerFilter: makeMultiCheckFilter(colEntries('decision'), DECISION_DEFAULTS),
          headerFilterFunc: multiFilterFunc,
          headerFilterEmptyCheck: (v) => !Array.isArray(v) || v.length === 0,
          formatter: (cell) => '<span class="' + decisionClass(cell.getValue()) + '">' + (cell.getValue() || '') + '</span>',
        },
        {
          title: 'Dec. Date', field: 'decision_date', widthGrow: 0.7, minWidth: 85,
          sorter: 'date', sorterParams: { format: 'YYYY-MM-DD' },
        },
        {
          title: 'Appeal', field: 'appeal_decision', widthGrow: 0.9, minWidth: 85,
          headerFilter: makeMultiCheckFilter(colEntries('appeal_decision')),
          headerFilterFunc: multiFilterFunc,
          headerFilterEmptyCheck: (v) => !Array.isArray(v) || v.length === 0,
          formatter: (cell) => '<span class="' + decisionClass(cell.getValue()) + '">' + (cell.getValue() || '') + '</span>',
        },
        {
          title: 'App. Date', field: 'appeal_date', widthGrow: 0.7, minWidth: 85,
          sorter: 'date', sorterParams: { format: 'YYYY-MM-DD' },
        },
      ],
    });

    // Global search (OR across key text fields)
    document.getElementById('search').addEventListener('input', function(e) {
      const v = e.target.value;
      if (!v) { table.clearFilter(); return; }
      table.setFilter([[
        { field: 'applreference', type: 'like', value: v },
        { field: 'address',       type: 'like', value: v },
        { field: 'description',   type: 'like', value: v },
        { field: 'decision',      type: 'like', value: v },
      ]]);
    });

    // Clear Filters button — resets search box and all checkbox dropdowns
    document.getElementById('clear-filters').addEventListener('click', function() {
      document.getElementById('search').value = '';
      table.clearFilter();
      filterResets.forEach(function(reset){ reset(); });
    });

    function updateCount(rows) {
      document.getElementById('count').textContent =
        rows.length === DATA.length
          ? DATA.length + ' applications'
          : rows.length + ' of ' + DATA.length + ' applications';
    }
    table.on('dataFiltered', (_, rows) => updateCount(rows));
    table.on('tableBuilt', () => updateCount(DATA));
  </script>
</body>
</html>`;
}

export function generateHtml(dbPath: string, outputDir: string): void {
  const db = new Database(dbPath, { readonly: true });
  const apps = getRecentApplications(db, DISPLAY_DAYS);
  const status = getScrapeStatus(db);
  db.close();

  const generatedAt = new Date().toUTCString();
  const html = buildHtml(JSON.stringify(apps), JSON.stringify(status), generatedAt);

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, 'index.html'), html, 'utf8');
  console.log(`[generate] ${apps.length} applications → ${outputDir}/index.html`);
}
