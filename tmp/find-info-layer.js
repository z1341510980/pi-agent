(() => {
  const items = document.querySelectorAll('[class*="cursor-pointer"]');
  for (const item of items) {
    const text = item.textContent || '';
    if (text.includes('新的信息差')) {
      item.click();
      return 'clicked: ' + text.slice(0, 30);
    }
  }
  const allButtons = document.querySelectorAll('button');
  for (const btn of allButtons) {
    const text = btn.textContent || '';
    if (text.includes('新的信息差')) {
      btn.click();
      return 'clicked button: ' + text.slice(0, 30);
    }
  }
  return 'not found';
})()
