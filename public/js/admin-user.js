// Admin user page: save the profile and set a new password in place.
const profileForm = document.getElementById('editUserForm');
const profileAlert = document.getElementById('form-alert');
const passwordForm = document.getElementById('passwordForm');
const passwordAlert = document.getElementById('password-alert');
const userUrl = `/api/admin/users/${encodeURIComponent(profileForm.dataset.userId)}`;

profileForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const submit = profileForm.querySelector('[type="submit"]');
    // Disabled fields (e.g. your own role) are left out and therefore unchanged.
    const data = Object.fromEntries(new FormData(profileForm));
    data.isVerified = data.isVerified === 'on';
    UI.hideFormError(profileAlert);
    UI.setLoading(submit, true, 'Saving…');

    try {
        const response = await fetch(userUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        const result = await UI.readJson(response);

        if (response.ok) {
            // Reload so the header badges and table reflect the new role and status.
            UI.flash('Profile saved');
            window.location.reload();
            return;
        }
        UI.showFormError(profileAlert, result.error || 'Failed to update user');
    } catch (error) {
        console.error('Error updating user:', error);
        UI.showFormError(profileAlert, 'Network error. Check your connection and try again.');
    }
    UI.setLoading(submit, false);
});

passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const submit = passwordForm.querySelector('[type="submit"]');
    const input = document.getElementById('newPassword');
    UI.hideFormError(passwordAlert);
    UI.setLoading(submit, true, 'Saving…');

    try {
        const response = await fetch(`${userUrl}/password`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: input.value }),
        });
        const result = await UI.readJson(response);

        if (response.ok) {
            passwordForm.reset();
            UI.toast('Password updated');
        } else {
            UI.showFormError(passwordAlert, result.error || 'Failed to update password');
        }
    } catch (error) {
        console.error('Error updating password:', error);
        UI.showFormError(passwordAlert, 'Network error. Check your connection and try again.');
    }
    UI.setLoading(submit, false);
});

// Organizations: add to one, change the role, remove (buttons use data-action).
const addMembershipForm = document.getElementById('addMembershipForm');
if (addMembershipForm) {
    UI.bindForm(addMembershipForm, {
        alert: document.getElementById('membership-alert'),
        loadingLabel: 'Adding…',
        submit: async (formData) => {
            await UI.sendJson(`/api/admin/organizations/${encodeURIComponent(formData.get('organizationId'))}/members`, {
                body: { email: addMembershipForm.dataset.email, orgRole: formData.get('orgRole') },
            });
            UI.flash('Added to the organization');
            window.location.reload();
        },
    });
}

document.querySelectorAll('[data-membership-role]').forEach((select) => {
    let previous = select.value;
    select.addEventListener('change', async () => {
        select.disabled = true;
        try {
            await UI.sendJson(select.dataset.membershipRole, { method: 'PUT', body: { orgRole: select.value } });
            previous = select.value;
            UI.toast(`Now ${select.value === 'admin' ? 'an admin' : 'a member'} of ${select.dataset.name}`);
        } catch (error) {
            select.value = previous;
            UI.toast(error.message, 'error');
        }
        select.disabled = false;
    });
});
