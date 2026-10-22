// Property list of a dictionary object (views/partials/object-builder.html): pick fields and objects
// from the dictionary, or create a field on the spot, then rename, reorder, mark as list or required.
// ObjectBuilder.create(...).getProperties() gives the list in the shape PUT /dictionary/objects takes.
(function () {
    const ICONS = {
        up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
        down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
        remove: '<path d="M18 6L6 18M6 6l12 12"/>',
        field: '<path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/>',
        object: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
    };
    const MAX_RESULTS = 40;

    const svg = (name) => `<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    const element = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const lowerFirst = (name) => name.charAt(0).toLowerCase() + name.slice(1);

    let counter = 0;

    function create({ root, properties = [], choices, selfId = null, onChange = () => {} }) {
        const rows = root.querySelector('[data-builder-rows]');
        const empty = root.querySelector('[data-builder-empty]');
        const table = root.querySelector('.builder-table');
        const pickerInput = root.querySelector('[data-picker-input]');
        const pickerList = root.querySelector('[data-picker-list]');
        const newFieldButton = root.querySelector('[data-builder-new-field]');
        const fieldPanel = root.querySelector('[data-builder-field-panel]');
        const fieldContainer = fieldPanel.querySelector('[data-field-form]');
        const fieldAlert = fieldPanel.querySelector('[data-builder-field-alert]');
        const state = { fields: [...choices.fields], objects: [...choices.objects] };
        let items = [];
        let results = [];
        let active = -1;

        const targetOf = (item) => (item.fieldId
            ? state.fields.find((field) => field.id === item.fieldId)
            : state.objects.find((object) => object.id === item.objectId) || (item.objectId === selfId ? { id: selfId, name: 'this object' } : null));

        function render() {
            rows.replaceChildren();
            items.forEach((item, index) => {
                const target = targetOf(item);
                const row = element('tr');

                const nameCell = element('td');
                const nameInput = element('input', 'input input-sm mono');
                nameInput.type = 'text';
                nameInput.value = item.name;
                nameInput.maxLength = 100;
                nameInput.spellcheck = false;
                nameInput.autocomplete = 'off';
                nameInput.id = `builder-${item.key}`;
                nameInput.setAttribute('aria-label', `Name of property ${index + 1}`);
                nameInput.addEventListener('input', () => {
                    item.name = nameInput.value.trim();
                    onChange();
                });
                nameCell.append(nameInput);

                const valueCell = element('td');
                const value = element('div', 'builder-value');
                valueCell.append(value);
                const kind = item.fieldId ? 'field' : 'object';
                value.insertAdjacentHTML('beforeend', svg(kind));
                if (target) {
                    const link = element('a', 'mono-name', target.name);
                    link.href = `/developer/dictionary/${kind === 'field' ? 'fields' : 'objects'}/${encodeURIComponent(target.id)}`;
                    link.target = '_blank';
                    link.rel = 'noopener';
                    value.append(link);
                    if (kind === 'field' && target.summary) value.append(element('span', 'schema-chip', target.summary));
                    if (kind === 'object') value.append(element('span', 'schema-chip', item.isArray ? 'list of objects' : 'object'));
                } else {
                    value.append(element('span', 'muted', 'No longer in the dictionary'));
                }

                const checkCell = (key, label) => {
                    const cell = element('td', 'builder-check');
                    const box = element('input');
                    box.type = 'checkbox';
                    box.checked = item[key];
                    box.setAttribute('aria-label', `${label}: ${item.name || `property ${index + 1}`}`);
                    box.addEventListener('change', () => {
                        item[key] = box.checked;
                        if (key === 'isArray') render();
                        onChange();
                    });
                    const caption = element('span', 'builder-check-label', label);
                    caption.setAttribute('aria-hidden', 'true');
                    cell.append(box, caption);
                    return cell;
                };

                const actions = element('td', 'actions-cell');
                const button = (icon, label, disabled, handler) => {
                    const node = element('button', 'btn btn-ghost btn-sm btn-icon');
                    node.type = 'button';
                    node.innerHTML = svg(icon);
                    node.setAttribute('aria-label', `${label} ${item.name}`);
                    node.title = label;
                    node.disabled = disabled;
                    node.addEventListener('click', handler);
                    return node;
                };
                actions.append(
                    button('up', 'Move up', index === 0, () => move(index, -1)),
                    button('down', 'Move down', index === items.length - 1, () => move(index, 1)),
                    button('remove', 'Remove', false, () => {
                        items.splice(index, 1);
                        render();
                        onChange();
                    }),
                );

                row.append(nameCell, valueCell, checkCell('isArray', 'List'), checkCell('required', 'Required'), actions);
                rows.append(row);
            });
            table.hidden = items.length === 0;
            empty.hidden = items.length > 0;
        }

        function move(index, step) {
            const [item] = items.splice(index, 1);
            items.splice(index + step, 0, item);
            render();
            onChange();
            rows.children[index + step]?.querySelector(`[aria-label^="${step < 0 ? 'Move up' : 'Move down'}"]`)?.focus();
        }

        function uniqueName(base) {
            const taken = new Set(items.map((item) => item.name));
            if (!taken.has(base)) return base;
            for (let suffix = 2; ; suffix += 1) if (!taken.has(`${base}${suffix}`)) return `${base}${suffix}`;
        }

        function add(choice) {
            counter += 1;
            const item = {
                key: counter,
                name: uniqueName(choice.kind === 'field' ? choice.name : lowerFirst(choice.name)),
                fieldId: choice.kind === 'field' ? choice.id : null,
                objectId: choice.kind === 'object' ? choice.id : null,
                isArray: false,
                required: false,
            };
            items.push(item);
            render();
            onChange();
            document.getElementById(`builder-${item.key}`)?.focus();
        }

        // ---------------------------------------------------------- Picker

        function closePicker() {
            pickerList.hidden = true;
            pickerInput.setAttribute('aria-expanded', 'false');
            pickerInput.removeAttribute('aria-activedescendant');
            active = -1;
        }

        function highlight(index) {
            active = index;
            [...pickerList.children].forEach((option, position) => option.setAttribute('aria-selected', String(position === index)));
            const option = pickerList.children[index];
            if (option && option.id) {
                pickerInput.setAttribute('aria-activedescendant', option.id);
                option.scrollIntoView({ block: 'nearest' });
            }
        }

        function openPicker() {
            const query = pickerInput.value.trim().toLowerCase();
            const all = [
                ...state.fields.map((field) => ({ ...field, kind: 'field' })),
                ...state.objects.filter((object) => object.id !== selfId).map((object) => ({ ...object, kind: 'object' })),
                ...(selfId ? [{ id: selfId, name: 'This object', kind: 'object', self: true }] : []),
            ];
            results = all.filter((choice) => !query || choice.name.toLowerCase().includes(query)).slice(0, MAX_RESULTS);
            pickerList.replaceChildren();
            if (!results.length) {
                const none = element('li', 'picker-empty', state.fields.length + state.objects.length
                    ? 'Nothing matches. Use New field to add one.'
                    : 'The dictionary is empty. Use New field to add the first field.');
                none.setAttribute('role', 'presentation');
                pickerList.append(none);
            }
            results.forEach((choice, index) => {
                const option = element('li', 'picker-option');
                option.id = `${pickerList.id}-${index}`;
                option.setAttribute('role', 'option');
                option.setAttribute('aria-selected', 'false');
                option.insertAdjacentHTML('beforeend', svg(choice.kind));
                option.append(element('span', 'mono-name', choice.name));
                option.append(element('span', 'picker-meta', choice.kind === 'field'
                    ? choice.summary
                    : choice.self ? 'for trees, such as a category with subcategories' : `object · ${choice.propertyCount} propert${choice.propertyCount === 1 ? 'y' : 'ies'}`));
                option.addEventListener('mousedown', (event) => event.preventDefault());
                option.addEventListener('click', () => choose(index));
                pickerList.append(option);
            });
            pickerList.hidden = false;
            pickerInput.setAttribute('aria-expanded', 'true');
            highlight(results.length ? 0 : -1);
        }

        function choose(index) {
            const choice = results[index];
            if (!choice) return;
            pickerInput.value = '';
            closePicker();
            add(choice);
        }

        pickerInput.addEventListener('focus', openPicker);
        pickerInput.addEventListener('input', openPicker);
        // Closes once focus has really left (not when it comes straight back, as after adding).
        pickerInput.addEventListener('blur', () => setTimeout(() => {
            if (document.activeElement !== pickerInput) closePicker();
        }, 100));
        pickerInput.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (pickerList.hidden) openPicker();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                if (results.length) highlight((active + step + results.length) % results.length);
            } else if (event.key === 'Enter') {
                event.preventDefault();
                if (!pickerList.hidden && active >= 0) choose(active);
            } else if (event.key === 'Escape') {
                closePicker();
            }
        });

        // ---------------------------------------------------------- New field

        FieldForm.bind(fieldContainer);
        const toggleFieldPanel = (open) => {
            fieldPanel.hidden = !open;
            newFieldButton.setAttribute('aria-expanded', String(open));
            UI.hideFormError(fieldAlert);
            if (open) fieldContainer.querySelector('[data-field-input="name"]').focus();
        };
        newFieldButton.addEventListener('click', () => toggleFieldPanel(fieldPanel.hidden));
        fieldPanel.querySelector('[data-builder-field-cancel]').addEventListener('click', () => {
            toggleFieldPanel(false);
            newFieldButton.focus();
        });
        const addFieldButton = fieldPanel.querySelector('[data-builder-field-add]');
        async function createField() {
            UI.hideFormError(fieldAlert);
            UI.setLoading(addFieldButton, true, 'Adding…');
            try {
                const { name, description, schema } = FieldForm.read(fieldContainer);
                const { field } = await UI.sendJson('/api/org/dictionary/fields', { body: { name, description, schema } });
                const choice = { id: field.id, name: field.name, summary: field.summary, type: field.schema.type, description: field.description };
                state.fields.push(choice);
                state.fields.sort((a, b) => a.name.localeCompare(b.name));
                FieldForm.reset(fieldContainer);
                toggleFieldPanel(false);
                add({ ...choice, kind: 'field' });
                UI.toast(`${field.name} was added to the dictionary`);
            } catch (error) {
                UI.showFormError(fieldAlert, error.message);
            }
            UI.setLoading(addFieldButton, false);
        }
        addFieldButton.addEventListener('click', createField);
        // Enter in the panel adds the field instead of submitting the form around the builder.
        fieldPanel.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
                event.preventDefault();
                createField();
            }
        });

        items = properties.map((property) => {
            counter += 1;
            return {
                key: counter,
                name: property.name,
                fieldId: property.fieldId || null,
                objectId: property.refObjectId || property.objectId || null,
                isArray: Boolean(property.isArray),
                required: Boolean(property.required),
            };
        });
        render();

        return {
            getProperties: () => items.map((item) => ({
                name: item.name,
                ...(item.fieldId ? { fieldId: item.fieldId } : { objectId: item.objectId }),
                isArray: item.isArray,
                required: item.required,
            })),
            addObjectChoice: (object) => state.objects.push(object),
            reset: () => {
                items = [];
                render();
            },
        };
    }

    window.ObjectBuilder = { create };
})();
