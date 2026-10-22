// Dictionary field inputs (views/partials/field-form.html): shows the sections of the chosen type and
// reads the inputs into { name, description, schema } for the API. The server checks everything
// again; this only turns text into the right JSON types and catches obvious typos early.
(function () {
    const visible = (element) => !element.closest('[hidden]');

    function sync(container) {
        const type = container.querySelector('[data-schema="type"]').value;
        const itemType = container.querySelector('[data-schema="items.type"]')?.value;
        container.querySelectorAll('[data-types]').forEach((section) => {
            section.hidden = !section.dataset.types.split(' ').includes(type);
        });
        container.querySelectorAll('[data-item-types]').forEach((section) => {
            section.hidden = !section.dataset.itemTypes.split(' ').includes(itemType);
        });
    }

    function parseValue(raw, type, label) {
        if (raw === '') return undefined;
        if (raw === 'null' && type !== 'string') return null;
        if (type === 'string') return raw;
        if (type === 'number' || type === 'integer') {
            const value = Number(raw);
            if (!Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) {
                throw new Error(`${label} must be ${type === 'integer' ? 'a whole number' : 'a number'}`);
            }
            return value;
        }
        if (type === 'boolean') {
            if (raw !== 'true' && raw !== 'false') throw new Error(`${label} must be true or false`);
            return raw === 'true';
        }
        try {
            return JSON.parse(raw);
        } catch {
            throw new Error(`${label} must be written as JSON, for example ${type === 'array' ? '["a", "b"]' : '{"key": "value"}'}`);
        }
    }

    function parseList(raw, type, label) {
        const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
        return lines.length ? lines.map((line) => parseValue(line, type, label)) : undefined;
    }

    function labelOf(input) {
        const label = input.id && input.closest('[data-field-form]').querySelector(`label[for="${input.id}"]`);
        return label ? label.childNodes[0].textContent.trim() : input.dataset.schema;
    }

    function read(container) {
        const input = (key) => container.querySelector(`[data-schema="${key}"]`);
        const type = input('type').value;
        const schema = { type };
        container.querySelectorAll('[data-schema]').forEach((element) => {
            const key = element.dataset.schema;
            if (key === 'type' || !visible(element)) return;
            if (key.startsWith('items.')) return;
            if (element.type === 'checkbox') {
                if (element.checked) schema[key] = true;
                return;
            }
            const raw = element.value.trim();
            if (raw === '') return;
            const label = labelOf(element);
            if (key === 'enum') schema.enum = parseList(element.value, type, label);
            else if (key === 'additionalProperties') schema.additionalProperties = raw === 'true';
            else if (element.dataset.kind === 'count' || element.dataset.kind === 'number') schema[key] = parseValue(raw, element.dataset.kind === 'count' ? 'integer' : 'number', label);
            else if (element.dataset.kind === 'value') schema[key] = parseValue(raw, type, label);
            else schema[key] = raw;
        });
        if (type === 'array') {
            const itemType = input('items.type').value;
            schema.items = { type: itemType };
            const format = input('items.format');
            if (format && visible(format) && format.value.trim()) schema.items.format = format.value.trim();
            const values = input('items.enum');
            if (values && visible(values)) {
                const list = parseList(values.value, itemType, 'Allowed item values');
                if (list) schema.items.enum = list;
            }
        }
        // Exclusive bounds only mean something next to their bound.
        if (schema.minimum === undefined) delete schema.exclusiveMinimum;
        if (schema.maximum === undefined) delete schema.exclusiveMaximum;
        const name = container.querySelector('[data-field-input="name"]');
        const description = container.querySelector('[data-field-input="description"]');
        return {
            name: name ? name.value.trim() : undefined,
            description: description ? description.value.trim() : undefined,
            schema,
        };
    }

    function bind(container, { onChange } = {}) {
        if (!container) return;
        sync(container);
        container.addEventListener('change', (event) => {
            if (event.target.matches('[data-schema="type"], [data-schema="items.type"]')) sync(container);
            if (onChange) onChange();
        });
        if (onChange) container.addEventListener('input', onChange);
    }

    // Loads a schema (in the dictionary's form) into the inputs, clearing what it doesn't set.
    function fill(container, schema) {
        const valueText = (value) => (value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value));
        const listText = (values) => (values || []).filter((value) => value !== null).map(String).join('\n');
        container.querySelectorAll('[data-schema]').forEach((element) => {
            const key = element.dataset.schema;
            const value = key.startsWith('items.') ? schema.items?.[key.slice(6)] : schema[key];
            if (element.type === 'checkbox') element.checked = value === true;
            else if (key === 'type' || key === 'items.type') element.value = value || 'string';
            else if (key === 'enum' || key === 'items.enum') element.value = listText(value);
            else if (key === 'additionalProperties') element.value = value === undefined ? '' : String(value);
            else element.value = valueText(value);
        });
        sync(container);
    }

    // Clears a compact form after its field was created.
    function reset(container) {
        container.querySelectorAll('input[type="text"], textarea').forEach((element) => { element.value = ''; });
        container.querySelectorAll('input[type="checkbox"]').forEach((element) => { element.checked = false; });
        const type = container.querySelector('[data-schema="type"]');
        type.value = 'string';
        sync(container);
    }

    // "Added 12 fields and 3 objects to the dictionary. 4 were already there." for an import result.
    function describeImport(result) {
        if (!result) return 'The API was imported, but its schemas could not be added to the dictionary. Try again from the dictionary page.';
        const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
        const added = result.fieldsAdded || result.objectsAdded
            ? `Added ${[result.fieldsAdded && plural(result.fieldsAdded, 'field'), result.objectsAdded && plural(result.objectsAdded, 'object')].filter(Boolean).join(' and ')} to the dictionary.`
            : 'Nothing new for the dictionary.';
        const reused = result.fieldsReused + result.objectsReused;
        return [added, reused ? `${reused} ${reused === 1 ? 'was' : 'were'} already there.` : '', result.notes.length ? `${plural(result.notes.length, 'entry')} skipped or renamed.`.replace('entrys', 'entries') : '']
            .filter(Boolean).join(' ');
    }

    window.FieldForm = { bind, read, fill, reset, sync, describeImport };
})();
