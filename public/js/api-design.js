// API designer: one operation's details, parameters, request body and responses, built from the
// data dictionary. Every change is saved to the OpenAPI document right away and the page reloads.
(function () {
    const operationRoot = document.getElementById('operation');
    const importButton = document.getElementById('importToDictionary');

    if (importButton) {
        importButton.addEventListener('click', async () => {
            UI.setLoading(importButton, true, 'Adding…');
            try {
                const { dictionary } = await UI.sendJson(`${importButton.dataset.apiUrl}/dictionary`);
                UI.toast(FieldForm.describeImport(dictionary), dictionary.notes.length ? 'info' : 'success');
                if (dictionary.notes.length) {
                    dictionary.notes.slice(0, 3).forEach((note) => UI.toast(note, 'info'));
                }
            } catch (error) {
                UI.toast(error.message, 'error');
            }
            UI.setLoading(importButton, false);
        });
    }

    if (!operationRoot) return;

    const apiUrl = operationRoot.dataset.apiUrl;
    const query = `method=${encodeURIComponent(operationRoot.dataset.method)}&path=${encodeURIComponent(operationRoot.dataset.path)}`;
    const url = (suffix) => `${apiUrl}/operations${suffix}?${query}`;

    // Sends a change; when it would replace schemas the dictionary didn't write, asks first.
    async function send(target, method, body) {
        try {
            return await UI.sendJson(target, { method, body });
        } catch (error) {
            if (error.status !== 409 || !error.body?.conflicts) throw error;
            const confirmed = await UI.confirm({
                title: 'Replace the schema?',
                message: error.message,
                confirmLabel: 'Replace',
                danger: true,
            });
            if (!confirmed) {
                const cancelled = new Error('Nothing was changed.');
                cancelled.cancelled = true;
                throw cancelled;
            }
            return UI.sendJson(target, { method, body: { ...body, replace: true } });
        }
    }

    const done = (message) => {
        UI.flash(message);
        window.location.reload();
    };

    // "object:<id>" / "schema:<name>" / "field:<id>" from the select.
    const sourceOf = (value) => {
        if (!value) return null;
        const index = value.indexOf(':');
        const type = value.slice(0, index);
        const ref = value.slice(index + 1);
        return type === 'schema' ? { type, name: ref } : { type, id: ref };
    };

    const bindChange = (form, alertId, label, submit) => UI.bindForm(form, {
        alert: document.getElementById(alertId),
        loadingLabel: label,
        submit: async (formData) => {
            try {
                await submit(formData);
            } catch (error) {
                if (error.cancelled) return;
                throw error;
            }
        },
    });

    // ------------------------------------------------------------- Details

    bindChange(document.getElementById('infoForm'), 'info-alert', 'Saving…', async (formData) => {
        await UI.sendJson(url(''), {
            method: 'PUT',
            body: {
                summary: formData.get('summary'),
                description: formData.get('description'),
                operationId: formData.get('operationId'),
                deprecated: formData.get('deprecated') === 'on',
            },
        });
        done('Endpoint details saved');
    });

    // ------------------------------------------------------------- Parameters

    const parameterForm = document.getElementById('parameterForm');
    const fieldPanel = document.getElementById('paramFieldPanel');
    const fieldContainer = fieldPanel.querySelector('[data-field-form]');
    const newFieldButton = document.getElementById('paramNewField');
    const fieldSelect = document.getElementById('paramField');
    FieldForm.bind(fieldContainer);

    const setFieldPanel = (open) => {
        fieldPanel.hidden = !open;
        fieldSelect.disabled = open || !fieldSelect.options.length || !fieldSelect.value;
        if (newFieldButton) {
            newFieldButton.setAttribute('aria-expanded', String(open));
            newFieldButton.textContent = open ? 'Use a dictionary field' : 'New field instead';
        }
        if (open) fieldContainer.querySelector('[data-field-input="name"]').focus();
    };
    if (newFieldButton) newFieldButton.addEventListener('click', () => setFieldPanel(fieldPanel.hidden));

    document.querySelectorAll('[data-describe-path]').forEach((button) => {
        button.addEventListener('click', () => {
            const name = button.dataset.describePath;
            document.getElementById('paramIn').value = 'path';
            document.getElementById('paramRequired').checked = true;
            const existing = [...fieldSelect.options].find((option) => option.textContent.split(' · ')[0] === name);
            if (existing) {
                setFieldPanel(false);
                fieldSelect.value = existing.value;
                document.getElementById('paramName').value = '';
            } else {
                setFieldPanel(true);
                fieldContainer.querySelector('[data-field-input="name"]').value = name;
                document.getElementById('paramName').value = name;
            }
            parameterForm.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
    });

    bindChange(parameterForm, 'parameter-alert', 'Adding…', async (formData) => {
        let fieldId = formData.get('fieldId');
        if (!fieldPanel.hidden) {
            const { name, description, schema } = FieldForm.read(fieldContainer);
            const { field } = await UI.sendJson('/api/org/dictionary/fields', { body: { name, description, schema } });
            fieldId = field.id;
            // The field is in the dictionary now, whatever happens to the parameter.
            const option = new Option(`${field.name} · ${field.summary}`, field.id);
            fieldSelect.add(option);
            fieldSelect.value = field.id;
            fieldSelect.disabled = false;
            setFieldPanel(false);
        }
        if (!fieldId) throw new Error('Choose a field, or create one with New field');
        const result = await UI.sendJson(url('/parameters'), {
            body: {
                fieldId,
                in: formData.get('in'),
                name: formData.get('name'),
                description: formData.get('description'),
                required: formData.get('required') === 'on',
            },
        });
        done(result.replaced ? 'Parameter replaced' : 'Parameter added');
    });

    // ------------------------------------------------------------- Editing a parameter

    const paramDialog = document.getElementById('parameterDialog');
    const paramDialogForm = document.getElementById('parameterDialogForm');
    const paramSchemaForm = paramDialog.querySelector('[data-param-form] [data-field-form]');
    const paramJson = document.getElementById('editParamJson');
    const paramFieldBox = paramDialog.querySelector('[data-param-field]');
    const updateFieldInput = document.getElementById('editParamUpdateField');
    const formRadio = paramDialogForm.querySelector('input[name="schemaMode"][value="form"]');
    const jsonRadio = paramDialogForm.querySelector('input[name="schemaMode"][value="json"]');
    let editing = null;
    FieldForm.bind(paramSchemaForm);

    const setMode = (mode) => {
        (mode === 'form' ? formRadio : jsonRadio).checked = true;
        paramDialog.querySelector('[data-param-form]').hidden = mode !== 'form';
        paramDialog.querySelector('[data-param-json]').hidden = mode !== 'json';
        // Only the form's schema can be written back to a dictionary field.
        updateFieldInput.disabled = mode !== 'form';
        if (mode !== 'form') updateFieldInput.checked = false;
    };
    [formRadio, jsonRadio].forEach((radio) => radio.addEventListener('change', () => setMode(radio.value)));

    document.querySelectorAll('[data-edit-parameter]').forEach((button) => {
        button.addEventListener('click', () => {
            editing = JSON.parse(button.dataset.parameter);
            paramDialog.querySelector('[data-param-location]').textContent = editing.in;
            paramDialog.querySelector('[data-param-location]').className = `location location-${editing.in}`;
            paramDialog.querySelector('[data-param-name]').textContent = editing.name;

            const scope = paramDialog.querySelector('[data-param-scope]');
            const scopeText = editing.shared
                ? `${editing.name} is the shared parameter ${editing.shared}: changes apply to every endpoint that uses it.`
                : editing.level === 'path'
                    ? `${editing.name} is defined for every operation on ${operationRoot.dataset.path}: changes apply to all of them.`
                    : '';
            scope.hidden = !scopeText;
            scope.querySelector('[data-param-scope-text]').textContent = scopeText;

            document.getElementById('editParamDescription').value = editing.description || '';
            const required = document.getElementById('editParamRequired');
            required.checked = editing.required || editing.in === 'path';
            required.disabled = editing.in === 'path';
            document.getElementById('editParamDeprecated').checked = editing.deprecated;

            paramJson.value = JSON.stringify(editing.rawSchema, null, 2);
            formRadio.disabled = !editing.formSchema;
            paramDialog.querySelector('[data-form-unavailable]').hidden = Boolean(editing.formSchema);
            if (editing.formSchema) FieldForm.fill(paramSchemaForm, editing.formSchema);

            paramFieldBox.hidden = !editing.fieldName;
            paramDialog.querySelector('[data-param-field-name]').textContent = editing.fieldName || '';
            updateFieldInput.checked = false;
            setMode(editing.formSchema ? 'form' : 'json');

            UI.hideFormError(document.getElementById('parameter-dialog-alert'));
            paramDialog.showModal();
            document.getElementById('editParamDescription').focus();
        });
    });
    paramDialog.querySelector('[data-dialog-cancel]').addEventListener('click', () => paramDialog.close());

    UI.bindForm(paramDialogForm, {
        alert: document.getElementById('parameter-dialog-alert'),
        loadingLabel: 'Saving…',
        submit: async (formData) => {
            const body = {
                description: formData.get('description'),
                required: editing.in === 'path' || formData.get('required') === 'on',
                deprecated: formData.get('deprecated') === 'on',
            };
            if (formData.get('schemaMode') === 'form') {
                body.schema = FieldForm.read(paramSchemaForm).schema;
                body.updateField = formData.get('updateField') === 'on';
            } else {
                try {
                    body.rawSchema = JSON.parse(paramJson.value);
                } catch {
                    throw new Error('The schema isn\'t valid JSON. Check quotes, commas and brackets.');
                }
            }
            const target = `${url('/parameters')}&in=${encodeURIComponent(editing.in)}&name=${encodeURIComponent(editing.name)}`;
            const result = await UI.sendJson(target, { method: 'PUT', body });
            done(body.updateField ? `Parameter and dictionary field ${editing.fieldName} saved`
                : editing.fieldId && !result.linkedFieldId ? `Parameter saved. It has its own schema now, apart from the field ${editing.fieldName || ''}`.trim()
                    : 'Parameter saved');
        },
    });

    // ------------------------------------------------------------- Bodies

    const bodyForm = document.getElementById('bodyForm');
    if (bodyForm) {
        bindChange(bodyForm, 'body-alert', 'Saving…', async (formData) => {
            const source = sourceOf(formData.get('source'));
            if (!source) throw new Error('Choose what describes the body');
            await send(url('/body'), 'PUT', {
                source,
                contentType: formData.get('contentType'),
                isArray: formData.get('isArray') === 'on',
                required: formData.get('required') === 'on',
            });
            done('Request body saved');
        });
    }

    const responseForm = document.getElementById('responseForm');
    const responseStatus = document.getElementById('responseStatus');
    bindChange(responseForm, 'response-alert', 'Saving…', async (formData) => {
        const source = sourceOf(formData.get('source'));
        await send(url('/responses'), 'PUT', {
            status: formData.get('status'),
            description: formData.get('description'),
            contentType: formData.get('contentType'),
            source,
            isArray: formData.get('isArray') === 'on',
        });
        done(`${formData.get('status')} response saved`);
    });
    // Picking a status already listed fills in its description, to change rather than retype it.
    responseStatus.addEventListener('change', () => {
        const row = [...document.querySelectorAll('.response-list li')]
            .find((item) => item.querySelector('.status-code').textContent.trim() === responseStatus.value.trim());
        const description = document.getElementById('responseDescription');
        if (row && !description.value) description.value = row.querySelector('.response-main > span').textContent.trim();
    });

    // ------------------------------------------------------------- New object dialog

    const dialog = document.getElementById('objectDialog');
    const dialogForm = document.getElementById('objectDialogForm');
    const builderRoot = dialog.querySelector('[data-dialog-builder]');
    const builder = ObjectBuilder.create({
        root: builderRoot.querySelector('[data-builder]'),
        choices: JSON.parse(builderRoot.dataset.choices),
    });
    let targetSelect = null;

    document.querySelectorAll('[data-new-object]').forEach((button) => {
        button.addEventListener('click', () => {
            targetSelect = button.closest('[data-source-form]').querySelector('[data-source-select]');
            UI.hideFormError(document.getElementById('dialog-alert'));
            dialog.showModal();
            document.getElementById('dialogObjectName').focus();
        });
    });
    dialog.querySelector('[data-dialog-cancel]').addEventListener('click', () => dialog.close());

    UI.bindForm(dialogForm, {
        alert: document.getElementById('dialog-alert'),
        loadingLabel: 'Creating…',
        submit: async (formData) => {
            const { object } = await UI.sendJson('/api/org/dictionary/objects', {
                body: {
                    name: formData.get('name'),
                    description: formData.get('description'),
                    properties: builder.getProperties(),
                },
            });
            const label = `${object.name} (${object.propertyCount} propert${object.propertyCount === 1 ? 'y' : 'ies'})`;
            document.querySelectorAll('[data-source-select]').forEach((select) => {
                let group = [...select.querySelectorAll('optgroup')].find((item) => item.label === 'Dictionary objects');
                if (!group) {
                    group = document.createElement('optgroup');
                    group.label = 'Dictionary objects';
                    select.insertBefore(group, select.options[1] || null);
                }
                group.append(new Option(label, `object:${object.id}`));
            });
            builder.addObjectChoice({ id: object.id, name: object.name, propertyCount: object.propertyCount });
            if (targetSelect) targetSelect.value = `object:${object.id}`;
            dialogForm.reset();
            builder.reset();
            dialog.close();
            UI.toast(`${object.name} was added to the dictionary. Save to use it.`);
            targetSelect?.closest('form').querySelector('[type="submit"]').focus();
        },
    });
})();
