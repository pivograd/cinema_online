'use strict';
(() => {
  const form = document.querySelector('.login');
  const user = form.elements.user;
  const pass = form.elements.password;
  const submit = form.querySelector('[type=submit]');
  const label = submit.querySelector('.lbl');
  const err = document.getElementById('err');
  const reveal = document.getElementById('reveal');

  const ERRORS = {
    1: 'Логин или пароль не подходят. Проверьте раскладку и Caps Lock.',
    limit: 'Слишком много попыток подряд. Попробуйте через пять минут.',
  };
  const code = new URLSearchParams(location.search).get('error');
  if (code) {
    err.textContent = ERRORS[code] || ERRORS[1];
    err.hidden = false;
    if (code !== 'limit') for (const f of [user, pass]) f.setAttribute('aria-invalid', 'true');
  }
  for (const f of [user, pass]) f.addEventListener('input', () => f.removeAttribute('aria-invalid'));

  // логин помним, чтобы после ошибки вводить только пароль
  try {
    const saved = localStorage.getItem('login');
    if (saved && !user.value) user.value = saved;
  } catch { /* приватный режим */ }
  // на телефоне не открываем клавиатуру сразу поверх неба
  if (matchMedia('(pointer: fine)').matches) (user.value ? pass : user).focus();

  form.addEventListener('submit', () => {
    try { localStorage.setItem('login', user.value.trim()); } catch { /* приватный режим */ }
    submit.disabled = true;
    label.textContent = 'Входим…';
  });
  // «Назад» из истории возвращает страницу как была — с выключенной кнопкой
  addEventListener('pageshow', () => { submit.disabled = false; label.textContent = 'Войти'; });

  reveal.addEventListener('click', () => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    reveal.setAttribute('aria-pressed', String(show));
    reveal.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
    reveal.querySelector('use').setAttribute('href', show ? '#i-eye-off' : '#i-eye');
  });

  // то же небо, что в зале, только без подписей: Пояс горит сам по себе
  if (window.Sky) window.Sky.mount({ root: document.querySelector('.scene') });
})();
