// Small SVG charts for the admin UI: single-series columns (per-mark hover) and a line with a
// crosshair. One scale per chart, hairline gridlines, 4px rounded column tops, 2px gaps, values
// in text colors; every chart has a table view. Names and values are set with textContent.
(function () {
    const SVG = 'http://www.w3.org/2000/svg';
    const tooltip = () => document.getElementById('tooltip');

    function el(name, attributes = {}, parent) {
        const node = document.createElementNS(SVG, name);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
        if (parent) parent.append(node);
        return node;
    }

    function niceMax(value) {
        if (value <= 0) return 4;
        const power = Math.pow(10, Math.floor(Math.log10(value)));
        const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((candidate) => candidate * 4 >= value);
        return step * 4;
    }

    function compact(value) {
        if (value >= 1000000) return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}M`;
        if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`;
        return String(Math.round(value * 10) / 10);
    }

    function showTooltip(event, value, label) {
        const box = tooltip();
        const strong = document.createElement('strong');
        strong.textContent = value;
        const span = document.createElement('span');
        span.textContent = label;
        box.replaceChildren(strong, span);
        box.hidden = false;
        const x = Math.min(window.innerWidth - box.offsetWidth - 12, event.clientX + 14);
        const y = Math.max(8, event.clientY - box.offsetHeight - 12);
        box.style.left = `${x}px`;
        box.style.top = `${y}px`;
    }

    function hideTooltip() {
        tooltip().hidden = true;
    }

    function frame(container) {
        const width = Math.max(280, container.clientWidth - 36);
        const height = 200;
        const margin = { top: 10, right: 8, bottom: 22, left: 40 };
        const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
        return { svg, width, height, margin, plotWidth: width - margin.left - margin.right, plotHeight: height - margin.top - margin.bottom };
    }

    function axes(f, max, points, timeLabel) {
        const grid = el('g', { class: 'grid' }, f.svg);
        const axis = el('g', { class: 'axis' }, f.svg);
        for (let i = 0; i <= 4; i += 1) {
            const value = (max / 4) * i;
            const y = f.margin.top + f.plotHeight - (value / max) * f.plotHeight;
            el('line', { x1: f.margin.left, x2: f.width - f.margin.right, y1: y, y2: y }, grid);
            const text = el('text', { x: f.margin.left - 8, y: y + 4, 'text-anchor': 'end' }, axis);
            text.textContent = compact(value);
        }
        // Start, middle and end times along the bottom.
        [0, Math.floor((points.length - 1) / 2), points.length - 1].forEach((index, position) => {
            if (!points[index]) return;
            const x = f.margin.left + ((index + 0.5) / points.length) * f.plotWidth;
            const text = el('text', { x, y: f.height - 4, 'text-anchor': position === 0 ? 'start' : position === 2 ? 'end' : 'middle' }, axis);
            text.textContent = timeLabel(points[index]);
        });
    }

    function table(container, points, columns) {
        const details = document.createElement('details');
        details.className = 'chart-table';
        const summary = document.createElement('summary');
        summary.textContent = 'Show as table';
        const wrap = document.createElement('div');
        wrap.className = 'table-wrap';
        const tableEl = document.createElement('table');
        const head = tableEl.createTHead().insertRow();
        columns.forEach((column) => {
            const th = document.createElement('th');
            th.textContent = column.label;
            if (column.numeric) th.className = 'num';
            head.append(th);
        });
        const body = tableEl.createTBody();
        points.forEach((point) => {
            const row = body.insertRow();
            columns.forEach((column) => {
                const cell = row.insertCell();
                cell.textContent = column.value(point);
                if (column.numeric) cell.className = 'num';
            });
        });
        wrap.append(tableEl);
        details.append(summary, wrap);
        container.append(details);
    }

    // points: [{ time, ...values }]; options: { key, label, unit, timeLabel, errors }
    function columns(container, points, options) {
        container.replaceChildren();
        const chart = document.createElement('div');
        chart.className = `chart${options.errors ? ' errors' : ''}`;
        container.append(chart);
        const f = frame(chart);
        f.svg.setAttribute('aria-label', options.label);
        const values = points.map((point) => point[options.key] || 0);
        const max = niceMax(Math.max(...values, 0));
        axes(f, max, points, options.timeLabel);

        const slot = f.plotWidth / points.length;
        const barWidth = Math.max(1, Math.min(24, slot - 2));
        const marks = el('g', {}, f.svg);
        points.forEach((point, index) => {
            const value = values[index];
            const x = f.margin.left + index * slot + (slot - barWidth) / 2;
            const baseline = f.margin.top + f.plotHeight;
            const heightValue = (value / max) * f.plotHeight;
            const hit = el('rect', { class: 'hit', x: f.margin.left + index * slot, y: f.margin.top, width: slot, height: f.plotHeight, tabindex: '0' }, marks);
            if (heightValue > 0) {
                const radius = Math.min(4, barWidth / 2, heightValue);
                // Rounded data end, square at the baseline.
                const top = baseline - heightValue;
                const d = `M${x},${baseline} V${top + radius} Q${x},${top} ${x + radius},${top} H${x + barWidth - radius} Q${x + barWidth},${top} ${x + barWidth},${top + radius} V${baseline} Z`;
                el('path', { class: 'bar', d }, marks);
            }
            const text = `${compact(value)}${options.unit ? ` ${options.unit}` : ''}`;
            const label = `${options.label} · ${options.timeLabel(point)}`;
            hit.addEventListener('pointermove', (event) => showTooltip(event, text, label));
            hit.addEventListener('pointerleave', hideTooltip);
            hit.addEventListener('focus', () => {
                const rect = hit.getBoundingClientRect();
                showTooltip({ clientX: rect.left + rect.width / 2, clientY: rect.top + 20 }, text, label);
            });
            hit.addEventListener('blur', hideTooltip);
        });
        chart.append(f.svg);
        table(container, points, [
            { label: 'Time', value: options.timeLabel },
            { label: options.label, value: (point) => String(point[options.key] || 0), numeric: true },
        ]);
    }

    // A line with a soft area wash and a crosshair that snaps to the nearest point. Gaps (null) break the line.
    function line(container, points, options) {
        container.replaceChildren();
        const chart = document.createElement('div');
        chart.className = 'chart';
        container.append(chart);
        const f = frame(chart);
        f.svg.setAttribute('aria-label', options.label);
        const values = points.map((point) => point[options.key]);
        const max = niceMax(Math.max(...values.filter((value) => value !== null && value !== undefined), 0));
        axes(f, max, points, options.timeLabel);

        const xAt = (index) => f.margin.left + ((index + 0.5) / points.length) * f.plotWidth;
        const yAt = (value) => f.margin.top + f.plotHeight - (value / max) * f.plotHeight;
        const segments = [];
        let current = [];
        values.forEach((value, index) => {
            if (value === null || value === undefined) {
                if (current.length) segments.push(current);
                current = [];
            } else {
                current.push([xAt(index), yAt(value)]);
            }
        });
        if (current.length) segments.push(current);
        const baseline = f.margin.top + f.plotHeight;
        segments.forEach((segment) => {
            if (segment.length > 1) {
                el('path', { class: 'area', d: `M${segment[0][0]},${baseline} ${segment.map(([x, y]) => `L${x},${y}`).join(' ')} L${segment[segment.length - 1][0]},${baseline} Z` }, f.svg);
                el('path', { class: 'line', d: segment.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ') }, f.svg);
            } else {
                el('circle', { class: 'dot', cx: segment[0][0], cy: segment[0][1], r: 4 }, f.svg);
            }
        });
        // Emphasize the latest value.
        const lastIndex = values.map((value) => value !== null && value !== undefined).lastIndexOf(true);
        if (lastIndex >= 0) el('circle', { class: 'dot', cx: xAt(lastIndex), cy: yAt(values[lastIndex]), r: 4 }, f.svg);

        const crosshair = el('line', { class: 'crosshair', y1: f.margin.top, y2: baseline, visibility: 'hidden' }, f.svg);
        const overlay = el('rect', { class: 'hit', x: f.margin.left, y: f.margin.top, width: f.plotWidth, height: f.plotHeight }, f.svg);
        overlay.addEventListener('pointermove', (event) => {
            const box = f.svg.getBoundingClientRect();
            const x = ((event.clientX - box.left) / box.width) * f.width;
            const index = Math.max(0, Math.min(points.length - 1, Math.floor(((x - f.margin.left) / f.plotWidth) * points.length)));
            crosshair.setAttribute('x1', xAt(index));
            crosshair.setAttribute('x2', xAt(index));
            crosshair.setAttribute('visibility', 'visible');
            const value = values[index];
            showTooltip(event, value === null || value === undefined ? 'No requests' : `${compact(value)} ${options.unit || ''}`.trim(), `${options.label} · ${options.timeLabel(points[index])}`);
        });
        overlay.addEventListener('pointerleave', () => {
            crosshair.setAttribute('visibility', 'hidden');
            hideTooltip();
        });
        chart.append(f.svg);
        table(container, points, [
            { label: 'Time', value: options.timeLabel },
            { label: options.label, value: (point) => (point[options.key] === null || point[options.key] === undefined ? '–' : String(point[options.key])), numeric: true },
        ]);
    }

    window.GatewayCharts = { columns, line, compact };
}());
