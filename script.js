/* =========================================================================
   EchoCipher - login page
   Validates input, creates the session that guards every app page, and wires
   the "Forgot password" and SSO flows.
   ========================================================================= */

document.addEventListener('DOMContentLoaded', () => {
    const EC = window.EchoCipher;
    const $ = (id) => document.getElementById(id);

    const form = $('loginForm');
    const loginBtn = $('loginBtn');
    const emailInput = $('email');
    const passwordInput = $('password');
    const rememberMe = $('rememberMe');

    if (!form) return;

    const REMEMBER_KEY = 'echocipher.rememberedEmail';

    /* Already signed in? Skip straight through. */
    if (EC && EC.Store.getSession()) {
        const next = new URLSearchParams(location.search).get('next');
        window.location.replace(next && /^[\w.-]+\.html$/.test(next) ? next : 'dashboard.html');
        return;
    }

    /* Restore a remembered address. */
    const remembered = localStorage.getItem(REMEMBER_KEY);
    if (remembered) {
        emailInput.value = remembered;
        rememberMe.checked = true;
        passwordInput.focus();
    } else {
        emailInput.focus();
    }

    /* ------------------------------------------------------------------ */
    /* Validation                                                          */
    /* ------------------------------------------------------------------ */

    function setError(input, message) {
        const errorEl = $(input.id + 'Error');
        input.classList.toggle('invalid', !!message);
        input.setAttribute('aria-invalid', message ? 'true' : 'false');
        if (errorEl) {
            errorEl.textContent = message || '';
            errorEl.hidden = !message;
        }
        return !message;
    }

    function validateEmail() {
        const value = emailInput.value.trim();
        if (!value) return setError(emailInput, 'Enter your email address.');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
            return setError(emailInput, 'That does not look like a valid email address.');
        }
        return setError(emailInput, null);
    }

    function validatePassword() {
        const value = passwordInput.value;
        if (!value) return setError(passwordInput, 'Enter your password.');
        if (value.length < 6) return setError(passwordInput, 'Password must be at least 6 characters.');
        return setError(passwordInput, null);
    }

    emailInput.addEventListener('blur', validateEmail);
    passwordInput.addEventListener('blur', validatePassword);
    emailInput.addEventListener('input', () => {
        if (emailInput.classList.contains('invalid')) validateEmail();
    });
    passwordInput.addEventListener('input', () => {
        if (passwordInput.classList.contains('invalid')) validatePassword();
    });

    /* ------------------------------------------------------------------ */
    /* Show / hide password                                                */
    /* ------------------------------------------------------------------ */

    const toggle = $('togglePassword');
    if (toggle) {
        toggle.addEventListener('click', () => {
            const showing = passwordInput.type === 'text';
            passwordInput.type = showing ? 'password' : 'text';
            toggle.classList.toggle('active', !showing);
            toggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
            passwordInput.focus();
        });
    }

    /* ------------------------------------------------------------------ */
    /* Submit                                                              */
    /* ------------------------------------------------------------------ */

    function signIn(email, method) {
        if (rememberMe.checked) {
            localStorage.setItem(REMEMBER_KEY, email);
        } else {
            localStorage.removeItem(REMEMBER_KEY);
        }

        EC.Store.setSession({
            email: email,
            method: method || 'password',
            signedInAt: new Date().toISOString()
        });

        // Keep the header name in step with whoever just signed in.
        const settings = EC.Store.getSettings();
        if (settings.email !== email) {
            EC.Store.saveSettings({ email: email });
        }

        const next = new URLSearchParams(location.search).get('next');
        window.location.href = next && /^[\w.-]+\.html$/.test(next) ? next : 'dashboard.html';
    }

    form.addEventListener('submit', (e) => {
        e.preventDefault();

        // Validate both so every problem is shown at once.
        const emailOk = validateEmail();
        const passwordOk = validatePassword();
        if (!emailOk || !passwordOk) {
            (emailOk ? passwordInput : emailInput).focus();
            return;
        }

        const originalText = loginBtn.innerHTML;
        loginBtn.innerHTML = 'Verifying Voice Signature <span class="spinner-icon"></span>';
        loginBtn.disabled = true;
        loginBtn.style.cursor = 'wait';

        setTimeout(() => {
            loginBtn.innerHTML = 'Verified &amp; Logged In';
            loginBtn.style.backgroundColor = 'var(--accent-green)';
            loginBtn.style.color = '#fff';
            loginBtn.style.cursor = 'default';
            setTimeout(() => signIn(emailInput.value.trim(), 'password'), 700);
        }, 1400);

        // If something goes wrong the button should not stay stuck.
        setTimeout(() => {
            if (document.body.contains(loginBtn) && loginBtn.disabled && !EC.Store.getSession()) {
                loginBtn.innerHTML = originalText;
                loginBtn.disabled = false;
                loginBtn.style.cursor = 'pointer';
            }
        }, 6000);
    });

    /* ------------------------------------------------------------------ */
    /* Forgot password                                                     */
    /* ------------------------------------------------------------------ */

    const forgotBtn = $('forgotPasswordBtn');
    if (forgotBtn) {
        forgotBtn.addEventListener('click', () => {
            EC.modal({
                title: 'Reset your password',
                body: `
                    <p>Enter the email on your account and we will send a reset link.</p>
                    <div class="field" style="margin-top:1rem;">
                        <label for="resetEmail">Email</label>
                        <input type="email" id="resetEmail" placeholder="name@enterprise.com"
                               value="${EC.Fmt.escape(emailInput.value.trim())}">
                        <span class="hint">Demo build — no email is actually sent.</span>
                    </div>`,
                confirmText: 'Send reset link',
                onConfirm: (root) => {
                    const value = root.querySelector('#resetEmail').value.trim();
                    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
                        EC.toast('Enter a valid email address.', 'error');
                        return false;   // keep the dialog open
                    }
                    EC.toast('Reset link sent to ' + value + '.', 'success');
                }
            });
        });
    }

    /* ------------------------------------------------------------------ */
    /* SSO                                                                 */
    /* ------------------------------------------------------------------ */

    const ssoBtn = $('ssoBtn');
    if (ssoBtn) {
        ssoBtn.addEventListener('click', () => {
            EC.modal({
                title: 'Sign in with SSO',
                body: `
                    <p>Continue with your organisation's identity provider.</p>
                    <div class="field" style="margin-top:1rem;">
                        <label for="ssoDomain">Work email or domain</label>
                        <input type="text" id="ssoDomain" placeholder="you@enterprise.com">
                        <span class="hint">Demo build — this signs you straight into the dashboard.</span>
                    </div>`,
                confirmText: 'Continue',
                onConfirm: (root) => {
                    const value = root.querySelector('#ssoDomain').value.trim();
                    if (!value) {
                        EC.toast('Enter your work email or domain.', 'error');
                        return false;
                    }
                    const email = value.includes('@') ? value : 'sso.user@' + value;
                    EC.toast('Authenticated via SSO.', 'success');
                    setTimeout(() => signIn(email, 'sso'), 500);
                }
            });
        });
    }
});
