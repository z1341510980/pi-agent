(() => {
  // 点击信息差条目
  const groups = document.querySelectorAll('[class*="rounded-md"]');
  for (const g of groups) {
    const text = (g.textContent || '').trim();
    if (text.includes('信息差集合')) {
      const items = g.querySelectorAll('[role="button"]');
      for (const item of items) {
        const itemText = (item.textContent || '').trim();
        if (itemText.includes('林墨真实身世')) {
          item.click();
          return 'clicked info layer item: ' + itemText.substring(0, 50);
        }
      }
      return 'info layer group found but no clickable item with 林墨真实身世';
    }
  }
  return 'info layer group not found';
})()
