UI.bindForm(document.getElementById('connectionForm'), {
    alert: document.getElementById('form-alert'),
    loadingLabel: 'Creating…',
    submit: async (formData) => {
        const result = await UI.sendJson('/api/org/connections', { body: { name: formData.get('name') } });
        UI.flash(`${result.connection.name} was created`);
        window.location.href = `/developer/connections/${encodeURIComponent(result.connection.id)}`;
    },
});
