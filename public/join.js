const params = new URLSearchParams(location.hash.slice(1));
const code = params.get('invite');
if (code) {
  document.getElementById('invite-code').value = code;
  document.getElementById('code-field').hidden = true;
  // Invitation stays in memory, not in the address bar, referrers, or localStorage.
  history.replaceState(null, '', location.pathname);
}
document.getElementById('join-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('join-submit');
  const error = document.getElementById('join-error');
  button.disabled = true;
  error.textContent = '';
  try {
    const response = await fetch('/api/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: document.getElementById('guest-name').value, code: document.getElementById('invite-code').value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    location.replace('/');
  } catch (reason) {
    error.textContent = reason.message || 'Не удалось войти.';
    if (code) document.getElementById('code-field').hidden = false;
    button.disabled = false;
  }
});
