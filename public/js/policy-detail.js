// Policy editor: the flow canvas (flow-editor.js), the settings of the selected step, saving,
// the list of problems and test runs on a gateway node.
const Flow = window.PolicyFlow;
const policyForm = document.getElementById('policyForm');
const policyUrl = policyForm.dataset.policyUrl;
const connections = JSON.parse(policyForm.dataset.connections);
const inspector = document.getElementById('inspector');
const statusBadge = document.getElementById('flowStatus');
const problemList = document.getElementById('flowProblems');
const dirtyNote = document.getElementById('dirtyNote');
const INDENT = '  ';

const icons = {};
document.getElementById('flow-icons').content.querySelectorAll('[data-icon]').forEach((element) => {
    icons[element.dataset.icon] = element.innerHTML;
});

let description = policyForm.dataset.description; // edited on the overview panel
let dirty = false;
let leaving = false;

// ------------------------------------------------------------------ step summaries

const connectionName = (id) => connections.find((connection) => connection.id === id)?.name;

const shorten = (text, max = 34) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const conditionText = (condition) => {
    const source = Flow.CONDITION_SOURCES[condition.source];
    const subject = source.named && condition.name ? `${source.label.toLowerCase()} ${condition.name}` : source.label.toLowerCase();
    const value = Flow.UNARY.includes(condition.operator) ? '' : ` ${condition.value}`;
    return `${subject} ${Flow.OPERATORS[condition.operator]}${value}`;
};

