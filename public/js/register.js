const registerForm = document.getElementById('registerForm');

UI.bindForm(registerForm, {
    alert: document.getElementById('form-alert'),
    loadingLabel: 'Creating account…',
    submit: async (formData) => {
        try {
            await UI.sendJson('/auth/register', {
                body: {
                    name: formData.get('name'),
                    email: formData.get('email'),
                    password: formData.get('password'),
                    organizationName: formData.get('organizationName'),
                },
            });
        } catch (error) {
            throw new Error(error.message === 'User already exists'
                ? 'An account with this email already exists. Try signing in instead.'
                : error.message);
        }
        UI.flash('Welcome! Your organization is ready.');
        window.location.href = '/developer/dashboard';
    },
});
