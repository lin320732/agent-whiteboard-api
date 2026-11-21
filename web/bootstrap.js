// Check the session while the main application downloads. Always settle this
// promise so a slow module download cannot cause an unhandled rejection.
const session = fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
  .then(async response => ({ ok: response.ok, data: await response.json() }))
  .catch(error => ({ ok: false, error }));

import('./app.js').then(app => app.startApp(session)).catch(() => {
  const message = document.getElementById('loginError');
  document.getElementById('loginView').hidden = false;
  message.textContent = '页面加载失败，请刷新重试。';
});
