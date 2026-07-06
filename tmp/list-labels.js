(() => {
  const labels = document.querySelectorAll('label');
  let result = [];
  for (const l of labels) {
    const text = (l.textContent || '').trim();
    if (text && text.length < 50) {
      result.push(text);
    }
  }
  return 'labels in detail panel: ' + result.join(' | ');
})()
