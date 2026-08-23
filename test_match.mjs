const SIMPLE_MAP = { '飯':'饭','麵':'面','機':'机','腦':'脑','電':'电','計算機':'计算机','遊':'游','戲':'戏','歷':'历','產':'产','職':'职','場':'场','時':'时','實':'实','際':'际' };
function toSimplified(s){let o='';for(const c of s)o+=SIMPLE_MAP[c]||c;return o;}
function normalizeName(s){return toSimplified(s).toLowerCase().replace(/[\s\u3000]+/g,'').replace(/[，。！？、；：""''（）()【】\[\]《》〈〉·\-—_/\\|.,!?;:'"`~@#$%^&*+=<>]/g,'');}
function matchExistingFolders(newNames, existingFolders){
  const existingNorm = existingFolders.map(n=>({orig:n,norm:normalizeName(n)}));
  const matched=new Map(), unmatched=[];
  for(const name of newNames){
    const norm=normalizeName(name);
    if(!norm){unmatched.push(name);continue;}
    let hit=existingNorm.find(e=>e.norm===norm);
    if(!hit) hit=existingNorm.find(e=>e.norm.length>=2&&norm.length>=2&&(e.norm.includes(norm)||norm.includes(e.norm)));
    if(hit) matched.set(name,hit.orig); else unmatched.push(name);
  }
  return {matched,unmatched};
}
const folders = ['默认收藏夹','编程开发','AI编程','数据算法','考研升学','求职就业','社会纪实','生活科普','游戏娱乐','历史政治','美食烹饪','手工DIY','学术科研','职业发展','AI前沿'];
console.log('场景1（正确夹名）:', JSON.stringify([...matchExistingFolders(['编程开发','游戏娱乐'], folders).matched]));
console.log('场景2（繁体）:', JSON.stringify([...matchExistingFolders(['計算機','遊戲'], folders).matched]));
console.log('场景3（字面不同）:', JSON.stringify(matchExistingFolders(['编程','游戏','学习'], folders).unmatched));
console.log('场景4（默认夹）:', JSON.stringify([...matchExistingFolders(['默认收藏夹'], folders).matched]));
