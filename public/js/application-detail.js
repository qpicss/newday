const form = document.getElementById('applicationForm');
const formAlert = document.getElementById('form-alert');
const deleteButton = document.getElementById('deleteApplication');
// The page sets the API endpoint, so the same script serves owners and admins.
const applicationUrl = form.dataset.apiUrl;

form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const submit = form.querySelector('[type="submit"]');
    const redirectUris = document.getElementById('redirectUris').value
        .split('\n')
        .map(uri => uri.trim())
        .filter(Boolean);
    UI.hideFormError(formAlert);
    UI.setLoading(submit, true, 'Saving…');

    try {
        const response = await fetch(applicationUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: document.getElementById('name').value.trim(),
                description: document.getElementById('description').value.trim(),
                redirectUris,
                publicKey: document.getElementById('publicKey').value.trim(),
            }),
        });
        const result = await UI.readJson(response);
        if (response.ok) {
            document.querySelectorAll('[data-app-name]').forEach((element) => {
                element.textContent = result.application.name;
            });
            deleteButton.dataset.name = result.application.name;
            document.querySelector('.page-alert')?.remove();
            UI.toast('Changes saved');
        } else {
            UI.showFormError(formAlert, result.error || 'Application could not be saved');
        }
    } catch (error) {
        console.error('Error updating application:', error);
        UI.showFormError(formAlert, 'Network error. Check your connection and try again.');
    }
    UI.setLoading(submit, false);
});

deleteButton.addEventListener('click', async () => {
    const confirmed = await UI.confirm({
        title: 'Delete application?',
        message: `"${deleteButton.dataset.name}" and its tokens will be removed. Clients using it will stop working immediately.`,
        confirmLabel: 'Delete application',
        danger: true,
    });
    if (!confirmed) return;

    UI.setLoading(deleteButton, true);
    try {
        const response = await fetch(applicationUrl, { method: 'DELETE' });
        if (response.ok) {
            UI.flash(`"${deleteButton.dataset.name}" was deleted`);
            window.location.href = form.dataset.afterDelete;
            return;
        }
        const result = await UI.readJson(response);
        UI.toast(result.error || 'Application could not be deleted', 'error');
    } catch (error) {
        console.error('Error deleting application:', error);
        UI.toast('Application could not be deleted', 'error');
    }
    UI.setLoading(deleteButton, false);
});

// Extra credentials: a name, then the new client ID and secret, shown once.
const credentialForm = document.getElementById('credentialForm');
const addCredential = document.getElementById('addCredential');
const newCredential = document.getElementById('newCredential');

const showCredentialForm = (open) => {
    credentialForm.hidden = !open;
    addCredential?.setAttribute('aria-expanded', String(open));
    if (open) document.getElementById('credentialName').focus();
};

addCredential?.addEventListener('click', () => showCredentialForm(credentialForm.hidden));
document.getElementById('cancelCredential').addEventListener('click', () => {
    credentialForm.reset();
    showCredentialForm(false);
});

UI.bindForm(credentialForm, {
    alert: document.getElementById('credential-alert'),
    loadingLabel: 'Creating…',
    submit: async (formData) => {
        const { credential } = await UI.sendJson(credentialForm.dataset.url, { body: { name: formData.get('name') } });
        credentialForm.reset();
        showCredentialForm(false);
        if (addCredential) addCredential.hidden = true;
        newCredential.querySelector('[data-new-name]').textContent = credential.name;
        document.getElementById('new-client-id').textContent = credential.clientId;
        document.getElementById('new-client-secret').textContent = credential.clientSecret;
        newCredential.hidden = false;
        newCredential.scrollIntoView({ block: 'nearest' });
    },
});

// The secret leaves the page with the reload, and the list shows the new credentials.
document.getElementById('doneCredential').addEventListener('click', () => window.location.reload());
