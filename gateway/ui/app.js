// Gateway admin UI. All server data is inserted with textContent.
(function () {
    const page = document.getElementById('page');
    const state = { user: null, overview: null, stream: null, paused: false, rows: [], filters: { status: '', api: '', text: '' }, timer: null };

    // ---------------------------------------------------------------- helpers
    function h(tag, attributes = {}, children = []) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attributes)) {
            if (value === undefined || value === null || value === false) continue;
            if (key === 'text') node.textContent = value;
            else if (key === 'class') node.className = value;
            else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
            else node.setAttribute(key, value === true ? '' : value);
        }
        for (const child of [].concat(children)) {
            if (child === null || child === undefined || child === false) continue;
            node.append(child instanceof Node ? child : document.createTextNode(String(child)));
        }
        return node;
    }

    async function api(path, { method = 'GET', body } = {}) {
        const response = await fetch(path, {
            method,
            headers: { ...(method !== 'GET' && { 'x-gateway-ui': '1' }), ...(body && { 'content-type': 'application/json' }) },
            body: body ? JSON.stringify(body) : undefined,
            credentials: 'same-origin',
        });
        let data = null;
        try {
            data = await response.json();
        } catch {
            data = null;
        }
        if (response.status === 401 && path !== '/api/login') {
            showLogin();
            throw new Error('Signed out');
        }
        if (!response.ok) throw new Error((data && data.error) || `Request failed (${response.status})`);
        return data;
    }

    const formatTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const shortTime = (point) => new Date(point.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const formatDate = (value) => (value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
    const duration = (seconds) => {
        if (seconds < 60) return `${seconds}s`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
        return `${Math.floor(seconds / 86400)} d ${Math.floor((seconds % 86400) / 3600)} h`;
    };
    const statusClass = (status) => `status s${Math.floor(status / 100)}`;
    const pill = (text, tone) => h('span', { class: `pill ${tone || ''}`, text });
    const daysUntil = (date) => Math.floor((new Date(date) - Date.now()) / 86400000);

    function card(title, body, actions) {
        return h('section', { class: 'card' }, [
            h('div', { class: 'card-head' }, [h('h2', { text: title }), actions || null]),
            body,
        ]);
    }

    function rows(items) {
        if (!items.length) return h('div', { class: 'card-body' }, h('p', { class: 'muted', text: 'Nothing here yet.' }));
        return h('div', { class: 'card-body rows' }, items.map(([title, detail, end]) => h('div', { class: 'row' }, [
            h('div', { class: 'row-main' }, [h('strong', { text: title }), detail ? h('span', { text: detail }) : null]),
            end || null,
        ])));
    }

    function kv(pairs) {
        return h('dl', { class: 'kv' }, pairs.flatMap(([key, value]) => [h('dt', { text: key }), h('dd', {}, value instanceof Node ? value : String(value ?? '—'))]));
    }

    // ---------------------------------------------------------------- auth
    function showLogin() {
        stopStream();
        clearInterval(state.timer);
        document.getElementById('app-view').hidden = true;
        document.getElementById('login-view').hidden = false;
    }

    async function showApp() {
        document.getElementById('login-view').hidden = true;
        document.getElementById('app-view').hidden = false;
        document.getElementById('user-name').textContent = `${state.user.name} · ${state.user.organization}`;
        await refreshOverview();
        route();
    }

    document.getElementById('login-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = document.getElementById('login-button');
        const error = document.getElementById('login-error');
        error.hidden = true;
        button.disabled = true;
        button.textContent = 'Checking with the console…';
        try {
            const result = await api('/api/login', {
                method: 'POST',
                body: { email: document.getElementById('email').value, password: document.getElementById('password').value },
            });
            state.user = result.user;
            document.getElementById('password').value = '';
            await showApp();
        } catch (problem) {
            error.textContent = problem.message;
            error.hidden = false;
        }
        button.disabled = false;
        button.textContent = 'Sign in';
    });

    document.getElementById('logout').addEventListener('click', async () => {
        await api('/api/logout', { method: 'POST' }).catch(() => {});
        state.user = null;
        showLogin();
    });

    async function refreshOverview() {
        state.overview = await api('/api/overview');
        document.getElementById('gateway-name').textContent = state.overview.gatewayName;
        document.title = `${state.overview.gatewayName} · Gateway admin`;
    }

    // ---------------------------------------------------------------- overview
    function renderOverview() {
        const o = state.overview;
        const total = o.stats.requests;
        const errors = o.stats.byStatus['5xx'] || 0;
        const certificateDays = daysUntil(o.certificate.validTo);
        const listening = o.handlers.filter((handler) => handler.listening).length;

        page.replaceChildren(
            h('div', { class: 'page-head' }, [
                h('div', {}, [h('h1', { text: 'Overview' }), h('p', { class: 'muted', text: `Node ${o.nodeName} · configuration ${o.version || 'not received yet'}` })]),
                h('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Refresh', onclick: async () => { await refreshOverview(); renderOverview(); } }),
            ]),
            h('div', { class: 'tiles' }, [
                tile('Requests since start', total.toLocaleString(), `up ${duration(o.uptimeSeconds)}`),
                tile('Server errors (5xx)', errors.toLocaleString(), total ? `${((errors / total) * 100).toFixed(1)}% of requests` : 'none yet'),
                tile('Ports listening', `${listening} of ${o.handlers.length}`, o.handlers.length ? null : 'no handlers configured'),
                tile('Certificate', certificateDays >= 0 ? `${certificateDays} days` : 'expired', `valid until ${formatDate(o.certificate.validTo)}`),
            ]),
            h('div', { class: 'grid-2' }, [
                card('Connection handlers', rows(o.handlers.map((handler) => [
                    `${handler.name} · ${handler.protocol.toUpperCase()} :${handler.port}`,
                    handler.error || (handler.policy ? `Port policy: ${handler.policy}` : 'No port policy'),
                    handler.listening ? pill('Listening', 'good') : pill('Not listening', 'bad'),
                ]))),
                card('APIs', rows(o.apis.map((item) => [
                    `${item.name} · ${item.basePath}`,
                    [`${item.operations} operations`, item.policy && `policy ${item.policy}`, item.connection && `connection ${item.connection}`].filter(Boolean).join(' · '),
                    item.circuit && item.circuit !== 'closed' ? pill(`Circuit ${item.circuit}`, 'bad') : null,
                ]))),
                card('Management console', h('div', { class: 'card-body' }, kv([
                    ['Address', o.link.url || 'not known yet'],
                    ['Source', o.link.source || '—'],
                    ['Last contact', formatDate(o.link.lastContactAt)],
                    ['Status', o.link.lastError ? pill(o.link.lastError, 'bad') : o.link.url ? pill('Connected', 'good') : pill('Waiting for a push', 'warn')],
                ]))),
                card('Rate limits', h('div', { class: 'card-body' }, kv([
                    ['Mode', o.rateLimits.mode === 'redis' ? 'Shared through Redis' : 'Local to this node'],
                    ['Status', o.rateLimits.mode === 'redis'
                        ? (o.rateLimits.healthy ? pill('Redis connected', 'good') : pill(`Redis unavailable, using local limits${o.rateLimits.lastError ? `: ${o.rateLimits.lastError}` : ''}`, 'bad'))
                        : pill(`Each node allows 1/${o.nodeCount} of a product limit`, '')],
                    ['Products', o.products.map((product) => `${product.name} (${product.rateLimit})`).join(', ') || 'none'],
                ]))),
            ]),
        );
    }

    function tile(label, value, note) {
        return h('div', { class: 'card tile' }, [h('div', { class: 'tile-label', text: label }), h('div', { class: 'tile-value', text: value }), note ? h('div', { class: 'tile-note', text: note }) : null]);
    }

    // ---------------------------------------------------------------- live requests
    function stopStream() {
        if (state.stream) state.stream.close();
        state.stream = null;
    }

    function matches(entry) {
        const { status, api: apiName, text } = state.filters;
        if (status && `${Math.floor(entry.status / 100)}xx` !== status) return false;
        if (apiName && entry.api !== apiName) return false;
        if (text && !`${entry.method} ${entry.path} ${entry.requestId} ${entry.traceId} ${entry.application || ''} ${entry.error || ''}`.toLowerCase().includes(text.toLowerCase())) return false;
        return true;
    }

    function requestRow(entry, fresh) {
        const row = h('tr', { class: `clickable${fresh ? ' fresh' : ''}`, tabindex: '0' }, [
            h('td', { class: 'mono', text: formatTime(entry.time) }),
            h('td', {}, [
                h('span', { class: 'mono', text: `${entry.method} ` }), h('span', { class: 'path', text: entry.path }),
                ...(entry.upstream || []).map((call) => h('div', { class: 'muted mono upstream-call', text: `→ ${call.method} ${call.url} · ${call.status || call.error}` })),
                ...(entry.threats || []).map((threat) => h('div', { class: 'mono upstream-call threat-found', text: `! ${threat}` })),
            ]),
            h('td', {}, h('span', { class: statusClass(entry.status), text: String(entry.status) })),
            h('td', { class: 'num', text: `${entry.durationMs} ms` }),
            h('td', { class: 'hide-sm', text: entry.api || '—' }),
            h('td', { class: 'hide-sm', text: entry.application || entry.clientId || '—' }),
        ]);
        const open = () => showDetail(entry);
        row.addEventListener('click', open);
        row.addEventListener('keydown', (event) => { if (event.key === 'Enter') open(); });
        return row;
    }

    function showDetail(entry) {
        const detail = document.getElementById('request-detail');
        const pre = h('pre', { text: JSON.stringify(entry, null, 2) });
        detail.replaceChildren(card(`${entry.method} ${entry.path}`, h('div', { class: 'card-body detail' }, pre),
            h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Close', onclick: () => detail.replaceChildren() })));
        detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function renderRows() {
        const body = document.getElementById('request-rows');
        if (!body) return;
        const visible = state.rows.filter(matches).slice(0, 300);
        body.replaceChildren(...visible.map((entry) => requestRow(entry, false)));
        document.getElementById('request-empty').hidden = visible.length > 0;
    }

    async function renderRequests() {
        const o = state.overview;
        const apis = o.apis.map((item) => item.name);
        const filters = h('div', { class: 'toolbar' }, [
            select('Status', 'status', [['', 'All statuses'], ['2xx', '2xx success'], ['3xx', '3xx redirect'], ['4xx', '4xx client error'], ['5xx', '5xx server error']]),
            select('API', 'api', [['', 'All APIs'], ...apis.map((name) => [name, name])]),
            h('label', {}, [h('span', { class: 'sr-only', text: 'Search' }), h('input', {
                class: 'input', type: 'search', placeholder: 'Path, request ID, trace ID, app', value: state.filters.text,
                oninput: (event) => { state.filters.text = event.target.value; renderRows(); },
            })]),
            h('button', {
                class: 'btn btn-secondary btn-sm', type: 'button', id: 'pause', text: state.paused ? 'Resume' : 'Pause',
                onclick: (event) => { state.paused = !state.paused; event.target.textContent = state.paused ? 'Resume' : 'Pause'; },
            }),
        ]);
        page.replaceChildren(
            h('div', { class: 'page-head' }, [
                h('div', {}, [h('h1', { text: 'Live requests' }), h('p', { class: 'muted', text: o.requestLog.enabled ? `The last ${o.requestLog.size} requests on this node, updated as they happen.` : 'The local request log is turned off in the console; requests are only off-loaded.' })]),
            ]),
            filters,
            h('section', { class: 'card' }, h('div', { class: 'table-wrap' }, [
                h('table', {}, [
                    h('thead', {}, h('tr', {}, [h('th', { text: 'Time' }), h('th', { text: 'Request' }), h('th', { text: 'Status' }), h('th', { class: 'num', text: 'Duration' }), h('th', { class: 'hide-sm', text: 'API' }), h('th', { class: 'hide-sm', text: 'Application' })])),
                    h('tbody', { id: 'request-rows' }),
                ]),
                h('p', { class: 'empty', id: 'request-empty', text: 'No requests match yet.' }),
            ])),
            h('div', { id: 'request-detail' }),
        );

        const initial = await api('/api/requests?limit=300');
        state.rows = initial.entries;
        renderRows();
        stopStream();
        state.stream = new EventSource('/api/requests/stream');
        state.stream.addEventListener('request', (message) => {
            const entry = JSON.parse(message.data);
            state.rows.unshift(entry);
            state.rows.length = Math.min(state.rows.length, 1000);
            if (state.paused || !matches(entry)) return;
            const body = document.getElementById('request-rows');
            if (!body) return;
            body.prepend(requestRow(entry, true));
            while (body.children.length > 300) body.lastChild.remove();
            document.getElementById('request-empty').hidden = true;
        });
    }

    function select(label, key, options) {
        return h('label', {}, [h('span', { class: 'sr-only', text: label }), h('select', {
            class: 'select', 'aria-label': label,
            onchange: (event) => { state.filters[key] = event.target.value; renderRows(); },
        }, options.map(([value, text]) => h('option', { value, text, selected: state.filters[key] === value })))]);
    }

    // ---------------------------------------------------------------- metrics
    async function renderMetrics(minutes = 15) {
        const series = await api(`/api/series?minutes=${minutes}`);
        const points = series.points;
        const totals = points.reduce((sum, point) => ({ requests: sum.requests + point.requests, errors: sum.errors + point.errors, limited: sum.limited + point.rateLimited }), { requests: 0, errors: 0, limited: 0 });
        const p95s = points.map((point) => point.p95).filter((value) => value !== null);

        const requestsChart = h('div');
        const errorsChart = h('div');
        const latencyChart = h('div');
        page.replaceChildren(
            h('div', { class: 'page-head' }, [
                h('div', {}, [h('h1', { text: 'Metrics' }), h('p', { class: 'muted', text: `This node, in ${series.bucketSeconds}-second intervals. Prometheus can scrape /metrics on the health port.` })]),
                h('label', {}, [h('span', { class: 'sr-only', text: 'Time window' }), h('select', {
                    class: 'select', 'aria-label': 'Time window', onchange: (event) => renderMetrics(Number(event.target.value)),
                }, [[15, 'Last 15 minutes'], [30, 'Last 30 minutes']].map(([value, text]) => h('option', { value, text, selected: value === minutes })))]),
            ]),
            h('div', { class: 'tiles' }, [
                tile('Requests', totals.requests.toLocaleString(), `${(totals.requests / (minutes * 60)).toFixed(2)} per second`),
                tile('Server errors', totals.errors.toLocaleString(), totals.requests ? `${((totals.errors / totals.requests) * 100).toFixed(1)}%` : '—'),
                tile('Rate limited', totals.limited.toLocaleString(), '429 responses'),
                tile('Worst p95 latency', p95s.length ? `${Math.max(...p95s)} ms` : '—', 'highest 10-second interval'),
            ]),
            card(`Requests per ${series.bucketSeconds} seconds`, requestsChart),
            h('div', { class: 'grid-2' }, [
                card(`Server errors (5xx) per ${series.bucketSeconds} seconds`, errorsChart),
                card('Latency, 95th percentile', latencyChart),
            ]),
        );
        window.GatewayCharts.columns(requestsChart, points, { key: 'requests', label: 'Requests', timeLabel: shortTime });
        window.GatewayCharts.columns(errorsChart, points, { key: 'errors', label: 'Server errors', timeLabel: shortTime, errors: true });
        window.GatewayCharts.line(latencyChart, points, { key: 'p95', label: 'p95 latency', unit: 'ms', timeLabel: shortTime });
    }

    // ---------------------------------------------------------------- settings
    function renderSettings() {
        const o = state.overview;
        const offload = o.offload;
        page.replaceChildren(
            h('div', { class: 'page-head' }, [h('div', {}, [h('h1', { text: 'Settings' }), h('p', { class: 'muted', text: 'Read-only. Change these on the gateway\'s page in the management console, then push.' })])]),
            h('div', { class: 'grid-2' }, [
                card('Observability', h('div', { class: 'card-body' }, kv([
                    ['Request log on this node', o.requestLog.enabled ? `On, last ${o.requestLog.size} requests` : 'Off'],
                    ['Prometheus metrics', o.metricsEnabled ? 'On, GET /metrics on the health port' : 'Off'],
                    ['Off-load', offload.type === 'none' ? 'Off' : `${offload.type === 'otlp' ? 'OpenTelemetry (OTLP/HTTP)' : 'HTTP JSON'} → ${offload.url}`],
                    ['Sample rate', offload.type === 'none' ? '—' : `${Math.round(offload.sampleRate * 100)}%`],
                ]))),
                card('Off-load delivery', h('div', { class: 'card-body' }, offload.type === 'none'
                    ? h('p', { class: 'muted', text: 'Off-loading is off. Request events stay on this node.' })
                    : kv([
                        ['Status', offload.lastError ? pill(offload.lastError, 'bad') : pill('Delivering', 'good')],
                        ['Sent', offload.sent.toLocaleString()],
                        ['Waiting', offload.queued.toLocaleString()],
                        ['Dropped', offload.dropped.toLocaleString()],
                        ['Last success', formatDate(offload.lastSuccessAt)],
                    ]))),
                card('Certificate', h('div', { class: 'card-body' }, kv([
                    ['Gateway', `${o.gatewayName} (${o.gatewayId})`],
                    ['Valid until', formatDate(o.certificate.validTo)],
                    ['SHA-256', h('code', { text: o.certificate.fingerprint })],
                ]))),
                card('Connections', rows(o.connections.map((connection) => [
                    connection.name,
                    `${connection.failures} recent failure${connection.failures === 1 ? '' : 's'}`,
                    connection.circuit === 'closed' ? pill('Circuit closed', 'good') : pill(`Circuit ${connection.circuit}`, 'bad'),
                ]))),
            ]),
        );
    }

    // ---------------------------------------------------------------- routing
    async function route() {
        const tab = (location.hash.replace('#/', '') || 'overview').split('?')[0];
        document.querySelectorAll('[data-tab]').forEach((link) => {
            if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });
        if (tab !== 'requests') stopStream();
        clearInterval(state.timer);
        try {
            if (tab === 'requests') await renderRequests();
            else if (tab === 'metrics') {
                await renderMetrics();
                state.timer = setInterval(() => { if (!document.hidden) renderMetrics(Number(document.querySelector('select[aria-label="Time window"]')?.value) || 15); }, 10000);
            } else if (tab === 'settings') {
                await refreshOverview();
                renderSettings();
            } else {
                await refreshOverview();
                renderOverview();
                state.timer = setInterval(async () => { if (!document.hidden) { await refreshOverview(); renderOverview(); } }, 15000);
            }
        } catch (error) {
            if (error.message !== 'Signed out') page.replaceChildren(h('p', { class: 'alert', text: error.message }));
        }
    }

    window.addEventListener('hashchange', () => { if (state.user) route(); });

    // Opened from the console's gateway page: #ticket=<one-time ticket>. Taken out of the address
    // right away, then exchanged for a session.
    const ticket = new URLSearchParams(window.location.hash.slice(1)).get('ticket');
    if (ticket) history.replaceState(null, '', window.location.pathname + window.location.search);

    (async () => {
        if (ticket) {
            try {
                const result = await api('/api/login', { method: 'POST', body: { ticket } });
                state.user = result.user;
                await showApp();
                return;
            } catch (problem) {
                showLogin();
                const error = document.getElementById('login-error');
                error.textContent = problem.message;
                error.hidden = false;
                return;
            }
        }
        try {
            const session = await api('/api/session');
            state.user = session.user;
            await showApp();
        } catch {
            showLogin();
        }
    })();
}());
