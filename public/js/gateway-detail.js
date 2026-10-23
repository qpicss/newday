const pushButton = document.getElementById('pushConfig');
const statusButton = document.getElementById('checkStatus');
const gatewayUrl = pushButton.dataset.gatewayUrl;
const pushResult = document.getElementById('push-result');
const nodeStatusCard = document.getElementById('node-status');

const STATUS_BADGES = {
    ok: ['In sync', 'badge-success'],
    warning: ['Warning', 'badge-warning'],
    error: ['Failed', 'badge-danger'],
};

function element(tag, { className, text } = {}, children = []) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    node.append(...children);
    return node;
}

function badge(label, className) {
    return element('span', { className: `badge badge-dot ${className}`, text: label });
}

function showPushResult(result) {
    pushResult.querySelector('[data-result-title]').textContent = result.ok ? 'Configuration pushed' : 'Push did not complete';
    const rows = pushResult.querySelector('[data-result-rows]');
    if (result.problems.length) {
        pushResult.querySelector('[data-result-summary]').textContent = 'Nothing was sent. Fix these first:';
        rows.replaceChildren(...result.problems.map((problem) => element('tr', {}, [element('td', { text: problem })])));
    } else {
        pushResult.querySelector('[data-result-summary]').textContent =
            `Version ${result.version}: ${result.summary.products} products, ${result.summary.apis} APIs, ${result.summary.subscriptions} approved applications.`;
        rows.replaceChildren(...result.nodes.map((node) => {
            const [label, className] = STATUS_BADGES[node.status] || ['Unknown', ''];
            const details = element('td', {}, [
                element('div', { className: 'cell-primary', text: node.name }),
                element('div', { className: 'cell-secondary mono-sm', text: node.url }),
            ]);
            if (node.error) details.append(element('div', { className: 'node-error', text: node.error }));
            const ports = node.handlers.map((handler) => `${handler.protocol}:${handler.port} ${handler.listening ? 'listening' : 'failed'}`).join(', ');
            return element('tr', {}, [details, element('td', {}, [badge(label, className)]), element('td', { className: 'hide-sm muted', text: ports })]);
        }));
    }
    pushResult.hidden = false;
    pushResult.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

pushButton.addEventListener('click', async () => {
    UI.setLoading(pushButton, true, 'Pushing…');
    try {
        const result = await UI.sendJson(`${gatewayUrl}/push`);
        showPushResult(result);
        UI.toast(result.ok ? 'Configuration pushed to every node' : 'The push did not complete', result.ok ? 'success' : 'error');
    } catch (error) {
        UI.toast(error.message, 'error');
    }
    UI.setLoading(pushButton, false);
});

pushResult.querySelector('[data-dismiss-result]').addEventListener('click', () => window.location.reload());

statusButton.addEventListener('click', async () => {
    UI.setLoading(statusButton, true, 'Checking…');
    try {
        const { nodes } = await UI.sendJson(`${gatewayUrl}/status`, { method: 'GET' });
        nodeStatusCard.querySelector('[data-status-rows]').replaceChildren(...nodes.map((node) => {
            const details = element('td', {}, [
                element('div', { className: 'cell-primary', text: node.name }),
                element('div', { className: 'cell-secondary mono-sm', text: node.url }),
            ]);
            if (!node.reachable) {
                details.append(element('div', { className: 'node-error', text: node.error }));
                return element('tr', {}, [details, element('td', {}, [badge('Unreachable', 'badge-danger')]), element('td', { className: 'hide-sm' })]);
            }
            const { status } = node;
            const handlers = status.handlers.map((handler) => `${handler.protocol}:${handler.port} ${handler.listening ? 'listening' : `failed (${handler.error})`}`).join(', ') || 'no handlers';
            const info = `version ${status.version || 'none'} · up ${Math.round(status.uptimeSeconds / 60)} min · ${status.stats.requests} requests · ${handlers}`;
            return element('tr', {}, [details, element('td', {}, [badge('Reachable', 'badge-success')]), element('td', { className: 'hide-sm muted', text: info })]);
        }));
        nodeStatusCard.hidden = false;
        nodeStatusCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
        UI.toast(error.message, 'error');
    }
    UI.setLoading(statusButton, false);
});

// A node the console connects to (push): added by its address, then checked by the console at once.
function addPushNode(formData) {
    return UI.sendJson(`${gatewayUrl}/nodes`, { body: { name: formData.get('name'), url: formData.get('url') } });
}
function pushNodeMessage(result) {
    const check = result.check;
    if (!check || check.reachable) return `${result.node.name} answered the console. ${check && check.resent ? 'It received the deployed configuration.' : 'Push to send it the configuration.'}`;
    return `${result.node.name} was added but didn't answer: ${check.error}. The console keeps checking it every 30 seconds. Check that the node runs and that port 9443 is open to the console.`;
}

const nodeForm = document.getElementById('nodeForm');
if (nodeForm) {
    UI.bindForm(nodeForm, {
        alert: document.getElementById('node-alert'),
        loadingLabel: 'Adding…',
        submit: async (formData) => {
            const result = await addPushNode(formData);
            UI.flash(pushNodeMessage(result), result.check && !result.check.reachable ? 'error' : 'success');
            window.location.reload();
        },
    });
}

// Opens a node's admin UI already signed in, with a one-time ticket from the console. The tab is
// opened before the request so that popup blockers allow it.
document.querySelectorAll('[data-open-admin]').forEach((button) => {
    button.addEventListener('click', async () => {
        const tab = window.open('', '_blank');
        if (tab) tab.opener = null;
        UI.setLoading(button, true, 'Opening…');
        try {
            const { url } = await UI.sendJson(button.dataset.openAdmin, { method: 'POST' });
            if (tab) tab.location.href = url;
            else window.location.href = url;
        } catch (error) {
            if (tab) tab.close();
            UI.toast(error.message, 'error');
        }
        UI.setLoading(button, false);
    });
});

// A new node: registered first, then the page opens its start command.
const addNodeForm = document.getElementById('addNodeForm');
if (addNodeForm) {
    const otherHost = addNodeForm.querySelector('[data-other-host]');
    const updatePlacement = () => {
        const other = addNodeForm.querySelector('[name="placement"]:checked')?.value === 'other';
        otherHost.hidden = !other;
        otherHost.querySelector('input').required = other;
    };
    addNodeForm.addEventListener('change', updatePlacement);
    if (!addNodeForm.querySelector('[name="placement"]:checked')) addNodeForm.querySelector('[value="other"]').checked = true;
    updatePlacement();
    UI.bindForm(addNodeForm, {
        alert: document.getElementById('add-node-alert'),
        loadingLabel: 'Adding…',
        submit: async (formData) => {
            const other = formData.get('placement') === 'other';
            const result = await UI.sendJson(`${gatewayUrl}/nodes`, {
                body: { name: formData.get('name'), ...(other ? { host: formData.get('host'), portOffset: 0 } : { host: addNodeForm.dataset.sameHost }) },
            });
            UI.flash(`${result.node.name} was added. Run its command to start it.`);
            window.location.hash = `node-${result.node.id}`;
            window.location.reload();
        },
    });
}

// Where a node runs: its host and port offset.
document.querySelectorAll('[data-node-form]').forEach((form) => {
    UI.bindForm(form, {
        alert: form.querySelector('[data-node-alert]'),
        loadingLabel: 'Saving…',
        submit: async (formData) => {
            await UI.sendJson(form.dataset.nodeForm, {
                method: 'PUT',
                body: { host: formData.get('host'), portOffset: Number(formData.get('portOffset') || 0) },
            });
            UI.flash(`Placement of ${form.dataset.nodeName} saved. Run its command again if the ports changed.`);
            window.location.reload();
        },
    });
});

// A link to a node (#node-<id>) opens its start command.
function openNodeFromHash() {
    const match = /^#node-(.+)$/.exec(window.location.hash);
    const details = match && document.querySelector(`[data-node-details="${CSS.escape(match[1])}"]`);
    if (!details) return;
    details.open = true;
    details.closest('.node-item').scrollIntoView({ block: 'start' });
}
window.addEventListener('hashchange', openNodeFromHash);
openNodeFromHash();

// HTTPS handlers need a certificate: issued by the management CA or pasted.
const handlerForm = document.getElementById('handlerForm');
function updateTlsFields() {
    const https = handlerForm.querySelector('[name="protocol"]').value === 'https';
    const custom = handlerForm.querySelector('[name="tlsMode"]:checked').value === 'custom';
    handlerForm.querySelector('[data-tls-fields]').hidden = !https;
    handlerForm.querySelector('[data-custom-tls]').hidden = !(https && custom);
}
handlerForm.addEventListener('change', updateTlsFields);
updateTlsFields();

UI.bindForm(handlerForm, {
    alert: document.getElementById('handler-alert'),
    loadingLabel: 'Adding…',
    submit: async (formData) => {
        const protocol = formData.get('protocol');
        const tlsMode = formData.get('tlsMode');
        const result = await UI.sendJson(`${gatewayUrl}/handlers`, {
            body: {
                name: formData.get('name'),
                port: Number(formData.get('port')),
                protocol,
                policyId: formData.get('policyId') || null,
                nodeId: formData.get('nodeId') || null,
                ...(protocol === 'https' && { tlsMode }),
                ...(protocol === 'https' && tlsMode === 'custom' && {
                    certificatePem: formData.get('certificatePem'),
                    privateKeyPem: formData.get('privateKeyPem'),
                }),
            },
        });
        UI.flash(`${result.handler.name} was added on port ${result.handler.port}. Push to open it on the nodes.`);
        window.location.reload();
    },
});

UI.bindForm(document.getElementById('settingsForm'), {
    alert: document.getElementById('settings-alert'),
    loadingLabel: 'Saving…',
    submit: async (formData) => {
        await UI.sendJson(gatewayUrl, {
            method: 'PUT',
            body: {
                name: formData.get('name'),
                publicUrl: formData.get('publicUrl'),
                catalogId: formData.get('catalogId') || null,
                autoPush: formData.get('autoPush') === 'on',
            },
        });
        UI.flash('Settings saved');
        window.location.reload();
    },
});

// Where a handler runs: saved as soon as it is chosen.
document.querySelectorAll('[data-handler-node]').forEach((select) => {
    let saved = select.value;
    select.addEventListener('change', async () => {
        select.disabled = true;
        try {
            await UI.sendJson(select.dataset.handlerNode, { method: 'PUT', body: { nodeId: select.value || null } });
            saved = select.value;
            UI.flash(`${select.dataset.handlerName} now runs on ${select.value ? select.selectedOptions[0].textContent.replace(/^Only /, '') : 'every node'}. Push to deploy it.`);
            window.location.reload();
        } catch (error) {
            select.value = saved;
            UI.toast(error.message, 'error');
        }
        select.disabled = false;
    });
});

// Port policy: saved as soon as it is chosen.
document.querySelectorAll('[data-handler-policy]').forEach((select) => {
    let saved = select.value;
    select.addEventListener('change', async () => {
        select.disabled = true;
        try {
            await UI.sendJson(select.dataset.handlerPolicy, { method: 'PUT', body: { policyId: select.value || null } });
            saved = select.value;
            UI.toast(`Port policy of ${select.dataset.handlerName} saved. Push to deploy it.`);
        } catch (error) {
            select.value = saved;
            UI.toast(error.message, 'error');
        }
        select.disabled = false;
    });
});

// Observability and off-load.
const observabilityForm = document.getElementById('observabilityForm');
function updateOffloadFields() {
    observabilityForm.querySelector('[data-offload-fields]').hidden = observabilityForm.querySelector('[name="offloadType"]').value === 'none';
}
observabilityForm.querySelector('[name="offloadType"]').addEventListener('change', updateOffloadFields);
updateOffloadFields();

UI.bindForm(observabilityForm, {
    alert: document.getElementById('observability-alert'),
    loadingLabel: 'Saving…',
    submit: async (formData) => {
        const type = formData.get('offloadType');
        await UI.sendJson(`${gatewayUrl}/observability`, {
            method: 'PUT',
            body: {
                requestLog: { enabled: formData.get('requestLogEnabled') === 'on', size: Number(formData.get('requestLogSize')) },
                metrics: { enabled: formData.get('metricsEnabled') === 'on' },
                adminUi: { enabled: formData.get('adminUiEnabled') === 'on' },
                offload: type === 'none' ? { type } : {
                    type,
                    url: formData.get('offloadUrl'),
                    headerName: formData.get('offloadHeaderName') || null,
                    headerValue: formData.get('offloadHeaderValue') || undefined,
                    batchSize: Number(formData.get('offloadBatchSize')),
                    flushIntervalMs: Number(formData.get('offloadFlushIntervalMs')),
                    sampleRate: Number(formData.get('offloadSampleRate')),
                },
            },
        });
        UI.flash('Observability settings saved. Push to apply them to the nodes.');
        window.location.reload();
    },
});

// Credentials: renew (nodes switch over the link) and revoke.
const renewButton = document.getElementById('renewCredentials');
renewButton.addEventListener('click', async () => {
    const confirmed = await UI.confirm({
        title: 'Renew the gateway certificate?',
        message: 'A new certificate is issued. Nodes connected to the console fetch it within a minute and switch without a restart; push nodes get it right away. Revoke the old one once every node uses the new one.',
        confirmLabel: 'Renew',
    });
    if (!confirmed) return;
    UI.setLoading(renewButton, true, 'Renewing…');
    try {
        const result = await UI.sendJson(`${gatewayUrl}/renew`);
        const failed = (result.nodes || []).filter((node) => node.status === 'error');
        UI.flash(failed.length
            ? `Certificate renewed. ${failed.map((node) => node.name).join(', ')} could not be updated directly and will fetch it on the next heartbeat.`
            : 'Certificate renewed');
        window.location.reload();
    } catch (error) {
        UI.toast(error.message, 'error');
        UI.setLoading(renewButton, false);
    }
});

document.querySelectorAll('[data-revoke-url]').forEach((button) => {
    button.addEventListener('click', async () => {
        const usedBy = button.dataset.usedBy;
        const confirmed = await UI.confirm({
            title: 'Revoke this certificate?',
            message: usedBy
                ? `${usedBy} still use${usedBy.includes(',') ? '' : 's'} it and will be cut off from the console immediately. Renew first to avoid that.`
                : 'Nodes using it can no longer reach the console or receive pushes.',
            confirmLabel: 'Revoke',
            danger: true,
        });
        if (!confirmed) return;
        UI.setLoading(button, true, 'Revoking…');
        try {
            await UI.sendJson(button.dataset.revokeUrl, { body: { force: Boolean(usedBy) } });
            UI.flash('Certificate revoked');
            window.location.reload();
        } catch (error) {
            UI.toast(error.message, 'error');
            UI.setLoading(button, false);
        }
    });
});

// ------------------------------------------------------------------ Setup

// Shell tabs: the viewer's last choice, else the one that fits their system.
const SHELL_KEY = 'gateway.shell';
function preferredShell() {
    try {
        const saved = localStorage.getItem(SHELL_KEY);
        if (saved) return saved;
    } catch { /* storage unavailable */ }
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    return /win/i.test(platform) ? 'powershell' : 'bash';
}

function showShell(shell, remember) {
    document.querySelectorAll('[data-shell-tabs]').forEach((group) => {
        if (!group.querySelector(`[data-shell="${shell}"]`)) return;
        group.querySelectorAll('[data-shell]').forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.shell === shell)));
        group.querySelectorAll('[data-shell-panel]').forEach((panel) => { panel.hidden = panel.dataset.shellPanel !== shell; });
    });
    if (remember) {
        try { localStorage.setItem(SHELL_KEY, shell); } catch { /* storage unavailable */ }
    }
}

