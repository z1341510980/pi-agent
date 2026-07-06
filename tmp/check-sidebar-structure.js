(() => {
  // 找到信息差集合分组下的条目
  // 侧边栏条目通常在 CollapsibleGroup 的 content 区域
  const allElements = document.querySelectorAll('*');
  let sidebarItems = [];
  for (const el of allElements) {
    if (el.children.length === 0) continue; // 只看叶子节点
    const text = (el.textContent || '').trim();
    if (text.includes('林墨真实身世') && text.length < 100) {
      sidebarItems.push({
        tag: el.tagName,
        cls: el.className.substring(0, 80),
        text: text.substring(0, 80),
        parentCls: (el.parentElement?.className || '').substring(0, 80)
      });
    }
  }
  return JSON.stringify(sidebarItems.slice(0, 5), null, 2);
})()
