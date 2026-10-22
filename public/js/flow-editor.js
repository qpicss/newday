// The canvas of the policy editor: draws the steps of a flow (gateway/src/flow.js format) and the
// lines between them, and lets people move steps, connect them by dragging from a step's dot to
// another step, select and delete steps and lines, pan, zoom and tidy up. Settings of a step are
// edited by policy-detail.js; this file only changes positions, lines and the list of steps.
(function () {
    const Flow = window.PolicyFlow;
    const NODE_WIDTH = 216;
    const NODE_HEIGHT = { input: 64, output: 64, script: 68, invoke: 68, if: 84, validateRequest: 68, validateBody: 68, security: 68 };
    const PORT_POSITION = { next: 0.5, true: 0.35, false: 0.72 };
    const GRID = 20;
    const SPACING_X = 260;
    const SPACING_Y = 124;
    const MIN_SCALE = 0.4;
    // Fit never shrinks steps below this; a larger flow starts at Input and the rest is a pan away.
    const MIN_FIT_SCALE = 0.7;
    const MAX_SCALE = 1.6;
    const SVG = 'http://www.w3.org/2000/svg';

    const heightOf = (node) => NODE_HEIGHT[node.type] || 68;
    const outPoint = (node, port) => ({ x: node.x + NODE_WIDTH, y: node.y + heightOf(node) * (PORT_POSITION[port] ?? 0.5) });
    const inPoint = (node) => ({ x: node.x, y: node.y + heightOf(node) / 2 });
    const snap = (value) => Math.round(value / GRID) * GRID;
    const curve = (a, b) => {
        const dx = Math.max(48, Math.abs(b.x - a.x) / 2);
        return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
    };
    // Midpoint of the cubic curve above (t = 0.5).
    const curveMiddle = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    let counter = 0;
    const newId = (type) => {
        counter += 1;
        return `${type}-${Date.now().toString(36).slice(-5)}${counter.toString(36)}`;
    };

    class FlowCanvas {
        // options: canvas, world, svg, edgeDelete, flow, icons (type -> SVG markup),
        // describe(node) -> { kind, detail }, onChange(reason), onSelect(selection), onZoom(scale)
        constructor(options) {
            Object.assign(this, options);
            this.view = { x: 0, y: 0, scale: 1 };
            this.selection = null; // { kind: 'node' | 'edge', id }
            this.elements = new Map();
            this.problems = new Map();
            this.trace = null;
            this.bindPointer();
            this.bindKeyboard();
            this.edgeDelete.addEventListener('click', () => {
                if (this.selection?.kind === 'edge') this.removeEdge(this.selection.id);
            });
            this.render();
        }

        node(id) {
            return this.flow.nodes.find((node) => node.id === id);
        }

        edgeFrom(id, port) {
            return this.flow.edges.find((edge) => edge.from === id && edge.port === port);
        }

        // ---------------------------------------------------------------- drawing

        render() {
            const ids = new Set(this.flow.nodes.map((node) => node.id));
            for (const [id, element] of this.elements) {
                if (!ids.has(id)) {
                    element.remove();
                    this.elements.delete(id);
                }
            }
            this.flow.nodes.forEach((node) => this.renderNode(node));
            this.renderEdges();
            this.applyView();
        }

        renderNode(node) {
            let element = this.elements.get(node.id);
            if (!element) {
                element = document.createElement('div');
                element.dataset.nodeId = node.id;
                element.tabIndex = 0;
                element.setAttribute('role', 'button');
                this.world.appendChild(element);
                this.elements.set(node.id, element);
            }
            const info = this.describe(node);
            const problems = this.problems.get(node.id) || [];
            const order = this.trace?.order.get(node.id);
            element.className = [
                'flow-node',
                `type-${node.type}`,
                this.selection?.kind === 'node' && this.selection.id === node.id ? 'is-selected' : '',
                problems.some((problem) => problem.level === 'error') ? 'has-error' : problems.length ? 'has-warning' : '',
                order ? 'is-traced' : '',
                this.trace?.failed.has(node.id) ? 'is-failed' : '',
            ].filter(Boolean).join(' ');
            element.style.left = `${node.x}px`;
            element.style.top = `${node.y}px`;
            element.style.width = `${NODE_WIDTH}px`;
            element.style.height = `${heightOf(node)}px`;
            element.setAttribute('aria-label', `${info.kind}: ${node.name}${info.detail ? `. ${info.detail}` : ''}`);
            element.setAttribute('aria-pressed', String(this.selection?.kind === 'node' && this.selection.id === node.id));
            element.title = problems.map((problem) => problem.message).join('\n');

            const parts = [];
            if (node.type !== 'input') parts.push(this.make('span', 'flow-port flow-port-in'));
            const icon = this.make('span', `flow-icon type-${node.type}`);
            icon.innerHTML = this.icons[node.type] || '';
            parts.push(icon);
            const text = this.make('span', 'flow-node-text');
            if (node.type !== 'input' && node.type !== 'output') text.appendChild(this.make('span', 'flow-node-kind', info.kind));
            text.appendChild(this.make('span', 'flow-node-name', node.name));
            if (info.detail) text.appendChild(this.make('span', 'flow-node-detail', info.detail));
            parts.push(text);
            for (const port of Flow.PORTS[node.type]) {
                const handle = this.make('span', `flow-port flow-port-out port-${port}`);
                handle.dataset.port = port;
                handle.style.top = `${heightOf(node) * PORT_POSITION[port]}px`;
                handle.title = port === 'next' ? 'Drag to the next step' : `Drag to the step for "${Flow.PORT_LABELS[port]}"`;
                if (port !== 'next') handle.appendChild(this.make('span', 'flow-port-label', Flow.PORT_LABELS[port]));
                parts.push(handle);
            }
            if (order) parts.push(this.make('span', 'flow-node-order', order.join(', ')));
            if (problems.length) {
                const marker = this.make('span', 'flow-node-problem');
                marker.innerHTML = this.icons.alert;
                parts.push(marker);
            }
            element.replaceChildren(...parts);
        }

        make(tag, className, text) {
            const element = document.createElement(tag);
            if (className) element.className = className;
            if (text !== undefined) element.textContent = text;
            return element;
        }

        renderEdges() {
            [...this.svg.querySelectorAll('.flow-edge, .flow-edge-temp')].forEach((element) => element.remove());
            for (const edge of this.flow.edges) {
                const from = this.node(edge.from);
                const to = this.node(edge.to);
                if (!from || !to) continue;
                const d = curve(outPoint(from, edge.port), inPoint(to));
                const selected = this.selection?.kind === 'edge' && this.selection.id === edge.id;
                const traced = this.trace?.edges.has(`${edge.from}:${edge.port}`);
                const group = document.createElementNS(SVG, 'g');
                group.setAttribute('class', `flow-edge port-${edge.port}${selected ? ' is-selected' : ''}${traced ? ' is-traced' : ''}`);
                group.dataset.edgeId = edge.id;
                const hit = document.createElementNS(SVG, 'path');
                hit.setAttribute('class', 'flow-edge-hit');
                hit.setAttribute('d', d);
                const line = document.createElementNS(SVG, 'path');
                line.setAttribute('class', 'flow-edge-line');
                line.setAttribute('d', d);
                line.setAttribute('marker-end', selected || traced ? 'url(#flow-arrow-active)' : 'url(#flow-arrow)');
                group.append(hit, line);
                this.svg.appendChild(group);
            }
            this.placeEdgeDelete();
        }

        placeEdgeDelete() {
            const edge = this.selection?.kind === 'edge' ? this.flow.edges.find((item) => item.id === this.selection.id) : null;
            const from = edge && this.node(edge.from);
            const to = edge && this.node(edge.to);
            if (!from || !to) {
                this.edgeDelete.hidden = true;
                return;
            }
            const middle = curveMiddle(outPoint(from, edge.port), inPoint(to));
            this.edgeDelete.hidden = false;
            this.edgeDelete.style.left = `${middle.x * this.view.scale + this.view.x}px`;
            this.edgeDelete.style.top = `${middle.y * this.view.scale + this.view.y}px`;
        }

        applyView() {
            const { x, y, scale } = this.view;
            this.world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
            this.canvas.style.backgroundSize = `${GRID * scale}px ${GRID * scale}px`;
            this.canvas.style.backgroundPosition = `${x}px ${y}px`;
            this.placeEdgeDelete();
            this.onZoom?.(scale);
        }

        // ---------------------------------------------------------------- state from the page

        setProblems(problems) {
            this.problems = new Map();
            for (const problem of problems) {
                if (!problem.nodeId) continue;
                if (!this.problems.has(problem.nodeId)) this.problems.set(problem.nodeId, []);
                this.problems.get(problem.nodeId).push(problem);
            }
            this.flow.nodes.forEach((node) => this.renderNode(node));
        }

        // steps: the trace of a test run ([{ nodeId, branch, error }]), or null to clear it.
        setTrace(steps) {
            if (!steps) {
                if (!this.trace) return;
                this.trace = null;
            } else {
                const order = new Map();
                const edges = new Set();
                const failed = new Set();
                steps.forEach((step, index) => {
                    if (!step.nodeId) return;
                    if (!order.has(step.nodeId)) order.set(step.nodeId, []);
                    order.get(step.nodeId).push(index + 1);
                    if (step.error) failed.add(step.nodeId);
                    const next = steps[index + 1];
                    if (next && next.nodeId) edges.add(`${step.nodeId}:${step.branch || 'next'}`);
                });
                this.trace = { order, edges, failed };
            }
            this.render();
        }

        select(selection) {
            const same = (this.selection && selection && this.selection.kind === selection.kind && this.selection.id === selection.id)
                || (!this.selection && !selection);
            this.selection = selection;
            this.flow.nodes.forEach((node) => this.renderNode(node));
            this.renderEdges();
            if (!same) this.onSelect?.(selection);
        }

        changed(reason) {
            this.render();
            this.onChange?.(reason);
        }

        // ---------------------------------------------------------------- editing

        addNode(type, position) {
            const node = {
                id: newId(type),
                type,
                name: Flow.TYPE_LABELS[type],
                x: snap(position.x),
                y: snap(position.y),
                config: Flow.defaultConfig(type),
            };
            if (type === 'script') node.config.code = this.defaultScript || '';
            if (type === 'invoke') node.config.url = this.backendUrl || '';
            this.flow.nodes.push(node);
            return node;
        }

        // Inserts a step after the selected one (or before Output) and keeps the flow connected.
        insertAfter(type) {
            const nodes = this.flow.nodes;
            let anchor = this.selection?.kind === 'node' ? this.node(this.selection.id) : null;
            if (!anchor || anchor.type === 'output') {
                const output = nodes.find((node) => node.type === 'output');
                const live = Flow.reachable(this.flow);
                const into = this.flow.edges
                    .filter((edge) => edge.to === output.id && live.has(edge.from))
                    .map((edge) => this.node(edge.from))
                    .sort((a, b) => b.x - a.x)[0];
                anchor = into || nodes.find((node) => node.type === 'input');
            }
            const port = anchor.type === 'if' ? 'true' : 'next';
            const existing = this.edgeFrom(anchor.id, port);
            const after = existing ? this.node(existing.to) : null;
            const x = anchor.x + SPACING_X;
            const y = anchor.type === 'if' ? anchor.y - 20 : anchor.y + (heightOf(anchor) - NODE_HEIGHT[type]) / 2;
            // Make room: everything to the right of the anchor moves one column on.
            nodes.forEach((node) => {
                if (node.id !== anchor.id && node.x >= x - NODE_WIDTH / 2) node.x += SPACING_X;
            });
            const node = this.addNode(type, { x, y });
            if (existing) this.flow.edges = this.flow.edges.filter((edge) => edge !== existing);
            this.link(anchor.id, port, node.id);
            if (after) {
                for (const nextPort of Flow.PORTS[type]) this.link(node.id, nextPort, after.id);
            }
            this.selection = { kind: 'node', id: node.id };
            this.changed('add');
            this.onSelect?.(this.selection);
            return node;
        }

        link(from, port, to) {
            this.flow.edges = this.flow.edges.filter((edge) => !(edge.from === from && edge.port === port));
            if (to) this.flow.edges.push({ id: `${from}-${port}`, from, port, to });
        }

        connect(from, port, to) {
            const source = this.node(from);
            const target = to ? this.node(to) : null;
            if (!source || (to && (!target || target.type === 'input' || target.id === source.id))) return false;
            this.link(from, port, to);
            this.changed('connect');
            return true;
        }

        removeEdge(id) {
            this.flow.edges = this.flow.edges.filter((edge) => edge.id !== id);
            this.selection = null;
            this.changed('disconnect');
            this.onSelect?.(null);
        }

        // Removes a step; lines that led into it now lead to where it went next.
        removeNode(id) {
            const node = this.node(id);
            if (!node || node.type === 'input' || node.type === 'output') return;
            const onward = this.edgeFrom(id, node.type === 'if' ? 'true' : 'next');
            this.flow.edges = this.flow.edges
                .filter((edge) => edge.from !== id)
                .map((edge) => (edge.to === id ? (onward ? { ...edge, to: onward.to } : null) : edge))
                .filter(Boolean)
                .filter((edge) => edge.from !== edge.to);
            this.flow.nodes = this.flow.nodes.filter((item) => item.id !== id);
            this.selection = null;
            this.changed('remove');
            this.onSelect?.(null);
        }

        // Columns by distance from Input, steps of a column stacked; unconnected steps go below.
        tidy() {
            const level = new Map();
            const input = this.flow.nodes.find((node) => node.type === 'input');
            const output = this.flow.nodes.find((node) => node.type === 'output');
            const visit = (node, depth, path) => {
                if (path.has(node.id)) return;
                if ((level.get(node.id) ?? -1) >= depth) return;
                level.set(node.id, depth);
                path.add(node.id);
                for (const port of Flow.PORTS[node.type]) {
                    const edge = this.edgeFrom(node.id, port);
                    const target = edge && this.node(edge.to);
                    if (target) visit(target, depth + 1, path);
                }
                path.delete(node.id);
            };
            visit(input, 0, new Set());
            const deepest = Math.max(0, ...[...level.entries()].filter(([id]) => id !== output.id).map(([, depth]) => depth));
            level.set(output.id, Math.max(level.get(output.id) ?? 0, deepest + 1));
            const columns = new Map();
            const loose = [];
            for (const node of this.flow.nodes) {
                if (!level.has(node.id)) {
                    loose.push(node);
                    continue;
                }
                const depth = level.get(node.id);
                if (!columns.has(depth)) columns.set(depth, []);
                columns.get(depth).push(node);
            }
            const tallest = Math.max(1, ...[...columns.values()].map((column) => column.length));
            for (const [depth, column] of columns) {
                column.sort((a, b) => a.y - b.y);
                const top = 160 - ((column.length - 1) * SPACING_Y) / 2 + ((tallest - 1) * SPACING_Y) / 2;
                column.forEach((node, index) => {
                    node.x = 40 + depth * SPACING_X;
                    node.y = snap(top + index * SPACING_Y);
                });
            }
            loose.forEach((node, index) => {
                node.x = 40 + index * SPACING_X;
                node.y = snap(160 + tallest * SPACING_Y);
            });
            this.changed('move');
            this.fit();
        }

        // ---------------------------------------------------------------- view

        fit() {
            const rect = this.canvas.getBoundingClientRect();
            if (!rect.width || !this.flow.nodes.length) return;
            const minX = Math.min(...this.flow.nodes.map((node) => node.x));
            const minY = Math.min(...this.flow.nodes.map((node) => node.y));
            const maxX = Math.max(...this.flow.nodes.map((node) => node.x + NODE_WIDTH));
            const maxY = Math.max(...this.flow.nodes.map((node) => node.y + heightOf(node)));
            const pad = 48;
            const scale = Math.max(MIN_FIT_SCALE, Math.min(1, (rect.width - pad * 2) / (maxX - minX), (rect.height - pad * 2) / (maxY - minY)));
            const width = (maxX - minX) * scale;
            const height = (maxY - minY) * scale;
            this.view = {
                scale,
                x: width <= rect.width - pad * 2 ? (rect.width - width) / 2 - minX * scale : pad - minX * scale,
                y: height <= rect.height - pad * 2 ? (rect.height - height) / 2 - minY * scale : pad - minY * scale,
            };
            this.applyView();
        }

        zoomBy(factor, center) {
            const rect = this.canvas.getBoundingClientRect();
            const point = center || { x: rect.width / 2, y: rect.height / 2 };
            const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.view.scale * factor));
            const ratio = scale / this.view.scale;
            this.view = { scale, x: point.x - (point.x - this.view.x) * ratio, y: point.y - (point.y - this.view.y) * ratio };
            this.applyView();
        }

        toWorld(clientX, clientY) {
            const rect = this.canvas.getBoundingClientRect();
            return { x: (clientX - rect.left - this.view.x) / this.view.scale, y: (clientY - rect.top - this.view.y) / this.view.scale };
        }

        // ---------------------------------------------------------------- pointer and keyboard

        bindPointer() {
            let action = null;
            const canvas = this.canvas;

            canvas.addEventListener('pointerdown', (event) => {
                if (event.button !== 0 || event.target.closest('.flow-edge-delete')) return;
                const port = event.target.closest('.flow-port-out');
                const nodeElement = event.target.closest('.flow-node');
                const edgeElement = event.target.closest('.flow-edge');
                const start = { clientX: event.clientX, clientY: event.clientY };
                if (port && nodeElement) {
                    const temp = document.createElementNS(SVG, 'path');
                    temp.setAttribute('class', 'flow-edge-temp');
                    this.svg.appendChild(temp);
                    action = { type: 'connect', from: nodeElement.dataset.nodeId, port: port.dataset.port, temp, start };
                } else if (nodeElement) {
                    const node = this.node(nodeElement.dataset.nodeId);
                    if (!(this.selection?.kind === 'node' && this.selection.id === node.id)) this.select({ kind: 'node', id: node.id });
                    // preventDefault below stops the browser from moving focus, so the keyboard
                    // (Delete, arrows) would still talk to the last field otherwise.
                    nodeElement.focus({ preventScroll: true });
                    action = { type: 'drag', node, origin: { x: node.x, y: node.y }, start, moved: false };
                } else if (edgeElement) {
                    this.select({ kind: 'edge', id: edgeElement.dataset.edgeId });
                    action = null;
                    canvas.focus({ preventScroll: true });
                    return;
                } else {
                    canvas.focus({ preventScroll: true });
                    action = { type: 'pan', origin: { x: this.view.x, y: this.view.y }, start, moved: false };
                }
                canvas.setPointerCapture(event.pointerId);
                event.preventDefault();
            });

            canvas.addEventListener('pointermove', (event) => {
                if (!action) return;
                const dx = event.clientX - action.start.clientX;
                const dy = event.clientY - action.start.clientY;
                if (Math.abs(dx) + Math.abs(dy) > 3) action.moved = true;
                if (action.type === 'pan') {
                    this.view.x = action.origin.x + dx;
                    this.view.y = action.origin.y + dy;
                    this.applyView();
                } else if (action.type === 'drag' && action.moved) {
                    action.node.x = snap(action.origin.x + dx / this.view.scale);
                    action.node.y = snap(action.origin.y + dy / this.view.scale);
                    const element = this.elements.get(action.node.id);
                    element.style.left = `${action.node.x}px`;
                    element.style.top = `${action.node.y}px`;
                    this.renderEdges();
                } else if (action.type === 'connect') {
                    const from = this.node(action.from);
                    const target = this.targetAt(event.clientX, event.clientY, action.from);
                    this.highlightTarget(target);
                    const end = target ? inPoint(target) : this.toWorld(event.clientX, event.clientY);
                    action.temp.setAttribute('d', curve(outPoint(from, action.port), end));
                    if (!this.svg.contains(action.temp)) this.svg.appendChild(action.temp);
                }
            });

            const finish = (event) => {
                if (!action) return;
                const current = action;
                action = null;
                if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
                if (current.type === 'pan' && !current.moved) {
                    this.select(null);
                } else if (current.type === 'drag' && current.moved) {
                    this.changed('move');
                } else if (current.type === 'connect') {
                    current.temp.remove();
                    this.highlightTarget(null);
                    const target = event.type === 'pointerup' ? this.targetAt(event.clientX, event.clientY, current.from) : null;
                    if (target) {
                        this.connect(current.from, current.port, target.id);
                    } else if (!current.moved) {
                        // A click on a dot selects the line that starts there.
                        const edge = this.edgeFrom(current.from, current.port);
                        if (edge) this.select({ kind: 'edge', id: edge.id });
                    }
                }
            };
            canvas.addEventListener('pointerup', finish);
            canvas.addEventListener('pointercancel', finish);

            canvas.addEventListener('wheel', (event) => {
                if (!event.ctrlKey && !event.metaKey) return;
                event.preventDefault();
                const rect = canvas.getBoundingClientRect();
                this.zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, { x: event.clientX - rect.left, y: event.clientY - rect.top });
            }, { passive: false });

            canvas.addEventListener('focusin', (event) => {
                const nodeElement = event.target.closest?.('.flow-node');
                if (nodeElement && !(this.selection?.kind === 'node' && this.selection.id === nodeElement.dataset.nodeId)) {
                    this.select({ kind: 'node', id: nodeElement.dataset.nodeId });
                }
            });
        }

        targetAt(clientX, clientY, fromId) {
            const element = document.elementFromPoint(clientX, clientY)?.closest('.flow-node');
            const node = element && this.node(element.dataset.nodeId);
            return node && node.id !== fromId && node.type !== 'input' ? node : null;
        }

        highlightTarget(node) {
            this.elements.forEach((element, id) => element.classList.toggle('is-drop-target', Boolean(node && node.id === id)));
        }

        bindKeyboard() {
            this.canvas.addEventListener('keydown', (event) => {
                const selected = this.selection;
                if (event.key === 'Escape') {
                    this.select(null);
                    return;
                }
                if (!selected) return;
                if (event.key === 'Delete' || event.key === 'Backspace') {
                    event.preventDefault();
                    if (selected.kind === 'edge') this.removeEdge(selected.id);
                    else this.removeNode(selected.id);
                    this.canvas.focus({ preventScroll: true });
                    return;
                }
                const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
                if (selected.kind === 'node' && moves[event.key]) {
                    event.preventDefault();
                    const node = this.node(selected.id);
                    const step = event.shiftKey ? GRID * 3 : GRID;
                    node.x += moves[event.key][0] * step;
                    node.y += moves[event.key][1] * step;
                    this.changed('move');
                    this.elements.get(node.id)?.focus({ preventScroll: true });
                }
            });
        }

        // Palette buttons: click inserts after the selected step; dragging drops a step where it lands.
        bindPalette(buttons) {
            buttons.forEach((button) => {
                let drag = null;
                let dragged = false;
                button.addEventListener('pointerdown', (event) => {
                    if (event.button !== 0) return;
                    drag = { x: event.clientX, y: event.clientY, ghost: null };
                    dragged = false;
                    button.setPointerCapture(event.pointerId);
                });
                button.addEventListener('pointermove', (event) => {
                    if (!drag) return;
                    if (!drag.ghost && Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 6) {
                        drag.ghost = button.cloneNode(true);
                        drag.ghost.classList.add('palette-ghost');
                        drag.ghost.setAttribute('aria-hidden', 'true');
                        document.body.appendChild(drag.ghost);
                    }
                    if (drag.ghost) {
                        drag.ghost.style.left = `${event.clientX}px`;
                        drag.ghost.style.top = `${event.clientY}px`;
                        this.canvas.classList.toggle('is-drop-zone', this.isOverCanvas(event.clientX, event.clientY));
                    }
                });
                const end = (event) => {
                    if (!drag) return;
                    const { ghost } = drag;
                    drag = null;
                    this.canvas.classList.remove('is-drop-zone');
                    if (!ghost) return;
                    ghost.remove();
                    dragged = true;
                    if (event.type === 'pointerup' && this.isOverCanvas(event.clientX, event.clientY)) {
                        const point = this.toWorld(event.clientX, event.clientY);
                        const type = button.dataset.addStep;
                        const node = this.addNode(type, { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT[type] / 2 });
                        this.selection = { kind: 'node', id: node.id };
                        this.changed('add');
                        this.onSelect?.(this.selection);
                    }
                };
                button.addEventListener('pointerup', end);
                button.addEventListener('pointercancel', end);
                button.addEventListener('click', () => {
                    if (dragged) {
                        dragged = false;
                        return;
                    }
                    this.insertAfter(button.dataset.addStep);
                });
            });
        }

        isOverCanvas(clientX, clientY) {
            const rect = this.canvas.getBoundingClientRect();
            return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
        }
    }

    window.FlowCanvas = FlowCanvas;
}());
