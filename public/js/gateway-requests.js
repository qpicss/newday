const card = document.getElementById('requests');
const requestsUrl = card.dataset.requestsUrl;
const rowsBody = document.getElementById('requestRows');
const filters = document.getElementById('filters');
const nodeNotes = document.getElementById('nodeNotes');
const liveButton = document.getElementById('toggleLive');
const liveIndicator = document.getElementById('liveIndicator');
const refreshButton = document.getElementById('refresh');
const pageSizeSelect = document.getElementById('pageSize');
const pager = document.getElementById('pager');
const pagerRange = document.getElementById('pagerRange');
const pagerPage = document.getElementById('pagerPage');
const POLL_MS = 5000;
const COLUMNS = 8;

let timer = null;
let loading = false;
let shownIds = new Set();
let entries = [];
let page = 0;
// Requests whose log is open, kept open across refreshes and pages.
const expanded = new Set();

const keyOf = (entry) => `${entry.node}:${entry.requestId}`;

function element(tag, { className, text } = {}, children = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    node.append(...children);
    return node;
}

const formatTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

function chevron() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M9 6l6 6-6 6');
    svg.append(path);
    return svg;
}

const pageSize = () => Number(pageSizeSelect.value) || 25;
const pageCount = () => Math.max(1, Math.ceil(entries.length / pageSize()));

const STEP_TYPES = {
    receive: 'Receive',
    route: 'Route',
    access: 'Access',
    rateLimit: 'Rate limit',
    respond: 'Respond',
    input: 'Input',
    output: 'Output',
    script: 'Gateway script',
    if: 'If',
    invoke: 'Invoke service',
    validateRequest: 'Validate request',
    validateBody: 'Validate body',
    security: 'Security',
};

// The step icons of the flow editor, plus the gateway's own steps.
const STEP_ICONS = {
    receive: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
    route: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    access: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M17 6l3 3M15 8l2 2"/>',
    rateLimit: '<path d="M12 14l4-4"/><path d="M3.3 17a9 9 0 1 1 17.4 0"/>',
    respond: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    input: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
    output: '<path d="M4 22V4M4 4h12l-2 4 2 4H4"/>',
    script: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M10 13l-2 2 2 2M14 13l2 2-2 2"/>',
    if: '<circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="7" r="2.5"/><path d="M6 7.5v9M18 9.5c0 4-4 4.5-9.5 7.5"/>',
    invoke: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>',
    validateRequest: '<path d="M11 6h10M11 12h10M11 18h10"/><path d="M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/>',
    validateBody: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M9 15l2 2 4-4"/>',
    security: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
};

function stepIcon(type) {
    const icon = element('span', { className: `flow-icon type-${type}` });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = STEP_ICONS[type] || STEP_ICONS.route;
    icon.append(svg);
    return icon;
}

// Every step of the request, in order: the gateway's own steps around the steps of the port's and the API's policies.
function flowLog(steps) {
    const list = element('ol', { className: 'test-steps flow-log' });
    let group;
    steps.forEach((step) => {
        const name = step.flow ? `Policy: ${step.flow}` : 'Gateway';
        if (name !== group) {
            group = name;
            list.append(element('li', { className: 'flow-log-flow', text: name }));
        }
        const kind = STEP_TYPES[step.type] || step.type;
        const title = element('div', { className: 'test-step-title' }, [
            element('span', { text: step.name }, step.name !== kind ? [element('span', { className: 'test-step-kind', text: kind })] : []),
            ...(step.durationMs !== undefined ? [element('span', { className: 'test-step-time', text: `${step.durationMs} ms` })] : []),
        ]);
        const lines = [
            ...(step.problems || []),
            ...(step.logs || []).map((line) => `[${line.level}] ${line.message}`),
        ];
        list.append(element('li', { className: `test-step type-${step.type}${step.error ? ' is-failed' : step.stop ? ' is-stopped' : ''}` }, [
            stepIcon(step.type),
            element('div', {}, [
                title,
                element('div', { className: 'test-step-text', text: step.error || step.outcome || '' }),
                ...(lines.length ? [element('pre', { text: lines.join('\n') })] : []),
            ]),
        ]));
    });
    return list;
}

// The row under a request that shows its log: every step, beside the whole entry.
function logRow(entry, id) {
    const hasFlow = Boolean(entry.flow && entry.flow.length);
    const steps = element('div', {}, [
        element('h3', { className: 'subsection-title', text: 'Steps' }),
        hasFlow
            ? flowLog(entry.flow)
            : element('p', { text: 'No steps were recorded: this node runs a gateway version that does not record them. Update the node to see every step.' }),
    ]);
    const cell = element('td', {}, [element('div', { className: 'request-log' }, [
        element('div', { className: 'request-log-grid' }, [
            steps,
            element('div', {}, [
                element('h3', { className: 'subsection-title', text: 'Log entry' }),
                element('pre', { text: JSON.stringify({ ...entry, flow: undefined }, null, 2) }),
            ]),
        ]),
        element('p', { text: 'Use the trace ID to find the same request in your tracing backend: the gateway forwards it upstream in traceparent.' }),
    ])]);
    cell.colSpan = COLUMNS;
    const row = element('tr', { className: 'request-log-row' }, [cell]);
    row.id = id;
    return row;
}

function toggle(row, entry, logId) {
    const open = row.getAttribute('aria-expanded') !== 'true';
    row.setAttribute('aria-expanded', String(open));
    if (open) {
        expanded.add(keyOf(entry));
        row.after(logRow(entry, logId));
    } else {
        expanded.delete(keyOf(entry));
        document.getElementById(logId)?.remove();
    }
}