document.querySelectorAll('[data-shell-tabs] [data-shell]').forEach((tab) => {
    tab.addEventListener('click', () => showShell(tab.dataset.shell, true));
    tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        const tabs = [...tab.parentElement.querySelectorAll('[data-shell]')];
        const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        showShell(next.dataset.shell, true);
        next.focus();
    });
});
showShell(preferredShell(), false);

const setupCard = document.querySelector('[data-gateway-setup]');
const nextStep = setupCard ? setupCard.dataset.nextStep : '';

// Step 3: the console connects to the node (push), or the node connects to the console (pull).
const setupMode = document.querySelector('[data-setup-mode]');
if (setupMode) {
    const showMode = () => {
        const mode = setupMode.querySelector('[name="setupMode"]:checked')?.value || 'push';
        document.querySelectorAll('[data-setup-panel]').forEach((panel) => { panel.hidden = panel.dataset.setupPanel !== mode; });
    };
    setupMode.addEventListener('change', showMode);
    showMode();
}
const setupPushForm = document.getElementById('setupPushForm');
if (setupPushForm) {
    UI.bindForm(setupPushForm, {
        alert: document.getElementById('setup-push-alert'),
        loadingLabel: 'Connecting…',
        submit: async (formData) => {
            const result = await addPushNode(formData);
            UI.flash(pushNodeMessage(result), result.check && !result.check.reachable ? 'error' : 'success');
            window.location.reload();
        },
    });
}

