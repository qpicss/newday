// OpenAPI source editor: line numbers, tab indentation, validation and saving of the whole document.
(function () {
    const editor = document.getElementById('sourceText');
    const gutter = document.getElementById('sourceGutter');
    const status = document.getElementById('sourceStatus');
    const alert = document.getElementById('source-alert');
    const goToLine = document.getElementById('goToLine');
    const validateButton = document.getElementById('validateSource');
    const saveButton = document.getElementById('saveSource');
    const revertButton = document.getElementById('revertSource');
    const apiUrl = editor.dataset.apiUrl;
    const original = editor.value;
    const INDENT = '  ';
    let errorLine = null;
    let lineCount = 0;

    function renderGutter() {
        const count = editor.value.split('\n').length;
        if (count !== lineCount) {
            lineCount = count;
            gutter.textContent = Array.from({ length: count }, (_, index) => index + 1).join('\n');
        }
        gutter.scrollTop = editor.scrollTop;
    }

    const isDirty = () => editor.value !== original;
    function updateDirty() {
        revertButton.disabled = !isDirty();
        saveButton.classList.toggle('is-dirty', isDirty());
    }

    function showError(message, line) {
        errorLine = line || null;
        goToLine.hidden = !errorLine;
        if (errorLine) goToLine.textContent = `Go to line ${errorLine}`;
        UI.showFormError(alert, message);
    }

    function jumpTo(line) {
        const lines = editor.value.split('\n');
        const start = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0);
        editor.focus();
        editor.setSelectionRange(start, start + (lines[line - 1] || '').length);
        const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 20;
        editor.scrollTop = Math.max(0, (line - 5) * lineHeight);
        renderGutter();
    }

    goToLine.addEventListener('click', () => errorLine && jumpTo(errorLine));

    editor.addEventListener('input', () => {
        renderGutter();
        updateDirty();
    });
    editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });

    // Tab and Shift+Tab indent and outdent the selected lines; Ctrl/Cmd+S saves.
    editor.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            save();
            return;
        }
        if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return;
        event.preventDefault();
        const { value, selectionStart, selectionEnd } = editor;
        const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
        if (selectionStart === selectionEnd && !event.shiftKey) {
            editor.setRangeText(INDENT, selectionStart, selectionEnd, 'end');
        } else {
            const block = value.slice(lineStart, selectionEnd);
            const changed = block.split('\n').map((line) => (event.shiftKey ? line.replace(/^ {1,2}/, '') : INDENT + line)).join('\n');
            editor.setRangeText(changed, lineStart, selectionEnd, 'select');
        }
        renderGutter();
        updateDirty();
    });

    async function validate() {
        UI.hideFormError(alert);
        UI.setLoading(validateButton, true, 'Checking…');
        try {
            const result = await UI.sendJson(`${apiUrl}/spec/validate`, { body: { content: editor.value } });
            if (result.valid) {
                status.textContent = `Valid: ${result.name} ${result.version}, OpenAPI ${result.openapi}, ${result.operationCount} endpoint${result.operationCount === 1 ? '' : 's'}`;
                status.classList.add('is-valid');
            } else {
                status.textContent = 'Not valid';
                status.classList.remove('is-valid');
                showError(result.error, result.line);
            }
        } catch (error) {
            showError(error.message);
        }
        UI.setLoading(validateButton, false);
    }

    async function save() {
        if (saveButton.disabled) return;
        UI.hideFormError(alert);
        UI.setLoading(saveButton, true, 'Saving…');
        try {
            const result = await UI.sendJson(`${apiUrl}/spec`, {
                method: 'PUT',
                body: { content: editor.value, updatedAt: editor.dataset.updatedAt },
            });
            window.removeEventListener('beforeunload', guard);
            UI.flash(`${result.api.name} saved: ${result.api.operationCount} endpoint${result.api.operationCount === 1 ? '' : 's'}. Push your gateways to deploy it.`);
            window.location.reload();
            return;
        } catch (error) {
            showError(error.message, error.body?.line);
        }
        UI.setLoading(saveButton, false);
    }

    validateButton.addEventListener('click', validate);
    saveButton.addEventListener('click', save);
    revertButton.addEventListener('click', async () => {
        const confirmed = await UI.confirm({ title: 'Undo your changes?', message: 'The editor goes back to the saved document.', confirmLabel: 'Undo changes' });
        if (!confirmed) return;
        editor.value = original;
        UI.hideFormError(alert);
        renderGutter();
        updateDirty();
    });

    function guard(event) {
        if (!isDirty()) return;
        event.preventDefault();
        event.returnValue = '';
    }
    window.addEventListener('beforeunload', guard);

    // Switching format reloads the saved document: ask before dropping edits.
    document.querySelectorAll('.segmented-btn').forEach((link) => {
        link.addEventListener('click', async (event) => {
            if (!isDirty() || link.getAttribute('aria-current')) return;
            event.preventDefault();
            const confirmed = await UI.confirm({ title: 'Switch format?', message: 'The editor shows the saved document in the other format. Your unsaved changes are dropped.', confirmLabel: 'Switch', danger: true });
            if (!confirmed) return;
            window.removeEventListener('beforeunload', guard);
            window.location.href = link.href;
        });
    });

    renderGutter();
})();
