const apiForm = document.getElementById('apiForm');
const endpointList = document.getElementById('endpoint-list');
const rowTemplate = document.getElementById('endpoint-row-template');

document.getElementById('addEndpoint').addEventListener('click', () => {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    endpointList.append(row);
    row.querySelector('[name="path"]').focus();
});

endpointList.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-endpoint]');
    if (remove) {
        remove.closest('[data-endpoint-row]').remove();
    }
});

// Rows with an empty path are ignored, so the form can be submitted with no endpoints.
function collectEndpoints() {
    return [...endpointList.querySelectorAll('[data-endpoint-row]')]
        .map((row) => ({
            method: row.querySelector('[name="method"]').value,
            path: row.querySelector('[name="path"]').value.trim(),
            summary: row.querySelector('[name="summary"]').value.trim(),
        }))
        .filter((endpoint) => endpoint.path);
}

UI.bindForm(apiForm, {
    alert: document.getElementById('form-alert'),
    loadingLabel: 'Creating…',
    submit: async (formData) => {
        const result = await UI.sendJson('/api/org/apis', {
            body: {
                name: formData.get('name'),
                version: formData.get('version'),
                baseUrl: formData.get('baseUrl'),
                description: formData.get('description'),
                endpoints: collectEndpoints(),
                catalogId: apiForm.dataset.catalogId,
            },
        });
        UI.flash(`${result.api.name} was created`);
        window.location.href = `/developer/apis/${encodeURIComponent(result.api.id)}`;
    },
});
