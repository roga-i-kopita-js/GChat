const form = document.querySelector('form');
const input = document.querySelector('input');
const error = document.querySelector('#error');

window.serverSelectionFailed = () => {
  error.textContent = 'Введите HTTPS-адрес без пути, параметров, логина и пароля.';
  form.querySelector('button').disabled = false;
};

form.addEventListener('submit', (event) => {
  event.preventDefault();

  try {
    const url = new URL(input.value.trim());

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error('Invalid server');
    }

    error.textContent = '';
    form.querySelector('button').disabled = true;
    window.webkit.messageHandlers.selectServer.postMessage({ serverUrl: url.origin });
  } catch {
    window.serverSelectionFailed();
  }
});
