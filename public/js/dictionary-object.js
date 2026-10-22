// Dictionary object page: build the property list and save it with the object's details.
const objectForm = document.getElementById('objectForm');
const objectUrl = `/api/org/dictionary/objects/${encodeURIComponent(objectForm.dataset.objectId)}`;
const saveState = document.querySelector('[data-save-state]');
const initial = JSON.parse(objectForm.dataset.builderState);
let dirty = false;

const markDirty = () => {
    dirty = true;
    saveState.hidden = false;
};

const builder = ObjectBuilder.create({
    root: objectForm.querySelector('[data-builder]'),
    properties: initial.properties,
    choices: initial.choices,
    selfId: objectForm.dataset.objectId,
    onChange: markDirty,
});

['objectName', 'objectDescription', 'objectExtra'].forEach((id) => {
    document.getElementById(id).addEventListener('input', markDirty);
});

window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
});

UI.bindForm(objectForm, {
    alert: document.getElementById('form-alert'),
    loadingLabel: 'Saving…',
    submit: async (formData) => {
        const result = await UI.sendJson(objectUrl, {
            method: 'PUT',
            body: {
                name: formData.get('name'),
                description: formData.get('description'),
                additionalProperties: formData.get('additionalProperties') === 'false' ? false : null,
                properties: builder.getProperties(),
            },
        });
        dirty = false;
        UI.flash(`${result.object.name} was saved`);
        window.location.reload();
    },
});
