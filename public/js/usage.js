// Daily usage charts (views/partials/usage-card.html). Drawing is done by /js/charts.js.
(function () {
    const dayLabel = (point) => new Date(`${point.day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

    function draw() {
        document.querySelectorAll('[data-usage-chart]').forEach((container) => {
            const points = JSON.parse(container.dataset.usage || '[]');
            const errors = container.dataset.usageChart === 'errors';
            window.GatewayCharts.columns(container, points, {
                key: errors ? 'errors' : 'requests',
                label: errors ? 'Server errors' : 'Requests',
                timeLabel: dayLabel,
                errors,
            });
        });
    }

    if (window.GatewayCharts) {
        draw();
        let timer;
        window.addEventListener('resize', () => {
            clearTimeout(timer);
            timer = setTimeout(draw, 150);
        });
    }
}());
