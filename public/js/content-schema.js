// One request body or response schema of an operation, written inline in the document, edited in
// the schema editor and saved with PUT /api/org/apis/:id/operations/content-schema.
(function () {
    const root = document.getElementById('contentSchema');
    const state = JSON.parse(root.dataset.state);
    const saveButton = root.querySelector('[data-save]');
    const updateField = document.getElementById('updateField');

    async function save(current, replace = false) {
        if (saveButton.disabled) return;
        UI.setLoading(saveButton, true, 'Saving…');
        try {
            await UI.sendJson(state.saveUrl, {
                method: 'PUT',
                body: { schema: current.getSchema(), addObjects: current.getPendingObjects(), replace, updateField: Boolean(updateField && updateField.checked) },
            });
            current.allowLeave();
            UI.flash(`${state.name} was saved. Push your gateways to deploy it.`);
            window.location.reload();
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

    const editor = SchemaEditor.create(root.querySelector('[data-schema-editor]'), {
        schema: state.schema,
        name: state.name,
        openapi31: state.openapi31,
        schemas: state.schemas,
        fields: state.fields,
        objects: state.objects,
        pageUrl: state.pageUrl,
        fixedName: true,
        onSave: (current) => save(current),
    });

    // Into components.schemas, then on to it in the Schemas tab.
    UI.bindForm(document.getElementById('moveForm'), {
        alert: document.getElementById('move-alert'),
        loadingLabel: 'Moving…',
        submit: async (formData) => {
            if (editor.isDirty()) throw new Error('Save your changes before moving the schema.');
            const result = await UI.sendJson(state.saveUrl.replace('/content-schema?', '/content-schema/move?'), { body: { name: formData.get('name') } });
            editor.allowLeave();
            UI.flash(`${result.name} is now one of the document's schemas`);
            window.location.href = `${state.pageUrl}?name=${encodeURIComponent(result.name)}`;
        },
    });
})();
