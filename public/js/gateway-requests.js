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

// The row under a request that shows its whole log entry.
function logRow(entry, id) {
    const cell = element('td', {}, [element('div', { className: 'request-log' }, [
        element('p', { text: 'Use the trace ID to find the same request in your tracing backend: the gateway forwards it upstream in traceparent.' }),
        element('pre', { text: JSON.stringify(entry, null, 2) }),
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
