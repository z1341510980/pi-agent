(() => {
  // 重写 window.confirm 自动返回 true
  window.confirm = () => true;
  
  // 找到信息差条目的删除按钮并点击
  const groups = document.querySelectorAll('[class*="rounded-md"]');
  for (const g of groups) {
    const text = (g.textContent || '').trim();
    if (text.includes('信息差集合')) {
      const items = g.querySelectorAll('[role="button"]');
      for (const item of items) {
        const itemText = (item.textContent || '').trim();
        if (itemText.includes('林墨真实身世')) {
          // 触发 hover
          item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          // 找删除按钮
          const delBtn = item.querySelector('button[title*="删除"]');
          if (delBtn) {
            delBtn.click();
            return 'clicked delete button';
          }
          return 'delete button not found after hover';
        }
      }
      return 'item not found';
    }
  }
  return 'group not found';
})()
