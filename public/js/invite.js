const inviteForm = document.getElementById('inviteForm');

UI.bindForm(inviteForm, {
    alert: document.getElementById('form-alert'),
    loadingLabel: 'Joining…',
    submit: async (formData) => {
        await UI.sendJson('/auth/accept-invite', {
            body: {
                token: inviteForm.dataset.token,
                name: formData.get('name') || undefined,
                password: formData.get('password'),
            },
        });
        UI.flash('Welcome! You can switch organizations from the menu at the top.');
        window.location.href = '/developer/dashboard';
    },
});
