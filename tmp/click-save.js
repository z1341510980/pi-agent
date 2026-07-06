(() => {
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    const text = (btn.textContent || '').trim();
    if (text === '保存修改' && !btn.disabled) {
      btn.click();
      return 'clicked: 保存修改';
    }
  }
  return 'not clicked';
})()
