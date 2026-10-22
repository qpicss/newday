// Admin-only forms are missing for members; every binding checks for its form first.
const inviteForm = document.getElementById('inviteForm');
const inviteResult = document.getElementById('invite-result');
const bind = (id, options) => {
    const form = document.getElementById(id);
    if (form) UI.bindForm(form, options);
};

function showInviteResult(result) {
    const message = result.emailSent
        ? `Invitation emailed to ${result.invitation.email}.`
        : result.emailFailed
            ? `The email to ${result.invitation.email} could not be sent. Share this link instead.`
            : `Invitation created for ${result.invitation.email}. Share this link with them.`;
    inviteResult.querySelector('[data-invite-message]').textContent = message;
    document.getElementById('invite-link').textContent = result.inviteUrl;
    inviteForm.hidden = true;
    inviteResult.hidden = false;
}

bind('inviteForm', {
    alert: document.getElementById('invite-alert'),
    loadingLabel: 'Sending…',
    submit: async (formData) => {
        const result = await UI.sendJson('/api/org/invitations', {
            body: { email: formData.get('email'), orgRole: formData.get('orgRole') },
        });
        showInviteResult(result);
    },
});

// "Done" reloads so the pending invitations list includes the new one.
inviteResult?.querySelector('[data-invite-done]').addEventListener('click', () => window.location.reload());

// Resend buttons return a fresh link; show it in the same panel.
document.addEventListener('ui:action-success', (event) => {
    if (event.target.closest('[data-invite-result]')) {
        showInviteResult(event.detail);
        inviteResult.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
});

bind('addMemberForm', {
    alert: document.getElementById('member-alert'),
    loadingLabel: 'Adding…',
    submit: async (formData) => {
        const result = await UI.sendJson('/api/org/members', {
            body: {
                email: formData.get('email'),
                name: formData.get('name') || undefined,
                password: formData.get('password') || undefined,
                orgRole: formData.get('orgRole'),
            },
        });
        UI.flash(result.existingAccount ? `${result.member.name} already had an account and was added` : `${result.member.name} was added`);
        window.location.reload();
    },
});

bind('orgForm', {
    alert: document.getElementById('org-alert'),
    loadingLabel: 'Saving…',
    submit: async (formData) => {
        const result = await UI.sendJson('/api/org', { method: 'PUT', body: { name: formData.get('name') } });
        document.querySelectorAll('[data-org-name]').forEach((element) => {
            element.textContent = result.organization.name;
        });
        UI.toast('Organization renamed');
    },
});

document.querySelectorAll('[data-member-role]').forEach((select) => {
    let previous = select.value;
    select.addEventListener('change', async () => {
        select.disabled = true;
        try {
            await UI.sendJson(`/api/org/members/${encodeURIComponent(select.dataset.memberRole)}`, {
                method: 'PUT',
                body: { orgRole: select.value },
            });
            previous = select.value;
            UI.toast(`${select.dataset.name} is now ${select.value === 'admin' ? 'an admin' : 'a member'}`);
        } catch (error) {
            select.value = previous;
            UI.toast(error.message, 'error');
        }
        select.disabled = false;
    });
});

bind('newOrgForm', {
    alert: document.getElementById('new-org-alert'),
    loadingLabel: 'Creating…',
    submit: async (formData) => {
        const result = await UI.sendJson('/api/me/organizations', { body: { name: formData.get('name') } });
        UI.flash(`${result.organization.name} was created. You're its admin. Create a catalog to start.`);
        window.location.href = '/developer/catalogs';
    },
});