const quickHandlerForm = document.getElementById('quickHandlerForm');
if (quickHandlerForm) {
    UI.bindForm(quickHandlerForm, {
        alert: document.getElementById('quick-handler-alert'),
        loadingLabel: 'Opening…',
        submit: async (formData) => {
            const protocol = formData.get('protocol');
            const result = await UI.sendJson(`${gatewayUrl}/handlers`, {
                body: {
                    name: protocol === 'https' ? 'Public HTTPS' : 'Public HTTP',
                    port: Number(formData.get('port')),
                    protocol,
                    ...(protocol === 'https' && { tlsMode: 'generated' }),
                },
            });
            UI.flash(`Port ${result.handler.port} is set. Next, download the credentials.`);
            window.location.reload();
        },
    });
}

// The download itself doesn't leave the page; reload once the console has recorded it.
if (nextStep === 'credentials') {
    document.querySelectorAll('[data-credentials-download]').forEach((link) => {
        link.addEventListener('click', () => {
            setTimeout(() => {
                UI.flash('Credentials downloaded. Now start a node with them.');
                window.location.reload();
            }, 1500);
        });
    });
}

// Waiting for the first node: check every few seconds and move on once it is running.
if (nextStep === 'node' && document.querySelector('[data-setup-waiting]')) {
    const startedAt = Date.now();
    const timer = setInterval(async () => {
        if (Date.now() - startedAt > 60 * 60 * 1000) return clearInterval(timer);
        if (document.hidden) return;
        try {
            const { gateway } = await UI.sendJson(gatewayUrl, { method: 'GET' });
            if (gateway.setup && gateway.setup.running) {
                clearInterval(timer);
                UI.flash(`${gateway.name} is running. Attach it to a catalog to serve its products.`);
                window.location.reload();
            }
        } catch { /* try again on the next tick */ }
    }, 5000);
}

const quickAttachForm = document.getElementById('quickAttachForm');
if (quickAttachForm) {
    UI.bindForm(quickAttachForm, {
        alert: document.getElementById('quick-attach-alert'),
        loadingLabel: 'Attaching…',
        submit: async (formData) => {
            const result = await UI.sendJson(gatewayUrl, { method: 'PUT', body: { catalogId: formData.get('catalogId') } });
            UI.flash(`${result.gateway.name} now serves ${result.gateway.catalog ? result.gateway.catalog.name : 'the catalog'}.`);
            window.location.reload();
        },
    });
}
