const createUserForm = document.getElementById('createUserForm');
const organizationSelect = document.getElementById('organizationId');
const newOrganizationField = createUserForm.querySelector('[data-new-organization]');
const orgRoleField = createUserForm.querySelector('[data-org-role]');

// New organization: name it (the user becomes its admin). Existing one: pick a role.
function updateOrganizationFields() {
    const creatingNew = !organizationSelect.value;
    newOrganizationField.hidden = !creatingNew;
    newOrganizationField.querySelector('input').required = creatingNew;
    orgRoleField.hidden = creatingNew;
}
organizationSelect.addEventListener('change', updateOrganizationFields);
updateOrganizationFields();

UI.bindForm(createUserForm, {
    alert: document.getElementById('form-alert'),
    loadingLabel: 'Creating…',
    submit: async (form) => {
        const organizationId = form.get('organizationId');
        const result = await UI.sendJson('/api/admin/users', {
            body: {
                name: form.get('name'),
                email: form.get('email'),
                password: form.get('password'),
                role: form.get('role'),
                isVerified: document.getElementById('isVerified').checked,
                ...(organizationId
                    ? { organizationId, orgRole: form.get('orgRole') }
                    : { organizationName: form.get('organizationName') }),
            },
        });
        UI.flash(`${result.user.name} was created`);
        window.location.href = '/developer/admin';
    },
});
