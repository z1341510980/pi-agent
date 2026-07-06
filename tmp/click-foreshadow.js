(() => {
  // 找到伏笔集合分组下的第一个条目
  // 伏笔条目通常有 class 包含 "cursor-pointer" 或在分组内容区
  const groups = document.querySelectorAll('[class*="rounded-md"]');
  for (const g of groups) {
    const text = (g.textContent || '').trim();
    if (text.includes('伏笔集合')) {
      // 找到分组内的条目（role=button 的 div）
      const items = g.querySelectorAll('[role="button"]');
      for (const item of items) {
        const itemText = (item.textContent || '').trim();
        // 跳过分组标题和新建按钮
        if (itemText && !itemText.includes('伏笔集合') && !itemText.includes('新建伏笔') && itemText.length > 5) {
          item.click();
          return 'clicked foreshadow item: ' + itemText.substring(0, 50);
        }
      }
      return 'group found but no clickable item | items count: ' + items.length;
    }
  }
  return 'foreshadow group not found';
})()
