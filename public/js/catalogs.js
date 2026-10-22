UI.bindForm(document.getElementById('catalogForm'), {
    alert: document.getElementById('form-alert'),
    loadingLabel: 'Creating…',
    submit: async (formData) => {
        const result = await UI.sendJson('/api/org/catalogs', {
            body: { name: formData.get('name'), description: formData.get('description') },
        });
        UI.flash(`${result.catalog.name} was created. Add APIs and products to it.`);
        window.location.href = `/developer/catalogs/${encodeURIComponent(result.catalog.id)}`;
    },
});
