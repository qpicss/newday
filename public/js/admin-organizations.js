// Platform admin: create organizations, rename them, and manage their members.
const bindIfPresent = (id, options) => {
    const form = document.getElementById(id);
    if (form) UI.bindForm(form, options(form));
};

bindIfPresent('newOrganizationForm', () => ({
    alert: document.getElementById('form-alert'),
    loadingLabel: 'Creating…',
    submit: async (formData) => {
        const result = await UI.sendJson('/api/admin/organizations', {
            body: { name: formData.get('name'), adminEmail: formData.get('adminEmail') || undefined },
        });
        UI.flash(`${result.organization.name} was created`);
        window.location.href = `/developer/admin/organizations/${encodeURIComponent(result.organization.id)}`;
    },
}));

bindIfPresent('organizationForm', (form) => ({
    alert: document.getElementById('org-alert'),
    loadingLabel: 'Saving…',
    submit: async (formData) => {
        const result = await UI.sendJson(form.dataset.orgUrl, { method: 'PUT', body: { name: formData.get('name') } });
        document.querySelectorAll('[data-org-name]').forEach((element) => {
            element.textContent = result.organization.name;
        });
        UI.toast('Organization renamed');
    },
}));

bindIfPresent('addMemberForm', (form) => ({
    alert: document.getElementById('member-alert'),
    loadingLabel: 'Adding…',
    submit: async (formData) => {
        const result = await UI.sendJson(`${form.dataset.orgUrl}/members`, {
            body: { email: formData.get('email'), orgRole: formData.get('orgRole') },
        });
        UI.flash(`${result.member.name} was added`);
        window.location.reload();
    },
}));

document.querySelectorAll('[data-membership-role]').forEach((select) => {
    let previous = select.value;
    select.addEventListener('change', async () => {
        select.disabled = true;
        try {
            await UI.sendJson(select.dataset.membershipRole, { method: 'PUT', body: { orgRole: select.value } });
            previous = select.value;
            UI.toast(`${select.dataset.name} is now ${select.value === 'admin' ? 'an admin' : 'a member'}`);
        } catch (error) {
            select.value = previous;
            UI.toast(error.message, 'error');
        }
        select.disabled = false;
    });
});
