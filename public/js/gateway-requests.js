const card = document.getElementById('requests');
const requestsUrl = card.dataset.requestsUrl;
const rowsBody = document.getElementById('requestRows');
const filters = document.getElementById('filters');
const nodeNotes = document.getElementById('nodeNotes');
const detail = document.getElementById('requestDetail');
const liveButton = document.getElementById('toggleLive');
const liveIndicator = document.getElementById('liveIndicator');
const refreshButton = document.getElementById('refresh');
const POLL_MS = 5000;

let timer = null;
let loading = false;
let shownIds = new Set();

function element(tag, { className, text } = {}, children = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    node.append(...children);
    return node;
}

const formatTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

function showDetail(entry) {
    detail.querySelector('[data-detail-title]').textContent = `${entry.method} ${entry.path}`;
    detail.querySelector('[data-detail-body]').textContent = JSON.stringify(entry, null, 2);
    detail.hidden = false;
    detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function render(entries) {
    if (!entries.length) {
        rowsBody.replaceChildren(element('tr', {}, [element('td', { className: 'muted', text: 'No requests match. Send a call through the gateway, then refresh.' })]));
        rowsBody.firstChild.firstChild.colSpan = 7;
        shownIds = new Set();
        return;
    }
    const previous = shownIds;
    shownIds = new Set(entries.map((entry) => `${entry.node}:${entry.requestId}`));
    rowsBody.replaceChildren(...entries.map((entry) => {
        const statusClass = `status-code status-${Math.floor(entry.status / 100)}xx`;
        const row = element('tr', { className: 'request-row' }, [
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
        if (previous.size && !previous.has(`${entry.node}:${entry.requestId}`)) row.classList.add('fresh');
        row.addEventListener('click', () => showDetail(entry));
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                showDetail(entry);
            }
        });
        return row;
    }));
}

async function load() {
    if (loading) return;
    loading = true;
    const params = new URLSearchParams();
    new FormData(filters).forEach((value, key) => { if (value) params.set(key, value); });
    try {
        const result = await UI.sendJson(`${requestsUrl}?${params}`, { method: 'GET' });
        render(result.entries);
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
detail.querySelector('[data-close-detail]').addEventListener('click', () => { detail.hidden = true; });

let debounce;
filters.addEventListener('input', () => {
    clearTimeout(debounce);
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
