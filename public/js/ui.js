// Shared UI helpers: toasts, confirmation dialogs, copy buttons, password toggles,
// table filtering, loading buttons and the mobile menu. Exposed as window.UI.
(function () {
    const ICON_PATHS = {
        success: '<path d="M20 6L9 17l-5-5"/>',
        error: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
        check: '<path d="M20 6L9 17l-5-5"/>',
    };
    const FLASH_KEY = 'ui-flash';

    function icon(name) {
        return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ICON_PATHS.info}</svg>`;
    }

    function toastRegion() {
        let region = document.getElementById('toast-region');
        if (!region) {
            region = document.createElement('div');
            region.id = 'toast-region';
            region.className = 'toast-region';
            region.setAttribute('aria-live', 'polite');
            document.body.append(region);
        }
        return region;
    }

    function toast(message, type = 'success') {
        const element = document.createElement('div');
        element.className = `toast toast-${type}`;
        element.setAttribute('role', type === 'error' ? 'alert' : 'status');
        element.innerHTML = icon(type);
        const text = document.createElement('span');
        text.textContent = message;
        element.append(text);
        toastRegion().append(element);

        requestAnimationFrame(() => element.classList.add('is-visible'));
        setTimeout(() => {
            element.classList.remove('is-visible');
            setTimeout(() => element.remove(), 250);
        }, type === 'error' ? 6000 : 4000);
    }

    // Shows a toast on the next page load (e.g. after a redirect).
    function flash(message, type = 'success') {
        try {
            sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message, type }));
        } catch {
            // Storage unavailable: the message is simply skipped.
        }
    }

    function showFlash() {
        try {
            const raw = sessionStorage.getItem(FLASH_KEY);
            if (raw) {
                sessionStorage.removeItem(FLASH_KEY);
                const { message, type } = JSON.parse(raw);
                toast(message, type);
            }
        } catch {
            // Ignore malformed or unavailable storage.
        }
    }

    function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
        return new Promise((resolve) => {
            const dialog = document.createElement('dialog');
            dialog.className = 'modal';
            dialog.innerHTML = `
                <form method="dialog" class="modal-content">
                    <h2 class="modal-title"></h2>
                    <p class="modal-message"></p>
                    <div class="modal-actions">
                        <button value="cancel" class="btn btn-secondary">Cancel</button>
                        <button value="confirm" class="btn ${danger ? 'btn-danger' : 'btn-primary'}"></button>
                    </div>
                </form>`;
            dialog.querySelector('.modal-title').textContent = title;
            dialog.querySelector('.modal-message').textContent = message;
            dialog.querySelector('button[value="confirm"]').textContent = confirmLabel;

            dialog.addEventListener('click', (event) => {
                if (event.target === dialog) dialog.close('cancel');
            });
            dialog.addEventListener('close', () => {
                resolve(dialog.returnValue === 'confirm');
                dialog.remove();
            });

            document.body.append(dialog);
            dialog.showModal();
            dialog.querySelector('button[value="cancel"]').focus();
        });
    }

    function setLoading(button, loading, label) {
        if (!button) return;
        if (loading) {
            button.dataset.label = button.innerHTML;
            button.disabled = true;
            button.classList.add('is-loading');
            if (label) button.textContent = label;
        } else {
            button.disabled = false;
            button.classList.remove('is-loading');
            if (button.dataset.label) button.innerHTML = button.dataset.label;
        }
    }

    function showFormError(alertElement, message) {
        if (!alertElement) {
            toast(message, 'error');
            return;
        }
        const text = alertElement.querySelector('[data-alert-text]') || alertElement;
        text.textContent = message;
        alertElement.hidden = false;
        alertElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function hideFormError(alertElement) {
        if (alertElement) alertElement.hidden = true;
    }

    async function readJson(response) {
        try {
            return await response.json();
        } catch {
            return {};
        }
    }

    async function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return;
        }
        const field = document.createElement('textarea');
        field.value = text;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.append(field);
        field.select();
        document.execCommand('copy');
        field.remove();
    }

    document.addEventListener('click', async (event) => {
        const copyButton = event.target.closest('[data-copy], [data-copy-target]');
        if (copyButton) {
            const target = copyButton.dataset.copyTarget && document.querySelector(copyButton.dataset.copyTarget);
            const text = copyButton.dataset.copy ?? target?.textContent.trim() ?? '';
            try {
                await copyText(text);
                const original = copyButton.innerHTML;
                copyButton.innerHTML = icon('check');
                copyButton.classList.add('is-copied');
                setTimeout(() => {
                    copyButton.innerHTML = original;
                    copyButton.classList.remove('is-copied');
                }, 1500);
                toast('Copied to clipboard');
            } catch {
                toast('Could not copy. Select the text and copy it manually.', 'error');
            }
            return;
        }

        const passwordToggle = event.target.closest('[data-toggle-password]');
        if (passwordToggle) {
            const input = document.getElementById(passwordToggle.dataset.togglePassword);
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            passwordToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
            passwordToggle.setAttribute('aria-pressed', String(show));
            return;
        }

        const navToggle = event.target.closest('[data-nav-toggle]');
        if (navToggle) {
            const header = document.querySelector('[data-app-header]');
            const open = header.classList.toggle('is-open');
            navToggle.setAttribute('aria-expanded', String(open));
        }

        // Organization switcher: pages show only the selected organization, so start over on the dashboard.
        const switchButton = event.target.closest('[data-switch-org]');
        if (switchButton) {
            if (switchButton.getAttribute('aria-checked') === 'true') {
                switchButton.closest('details').open = false;
                return;
            }
            switchButton.disabled = true;
            sendJson('/api/me/organization', { method: 'PUT', body: { organizationId: switchButton.dataset.switchOrg } })
                .then(() => {
                    flash(`Switched to ${switchButton.dataset.orgName}`);
                    window.location.href = switchButton.dataset.redirect || '/developer/dashboard';
                })
                .catch((error) => {
                    switchButton.disabled = false;
                    toast(error.message, 'error');
                });
            return;
        }

        // Close the switcher when clicking elsewhere.
        document.querySelectorAll('[data-org-switcher][open]').forEach((details) => {
            if (!details.contains(event.target)) details.open = false;
        });
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        document.querySelectorAll('[data-org-switcher][open]').forEach((details) => {
            details.open = false;
            details.querySelector('summary').focus();
        });
    });

    // Client-side search: <input data-filter="#container"> filters [data-search] items.
    document.querySelectorAll('[data-filter]').forEach((input) => {
        const container = document.querySelector(input.dataset.filter);
        const empty = document.querySelector(`[data-filter-empty="${input.dataset.filter}"]`);
        if (!container) return;

        input.addEventListener('input', () => {
            const query = input.value.trim().toLowerCase();
            let visible = 0;
            container.querySelectorAll('[data-search]').forEach((item) => {
                const match = item.dataset.search.includes(query);
                item.hidden = !match;
                if (match) visible += 1;
            });
            if (empty) empty.hidden = visible > 0;
        });
    });

    // fetch() wrapper: sends JSON, returns the parsed body, throws an Error with the API's message
    // (and the response's status and body, for callers that handle a 409 conflict themselves).
    async function sendJson(url, { method = 'POST', body } = {}) {
        let response;
        try {
            response = await fetch(url, {
                method,
                headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
                body: body !== undefined ? JSON.stringify(body) : undefined,
            });
        } catch {
            throw new Error('Network error. Check your connection and try again.');
        }
        const result = await readJson(response);
        if (!response.ok) {
            const error = new Error(result.error || 'Something went wrong. Please try again.');
            error.status = response.status;
            error.body = result;
            throw error;
        }
        return result;
    }

    // Wires a form to an async handler with loading state and inline errors.
    function bindForm(form, { alert, loadingLabel, submit }) {
        if (!form) return;
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const button = event.submitter || form.querySelector('[type="submit"]');
            hideFormError(alert);
            setLoading(button, true, loadingLabel);
            try {
                await submit(new FormData(form), form);
            } catch (error) {
                showFormError(alert, error.message);
            }
            setLoading(button, false);
        });
    }

    // Declarative buttons: data-action="/url" data-method="PUT" data-body='{"a":1}'
    // data-confirm-title/-message/-label (+ data-danger), data-success, data-redirect, data-no-reload.
    document.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-action]');
        if (!button || button.disabled) return;
        event.preventDefault();

        const { dataset } = button;
        if (dataset.confirmTitle) {
            const confirmed = await confirmDialog({
                title: dataset.confirmTitle,
                message: dataset.confirmMessage || '',
                confirmLabel: dataset.confirmLabel || 'Confirm',
                danger: 'danger' in dataset,
            });
            if (!confirmed) return;
        }

        setLoading(button, true);
        try {
            const result = await sendJson(dataset.action, {
                method: dataset.method || 'POST',
                body: dataset.body ? JSON.parse(dataset.body) : undefined,
            });
            button.dispatchEvent(new CustomEvent('ui:action-success', { bubbles: true, detail: result }));
            if ('noReload' in dataset) {
                if (dataset.success) toast(dataset.success);
                setLoading(button, false);
                return;
            }
            if (dataset.success) flash(dataset.success);
            if (dataset.redirect) {
                window.location.href = dataset.redirect;
            } else {
                window.location.reload();
            }
        } catch (error) {
            toast(error.message, 'error');
            setLoading(button, false);
        }
    });

    showFlash();

    window.UI = {
        toast,
        flash,
        confirm: confirmDialog,
        setLoading,
        showFormError,
        hideFormError,
        readJson,
        sendJson,
        bindForm,
        copyText,
    };
})();
