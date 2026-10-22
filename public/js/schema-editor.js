// Schema editor: one JSON schema as a tree (properties, nested objects, lists of objects and, in a
// document, references to its other schemas), edited in the browser with undo/redo. Used by an API's
// Schemas tab (schema-designer.js), inline body and response schemas (content-schema.js) and object
// fields of the dictionary (dictionary-field.js).
// A row is addressed by its path: the property names from the root, through the items of lists.
//
//   SchemaEditor.create(element, { schema, name, openapi31, schemas, fields, objects, pageUrl,
//     allowRefs, rootLocked, fixedName (the root can't be renamed), onSave(editor), onChange(dirty) })
//   -> { getSchema, getName, getPendingObjects, isDirty, allowLeave }
(function () {
    function create(root, config) {
        const state = { schemas: {}, fields: [], objects: [], openapi31: false, pageUrl: '', allowRefs: true, rootLocked: false, fixedName: false, ...config, selected: config.name };
        let leaving = false;

        // ------------------------------------------------------------- Model

        const clone = (value) => JSON.parse(JSON.stringify(value));
        const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
        const REF_PREFIX = '#/components/schemas/';
        const refName = (ref) => (typeof ref === 'string' && ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length).replace(/~1/g, '/').replace(/~0/g, '~') : null);
        const typesOf = (schema) => (Array.isArray(schema?.type) ? schema.type : schema?.type ? [schema.type] : []);
        const mainType = (schema) => typesOf(schema).find((type) => type !== 'null');
        const isObjectLike = (schema) => isObject(schema) && !schema.$ref && (mainType(schema) === 'object' || isObject(schema.properties));
        const isComposed = (schema) => isObject(schema) && ['allOf', 'oneOf', 'anyOf', 'not'].some((key) => schema[key] !== undefined);

        const model = {
            schema: clone(config.schema),
            name: config.name,
            pendingObjects: [],
        };
        const saved = JSON.stringify(model);

        // What a row holds, which decides its children and its inspector.
        function kindOf(schema) {
            if (!isObject(schema) || isComposed(schema)) return 'json';
            if (schema.$ref) return 'ref';
            if (mainType(schema) === 'array' && isObject(schema.items)) {
                if (schema.items.$ref) return 'ref';
                if (isObjectLike(schema.items) && !isComposed(schema.items)) return 'list';
            }
            if (isObjectLike(schema)) return 'object';
            return 'value';
        }

        // The object whose properties are a row's children: itself, or its items for a list.
        function containerOf(schema) {
            const kind = kindOf(schema);
            if (kind === 'object') return schema;
            if (kind === 'list') return schema.items;
            return null;
        }

        function nodeAt(path) {
            let node = model.schema;
            for (const name of path) {
                const container = containerOf(node);
                if (!container || !isObject(container.properties) || !(name in container.properties)) return null;
                node = container.properties[name];
            }
            return node;
        }
        const parentOf = (path) => containerOf(nodeAt(path.slice(0, -1)));
        const keyOf = (path) => JSON.stringify(path);

        // ------------------------------------------------------------- Undo / redo

        const undoStack = [];
        const redoStack = [];
        const undoButton = root.querySelector('[data-undo]');
        const redoButton = root.querySelector('[data-redo]');
        const saveState = root.querySelector('[data-save-state]');

        // inspector: false while the change comes from the inspector's own inputs, so typing goes on.
        function change(mutate, { select, inspector = true } = {}) {
            const before = JSON.stringify(model);
            mutate();
            if (JSON.stringify(model) === before) return;
            undoStack.push(before);
            if (undoStack.length > 100) undoStack.shift();
            redoStack.length = 0;
            if (select) selected = select;
            refresh({ inspector });
        }

        function restore(snapshot) {
            const value = JSON.parse(snapshot);
            model.schema = value.schema;
            model.name = value.name;
            model.pendingObjects = value.pendingObjects;
            if (!nodeAt(selected)) selected = [];
            refresh();
        }
        undoButton.addEventListener('click', () => {
            if (!undoStack.length) return;
            redoStack.push(JSON.stringify(model));
            restore(undoStack.pop());
        });
        redoButton.addEventListener('click', () => {
            if (!redoStack.length) return;
            undoStack.push(JSON.stringify(model));
            restore(redoStack.pop());
        });
        document.addEventListener('keydown', (event) => {
            if (!(event.ctrlKey || event.metaKey) || event.target.closest('input, textarea, select')) return;
            const key = event.key.toLowerCase();
            if (key === 'z' && !event.shiftKey) {
                event.preventDefault();
                undoButton.click();
            } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
                event.preventDefault();
                redoButton.click();
            } else if (key === 's') {
                event.preventDefault();
                save();
            }
        });

        const isDirty = () => JSON.stringify(model) !== saved;
        window.addEventListener('beforeunload', (event) => {
            if (leaving || !isDirty()) return;
            event.preventDefault();
            event.returnValue = '';
        });

        // ------------------------------------------------------------- Describing schemas

        function describe(schema, depth = 0) {
            if (!isObject(schema) || depth > 4) return 'any value';
            if (schema.$ref) return refName(schema.$ref) || schema.$ref;
            if (schema.oneOf || schema.anyOf) return `one of ${(schema.oneOf || schema.anyOf).length}`;
            if (schema.allOf) return `all of ${schema.allOf.length}`;
            const type = mainType(schema) || (schema.properties ? 'object' : schema.items ? 'array' : null);
            if (!type) return 'any value';
            if (type === 'array') return `list of ${describe(schema.items, depth + 1)}`;
            if (type === 'object') {
                const count = Object.keys(schema.properties || {}).length;
                return count ? `object · ${count}` : 'object';
            }
            return [type, schema.format].filter(Boolean).join(' · ');
        }

        function constraints(schema) {
            if (!isObject(schema) || schema.$ref) return [];
            const target = mainType(schema) === 'array' && isObject(schema.items) && !schema.items.$ref ? schema : schema;
            const chips = [];
            const values = (target.enum || []).filter((value) => value !== null);
            if (values.length) chips.push(values.length <= 3 ? values.join(' | ') : `${values.length} values`);
            if (target.pattern) chips.push('pattern');
            if (target.minLength !== undefined || target.maxLength !== undefined) chips.push(`length ${target.minLength ?? 0}–${target.maxLength ?? '∞'}`);
            const low = typeof target.exclusiveMinimum === 'number' ? `>${target.exclusiveMinimum}` : target.minimum !== undefined ? `${target.exclusiveMinimum ? '>' : '≥'}${target.minimum}` : null;
            const high = typeof target.exclusiveMaximum === 'number' ? `<${target.exclusiveMaximum}` : target.maximum !== undefined ? `${target.exclusiveMaximum ? '<' : '≤'}${target.maximum}` : null;
            if (low || high) chips.push([low, high].filter(Boolean).join(' '));
            if (target.minItems !== undefined || target.maxItems !== undefined) chips.push(`${target.minItems ?? 0}–${target.maxItems ?? '∞'} items`);
            if (target.nullable || typesOf(target).includes('null')) chips.push('nullable');
            if (target.readOnly) chips.push('read-only');
            if (target.writeOnly) chips.push('write-only');
            if (target.deprecated) chips.push('deprecated');
            if (target.additionalProperties === false) chips.push('closed');
            return chips;
        }

        // ------------------------------------------------------------- Tree

        const tree = root.querySelector('[data-tree]');
        const collapsed = new Set();
        let selected = [];

        function svg(paths) {
            return `<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
        }
        const ICON = {
            chevron: '<path d="M9 6l6 6-6 6"/>',
            plus: '<path d="M12 5v14M5 12h14"/>',
            trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/>',
            link: '<path d="M7 17L17 7M9 7h8v8"/>',
        };
        const el = (tag, className, text) => {
            const node = document.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined) node.textContent = text;
            return node;
        };

        function renderRow(schema, path, depth, required) {
            const kind = kindOf(schema);
            const container = containerOf(schema);
            const children = container && isObject(container.properties) ? Object.keys(container.properties) : [];
            const hasChildren = kind === 'object' || kind === 'list';
            const open = !collapsed.has(keyOf(path));

            const row = el('div', `tree-row kind-${kind}`);
            row.setAttribute('role', 'treeitem');
            row.setAttribute('aria-level', String(depth + 1));
            row.setAttribute('aria-selected', String(keyOf(path) === keyOf(selected)));
            if (hasChildren) row.setAttribute('aria-expanded', String(open));
            row.tabIndex = keyOf(path) === keyOf(selected) ? 0 : -1;
            row.dataset.path = keyOf(path);
            row.style.setProperty('--depth', depth);

            const toggle = el('button', 'tree-toggle');
            toggle.type = 'button';
            toggle.tabIndex = -1;
            if (hasChildren) {
                toggle.innerHTML = svg(ICON.chevron);
                toggle.setAttribute('aria-label', open ? 'Fold' : 'Unfold');
                toggle.addEventListener('click', (event) => {
                    event.stopPropagation();
                    setOpen(path, !open);
                });
            } else {
                toggle.disabled = true;
                toggle.setAttribute('aria-hidden', 'true');
            }

            const name = el('span', 'tree-name', path.length ? path[path.length - 1] : model.name);
            if (required) name.append(el('span', 'tree-required', '*'));
            if (required) name.title = 'Required';

            const type = el('span', `tree-type type-${kind}`, kind === 'list' ? `list of objects · ${children.length}` : describe(schema));
            const details = el('span', 'tree-details');
            constraints(schema).forEach((chip) => details.append(el('span', 'schema-chip', chip)));
            if (schema && schema.description) details.append(el('span', 'tree-description', schema.description));

            const actions = el('span', 'tree-actions');
            if (hasChildren) {
                const add = el('button', 'btn btn-ghost btn-sm btn-icon');
                add.type = 'button';
                add.tabIndex = -1;
                add.innerHTML = svg(ICON.plus);
                add.setAttribute('aria-label', `Add a property to ${path.length ? path[path.length - 1] : model.name}`);
                add.title = 'Add property';
                add.addEventListener('click', (event) => {
                    event.stopPropagation();
                    addProperty(path);
                });
                actions.append(add);
            }
            const target = kind === 'ref' ? refName(schema.$ref || schema.items?.$ref) : null;
            if (target && target !== model.name && state.schemas[target]) {
                const open = el('a', 'btn btn-ghost btn-sm btn-icon');
                open.href = `${state.pageUrl}?name=${encodeURIComponent(target)}`;
                open.tabIndex = -1;
                open.innerHTML = svg(ICON.link);
                open.setAttribute('aria-label', `Open ${target}`);
                open.title = `Open ${target}`;
                open.addEventListener('click', (event) => event.stopPropagation());
                actions.append(open);
            }
            if (path.length) {
                const remove = el('button', 'btn btn-ghost btn-sm btn-icon');
                remove.type = 'button';
                remove.tabIndex = -1;
                remove.innerHTML = svg(ICON.trash);
                remove.setAttribute('aria-label', `Delete ${path[path.length - 1]}`);
                remove.title = 'Delete';
                remove.addEventListener('click', (event) => {
                    event.stopPropagation();
                    deleteNode(path);
                });
                actions.append(remove);
            }

            row.append(toggle, name, type, details, actions);
            row.addEventListener('click', () => select(path));

            const fragment = document.createDocumentFragment();
            fragment.append(row);
            if (hasChildren && open) {
                const requiredNames = new Set(Array.isArray(container.required) ? container.required : []);
                if (!children.length) {
                    const empty = el('div', 'tree-empty', 'No properties yet. ');
                    empty.style.setProperty('--depth', depth + 1);
                    const add = el('button', 'link-button', 'Add one');
                    add.type = 'button';
                    add.addEventListener('click', () => addProperty(path));
                    empty.append(add);
                    fragment.append(empty);
                }
                children.forEach((child) => fragment.append(renderRow(container.properties[child], [...path, child], depth + 1, requiredNames.has(child))));
            }
            return fragment;
        }

        function renderTree() {
            tree.replaceChildren(renderRow(model.schema, [], 0, false));
        }

        function setOpen(path, open) {
            if (open) collapsed.delete(keyOf(path));
            else collapsed.add(keyOf(path));
            renderTree();
            focusSelected();
        }

        function focusSelected() {
            const row = tree.querySelector(`[data-path="${CSS.escape(keyOf(selected))}"]`);
            if (row) row.focus({ preventScroll: false });
        }

        function select(path) {
            selected = path;
            // Every row above the selected one is unfolded, so it can be seen.
            for (let index = 0; index < path.length; index += 1) collapsed.delete(keyOf(path.slice(0, index)));
            renderTree();
            renderInspector();
            focusSelected();
        }

        tree.addEventListener('keydown', (event) => {
            const rows = [...tree.querySelectorAll('.tree-row')];
            const index = rows.findIndex((row) => row.dataset.path === keyOf(selected));
            const current = nodeAt(selected);
            const hasChildren = ['object', 'list'].includes(kindOf(current));
            if (event.key === 'ArrowDown' && index < rows.length - 1) select(JSON.parse(rows[index + 1].dataset.path));
            else if (event.key === 'ArrowUp' && index > 0) select(JSON.parse(rows[index - 1].dataset.path));
            else if (event.key === 'ArrowRight' && hasChildren && collapsed.has(keyOf(selected))) setOpen(selected, true);
            else if (event.key === 'ArrowLeft' && hasChildren && !collapsed.has(keyOf(selected))) setOpen(selected, false);
            else if (event.key === 'ArrowLeft' && selected.length) select(selected.slice(0, -1));
            else if (event.key === 'Delete' && selected.length) deleteNode(selected);
            else if (event.key === 'Enter') document.getElementById(selected.length ? 'nodeName' : 'nodeDescription').focus();
            else return;
            event.preventDefault();
        });

        // ------------------------------------------------------------- Changes

        function uniqueName(container, base) {
            const names = new Set(Object.keys(container.properties || {}));
            if (!names.has(base)) return base;
            for (let suffix = 2; ; suffix += 1) if (!names.has(`${base}${suffix}`)) return `${base}${suffix}`;
        }

        function addProperty(path) {
            const name = uniqueName(containerOf(nodeAt(path)), 'newProperty');
            change(() => {
                const container = containerOf(nodeAt(path));
                container.properties = isObject(container.properties) ? container.properties : {};
                container.properties[name] = { type: 'string' };
                collapsed.delete(keyOf(path));
            }, { select: [...path, name] });
            const input = document.getElementById('nodeName');
            input.focus();
            input.select();
        }

        function deleteNode(path) {
            change(() => {
                const container = parentOf(path);
                const name = path[path.length - 1];
                delete container.properties[name];
                if (Array.isArray(container.required)) {
                    container.required = container.required.filter((item) => item !== name);
                    if (!container.required.length) delete container.required;
                }
            }, { select: path.slice(0, -1) });
            UI.toast(`${path[path.length - 1]} was removed. Undo with Ctrl+Z.`, 'info');
        }

        // Rebuilds properties in a new order or with a new name, keeping every other key in place.
        function rewriteProperties(container, mapEntries) {
            container.properties = Object.fromEntries(mapEntries(Object.entries(container.properties)));
        }

        function moveNode(path, step) {
            const container = parentOf(path);
            const names = Object.keys(container.properties);
            const index = names.indexOf(path[path.length - 1]);
            const target = index + step;
            if (target < 0 || target >= names.length) return;
            change(() => rewriteProperties(container, (entries) => {
                const [entry] = entries.splice(index, 1);
                entries.splice(target, 0, entry);
                return entries;
            }), { select: path });
        }

        function renameNode(path, name) {
            const container = parentOf(path);
            const old = path[path.length - 1];
            change(() => {
                rewriteProperties(container, (entries) => entries.map(([key, value]) => [key === old ? name : key, value]));
                if (Array.isArray(container.required)) container.required = container.required.map((item) => (item === old ? name : item));
            }, { select: [...path.slice(0, -1), name] });
        }

        function replaceNode(path, schema) {
            if (!path.length) model.schema = schema;
            else parentOf(path).properties[path[path.length - 1]] = schema;
        }

        // ------------------------------------------------------------- Version forms (3.0 / 3.1)

        // The field form works in OpenAPI 3.0 terms; a 3.1 document writes nullable and exclusive bounds its way.
        function forDocument(schema) {
            const result = clone(schema);
            if (result.items) result.items = forDocument(result.items);
            if (!state.openapi31) return result;
            if (result.nullable) {
                result.type = [result.type, 'null'];
                if (result.enum && !result.enum.includes(null)) result.enum.push(null);
                delete result.nullable;
            }
            [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']].forEach(([flag, bound]) => {
                if (result[flag] === true) {
                    result[flag] = result[bound];
                    delete result[bound];
                }
            });
            return result;
        }

        function forForm(schema) {
            const result = clone(schema);
            if (isObject(result.items)) result.items = forForm(result.items);
            if (Array.isArray(result.type)) {
                const types = result.type.filter((type) => type !== 'null');
                if (types.length === 1) {
                    if (result.type.includes('null')) result.nullable = true;
                    result.type = types[0];
                }
            }
            if (result.nullable && Array.isArray(result.enum)) result.enum = result.enum.filter((value) => value !== null);
            [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']].forEach(([flag, bound]) => {
                if (typeof result[flag] === 'number') {
                    result[bound] = result[flag];
                    result[flag] = true;
                }
            });
            return result;
        }

        const sorted = (value) => {
            if (Array.isArray(value)) return value.map(sorted);
            if (!isObject(value)) return value;
            return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
        };
        const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
        const withoutDescription = (schema) => {
            const { description, ...rest } = schema;
            return rest;
        };

        // ------------------------------------------------------------- Inspector

        const inspector = root.querySelector('[data-inspector]');
        const valueForm = inspector.querySelector('[data-value-form] [data-field-form]');
        const nameInput = document.getElementById('nodeName');
        const nameError = inspector.querySelector('[data-name-error]');
        const requiredInput = document.getElementById('nodeRequired');
        const descriptionInput = document.getElementById('nodeDescription');
        const refSelect = document.getElementById('nodeRef');
        const refList = document.getElementById('nodeRefList');
        const nodeJson = document.getElementById('nodeJson');
        const valueError = inspector.querySelector('[data-value-error]');
        FieldForm.bind(valueForm, { onChange: () => applyValueForm() });

        const showError = (element, message) => {
            element.textContent = message || '';
            element.hidden = !message;
        };

        function fillRefOptions(current) {
            refSelect.replaceChildren();
            const docGroup = el('optgroup');
            docGroup.label = 'Schemas in this document';
            const names = Object.keys(state.schemas).filter((name) => name !== state.selected);
            [model.name, ...names].sort((a, b) => a.localeCompare(b)).forEach((name) => docGroup.append(new Option(name === model.name ? `${name} (this schema)` : name, `schema:${name}`)));
            refSelect.append(docGroup);
            const objects = state.objects.filter((object) => !state.schemas[object.name] && object.name !== model.name);
            if (objects.length) {
                const group = el('optgroup');
                group.label = 'Dictionary objects';
                objects.forEach((object) => group.append(new Option(`${object.name} (${object.propertyCount} propert${object.propertyCount === 1 ? 'y' : 'ies'})`, `object:${object.id}`)));
                refSelect.append(group);
            }
            const pending = state.objects.find((object) => object.name === current && model.pendingObjects.includes(object.id));
            refSelect.value = pending ? `object:${pending.id}` : `schema:${current}`;
        }

        function renderInspector() {
            const node = nodeAt(selected);
            const empty = inspector.querySelector('[data-inspector-empty]');
            const content = inspector.querySelector('[data-inspector-content]');
            empty.hidden = Boolean(node);
            content.hidden = !node;
            if (!node) return;
            const isRoot = selected.length === 0;
            const kind = kindOf(node);

            inspector.querySelector('[data-inspector-path]').textContent = [model.name, ...selected].join(' › ');
            inspector.querySelector('[data-node-moves]').hidden = isRoot;
            if (!isRoot) {
                const names = Object.keys(parentOf(selected).properties);
                const index = names.indexOf(selected[selected.length - 1]);
                inspector.querySelector('[data-move="-1"]').disabled = index === 0;
                inspector.querySelector('[data-move="1"]').disabled = index === names.length - 1;
            }
            inspector.querySelector('[data-name-label]').textContent = isRoot ? 'Schema name' : 'Property name';
            nameInput.value = isRoot ? model.name : selected[selected.length - 1];
            showError(nameError, '');
            inspector.querySelector('[data-required-row]').hidden = isRoot;
            if (!isRoot) {
                const required = parentOf(selected).required;
                requiredInput.checked = Array.isArray(required) && required.includes(selected[selected.length - 1]);
            }
            // OpenAPI 3.0 ignores what sits next to a $ref, so a reference has no description there.
            const describable = !(kind === 'ref' && node.$ref && !state.openapi31);
            inspector.querySelector('[data-description-row]').hidden = !describable || kind === 'json';
            descriptionInput.value = node.description || '';

            inspector.querySelectorAll('input[name="nodeKind"]').forEach((radio) => {
                radio.checked = radio.value === kind;
            });
            inspector.querySelectorAll('[data-kind-section]').forEach((section) => {
                section.hidden = section.dataset.kindSection !== kind;
            });

            if (kind === 'value') {
                // The form only when it describes the value fully; otherwise JSON, to lose nothing.
                const formSchema = forForm(withoutDescription(node));
                FieldForm.fill(valueForm, formSchema);
                let exact = false;
                try {
                    exact = same(forDocument(FieldForm.read(valueForm).schema), withoutDescription(node));
                } catch {
                    exact = false;
                }
                inspector.querySelector('[data-value-form]').hidden = !exact;
                inspector.querySelector('[data-value-json-note]').hidden = exact;
                if (!exact) {
                    inspector.querySelector('[data-kind-section="json"]').hidden = false;
                }
                document.getElementById('nodeFieldPick').value = '';
                showError(valueError, '');
            }
            if (kind === 'object') document.getElementById('nodeExtra').value = node.additionalProperties === false ? 'false' : '';
            if (kind === 'ref') {
                const listed = Boolean(node.items);
                const current = refName(listed ? node.items.$ref : node.$ref);
                fillRefOptions(current);
                refList.checked = listed;
                const open = inspector.querySelector('[data-open-ref]');
                open.hidden = !current || current === model.name || !state.schemas[current];
                if (!open.hidden) open.href = `${state.pageUrl}?name=${encodeURIComponent(current)}`;
            }
            nodeJson.value = JSON.stringify(node, null, 2);
            showError(inspector.querySelector('[data-node-json-error]'), '');
            // A locked root (an object field) is always an object, named and described by its own page.
            const lockedRoot = state.rootLocked && isRoot;
            nameInput.closest('.field').hidden = lockedRoot || (isRoot && state.fixedName);
            inspector.querySelector('.kind-picker').closest('.field').hidden = lockedRoot;
            if (lockedRoot) inspector.querySelector('[data-description-row]').hidden = true;
            document.getElementById('nodeExtra').closest('.field').hidden = lockedRoot;
        }

        nameInput.addEventListener('change', () => {
            const name = nameInput.value.trim();
            if (!selected.length) {
                if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return showError(nameError, 'Use letters, digits, ".", "-" and "_".');
                if (name !== state.selected && state.schemas[name]) return showError(nameError, `The document already has a schema named ${name}.`);
                showError(nameError, '');
                change(() => { model.name = name; });
                return undefined;
            }
            const old = selected[selected.length - 1];
            if (name === old) return showError(nameError, '');
            if (!name || /\s/.test(name)) return showError(nameError, 'Property names have no spaces.');
            if (name in parentOf(selected).properties) return showError(nameError, `There is already a property named ${name}.`);
            showError(nameError, '');
            renameNode(selected, name);
            return undefined;
        });

        requiredInput.addEventListener('change', () => change(() => {
            const container = parentOf(selected);
            const name = selected[selected.length - 1];
            const list = new Set(Array.isArray(container.required) ? container.required : []);
            if (requiredInput.checked) list.add(name);
            else list.delete(name);
            // Kept in property order, so the document reads the same way as the tree.
            const ordered = Object.keys(container.properties).filter((key) => list.has(key));
            if (ordered.length) container.required = ordered;
            else delete container.required;
        }, { select: selected }));

        descriptionInput.addEventListener('change', () => change(() => {
            const node = nodeAt(selected);
            const text = descriptionInput.value.trim();
            if (text) node.description = text;
            else delete node.description;
        }, { select: selected }));

        const KIND_STARTS = {
            value: () => ({ type: 'string' }),
            object: () => ({ type: 'object', properties: {} }),
            list: () => ({ type: 'array', items: { type: 'object', properties: {} } }),
            ref: () => {
                const other = Object.keys(state.schemas).find((name) => name !== state.selected) || model.name;
                return { $ref: `${REF_PREFIX}${other}` };
            },
        };
        inspector.querySelectorAll('input[name="nodeKind"]').forEach((radio) => radio.addEventListener('change', async () => {
            const node = nodeAt(selected);
            if (radio.value === 'json') {
                inspector.querySelectorAll('[data-kind-section]').forEach((section) => {
                    section.hidden = section.dataset.kindSection !== 'json';
                });
                return;
            }
            const container = containerOf(node);
            const count = container && isObject(container.properties) ? Object.keys(container.properties).length : 0;
            const keepsChildren = ['object', 'list'].includes(kindOf(node)) && ['object', 'list'].includes(radio.value);
            if (count && !keepsChildren) {
                const confirmed = await UI.confirm({
                    title: 'Replace its properties?',
                    message: `It has ${count} propert${count === 1 ? 'y' : 'ies'}, which a ${radio.value === 'ref' ? 'schema reference' : 'value'} doesn't have. You can undo this.`,
                    confirmLabel: 'Replace',
                    danger: true,
                });
                if (!confirmed) {
                    renderInspector();
                    return;
                }
            }
            change(() => {
                let next = KIND_STARTS[radio.value]();
                if (keepsChildren) {
                    // Object <-> list of objects keeps the properties.
                    const properties = clone(container);
                    delete properties.description;
                    next = radio.value === 'list' ? { type: 'array', items: properties } : properties;
                }
                if (node.description) next.description = node.description;
                replaceNode(selected, next);
            }, { select: selected });
        }));

        function applyValueForm() {
            if (kindOf(nodeAt(selected)) !== 'value' || inspector.querySelector('[data-value-form]').hidden) return;
            let schema;
            try {
                schema = FieldForm.read(valueForm).schema;
            } catch (error) {
                showError(valueError, error.message);
                return;
            }
            showError(valueError, '');
            const node = nodeAt(selected);
            const next = forDocument(schema);
            if (node.description) next.description = node.description;
            if (same(next, node)) return;
            change(() => replaceNode(selected, next), { inspector: false });
        }

        document.getElementById('nodeFieldPick').addEventListener('change', (event) => {
            const field = state.fields.find((item) => item.id === event.target.value);
            if (!field) return;
            change(() => {
                const next = clone(field.schema);
                replaceNode(selected, next);
            }, { select: selected });
            if (selected.length && selected[selected.length - 1].startsWith('newProperty')) {
                const container = parentOf(selected);
                if (!(field.name in container.properties)) renameNode(selected, field.name);
            }
            UI.toast(`Took the rules of the dictionary field ${field.name}`);
        });

        document.getElementById('nodeExtra').addEventListener('change', (event) => change(() => {
            const node = nodeAt(selected);
            if (event.target.value === 'false') node.additionalProperties = false;
            else delete node.additionalProperties;
        }, { select: selected }));

        inspector.querySelectorAll('[data-add-child]').forEach((button) => button.addEventListener('click', () => addProperty(selected)));

        function applyRef() {
            const [type, value] = [refSelect.value.slice(0, refSelect.value.indexOf(':')), refSelect.value.slice(refSelect.value.indexOf(':') + 1)];
            let name = value;
            change(() => {
                if (type === 'object') {
                    const object = state.objects.find((item) => item.id === value);
                    name = object.name;
                    if (!model.pendingObjects.includes(object.id)) model.pendingObjects.push(object.id);
                }
                const node = nodeAt(selected);
                const ref = { $ref: `${REF_PREFIX}${name}` };
                const next = refList.checked ? { type: 'array', items: ref } : ref;
                if (node.description && (refList.checked || state.openapi31)) next.description = node.description;
                replaceNode(selected, next);
                // Objects no longer referred to anywhere in the schema are not added after all.
                const text = JSON.stringify(model.schema);
                model.pendingObjects = model.pendingObjects.filter((id) => {
                    const object = state.objects.find((item) => item.id === id);
                    return object && text.includes(JSON.stringify(`${REF_PREFIX}${object.name}`));
                });
            }, { select: selected });
        }
        refSelect.addEventListener('change', applyRef);
        refList.addEventListener('change', applyRef);

        inspector.querySelector('[data-apply-node-json]').addEventListener('click', () => {
            const error = inspector.querySelector('[data-node-json-error]');
            let value;
            try {
                value = JSON.parse(nodeJson.value);
            } catch {
                showError(error, 'This isn\'t valid JSON. Check quotes, commas and brackets.');
                return;
            }
            if (!isObject(value)) {
                showError(error, 'A schema is a JSON object, for example {"type": "string"}.');
                return;
            }
            showError(error, '');
            change(() => replaceNode(selected, value), { select: selected });
        });

        inspector.querySelectorAll('[data-move]').forEach((button) => button.addEventListener('click', () => moveNode(selected, Number(button.dataset.move))));
        inspector.querySelector('[data-delete-node]').addEventListener('click', () => deleteNode(selected));

        // ------------------------------------------------------------- JSON, YAML and example views

        const tabs = [...root.querySelectorAll('[data-tab]')];
        let activeTab = 'tree';
        const jsonArea = document.getElementById('schemaJson');
        const jsonAlert = root.querySelector('[data-json-alert]');

        function showTab(name) {
            activeTab = name;
            tabs.forEach((tab) => {
                const active = tab.dataset.tab === name;
                tab.setAttribute('aria-selected', String(active));
                tab.tabIndex = active ? 0 : -1;
                document.getElementById(`panel-${tab.dataset.tab}`).hidden = !active;
            });
            renderViews();
        }
        tabs.forEach((tab, index) => {
            tab.addEventListener('click', () => showTab(tab.dataset.tab));
            tab.addEventListener('keydown', (event) => {
                if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
                next.focus();
                showTab(next.dataset.tab);
            });
        });

        root.querySelector('[data-apply-json]').addEventListener('click', () => {
            let value;
            try {
                value = JSON.parse(jsonArea.value);
            } catch {
                UI.showFormError(jsonAlert, 'This isn\'t valid JSON. Check quotes, commas and brackets.');
                return;
            }
            if (!isObject(value)) {
                UI.showFormError(jsonAlert, 'A schema is a JSON object.');
                return;
            }
            UI.hideFormError(jsonAlert);
            change(() => { model.schema = value; }, { select: [] });
            UI.toast('JSON applied. Save to keep it.');
        });

        // A small YAML writer for display (strings quoted only when they need it).
        function yaml(value, indent = '') {
            const scalar = (item) => {
                if (item === null) return 'null';
                if (typeof item !== 'string') return String(item);
                return /^[\w./-][\w ./@:+-]*$/.test(item) && !/^(true|false|null|yes|no|~|[-+]?\d[\d.e+-]*)$/i.test(item) && !/: |\s$/.test(item) ? item : JSON.stringify(item);
            };
            if (Array.isArray(value)) {
                if (!value.length) return '[]';
                return value.map((item) => {
                    if (isObject(item) || Array.isArray(item)) {
                        const inner = yaml(item, `${indent}  `);
                        return `${indent}- ${inner.trimStart()}`;
                    }
                    return `${indent}- ${scalar(item)}`;
                }).join('\n');
            }
            if (isObject(value)) {
                const entries = Object.entries(value);
                if (!entries.length) return '{}';
                return entries.map(([key, item]) => {
                    const label = `${indent}${scalar(key)}:`;
                    if ((isObject(item) && Object.keys(item).length) || (Array.isArray(item) && item.length)) return `${label}\n${yaml(item, `${indent}  `)}`;
                    return `${label} ${isObject(item) ? '{}' : Array.isArray(item) ? '[]' : scalar(item)}`;
                }).join('\n');
            }
            return `${indent}${scalar(value)}`;
        }

        const SAMPLES = {
            email: 'user@example.com', uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6', date: '2026-10-21', 'date-time': '2026-10-21T09:30:00Z',
            time: '09:30:00', uri: 'https://example.com', hostname: 'example.com', ipv4: '192.0.2.10', ipv6: '2001:db8::1', byte: 'U3dhZ2dlcg==',
        };
        // A payload that fits the schema; references are followed (once per branch) through the document.
        function example(schema, seen = [], depth = 0) {
            if (!isObject(schema) || depth > 12) return null;
            if (schema.$ref) {
                const name = refName(schema.$ref);
                if (!name || seen.includes(name)) return {};
                const target = name === model.name ? model.schema : state.schemas[name];
                return example(target, [...seen, name], depth + 1);
            }
            if (schema.example !== undefined) return schema.example;
            if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
            if (schema.default !== undefined) return schema.default;
            if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.find((value) => value !== null) ?? null;
            if (schema.const !== undefined) return schema.const;
            if (schema.allOf) return Object.assign({}, ...schema.allOf.map((part) => example(part, seen, depth + 1)).filter(isObject));
            if (schema.oneOf || schema.anyOf) return example((schema.oneOf || schema.anyOf)[0], seen, depth + 1);
            const type = mainType(schema) || (schema.properties ? 'object' : schema.items ? 'array' : 'string');
            if (type === 'object') {
                return Object.fromEntries(Object.entries(schema.properties || {})
                    .filter(([, value]) => !(isObject(value) && value.writeOnly))
                    .map(([key, value]) => [key, example(value, seen, depth + 1)]));
            }
            if (type === 'array') return [example(schema.items, seen, depth + 1)];
            if (type === 'integer') return Math.max(schema.minimum ?? 1, typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum + 1 : 1);
            if (type === 'number') return schema.minimum ?? 10.5;
            if (type === 'boolean') return true;
            if (SAMPLES[schema.format]) return SAMPLES[schema.format];
            const text = 'string';
            return schema.minLength && schema.minLength > text.length ? text.padEnd(schema.minLength, 'x') : text;
        }

        function renderViews() {
            if (activeTab === 'json' && document.activeElement !== jsonArea) jsonArea.value = JSON.stringify(model.schema, null, 2);
            if (activeTab === 'yaml') root.querySelector('[data-yaml]').textContent = yaml(model.schema);
            if (activeTab === 'example') root.querySelector('[data-example]').textContent = JSON.stringify(example(model.schema, [model.name]), null, 2);
        }

        // ------------------------------------------------------------- Save

        // Saving belongs to the page: the API's Schemas tab writes the schema, the field page the field.
        const saveButton = root.querySelector('[data-save]');
        function save() {
            if (config.onSave) config.onSave(editor);
        }
        if (saveButton) saveButton.addEventListener('click', () => save());

        // ------------------------------------------------------------- Everything follows the model

        function refresh({ inspector: withInspector = true } = {}) {
            root.querySelector('[data-schema-title]').textContent = model.name;
            root.querySelector('[data-schema-summary]').textContent = describe(model.schema);
            undoButton.disabled = !undoStack.length;
            redoButton.disabled = !redoStack.length;
            saveState.hidden = !isDirty();
            if (saveButton) saveButton.classList.toggle('is-dirty', isDirty());
            if (config.onChange) config.onChange(isDirty());
            renderTree();
            if (withInspector) renderInspector();
            renderViews();
        }

        if (!state.allowRefs) inspector.querySelector('input[name="nodeKind"][value="ref"]').closest('label').hidden = true;
        refresh();

        const editor = {
            getSchema: () => clone(model.schema),
            getName: () => model.name,
            getPendingObjects: () => [...model.pendingObjects],
            isDirty,
            allowLeave: () => { leaving = true; },
        };
        return editor;
    }

    window.SchemaEditor = { create };
})();