function renderPager() {
    const total = entries.length;
    pager.hidden = total === 0;
    if (!total) return;
    const from = page * pageSize() + 1;
    const to = Math.min(total, from + pageSize() - 1);
    pagerRange.textContent = `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()} requests`;
    pagerPage.textContent = `Page ${page + 1} of ${pageCount()}`;
    const atStart = page === 0;
    const atEnd = page >= pageCount() - 1;
    pager.querySelector('[data-page="first"]').disabled = atStart;
    pager.querySelector('[data-page="prev"]').disabled = atStart;
    pager.querySelector('[data-page="next"]').disabled = atEnd;
    pager.querySelector('[data-page="last"]').disabled = atEnd;
}

function requestRow(entry, logId, isNew) {
    const statusClass = `status-code status-${Math.floor(entry.status / 100)}xx`;
    const row = element('tr', { className: 'request-row' }, [
        element('td', { className: 'request-toggle' }, [chevron()]),
        element('td', { className: 'mono-sm', text: formatTime(entry.time) }),
        element('td', {}, [
            element('div', { className: 'cell-primary mono-sm', text: `${entry.method} ${entry.path}` }),
            // The providers the gateway called for this request.
            ...(entry.upstream || []).map((call) => element('div', { className: 'cell-secondary mono-sm upstream-call', text: `→ ${call.method} ${call.url} · ${call.status || call.error} · ${call.durationMs} ms` })),
            ...(entry.threats || []).map((threat) => element('div', { className: 'cell-secondary mono-sm upstream-call threat-found', text: `! ${threat}` })),
            ...(entry.error ? [element('div', { className: 'node-error', text: entry.error })] : []),
        ]),
        element('td', {}, [element('span', { className: statusClass, text: String(entry.status) })]),
        element('td', { className: 'num', text: `${entry.durationMs} ms` }),
        element('td', { className: 'hide-sm', text: entry.api || '—' }),
        element('td', { className: 'hide-sm', text: entry.application || entry.clientId || '—' }),
        element('td', { className: 'hide-sm muted', text: entry.node }),
    ]);
    row.tabIndex = 0;
    row.setAttribute('aria-controls', logId);
    row.setAttribute('aria-expanded', String(expanded.has(keyOf(entry))));
    if (isNew) row.classList.add('fresh');
    row.addEventListener('click', () => {
        if (window.getSelection()?.toString()) return; // selecting text, not opening
        toggle(row, entry, logId);
    });
    row.addEventListener('keydown', (event) => {
        if (event.target !== row) return;
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle(row, entry, logId);
        }
    });
    return row;
}

function render() {
    page = Math.min(page, pageCount() - 1);
    renderPager();
    if (!entries.length) {
        const cell = element('td', { className: 'muted', text: 'No requests match. Send a call through the gateway, then refresh.' });
        cell.colSpan = COLUMNS;
        rowsBody.replaceChildren(element('tr', {}, [cell]));
        shownIds = new Set();
        return;
    }
    const previous = shownIds;
    shownIds = new Set(entries.map(keyOf));
    const rows = [];
    entries.slice(page * pageSize(), (page + 1) * pageSize()).forEach((entry, index) => {
        const logId = `request-log-${index}`;
        rows.push(requestRow(entry, logId, previous.size > 0 && !previous.has(keyOf(entry))));
        if (expanded.has(keyOf(entry))) rows.push(logRow(entry, logId));
    });
    rowsBody.replaceChildren(...rows);
}

async function load() {
    if (loading) return;
    loading = true;
    const params = new URLSearchParams();
    new FormData(filters).forEach((value, key) => { if (value) params.set(key, value); });
    try {
        const result = await UI.sendJson(`${requestsUrl}?${params}`, { method: 'GET' });
        entries = result.entries;
        render();
        const notes = result.nodes.filter((node) => !node.reachable || node.enabled === false)
            .map((node) => (node.reachable ? `${node.name}: request log is off` : `${node.name}: ${node.error}`));
        if (!result.nodes.length) notes.push('This gateway has no nodes yet. Add one on the gateway page.');
        nodeNotes.textContent = notes.join(' · ');
        nodeNotes.hidden = !notes.length;
    } catch (error) {
        UI.toast(error.message, 'error');
    }
    loading = false;
}

function setLive(live) {
    clearInterval(timer);
    timer = live ? setInterval(load, POLL_MS) : null;
    liveButton.setAttribute('aria-pressed', String(live));
    liveButton.textContent = live ? 'Pause' : 'Follow live';
    liveIndicator.textContent = live ? 'Live, every 5 s' : 'Paused';
    liveIndicator.classList.toggle('is-live', live);
}

liveButton.addEventListener('click', () => setLive(!timer));
refreshButton.addEventListener('click', load);

pager.addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (!button) return;
    const target = { first: 0, prev: page - 1, next: page + 1, last: pageCount() - 1 }[button.dataset.page];
    page = Math.max(0, Math.min(pageCount() - 1, target));
    render();
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Rows per page only changes what is shown; the other fields reload from the nodes.
pageSizeSelect.addEventListener('change', () => {
    page = 0;
    render();
});

let debounce;
filters.addEventListener('input', (event) => {
    if (event.target === pageSizeSelect) return;
    clearTimeout(debounce);
    page = 0;
    debounce = setTimeout(load, 300);
});
filters.addEventListener('submit', (event) => {
    event.preventDefault();
    load();
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden && timer) setLive(false);
});

load();
