UI.bindForm(document.getElementById('policyForm'), {
    alert: document.getElementById('form-alert'),
    loadingLabel: 'Creating…',
    submit: async (formData) => {
        const result = await UI.sendJson('/api/org/policies', {
            body: { name: formData.get('name'), description: formData.get('description') },
        });
        UI.flash(`${result.policy.name} was created`);
        window.location.href = `/developer/policies/${encodeURIComponent(result.policy.id)}`;
    },
});
