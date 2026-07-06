(() => {
  const groups = document.querySelectorAll('[class*="rounded-md"]');
  for (const g of groups) {
    const text = (g.textContent || '').trim();
    if (text.includes('冲突集合')) {
      const items = g.querySelectorAll('[role="button"]');
      for (const item of items) {
        const itemText = (item.textContent || '').trim();
        if (itemText && !itemText.includes('冲突集合') && !itemText.includes('新建冲突') && itemText.length > 5) {
          item.click();
          return 'clicked conflict item: ' + itemText.substring(0, 50);
        }
      }
      return 'conflict group found but no clickable item | items: ' + items.length;
    }
  }
  return 'conflict group not found';
})()