const describe = (node) => {
    const kind = Flow.TYPE_LABELS[node.type];
    const { config } = node;
    switch (node.type) {
        case 'input':
            return { kind, detail: 'The request from the client' };
        case 'output':
            return { kind, detail: 'Answers the client' };
        case 'script': {
            const lines = config.code ? config.code.split('\n').length : 0;
            return { kind, detail: `${config.fileName || (lines ? `${lines} lines` : 'No code yet')} · ${config.timeoutMs} ms` };
        }
        case 'if': {
            if (!config.conditions.length) return { kind, detail: 'No condition yet' };
            const more = config.conditions.length > 1 ? ` +${config.conditions.length - 1}` : '';
            return { kind, detail: shorten(conditionText(config.conditions[0])) + more };
        }
        case 'invoke': {
            const method = config.method === 'request' ? 'Same method' : config.method;
            const url = config.url ? shorten(config.url.replace(/^https?:\/\//, ''), 24) : null;
            const target = url || (config.target === 'backend' ? "API's server" : 'No URL yet');
            const where = config.responseTo === 'variable' && config.variable ? ` → ${config.variable}` : '';
            return { kind, detail: `${method} · ${target}${where}` };
        }
        case 'validateRequest': {
            const parts = [config.headers && 'Headers', config.query && (config.rejectUnknownQuery ? 'query (strict)' : 'query')].filter(Boolean);
            return { kind, detail: parts.length ? `${parts.join(' and ')} · 422` : 'Nothing checked' };
        }
        case 'validateBody':
            return { kind, detail: `Body schema${config.rejectUnknown ? ' (strict)' : ''} · 422` };
        case 'security': {
            const injections = Object.keys(Flow.SECURITY_CHECKS).filter((key) => config[key]).length;
            const parts = [injections && `${injections} attack checks`, config.bruteForce && 'brute force', (config.ipAllow.length || config.ipDeny.length) && 'IP lists']
                .filter(Boolean);
            return { kind, detail: `${parts.length ? parts.join(', ') : 'No checks'} · ${config.mode === 'monitor' ? 'log only' : 'blocks'}` };
        }
        default:
            return { kind, detail: '' };
    }
};

// ------------------------------------------------------------------ canvas

const canvas = new window.FlowCanvas({
    canvas: document.getElementById('flowCanvas'),
    world: document.getElementById('flowWorld'),
    svg: document.getElementById('flowEdges'),
    edgeDelete: document.getElementById('edgeDelete'),
    flow: JSON.parse(policyForm.dataset.flow),
    icons,
    describe,
    defaultScript: policyForm.dataset.defaultScript,
    backendUrl: policyForm.dataset.backendUrl,
    onChange: () => {
        canvas.setTrace(null);
        markDirty();
        validate();
        if (canvas.selection) renderInspector();
    },
    onSelect: () => renderInspector(),
    onZoom: (scale) => {
        document.querySelector('[data-zoom-label]').textContent = `${Math.round(scale * 100)}%`;
    },
});
canvas.bindPalette([...document.querySelectorAll('[data-add-step]')]);

document.querySelectorAll('[data-canvas]').forEach((button) => {
    button.addEventListener('click', () => {
        const action = button.dataset.canvas;
        if (action === 'zoom-in') canvas.zoomBy(1.2);
        if (action === 'zoom-out') canvas.zoomBy(1 / 1.2);
        if (action === 'fit') canvas.fit();
        if (action === 'tidy') canvas.tidy();
    });
});

// ------------------------------------------------------------------ problems and status

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function validate() {
    let problems;
    const { flow, error } = Flow.normalizeFlow(canvas.flow);
    if (error) {
        problems = [{ level: 'error', nodeId: null, message: error }];
    } else {
        problems = Flow.flowProblems(flow, { connectionIds: new Set(connections.map((connection) => connection.id)) });
    }
    canvas.setProblems(problems);
    const errors = problems.filter((problem) => problem.level === 'error');
    const warnings = problems.filter((problem) => problem.level === 'warning');

    statusBadge.className = `flow-status ${errors.length ? 'is-error' : warnings.length ? 'is-warning' : 'is-ok'}`;
    statusBadge.innerHTML = errors.length ? icons.alert : icons.check;
    statusBadge.append(errors.length
        ? `${plural(errors.length, 'thing')} to fix before deploying`
        : warnings.length ? `Ready to deploy, ${plural(warnings.length, 'warning')}` : 'Ready to deploy');

    problemList.replaceChildren();
    if (!problems.length) return problems;
    const heading = document.createElement('h3');
    heading.className = 'flow-panel-title';
    heading.textContent = 'To check';
    const list = document.createElement('ul');
    for (const problem of problems) {
        const item = document.createElement('li');
        item.className = `flow-problem is-${problem.level}`;
        if (problem.nodeId) {
            const link = document.createElement('button');
            link.type = 'button';
            link.className = 'link-button';
            link.textContent = problem.message;
            link.addEventListener('click', () => canvas.select({ kind: 'node', id: problem.nodeId }));
            item.appendChild(link);
        } else {
            item.textContent = problem.message;
        }
        list.appendChild(item);
    }
    problemList.append(heading, list);
    return problems;
}

function markDirty() {
    dirty = true;
    dirtyNote.textContent = 'Unsaved changes';
    dirtyNote.classList.add('is-dirty');
}

window.addEventListener('beforeunload', (event) => {
    if (dirty && !leaving) event.preventDefault();
});

// ------------------------------------------------------------------ inspector

const panel = (id) => document.getElementById(id).content.cloneNode(true);

// A panel is a fragment that empties once it is in the inspector, so code that runs later (the
// sync of a panel) looks its elements up in a list taken before that.
const finder = (root) => {
    const elements = [...root.querySelectorAll('*')];
    return (selector) => elements.filter((element) => element.matches(selector));
};

const selectedNode = () => (canvas.selection?.kind === 'node' ? canvas.node(canvas.selection.id) : null);

// A step changed in the inspector: redraw it and re-check the flow.
function stepChanged(node) {
    canvas.setTrace(null);
    canvas.renderNode(node);
    markDirty();
    validate();
}

// "Next step" selects, an alternative to drawing lines.
function bindNextFields(root, node) {
    root.querySelectorAll('[data-next-field]').forEach((field) => {
        const port = field.dataset.nextField;
        const id = `next-${port}`;
        field.querySelector('label').htmlFor = id;
        const select = document.createElement('select');
        select.className = 'select select-sm';
        select.id = id;
        const none = new Option('Not connected', '');
        select.add(none);
        canvas.flow.nodes
            .filter((candidate) => candidate.id !== node.id && candidate.type !== 'input')
            .forEach((candidate) => select.add(new Option(candidate.type === 'output' ? 'Output (answer the client)' : candidate.name, candidate.id)));
        select.value = canvas.edgeFrom(node.id, port)?.to || '';
        select.addEventListener('change', () => canvas.connect(node.id, port, select.value || null));
        field.appendChild(select);
    });
}

function readValue(element) {
    if (element.type === 'checkbox') return element.checked;
    if (element.dataset.list !== undefined) return element.value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
    if (element.dataset.number !== undefined) {
        if (element.value === '') return element.dataset.nullable !== undefined ? null : '';
        return Number(element.value);
    }
    if (element.dataset.nullable !== undefined && element.value === '') return null;
    return element.value;
}

function writeValue(element, value) {
    if (element.type === 'checkbox') element.checked = Boolean(value);
    else if (element.type === 'radio') element.checked = element.value === value;
    else if (Array.isArray(value)) element.value = value.join(', ');
    else element.value = value === null || value === undefined ? '' : String(value);
}

function bindFields(root, node, onUpdate) {
    root.querySelectorAll('[data-field]').forEach((element) => {
        writeValue(element, node[element.dataset.field]);
        element.addEventListener('input', () => {
            node[element.dataset.field] = element.value.trim() || Flow.TYPE_LABELS[node.type];
            stepChanged(node);
        });
    });
    root.querySelectorAll('[data-config]').forEach((element) => {
        writeValue(element, node.config[element.dataset.config]);
        const event = element.tagName === 'SELECT' || element.type === 'radio' || element.type === 'checkbox' ? 'change' : 'input';
        element.addEventListener(event, () => {
            if (element.type === 'radio' && !element.checked) return;
            node.config[element.dataset.config] = readValue(element);
            onUpdate?.();
            stepChanged(node);
        });
    });
}

// Tab indents (and Shift+Tab outdents) instead of leaving the editor; Enter keeps the indentation.
function bindCodeEditor(editor) {
    editor.addEventListener('keydown', (event) => {
        if (event.key === 'Tab' && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            const { selectionStart: start, selectionEnd: end, value } = editor;
            if (event.shiftKey) {
                const lineStart = value.lastIndexOf('\n', start - 1) + 1;
                if (value.startsWith(INDENT, lineStart)) {
                    editor.setRangeText('', lineStart, lineStart + INDENT.length, 'preserve');
                    editor.selectionStart = editor.selectionEnd = Math.max(lineStart, start - INDENT.length);
                }
            } else {
                editor.setRangeText(INDENT, start, end, 'end');
            }
            editor.dispatchEvent(new Event('input'));
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
            const { selectionStart: start, value } = editor;
            const lineStart = value.lastIndexOf('\n', start - 1) + 1;
            const indent = value.slice(lineStart).match(/^[ \t]*/)[0];
            const extra = /[{([]\s*$/.test(value.slice(lineStart, start)) ? INDENT : '';
            event.preventDefault();
            editor.setRangeText(`\n${indent}${extra}`, start, editor.selectionEnd, 'end');
            editor.dispatchEvent(new Event('input'));
        }
    });
}

function scriptPanel(node) {
    const root = panel('panel-script');
    const code = root.querySelector('[data-config="code"]');
    const fileName = root.querySelector('[data-file-name]');
    const showFile = () => {
        fileName.textContent = node.config.fileName ? `From ${node.config.fileName}` : 'or write the script below';
    };
    bindFields(root, node, () => {
        // Typing in the editor makes it your own code rather than the uploaded file.
        if (document.activeElement === code && node.config.fileName) {
            node.config.fileName = null;
            showFile();
        }
    });
    showFile();
    bindCodeEditor(code);

    // The settings panel moves under the canvas at full width, with a taller editor.
    const workspace = document.querySelector('.flow-workspace');
    const wide = root.querySelector('[data-wide-editor]');
    const showWide = () => {
        const on = workspace.classList.contains('is-wide-editor');
        wide.setAttribute('aria-pressed', String(on));
        wide.querySelector('span').textContent = on ? 'Narrow editor' : 'Wider editor';
    };
    wide.addEventListener('click', () => {
        workspace.classList.toggle('is-wide-editor');
        showWide();
        code.focus();
    });
    showWide();

    const upload = root.querySelector('[data-upload-script]');
    upload.addEventListener('change', async () => {
        const file = upload.files[0];
        upload.value = '';
        if (!file) return;
        if (file.size > Flow.LIMITS.code) {
            UI.toast(`${file.name} is larger than ${Flow.LIMITS.code.toLocaleString('en-US')} characters`, 'error');
            return;
        }
        if (node.config.code.trim() && !await UI.confirm({
            title: `Replace the script with ${file.name}?`,
            message: 'The code in the editor is replaced. Nothing is saved until you click Save policy.',
            confirmLabel: 'Replace',
        })) return;
        node.config.code = await file.text();
        node.config.fileName = file.name.slice(0, 200);
        code.value = node.config.code;
        showFile();
        stepChanged(node);
    });

    const example = root.querySelector('[data-example]');
    example.addEventListener('change', async () => {
        const chosen = example.value;
        example.value = '';
        if (!chosen) return;
        if (node.config.code.trim() && !await UI.confirm({
            title: 'Replace the script with the example?',
            message: 'The code in the editor is replaced. Nothing is saved until you click Save policy.',
            confirmLabel: 'Replace',
        })) return;
        node.config.code = document.getElementById(`example-${chosen}`).content.textContent;
        node.config.fileName = null;
        code.value = node.config.code;
        showFile();
        stepChanged(node);
        code.focus();
    });
    bindNextFields(root, node);
    return root;
}

const NAME_HINTS = {
    header: 'header name',
    query: 'parameter',
    body: 'JSON field, e.g. order.total (empty: whole body)',
    variable: 'variable, e.g. userId',
    responseHeader: 'header name',
    responseBody: 'JSON field (empty: whole body)',
};

function conditionRow(node, condition, index, rerender) {
    const row = panel('condition-row').firstElementChild;
    const fields = Object.fromEntries([...row.querySelectorAll('[data-condition]')].map((element) => [element.dataset.condition, element]));
    const sync = () => {
        const source = Flow.CONDITION_SOURCES[condition.source];
        fields.name.hidden = !source.named;
        fields.name.placeholder = NAME_HINTS[condition.source] || '';
        fields.value.hidden = Flow.UNARY.includes(condition.operator);
        fields.value.placeholder = condition.operator === 'in' ? 'a, b, c' : 'value';
    };
    Object.entries(fields).forEach(([key, element]) => {
        element.value = condition[key] ?? '';
        element.addEventListener(element.tagName === 'SELECT' ? 'change' : 'input', () => {
            condition[key] = element.value;
            sync();
            stepChanged(node);
        });
    });
    row.querySelector('[data-remove-condition]').addEventListener('click', () => {
        node.config.conditions.splice(index, 1);
        stepChanged(node);
        rerender();
    });
    sync();
    return row;
}

function ifPanel(node) {
    const root = panel('panel-if');
    bindFields(root, node);
    const list = root.querySelector('[data-conditions]');
    const renderConditions = () => {
        list.replaceChildren(...node.config.conditions.map((condition, index) => conditionRow(node, condition, index, renderConditions)));
        if (!node.config.conditions.length) {
            const empty = document.createElement('p');
            empty.className = 'hint';
            empty.textContent = 'No condition yet. Add one to decide which line the request takes.';
            list.appendChild(empty);
        }
    };
    renderConditions();
    root.querySelector('[data-add-condition]').addEventListener('click', () => {
        if (node.config.conditions.length >= Flow.LIMITS.conditions) return;
        node.config.conditions.push({ source: 'header', name: '', operator: 'equals', value: '' });
        renderConditions();
        stepChanged(node);
        list.lastElementChild.querySelector('[data-condition="name"]').focus();
    });
    bindNextFields(root, node);
    return root;
}

function pairList(root, node, key) {
    const list = root.querySelector(`[data-pairs="${key}"]`);
    const render = () => {
        list.replaceChildren(...node.config[key].map((pair, index) => {
            const row = panel('pair-row').firstElementChild;
            row.querySelectorAll('[data-pair]').forEach((element) => {
                element.value = pair[element.dataset.pair];
                element.addEventListener('input', () => {
                    pair[element.dataset.pair] = element.value;
                    stepChanged(node);
                });
            });
            row.querySelector('[data-remove-pair]').addEventListener('click', () => {
                node.config[key].splice(index, 1);
                render();
                stepChanged(node);
            });
            return row;
        }));
    };
    render();
    root.querySelector(`[data-add-pair="${key}"]`).addEventListener('click', () => {
        if (node.config[key].length >= Flow.LIMITS.pairs) return;
        node.config[key].push({ name: '', value: '' });
        render();
        stepChanged(node);
        list.lastElementChild.querySelector('[data-pair="name"]').focus();
    });
}

function invokePanel(node) {
    const root = panel('panel-invoke');
    const find = finder(root);
    const sync = () => {
        find('[data-show-target]').forEach((element) => { element.hidden = element.dataset.showTarget !== node.config.target; });
        find('[data-url-input]')[0].placeholder = node.config.target === 'backend' ? 'https://orders.internal.example.com/v1' : 'https://risk.internal.example.com/check';
        find('[data-show-body]').forEach((element) => { element.hidden = element.dataset.showBody !== node.config.body; });
        find('[data-show-response]').forEach((element) => { element.hidden = element.dataset.showResponse !== node.config.responseTo; });
        find('[data-variable-name]').forEach((element) => { element.textContent = node.config.variable || 'name'; });
    };
    bindFields(root, node, sync);
    pairList(root, node, 'headers');
    pairList(root, node, 'query');
    bindNextFields(root, node);
    sync();
    return root;
}

function validateRequestPanel(node) {
    const root = panel('panel-validateRequest');
    const find = finder(root);
    const sync = () => {
        find('[data-show-query]').forEach((element) => { element.hidden = !node.config.query; });
    };
    bindFields(root, node, sync);
    bindNextFields(root, node);
    sync();
    return root;
}

function validateBodyPanel(node) {
    const root = panel('panel-validateBody');
    bindFields(root, node);
    bindNextFields(root, node);
    return root;
}

function securityPanel(node) {
    const root = panel('panel-security');
    const find = finder(root);
    const sync = () => {
        const { config } = node;
        find('[data-show-mode]').forEach((element) => { element.hidden = element.dataset.showMode !== config.mode; });
        find('[data-show-brute]').forEach((element) => { element.hidden = !config.bruteForce; });
        const named = config.bruteKey === 'header' || config.bruteKey === 'body';
        find('[data-show-brute-name]').forEach((element) => { element.hidden = !named; });
        const [name] = find('#secBruteName');
        find('[data-brute-name-label]')[0].textContent = config.bruteKey === 'header' ? 'Header name' : 'Body field';
        name.placeholder = config.bruteKey === 'header' ? 'x-username' : 'username or user.email';
    };
    bindFields(root, node, sync);
    bindNextFields(root, node);
    sync();
    return root;
}

function overviewPanel() {
    const root = panel('panel-overview');
    const field = root.querySelector('[data-description]');
    field.value = description ?? '';
    field.addEventListener('input', () => {
        description = field.value;
        markDirty();
    });
    root.querySelector('[data-delete-policy]').addEventListener('click', () => { leaving = true; });
    return root;
}

function edgePanel(edge) {
    const root = panel('panel-edge');
    const from = canvas.node(edge.from);
    const to = canvas.node(edge.to);
    const branch = edge.port === 'next' ? '' : ` (${Flow.PORT_LABELS[edge.port]})`;
    root.querySelector('[data-edge-summary]').textContent = `From ${from.name}${branch} to ${to.name}.`;
    root.querySelector('[data-remove-edge]').addEventListener('click', () => canvas.removeEdge(edge.id));
    return root;
}

function simplePanel(node, template) {
    const root = panel(template);
    bindNextFields(root, node);
    return root;
}

function renderInspector() {
    const selection = canvas.selection;
    let content;
    if (!selection) {
        content = overviewPanel();
    } else if (selection.kind === 'edge') {
        const edge = canvas.flow.edges.find((item) => item.id === selection.id);
        content = edge ? edgePanel(edge) : overviewPanel();
    } else {
        const node = selectedNode();
        if (!node) content = overviewPanel();
        else if (node.type === 'script') content = scriptPanel(node);
        else if (node.type === 'if') content = ifPanel(node);
        else if (node.type === 'invoke') content = invokePanel(node);
        else if (node.type === 'validateRequest') content = validateRequestPanel(node);
        else if (node.type === 'validateBody') content = validateBodyPanel(node);
        else if (node.type === 'security') content = securityPanel(node);
        else content = simplePanel(node, `panel-${node.type}`);
    }
    // Keep the field being typed in when the panel is rebuilt for the same step.
    const focusedId = inspector.contains(document.activeElement) ? document.activeElement.id : null;
    inspector.replaceChildren(content);
    if (focusedId) document.getElementById(focusedId)?.focus();
}

// ------------------------------------------------------------------ save

UI.bindForm(policyForm, {
    alert: document.getElementById('form-alert'),
    loadingLabel: 'Saving…',
    submit: async (formData) => {
        const result = await UI.sendJson(policyUrl, {
            method: 'PUT',
            body: { name: formData.get('name'), description, flow: canvas.flow },
        });
        dirty = false;
        dirtyNote.textContent = 'Saved';
        dirtyNote.classList.remove('is-dirty');
        document.title = document.title.replace(/^[^|–-]*/, `${result.policy.name} `);
        const errors = result.policy.problems.filter((problem) => problem.level === 'error').length;
        UI.toast(errors ? `Policy saved. Fix ${plural(errors, 'problem')} before the next push.` : 'Policy saved. Push the gateways to deploy it.');
    },
});

document.getElementById('name').addEventListener('input', markDirty);

document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        policyForm.requestSubmit();
    }
});

// ------------------------------------------------------------------ test

const testPanel = document.getElementById('test');
const testOutput = document.getElementById('testOutput');
const runTestButton = document.getElementById('runTest');
const clearTestButton = document.getElementById('clearTest');

const pretty = (value) => JSON.stringify(value, null, 2);

function showResponse(response) {
    if (!response) return '';
    const head = `HTTP ${response.status}${response.echoed ? ' (the request, returned as it is)' : ''}`;
    const headers = Object.entries(response.headers || {}).map(([name, value]) => `${name}: ${value}`).join('\n');
    let body = response.body || '';
    if (response.bodyEncoding === 'base64') body = `[binary, ${Math.round(body.length * 0.75)} bytes]`;
    else {
        try {
            body = pretty(JSON.parse(body));
        } catch {
            // not JSON
        }
    }
    return [head, headers, '', body, response.truncated ? '\n[cut at 256 KB]' : ''].filter((part, index) => part || index === 2).join('\n');
}

function stepItem(step) {
    const item = document.createElement('li');
    item.className = `test-step type-${step.type}${step.error ? ' is-failed' : ''}`;
    const icon = document.createElement('span');
    icon.className = `flow-icon type-${step.type}`;
    icon.innerHTML = icons[step.type] || '';
    const body = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'test-step-title';
    title.textContent = step.name;
    if (step.durationMs !== undefined) {
        const time = document.createElement('span');
        time.className = 'test-step-time';
        time.textContent = `${step.durationMs} ms`;
        title.appendChild(time);
    }
    const text = document.createElement('div');
    text.className = 'test-step-text';
    text.textContent = step.error || step.outcome || '';
    body.append(title, text);
    // Validation errors and security findings, one per line.
    if (step.problems?.length) {
        const problems = document.createElement('pre');
        problems.textContent = step.problems.map((problem) => (problem.rule
            ? `${problem.label} in ${problem.location}`
            : `${problem.in ? `${problem.in} ${problem.name}` : 'body'}${problem.path || ''}: ${problem.message}`)).join('\n');
        body.appendChild(problems);
    }
    if (step.logs?.length) {
        const logs = document.createElement('pre');
        logs.textContent = step.logs.map(([level, message]) => `[${level}] ${message}`).join('\n');
        body.appendChild(logs);
    }
    item.append(icon, body);
    return item;
}

function showTest(className, message, outcome) {
    const status = testOutput.querySelector('[data-test-status]');
    status.className = `alert ${className}`;
    status.textContent = message;
    const steps = outcome?.steps || [];
    testOutput.querySelector('[data-test-steps]').replaceChildren(...steps.map(stepItem));
    testOutput.querySelector('.test-result-grid').hidden = !outcome;
    testOutput.querySelector('[data-test-response]').textContent = showResponse(outcome?.response);
    const variables = outcome?.variables && Object.keys(outcome.variables).length ? outcome.variables : null;
    testOutput.querySelector('[data-test-variables-wrap]').hidden = !variables;
    testOutput.querySelector('[data-test-variables]').textContent = variables ? pretty(variables) : '';
    const sent = outcome?.request?.sent;
    testOutput.querySelector('[data-test-sent-wrap]').hidden = !sent;
    testOutput.querySelector('[data-test-sent]').textContent = sent
        ? [`${sent.method} ${sent.url}`, ...Object.entries(sent.headers || {}).map(([name, value]) => `${name}: ${value}`)].join('\n')
        : '';
    testOutput.hidden = false;
    clearTestButton.hidden = false;
    canvas.setTrace(steps.length ? steps : null);
}

runTestButton.addEventListener('click', async () => {
    const value = (id) => document.getElementById(id).value;
    UI.setLoading(runTestButton, true, 'Running…');
    try {
        const outcome = await UI.sendJson(testPanel.dataset.testUrl, {
            body: {
                name: value('name'),
                flow: canvas.flow,
                apiId: value('testApi') || null,
                sample: {
                    method: value('testMethod'),
                    path: value('testPath'),
                    query: value('testQuery'),
                    headers: value('testHeaders'),
                    body: value('testBody'),
                },
            },
        });
        const where = `${outcome.gateway} / ${outcome.node}`;
        if (!outcome.ok) {
            showTest('alert-danger', `The test could not start on ${where}: ${outcome.error || 'unknown error'}`, null);
        } else if (outcome.result.ok) {
            const total = outcome.result.steps.reduce((sum, step) => sum + (step.durationMs || 0), 0);
            showTest('alert-success', `Ran on ${where} in ${Math.round(total)} ms. The client gets status ${outcome.result.response.status}.`, outcome.result);
        } else {
            showTest('alert-danger', `The flow failed on ${where}: ${outcome.result.error} Live traffic would get status 500 (or the service's 502/504).`, outcome.result);
        }
    } catch (error) {
        showTest('alert-warning', error.message, null);
    }
    UI.setLoading(runTestButton, false);
});

clearTestButton.addEventListener('click', () => {
    testOutput.hidden = true;
    clearTestButton.hidden = true;
    canvas.setTrace(null);
});

// The test fields sit inside the policy form: Enter there runs the test instead of saving.
testPanel.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
        event.preventDefault();
        runTestButton.click();
    }
});

// ------------------------------------------------------------------ start

validate();
renderInspector();
requestAnimationFrame(() => canvas.fit());
