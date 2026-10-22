const apiForm = document.getElementById('apiForm');
const apiUrl = `/api/org/apis/${encodeURIComponent(apiForm.dataset.apiId)}`;

UI.bindForm(apiForm, {
    alert: document.getElementById('form-alert'),
    loadingLabel: 'Saving…',
    submit: async (formData) => {
        const result = await UI.sendJson(apiUrl, {
            method: 'PUT',
            body: {
                name: formData.get('name'),
                version: formData.get('version'),
                description: formData.get('description'),
            },
        });
        UI.flash(`${result.api.name} was saved`);
        window.location.reload();
    },
});

UI.bindForm(document.getElementById('gatewayForm'), {
    alert: document.getElementById('gateway-alert'),
    loadingLabel: 'Saving…',
    submit: async (formData) => {
        await UI.sendJson(apiUrl, {
            method: 'PUT',
            body: {
                basePath: formData.get('basePath'),
                policyId: formData.get('policyId') || null,
                connectionId: formData.get('connectionId') || null,
            },
        });
        UI.flash('Gateway settings saved. Push your gateways to deploy them.');
        window.location.reload();
    },
});

const operationForm = document.getElementById('operationForm');
UI.bindForm(operationForm, {
    alert: document.getElementById('operation-alert'),
    loadingLabel: 'Adding…',
    submit: async (formData) => {
        await UI.sendJson(`${apiUrl}/operations`, {
            body: {
                method: formData.get('method'),
                path: formData.get('path'),
                summary: formData.get('summary'),
            },
        });
        UI.flash('Endpoint added');
        window.location.reload();
    },
});
