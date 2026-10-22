UI.bindForm(document.getElementById('gatewayForm'), {
    alert: document.getElementById('gateway-alert'),
    loadingLabel: 'Creating…',
    submit: async (formData) => {
        const result = await UI.sendJson('/api/org/gateways', {
            body: {
                name: formData.get('name'),
                publicUrl: formData.get('publicUrl'),
            },
        });
        UI.flash(`${result.gateway.name} was created. Add a port, then start a node with its credentials.`);
        window.location.href = `/developer/gateways/${encodeURIComponent(result.gateway.id)}`;
    },
});

