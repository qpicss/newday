const form = document.getElementById('connectionForm');
const connectionUrl = form.dataset.connectionUrl;
const authType = form.querySelector('[name="authType"]');
const SECRET_LABELS = { basic: 'Password', bearer: 'Token', header: 'Header value' };

function updateAuthFields() {
    form.querySelectorAll('[data-auth]').forEach((field) => {
        field.hidden = !field.dataset.auth.split(' ').includes(authType.value);
    });
    form.querySelector('[data-secret-label]').textContent = SECRET_LABELS[authType.value] || 'Secret';
}
authType.addEventListener('change', updateAuthFields);
updateAuthFields();

UI.bindForm(form, {
    alert: document.getElementById('form-alert'),
    loadingLabel: 'Saving…',
    submit: async (formData) => {
        const type = formData.get('authType');
        const tls = {
            rejectUnauthorized: formData.get('rejectUnauthorized') === 'on',
            serverName: formData.get('serverName'),
        };
        if (formData.get('removeCa') === 'on') tls.caPem = '';
        else if (formData.get('caPem').trim()) tls.caPem = formData.get('caPem');
        if (formData.get('removeClientCertificate') === 'on') {
            tls.removeClientCertificate = true;
        } else if (formData.get('clientCertificatePem').trim() || formData.get('clientKeyPem').trim()) {
            tls.clientCertificatePem = formData.get('clientCertificatePem');
            tls.clientKeyPem = formData.get('clientKeyPem');
        }
        await UI.sendJson(connectionUrl, {
            method: 'PUT',
            body: {
                name: formData.get('name'),
                connectTimeoutMs: Number(formData.get('connectTimeoutMs')),
                timeoutMs: Number(formData.get('timeoutMs')),
                retries: Number(formData.get('retries')),
                retryOn: formData.get('retryOn'),
                circuitBreaker: {
                    enabled: formData.get('breakerEnabled') === 'on',
                    failureThreshold: Number(formData.get('failureThreshold')),
                    cooldownMs: Number(formData.get('cooldownMs')),
                },
                auth: {
                    type,
                    username: formData.get('authUsername'),
                    headerName: formData.get('authHeaderName'),
                    secret: formData.get('authSecret') || undefined,
                },
                tls,
            },
        });
        UI.flash('Connection saved. Push your gateways to apply it.');
        window.location.reload();
    },
});
