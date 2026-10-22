const importForm = document.getElementById('importForm');
const fileInput = document.getElementById('specFile');
const contentInput = document.getElementById('content');
const dropzone = document.querySelector('[data-dropzone]');
const fileLabel = dropzone.querySelector('[data-file-label]');
const importAlert = document.getElementById('form-alert');
const MAX_BYTES = 2 * 1024 * 1024;

async function loadFile(file) {
    if (!file) return;
    UI.hideFormError(importAlert);
    if (file.size > MAX_BYTES) {
        UI.showFormError(importAlert, 'OpenAPI files must be 2 MB or smaller');
        return;
    }
    contentInput.value = await file.text();
    fileLabel.textContent = file.name;
    dropzone.classList.add('has-file');
}

fileInput.addEventListener('change', () => loadFile(fileInput.files[0]));

['dragenter', 'dragover'].forEach((type) => dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-dragging');
}));
['dragleave', 'drop'].forEach((type) => dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-dragging');
}));
dropzone.addEventListener('drop', (event) => loadFile(event.dataTransfer.files[0]));

UI.bindForm(importForm, {
    alert: importAlert,
    loadingLabel: 'Importing…',
    submit: async () => {
        if (!contentInput.value.trim()) {
            throw new Error('Choose a file or paste an OpenAPI document first');
        }
        const result = await UI.sendJson('/api/org/apis/import', { body: { content: contentInput.value, catalogId: importForm.dataset.catalogId } });
        UI.flash(`${result.api.name} was imported with ${result.api.operationCount} endpoint${result.api.operationCount === 1 ? '' : 's'}`);
        window.location.href = `/developer/apis/${encodeURIComponent(result.api.id)}`;
    },
});
