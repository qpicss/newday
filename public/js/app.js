const loginForm = document.getElementById('loginForm');
const loginAlert = document.getElementById('form-alert');

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault(); // Prevent default form submission

    const submit = loginForm.querySelector('[type="submit"]');
    const formData = new FormData(loginForm);
    UI.hideFormError(loginAlert);
    UI.setLoading(submit, true, 'Signing in…');

    try {
        const response = await fetch('/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                email: formData.get('email'),
                password: formData.get('password'),
            }),
        });

        const result = await UI.readJson(response);

        if (response.ok) {
            // Redirect based on user role
            window.location.href = result.user.role === 'admin' ? '/developer/admin' : '/developer/dashboard';
            return;
        }

        UI.showFormError(loginAlert, result.error === 'Invalid credentials'
            ? 'That email and password combination is incorrect.'
            : (result.error || 'Unable to sign in. Please try again.'));
    } catch (error) {
        console.error('Login error:', error);
        UI.showFormError(loginAlert, 'Network error. Check your connection and try again.');
    }
    UI.setLoading(submit, false);
});
