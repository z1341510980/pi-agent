(() => {
  const groups = document.querySelectorAll('[class*="rounded-md"]');
  for (const g of groups) {
    const text = (g.textContent || '').trim();
    if (text.includes('角色集合')) {
      const items = g.querySelectorAll('[role="button"]');
      for (const item of items) {
        const itemText = (item.textContent || '').trim();
        if (itemText && !itemText.includes('角色集合') && !itemText.includes('新建角色') && itemText.length > 5) {
          item.click();
          return 'clicked character item: ' + itemText.substring(0, 50);
        }
      }
      return 'character group found but no clickable item | items: ' + items.length;
    }
  }
  return 'character group not found';
})()
