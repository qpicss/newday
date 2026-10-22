const requestForm = document.getElementById('requestForm');

UI.bindForm(requestForm, {
    alert: document.getElementById('form-alert'),
    loadingLabel: 'Requesting…',
    submit: async (formData) => {
        const applicationId = formData.get('applicationId');
        await UI.sendJson(`/api/applications/${encodeURIComponent(applicationId)}/subscriptions`, {
            body: { productId: requestForm.dataset.productId },
        });
        UI.flash('Access requested. You\'ll see the status here once an admin decides.');
        window.location.reload();
    },
});
