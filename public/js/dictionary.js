// Data dictionary list: add a field or an object, or fill the dictionary from an API's document.
const fieldForm = document.getElementById('fieldForm');
if (fieldForm) {
    const container = fieldForm.querySelector('[data-field-form]');
    FieldForm.bind(container);
    UI.bindForm(fieldForm, {
        alert: document.getElementById('field-alert'),
        loadingLabel: 'Adding…',
        submit: async () => {
            const { name, description, schema } = FieldForm.read(container);
            const result = await UI.sendJson('/api/org/dictionary/fields', { body: { name, description, schema } });
            UI.flash(`${result.field.name} was added to the dictionary`);
            window.location.reload();
        },
    });
}

const objectForm = document.getElementById('objectForm');
UI.bindForm(objectForm, {
    alert: document.getElementById('object-alert'),
    loadingLabel: 'Creating…',
    submit: async (formData) => {
        const result = await UI.sendJson('/api/org/dictionary/objects', {
            body: { name: formData.get('name'), description: formData.get('description'), properties: [] },
        });
        UI.flash(`${result.object.name} was created. Add its properties.`);
        window.location.href = `/developer/dictionary/objects/${encodeURIComponent(result.object.id)}`;
    },
});

const importForm = document.getElementById('importForm');
UI.bindForm(importForm, {
    alert: document.getElementById('import-alert'),
    loadingLabel: 'Adding…',
    submit: async (formData) => {
        const { dictionary } = await UI.sendJson(`/api/org/apis/${encodeURIComponent(formData.get('apiId'))}/dictionary`);
        if (!dictionary.notes.length) {
            UI.flash(FieldForm.describeImport(dictionary));
            window.location.reload();
            return;
        }
        // Skipped and renamed entries are worth reading before the list refreshes.
        const panel = document.createElement('div');
        panel.className = 'alert alert-info import-result';
        panel.setAttribute('role', 'status');
        const body = document.createElement('div');
        const summary = document.createElement('p');
        summary.textContent = FieldForm.describeImport(dictionary);
        const notes = document.createElement('ul');
        dictionary.notes.forEach((note) => {
            const item = document.createElement('li');
            item.textContent = note;
            notes.append(item);
        });
        const reload = document.createElement('button');
        reload.type = 'button';
        reload.className = 'btn btn-secondary btn-sm';
        reload.textContent = 'Show the dictionary';
        reload.addEventListener('click', () => window.location.reload());
        body.append(summary, notes, reload);
        panel.append(body);
        importForm.querySelector('.import-result')?.remove();
        importForm.append(panel);
    },
});
