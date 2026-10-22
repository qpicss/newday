// An API's Schemas tab: the document's components.schemas, one at a time in the schema editor
// (schema-editor.js), saved with PUT /api/org/apis/:id/schemas/:name.
(function () {
    const root = document.getElementById('schemaDesigner');
    const state = JSON.parse(root.dataset.state);
    const newDialog = document.getElementById('newSchemaDialog');
    let editor = null;

    document.querySelectorAll('[data-new-schema]').forEach((button) => button.addEventListener('click', () => {
        UI.hideFormError(document.getElementById('new-schema-alert'));
        newDialog.showModal();
        document.getElementById('newSchemaName').focus();
    }));
    newDialog.querySelector('[data-dialog-cancel]').addEventListener('click', () => newDialog.close());
    const STARTS = {
        object: { type: 'object', properties: {} },
        list: { type: 'array', items: { type: 'object', properties: {} } },
        value: { type: 'string' },
    };
    UI.bindForm(document.getElementById('newSchemaForm'), {
        alert: document.getElementById('new-schema-alert'),
        loadingLabel: 'Creating…',
        submit: async (formData) => {
            const result = await UI.sendJson(`${state.apiUrl}/schemas`, { body: { name: formData.get('name'), schema: STARTS[formData.get('kind')] } });
            if (editor) editor.allowLeave();
            UI.flash(`${result.name} was created`);
            window.location.href = `${state.pageUrl}?name=${encodeURIComponent(result.name)}`;
        },
    });

    if (!state.selected) return;

    const saveButton = root.querySelector('[data-save]');
    async function save(current, replace = false) {
        if (saveButton.disabled) return;
        UI.setLoading(saveButton, true, 'Saving…');
        try {
            const result = await UI.sendJson(`${state.apiUrl}/schemas/${encodeURIComponent(state.selected)}`, {
                method: 'PUT',
                body: { schema: current.getSchema(), name: current.getName(), addObjects: current.getPendingObjects(), replace },
            });
            current.allowLeave();
            UI.flash(`${result.name} was saved. Push your gateways to deploy it.`);
            window.location.href = `${state.pageUrl}?name=${encodeURIComponent(result.name)}`;
            return;
        } catch (error) {
            UI.setLoading(saveButton, false);
            if (error.status === 409 && error.body?.conflicts) {
                const confirmed = await UI.confirm({ title: 'Replace the schema?', message: error.message, confirmLabel: 'Replace', danger: true });
                if (confirmed) save(current, true);
                return;
            }
            UI.toast(error.message, 'error');
        }
    }

    editor = SchemaEditor.create(root.querySelector('[data-schema-editor]'), {
        schema: state.schemas[state.selected],
        name: state.selected,
        openapi31: state.openapi31,
        schemas: state.schemas,
        fields: state.fields,
        objects: state.objects,
        pageUrl: state.pageUrl,
        onSave: (current) => save(current),
    });
})();
