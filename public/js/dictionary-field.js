// Dictionary field page: edit the field, with a live preview of the schema it becomes. An object
// field also has a structure (its properties), edited in the schema editor and saved with the field.
const fieldForm = document.getElementById('fieldForm');
const container = fieldForm.querySelector('[data-field-form]');
const preview = document.getElementById('fieldPreview');
const fieldUrl = `/api/org/dictionary/fields/${encodeURIComponent(fieldForm.dataset.fieldId)}`;
const structure = document.querySelector('[data-structure]');
const typeSelect = container.querySelector('[data-schema="type"]');

const ORDER = ['type', 'format', 'description', 'properties', 'required', 'enum', 'pattern', 'minLength', 'maxLength', 'minimum', 'exclusiveMinimum',
    'maximum', 'exclusiveMaximum', 'multipleOf', 'items', 'minItems', 'maxItems', 'uniqueItems', 'additionalProperties',
    'nullable', 'readOnly', 'writeOnly', 'deprecated', 'default', 'example'];

let editor = null;

// The form's rules plus, for an object, the structure from the editor.
function currentField() {
    const { name, description, schema } = FieldForm.read(container);
    if (schema.type === 'object' && editor) {
        const tree = editor.getSchema();
        if (tree.properties && Object.keys(tree.properties).length) schema.properties = tree.properties;
        if (Array.isArray(tree.required) && tree.required.length) schema.required = tree.required;
    }
    return { name, description, schema };
}

function showPreview() {
    try {
        const { description, schema } = currentField();
        const full = { ...schema, ...(description && { description }) };
        const ordered = {};
        ORDER.forEach((key) => { if (full[key] !== undefined) ordered[key] = full[key]; });
        preview.textContent = JSON.stringify(ordered, null, 2);
        preview.classList.remove('is-invalid');
    } catch (error) {
        // Half-typed values (a number field holding "1e") just leave the last good preview.
        preview.classList.add('is-invalid');
    }
}

FieldForm.bind(container, { onChange: showPreview });

if (structure) {
    const host = structure.querySelector('[data-structure-editor]');
    const config = JSON.parse(host.dataset.config);
    editor = SchemaEditor.create(host.querySelector('[data-schema-editor]'), {
        ...config,
        allowRefs: false,
        rootLocked: true,
        onChange: showPreview,
        onSave: () => fieldForm.requestSubmit(),
    });
    // The structure only exists for objects.
    typeSelect.addEventListener('change', () => {
        structure.hidden = typeSelect.value !== 'object';
    });
}

UI.bindForm(fieldForm, {
    alert: document.getElementById('form-alert'),
    loadingLabel: 'Saving…',
    submit: async () => {
        const { name, description, schema } = currentField();
        const result = await UI.sendJson(fieldUrl, { method: 'PUT', body: { name, description, schema } });
        if (editor) editor.allowLeave();
        UI.flash(`${result.field.name} was saved`);
        window.location.reload();
    },
});

showPreview();
