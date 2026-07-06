(() => {
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    const text = (btn.textContent || '').trim();
    if (text === '保存修改' || text === '保存') {
      return 'found button: text="' + text + '" disabled=' + btn.disabled + ' index unknown';
    }
  }
  // 尝试找所有包含"保存"的按钮
  const all = Array.from(document.querySelectorAll('button')).filter(b => (b.textContent||'').includes('保存'));
  return 'buttons containing 保存: ' + all.length + ' | texts: ' + all.map(b => '"' + (b.textContent||'').trim() + '" disabled=' + b.disabled).join(', ');
})()
