(() => {
  // 找到侧边栏中包含"林墨真实身世"的条目
  const items = document.querySelectorAll('[class*="cursor-pointer"]');
  for (const item of items) {
    const text = (item.textContent || '').trim();
    if (text.includes('林墨真实身世')) {
      return 'sidebar item text: "' + text.substring(0, 100) + '"';
    }
  }
  // 尝试找信息差集合分组下的条目
  const groups = document.querySelectorAll('[class*="group"], [class*="Collapsible"]');
  let result = [];
  for (const g of groups) {
    const t = (g.textContent || '').trim();
    if (t.includes('信息差集合')) {
      result.push('group: ' + t.substring(0, 200));
    }
  }
  return 'no item found with 林墨真实身世 | groups: ' + result.join(' | ');
})()
