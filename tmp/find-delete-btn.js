(() => {
  // 找到信息差条目，hover 显示删除按钮
  const groups = document.querySelectorAll('[class*="rounded-md"]');
  for (const g of groups) {
    const text = (g.textContent || '').trim();
    if (text.includes('信息差集合')) {
      const items = g.querySelectorAll('[role="button"]');
      for (const item of items) {
        const itemText = (item.textContent || '').trim();
        if (itemText.includes('林墨真实身世')) {
          // 触发 mouseenter 事件显示 hover 按钮
          item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          // 查找删除按钮
          const delBtn = item.querySelector('button[aria-label*="删除"], button[aria-label*="delete"], button[title*="删除"]');
          if (delBtn) {
            return 'found delete button: aria-label=' + delBtn.getAttribute('aria-label') + ' | title=' + delBtn.getAttribute('title');
          }
          // 查找所有按钮
          const allBtns = item.querySelectorAll('button');
          return 'no delete button found | total buttons: ' + allBtns.length + ' | aria-labels: ' + Array.from(allBtns).map(b => b.getAttribute('aria-label') || b.getAttribute('title') || 'no-label').join(', ');
        }
      }
      return 'item not found';
    }
  }
  return 'group not found';
})()
