const applicationForm = document.getElementById('applicationForm');
const applicationAlert = document.getElementById('form-alert');

applicationForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const submit = applicationForm.querySelector('[type="submit"]');
    const redirectUris = document.getElementById('redirectUris').value
        .split('\n')
        .map(uri => uri.trim())
        .filter(Boolean);
    UI.hideFormError(applicationAlert);
    UI.setLoading(submit, true, 'Creating…');

    try {
        const response = await fetch('/api/applications', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: document.getElementById('name').value.trim(),
                description: document.getElementById('description').value.trim(),
                redirectUris,
                publicKey: document.getElementById('publicKey').value.trim(),
            }),
        });

        const result = await UI.readJson(response);
        if (!response.ok) {
            UI.showFormError(applicationAlert, result.error || 'Application could not be created');
            UI.setLoading(submit, false);
            return;
        }

        document.getElementById('client-id').textContent = result.application.clientId;
        document.getElementById('client-secret').textContent = result.application.clientSecret;
        document.getElementById('view-application').href = `/developer/applications/${encodeURIComponent(result.application.id)}`;
        document.getElementById('create-panel').hidden = true;
        document.getElementById('credentials').hidden = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
        UI.toast('Application created');
    } catch (error) {
        console.error('Error creating application:', error);
        UI.showFormError(applicationAlert, 'Network error. Check your connection and try again.');
        UI.setLoading(submit, false);
    }
});
