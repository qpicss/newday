async function deleteApplication(button) {
    const confirmed = await UI.confirm({
        title: 'Delete application?',
        message: `"${button.dataset.name}" and its tokens will be removed. Clients using it will stop working immediately.`,
        confirmLabel: 'Delete application',
        danger: true,
    });
    if (!confirmed) return;

    UI.setLoading(button, true);
    try {
        // Admin pages point the button at the admin API instead.
        const url = button.dataset.apiUrl || `/api/applications/${encodeURIComponent(button.dataset.deleteApplication)}`;
        const response = await fetch(url, {
            method: 'DELETE',
        });

        if (response.ok) {
            UI.flash(`"${button.dataset.name}" was deleted`);
            window.location.reload();
            return;
        }
        const result = await UI.readJson(response);
        UI.toast(result.error || 'Failed to delete application', 'error');
    } catch (error) {
        console.error('Error deleting application:', error);
        UI.toast('Failed to delete application', 'error');
    }
    UI.setLoading(button, false);
}

document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-delete-application]');
    if (button) {
        deleteApplication(button);
    }
});
