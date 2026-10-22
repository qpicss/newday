async function deleteUser(button) {
    const confirmed = await UI.confirm({
        title: 'Delete user?',
        message: `${button.dataset.name} will lose access immediately, and their applications will be deleted. This can't be undone.`,
        confirmLabel: 'Delete user',
        danger: true,
    });
    if (!confirmed) return;

    UI.setLoading(button, true);
    try {
        const response = await fetch(`/api/admin/users/${encodeURIComponent(button.dataset.deleteUser)}`, {
            method: 'DELETE',
        });

        if (response.ok) {
            UI.flash(`${button.dataset.name} was deleted`);
            if (button.dataset.redirect) {
                window.location.href = button.dataset.redirect;
            } else {
                window.location.reload();
            }
            return;
        }
        const result = await UI.readJson(response);
        UI.toast(result.error || 'Failed to delete user', 'error');
    } catch (error) {
        console.error('Error deleting user:', error);
        UI.toast('Failed to delete user', 'error');
    }
    UI.setLoading(button, false);
}

document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-delete-user]');
    if (button) {
        deleteUser(button);
    }
});

document.querySelectorAll('[data-auto-submit]').forEach((select) => {
    select.addEventListener('change', () => select.form.submit());
});
